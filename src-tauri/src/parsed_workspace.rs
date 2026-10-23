use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState, ParsedDocumentVersionRecord};
use crate::parsed_preview::{clean_local_asset_path, ParsedPreviewSession, ParsedPreviewState};

const MAX_BLOCKS_JSON_SIZE: u64 = 50 * 1024 * 1024; // 50MB
const MAX_BLOCKS_COUNT: usize = 2000;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActiveParsedWorkspaceResponse {
    pub version_id: String,
    pub document_id: String,
    pub source_revision: String,
    pub provider: String,
    pub block_count: i64,
    pub asset_count: i64,
    pub created_at: i64,
    pub session_id: String,
    pub blocks_path: String,
    pub doc_dir: String,
    pub raw_json: String,
    pub has_assets: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParsedWorkspaceManifest {
    pub version_id: String,
    pub document_id: String,
    pub source_revision: String,
    pub provider: String,
    pub block_count: i64,
    pub asset_count: i64,
    pub created_at: i64,
}

/// 安全清理目录，严格校验目标目录处于预期父目录之下且不等于父目录本身
pub fn safe_remove_dir_all(dir: &Path, expected_parent: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let canonical_dir = dir.canonicalize()?;
    let canonical_parent = expected_parent.canonicalize()?;
    if !canonical_dir.starts_with(&canonical_parent) || canonical_dir == canonical_parent {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "拒绝删除非预期父目录下的目录",
        ));
    }
    fs::remove_dir_all(&canonical_dir)
}

/// 复制安全校验通过的图片资产到隐式工作区
/// 严格防御：排除符号链接、拦截路径遍历、仅放行合法图片扩展名、支持递归嵌套目录结构
pub fn copy_safe_assets(
    source_assets_dir: &Path,
    target_assets_dir: &Path,
) -> Result<i64, String> {
    if !source_assets_dir.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(target_assets_dir)
        .map_err(|e| format!("创建目标 assets 目录失败: {}", e))?;

    let canonical_src_assets = source_assets_dir
        .canonicalize()
        .map_err(|e| format!("解析源 assets 目录失败: {}", e))?;

    let allowed_exts = ["png", "jpg", "jpeg", "webp", "svg", "gif"];
    let mut copied_count = 0;

    fn walk_and_copy(
        current_src: &Path,
        root_src: &Path,
        root_dst: &Path,
        canonical_root: &Path,
        allowed_exts: &[&str],
        copied: &mut i64,
    ) -> Result<(), String> {
        let entries = fs::read_dir(current_src)
            .map_err(|e| format!("遍历 assets 目录失败: {}", e))?;

        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;

            if file_type.is_symlink() {
                continue;
            }

            if let Ok(meta) = fs::symlink_metadata(&path) {
                if meta.file_type().is_symlink() {
                    continue;
                }
            }

            let rel_path = match path.strip_prefix(root_src) {
                Ok(p) => p,
                Err(_) => continue,
            };

            let all_normal = rel_path
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)));
            if !all_normal {
                continue;
            }

            if file_type.is_dir() {
                if let Ok(c) = path.canonicalize() {
                    if c.starts_with(canonical_root) && c != *canonical_root {
                        walk_and_copy(
                            &path,
                            root_src,
                            root_dst,
                            canonical_root,
                            allowed_exts,
                            copied,
                        )?;
                    }
                }
            } else if file_type.is_file() {
                let canonical_entry = match path.canonicalize() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if !canonical_entry.starts_with(canonical_root) {
                    continue;
                }

                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();

                if allowed_exts.contains(&ext.as_str()) {
                    let dest_file = root_dst.join(rel_path);
                    if let Some(parent) = dest_file.parent() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("创建资产子目录失败: {}", e))?;
                    }
                    fs::copy(&canonical_entry, &dest_file)
                        .map_err(|e| format!("复制资产文件 {:?} 失败: {}", rel_path, e))?;
                    *copied += 1;
                }
            }
        }
        Ok(())
    }

    walk_and_copy(
        source_assets_dir,
        source_assets_dir,
        target_assets_dir,
        &canonical_src_assets,
        &allowed_exts,
        &mut copied_count,
    )?;

    Ok(copied_count)
}

/// 过滤 Markdown 中的代码环境（围栏代码块、行内代码与缩进代码），防止误将代码示例中的图片语法当作必需资产
fn strip_markdown_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_fenced_block = false;
    let mut fence_char = ' ';
    let mut fence_len = 0;
    let mut prev_line_blank = true;
    let mut in_unclosed_tag = false;
    let mut in_indented_code = false;

    for line in content.lines() {
        let trimmed_start = line.trim_start();
        let leading_spaces = line.len() - trimmed_start.len();
        let is_blank = trimmed_start.is_empty();

        if in_fenced_block {
            let fence_prefix = std::iter::repeat(fence_char).take(fence_len).collect::<String>();
            if leading_spaces <= 3 && trimmed_start.starts_with(&fence_prefix) {
                let rest = trimmed_start[fence_len..].trim();
                if rest.is_empty() {
                    in_fenced_block = false;
                }
            }
            prev_line_blank = is_blank;
            in_indented_code = false;
            continue;
        }

        if leading_spaces <= 3 {
            if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
                let ch = trimmed_start.chars().next().unwrap();
                let count = trimmed_start.chars().take_while(|&c| c == ch).count();
                if count >= 3 {
                    in_fenced_block = true;
                    fence_char = ch;
                    fence_len = count;
                    prev_line_blank = is_blank;
                    in_indented_code = false;
                    continue;
                }
            }
        }

        // 缩进代码块处理：
        // 1. 若当前已处于缩进代码块中：
        //    - 若当前行有 4+ 空格缩进或 tab，继续属于缩进代码块；
        //    - 若当前行为纯空行，作为缩进代码块内部的空行跳过；
        //    - 否则（缩进 < 4 且非空行），退出缩进代码块并继续向下作为正文处理。
        // 2. 若当前未处于缩进代码块中：
        //    - 必须前一行为空行、不在未闭合 HTML 标签内，且当前行有 4+ 空格缩进或 tab，才进入缩进代码块。
        if in_indented_code {
            if leading_spaces >= 4 || line.starts_with('\t') {
                prev_line_blank = is_blank;
                continue;
            } else if is_blank {
                prev_line_blank = true;
                continue;
            } else {
                in_indented_code = false;
            }
        } else if (leading_spaces >= 4 || line.starts_with('\t')) && prev_line_blank && !in_unclosed_tag {
            in_indented_code = true;
            prev_line_blank = is_blank;
            continue;
        }

        // 检查 HTML 标签跨行状态
        for ch in line.chars() {
            if ch == '<' {
                in_unclosed_tag = true;
            } else if ch == '>' {
                in_unclosed_tag = false;
            }
        }

        // 行内代码过滤：根据反引号分隔符长度精准识别代码范围，代码内全部置换为空格
        // 支持单个反引号 `...`，双反引号 ``...``，且支持双反引号内包含单个反引号
        let chars: Vec<char> = line.chars().collect();
        let line_len = chars.len();
        let mut idx = 0;

        while idx < line_len {
            if chars[idx] == '`' {
                let mut n = 0;
                while idx + n < line_len && chars[idx + n] == '`' {
                    n += 1;
                }
                // 在当前行寻找长度严格匹配的闭合反引号串（恰好 n 个连续反引号）
                let mut close_start = None;
                let mut scan = idx + n;
                while scan < line_len {
                    if chars[scan] == '`' {
                        let mut m = 0;
                        while scan + m < line_len && chars[scan + m] == '`' {
                            m += 1;
                        }
                        if m == n {
                            close_start = Some(scan);
                            break;
                        }
                        scan += m;
                    } else {
                        scan += 1;
                    }
                }

                if let Some(c_start) = close_start {
                    for _ in 0..(c_start + n - idx) {
                        out.push(' ');
                    }
                    idx = c_start + n;
                    continue;
                }
            }
            out.push(chars[idx]);
            idx += 1;
        }
        out.push('\n');
        prev_line_blank = is_blank;
    }

    out
}

/// 提取 Markdown 引用链接定义（如 `[ref]: assets/a.png "Title"`）
fn extract_markdown_ref_defs(content: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if let Some(close_bracket) = trimmed.find("]:") {
                let label = trimmed[1..close_bracket].trim().to_ascii_lowercase();
                let rest = trimmed[close_bracket + 2..].trim();
                if !label.is_empty() && !rest.is_empty() {
                    let url = if rest.starts_with('<') {
                        if let Some(close_angle) = rest.find('>') {
                            &rest[1..close_angle]
                        } else {
                            rest.split_whitespace().next().unwrap_or("")
                        }
                    } else {
                        rest.split_whitespace().next().unwrap_or("")
                    };
                    if !url.is_empty() {
                        map.insert(label, url.to_string());
                    }
                }
            }
        }
    }
    map
}

/// 解析 HTML <img> 标签内的 src 属性值，支持任意属性排布与空白
fn parse_img_src_attribute(tag_str: &str, refs: &mut Vec<String>) -> Result<(), String> {
    let bytes = tag_str.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i + 3 <= len {
        if bytes[i..i + 3].eq_ignore_ascii_case(b"src") {
            let prev_ok = i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b'<' || bytes[i - 1] == b'/';
            let mut j = i + 3;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if prev_ok && j < len && bytes[j] == b'=' {
                j += 1;
                while j < len && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < len {
                    let quote = bytes[j];
                    let url = if quote == b'"' || quote == b'\'' {
                        j += 1;
                        let start = j;
                        while j < len && bytes[j] != quote {
                            j += 1;
                        }
                        &tag_str[start..j]
                    } else {
                        let start = j;
                        while j < len && !bytes[j].is_ascii_whitespace() && bytes[j] != b'>' {
                            j += 1;
                        }
                        let raw_val = &tag_str[start..j];
                        raw_val.trim_end_matches('/')
                    };
                    if let Some(clean) = clean_local_asset_path(url)? {
                        refs.push(clean);
                    }
                    return Ok(());
                }
            }
        }
        i += 1;
    }
    Ok(())
}

/// 从 Markdown/HTML 文本中提取图片引用
/// 严格防御：跳过代码块、Unicode安全切片不panic、支持标题与引用式图片、共用 clean_local_asset_path 规则
fn extract_image_refs_from_content(content: &str, refs: &mut Vec<String>) -> Result<(), String> {
    let clean_content = strip_markdown_code(content);
    let ref_defs = extract_markdown_ref_defs(&clean_content);

    // 1. Markdown 图片语法: ![alt](url) 与 ![alt][ref]
    let bytes = clean_content.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i + 2 < len {
        if bytes[i] == b'!' && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            let mut bracket_depth = 1;
            while j < len && bracket_depth > 0 {
                if bytes[j] == b'[' {
                    bracket_depth += 1;
                } else if bytes[j] == b']' {
                    bracket_depth -= 1;
                }
                j += 1;
            }
            if bracket_depth == 0 && j < len {
                let alt_text = &clean_content[i + 2..j - 1];
                let mut after_bracket = j;
                while after_bracket < len && bytes[after_bracket].is_ascii_whitespace() {
                    after_bracket += 1;
                }
                if after_bracket < len {
                    if bytes[after_bracket] == b'(' {
                        // 行内式图片: ![alt](url "title")
                        let start_paren = after_bracket + 1;
                        let mut k = start_paren;
                        let mut paren_depth = 1;
                        while k < len && paren_depth > 0 {
                            if bytes[k] == b'(' {
                                paren_depth += 1;
                            } else if bytes[k] == b')' {
                                paren_depth -= 1;
                            }
                            k += 1;
                        }
                        if paren_depth == 0 {
                            let raw_inside = clean_content[start_paren..k - 1].trim();
                            let url = if raw_inside.starts_with('<') {
                                if let Some(end_angle) = raw_inside.find('>') {
                                    &raw_inside[1..end_angle]
                                } else {
                                    raw_inside.split_whitespace().next().unwrap_or("")
                                }
                            } else {
                                raw_inside.split_whitespace().next().unwrap_or("")
                            };
                            if let Some(clean) = clean_local_asset_path(url)? {
                                refs.push(clean);
                            }
                            i = k;
                            continue;
                        }
                    } else if bytes[after_bracket] == b'[' {
                        // 引用式图片: ![alt][ref] 或 ![alt][]
                        let start_ref = after_bracket + 1;
                        let mut k = start_ref;
                        while k < len && bytes[k] != b']' {
                            k += 1;
                        }
                        if k < len {
                            let raw_label = clean_content[start_ref..k].trim();
                            let target_label = if raw_label.is_empty() {
                                alt_text.trim().to_ascii_lowercase()
                            } else {
                                raw_label.to_ascii_lowercase()
                            };
                            if let Some(url) = ref_defs.get(&target_label) {
                                if let Some(clean) = clean_local_asset_path(url)? {
                                    refs.push(clean);
                                }
                            }
                            i = k + 1;
                            continue;
                        }
                    }
                }
            }
        }
        i += 1;
    }

    // 2. HTML <img> 标签语法: <img ... src="..." />
    // 纯字节/ASCII匹配，绝不在 UTF-8 多字节文本上混用 to_lowercase 字节索引
    let bytes = clean_content.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        if bytes[i] == b'<' && i + 4 <= len {
            let tag_head = &bytes[i + 1..i + 4];
            if tag_head.eq_ignore_ascii_case(b"img") {
                let next_byte = if i + 4 < len { bytes[i + 4] } else { b'>' };
                if next_byte.is_ascii_whitespace() || next_byte == b'>' || next_byte == b'/' {
                    let tag_start = i;
                    let mut tag_end = None;
                    let mut in_quote = None;
                    let mut j = i + 4;
                    while j < len {
                        let b = bytes[j];
                        if let Some(q) = in_quote {
                            if b == q {
                                in_quote = None;
                            }
                        } else if b == b'"' || b == b'\'' {
                            in_quote = Some(b);
                        } else if b == b'>' {
                            tag_end = Some(j);
                            break;
                        }
                        j += 1;
                    }
                    if let Some(end) = tag_end {
                        let tag_str = &clean_content[tag_start..=end];
                        parse_img_src_attribute(tag_str, refs)?;
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }

    Ok(())
}

/// 提取 blocks.json 中所有必需的本地图片资产相对路径
fn extract_required_assets(blocks: &[serde_json::Value]) -> Result<Vec<String>, String> {
    let mut refs = Vec::new();

    for (idx, block) in blocks.iter().enumerate() {
        let block_id = block
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_block");

        // 1. block.asset_ref
        if let Some(asset_ref) = block.get("asset_ref").and_then(|v| v.as_str()) {
            let trimmed = asset_ref.trim();
            if !trimmed.is_empty() {
                match clean_local_asset_path(trimmed) {
                    Ok(Some(clean)) => refs.push(clean),
                    Ok(None) => {}
                    Err(e) => {
                        return Err(format!(
                            "第 {} 块 (ID: {}) 包含非法或逃逸的图片资产路径: {}",
                            idx + 1,
                            block_id,
                            e
                        ));
                    }
                }
            }
        }

        // 2. block.content 中的 Markdown 与 HTML 图片
        if let Some(content) = block.get("content").and_then(|v| v.as_str()) {
            extract_image_refs_from_content(content, &mut refs)
                .map_err(|e| format!("第 {} 块 (ID: {}) 内容中包含非法图片引用: {}", idx + 1, block_id, e))?;
        }
    }

    Ok(refs)
}

/// 核心导入业务逻辑，支持脱离 Tauri 容器运行测试
pub fn import_dir_internal(
    workspace_dir: &Path,
    conn: &mut rusqlite::Connection,
    preview_state: &ParsedPreviewState,
    document_id: &str,
    source_revision: &str,
    source_blocks_path: &str,
    provider: &str,
) -> Result<ActiveParsedWorkspaceResponse, String> {
    // 0. 严格校验 document_id
    if document_id.is_empty()
        || !document_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("文档 ID 包含非法字符: {}", document_id));
    }

    let doc_exists: bool = conn
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            [document_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !doc_exists {
        return Err(format!("文档 ID 不存在于 documents 表中: {}", document_id));
    }

    let staging_root = workspace_dir.join("staging");
    fs::create_dir_all(&staging_root)
        .map_err(|e| format!("创建 staging 目录失败: {}", e))?;

    let temp_id = format!("staging_{}", Uuid::new_v4().simple());
    let staging_dir = staging_root.join(&temp_id);
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("创建临时导入暂存区失败: {}", e))?;

    let doc_versions_dir = workspace_dir
        .join("documents")
        .join(document_id)
        .join("versions");

    let mut staging_success = false;

    let staging_res = (|| -> Result<(String, i64, i64, String), String> {
        let src_path = Path::new(source_blocks_path);
        if !src_path.is_file() {
            return Err(format!("源 blocks.json 不存在或不是文件: {}", source_blocks_path));
        }

        // 1. 严格校验 blocks.json 文件大小与内容
        let meta = fs::metadata(src_path)
            .map_err(|e| format!("无法读取源 blocks.json 元数据: {}", e))?;
        if meta.len() > MAX_BLOCKS_JSON_SIZE {
            return Err(format!(
                "源 blocks.json 文件大小 ({} bytes) 超过 50MB 上限",
                meta.len()
            ));
        }

        let raw_blocks = fs::read_to_string(src_path)
            .map_err(|e| format!("读取源 blocks.json 失败: {}", e))?;
        let json_val: serde_json::Value = serde_json::from_str(&raw_blocks)
            .map_err(|e| format!("源 blocks.json 不是合法的 JSON 语法: {}", e))?;
        let arr = json_val
            .as_array()
            .ok_or_else(|| "blocks.json 顶层必须为包含结构块的 JSON 数组".to_string())?;

        let block_count = arr.len() as i64;
        if arr.len() > MAX_BLOCKS_COUNT {
            return Err(format!(
                "文档包含 {} 个结构块，超出只读原型承载范围 (上限 {} 块)",
                arr.len(),
                MAX_BLOCKS_COUNT
            ));
        }

        // 提取并校验 blocks.json 声明的必需图片资产引用
        let required_assets = extract_required_assets(arr)?;

        // 写入暂存 blocks.json
        let dest_blocks = staging_dir.join("blocks.json");
        fs::write(&dest_blocks, &raw_blocks)
            .map_err(|e| format!("写入暂存 blocks.json 失败: {}", e))?;

        let src_dir = src_path
            .parent()
            .ok_or_else(|| "无法获取源文件所在目录".to_string())?;

        // 2. 复制 content.md 与 source-map.json (若源目录存在，复制失败必须显式报错)
        let src_content_md = src_dir.join("content.md");
        if src_content_md.is_file() {
            fs::copy(&src_content_md, staging_dir.join("content.md"))
                .map_err(|e| format!("复制 content.md 失败: {}", e))?;
        }
        let src_source_map = src_dir.join("source-map.json");
        if src_source_map.is_file() {
            fs::copy(&src_source_map, staging_dir.join("source-map.json"))
                .map_err(|e| format!("复制 source-map.json 失败: {}", e))?;
        }

        // 3. 复制合法资产
        let src_assets = src_dir.join("assets");
        let dest_assets = staging_dir.join("assets");
        let asset_count = copy_safe_assets(&src_assets, &dest_assets)?;

        // 4. 严格校验：blocks 引用的所有本地图片资产必须全部存在且已安全落盘
        for req in &required_assets {
            let req_path = dest_assets.join(req);
            if !req_path.is_file() {
                return Err(format!("缺少必需的本地图片资产: assets/{}", req));
            }
        }

        // 5. 生成 version_id 并写入 manifest.json
        let version_id = format!("ver_{}_{}", db::now_ms(), Uuid::new_v4().simple());
        let manifest = ParsedWorkspaceManifest {
            version_id: version_id.clone(),
            document_id: document_id.to_string(),
            source_revision: source_revision.to_string(),
            provider: provider.to_string(),
            block_count,
            asset_count,
            created_at: db::now_ms(),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("序列化 manifest.json 失败: {}", e))?;
        fs::write(staging_dir.join("manifest.json"), manifest_json)
            .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;

        // 6. 原子落盘到目标版本目录（取消静默回退，严格使用 rename 保证原子性）
        fs::create_dir_all(&doc_versions_dir)
            .map_err(|e| format!("创建版本目标目录失败: {}", e))?;

        let target_version_dir = doc_versions_dir.join(&version_id);
        fs::rename(&staging_dir, &target_version_dir)
            .map_err(|e| format!("原子移动解析版本目录失败: {}", e))?;

        staging_success = true;
        let rel_path = format!("documents/{}/versions/{}", document_id, version_id);
        Ok((version_id, block_count, asset_count, rel_path))
    })();

    if !staging_success {
        let _ = safe_remove_dir_all(&staging_dir, &staging_root);
    }
    let (version_id, block_count, asset_count, storage_rel_path) = staging_res?;

    // 7. 写入 SQLite parsed_document_versions (显式事务控制)
    let record = ParsedDocumentVersionRecord {
        version_id: version_id.clone(),
        document_id: document_id.to_string(),
        source_revision: source_revision.to_string(),
        provider: provider.to_string(),
        config_signature: format!("{}:default", provider),
        storage_rel_path: storage_rel_path.clone(),
        block_count,
        asset_count,
        is_active: 1,
        created_at: db::now_ms(),
    };

    let target_version_dir = doc_versions_dir.join(&version_id);
    if let Err(e) = db::record_parsed_version(conn, &record) {
        // DB 写入失败，严格回滚清理该新增版本目录
        let _ = safe_remove_dir_all(&target_version_dir, &doc_versions_dir);
        return Err(e);
    }

    // 8. 注册只读读取会话到 ParsedPreviewState
    // 注意：若后续会话注册失败，不回滚已落盘文件或已提交记录，显式返回错误
    let target_blocks = target_version_dir.join("blocks.json");
    let raw_json = fs::read_to_string(&target_blocks)
        .map_err(|e| format!("读取已落盘 blocks.json 失败: {}", e))?;

    let session_id = format!("sess_ws_{}", Uuid::new_v4().simple());
    let session = ParsedPreviewSession {
        session_id: session_id.clone(),
        blocks_path: target_blocks.clone(),
        doc_dir: target_version_dir.clone(),
        assets_dir: target_version_dir.join("assets"),
        has_assets: asset_count > 0,
    };

    {
        let mut lock = preview_state.sessions.lock().map_err(|e| e.to_string())?;
        lock.insert(session_id.clone(), session);
    }

    Ok(ActiveParsedWorkspaceResponse {
        version_id,
        document_id: document_id.to_string(),
        source_revision: source_revision.to_string(),
        provider: provider.to_string(),
        block_count,
        asset_count,
        created_at: record.created_at,
        session_id,
        blocks_path: target_blocks.to_string_lossy().to_string(),
        doc_dir: target_version_dir.to_string_lossy().to_string(),
        raw_json,
        has_assets: asset_count > 0,
    })
}

/// 将已归一化的本地解析产物目录持久化登记到隐式工作区中
/// 专供后台解析任务调用：原子落盘与条件化版本激活，绝不创建阅读 session！
pub struct ParsedImportOptions<'a> {
    /// 任务创建时固定下来的激活基准版本
    pub expected_active_version_id: Option<&'a str>,
    /// 是否允许自动替换当前激活版本（源已变化或用户已选择其它版本时为 false）
    pub activate: bool,
    /// 关联的解析任务：版本登记与任务成功更新在同一事务内完成
    pub job_id: Option<&'a str>,
    /// 崩溃恢复用：固定版本号，保证重试不会产生第二个版本目录
    pub version_id_override: Option<&'a str>,
}

impl<'a> Default for ParsedImportOptions<'a> {
    fn default() -> Self {
        Self {
            expected_active_version_id: None,
            activate: true,
            job_id: None,
            version_id_override: None,
        }
    }
}

#[allow(dead_code)]
pub fn import_normalized_dir_internal(
    workspace_dir: &Path,
    conn: &mut rusqlite::Connection,
    document_id: &str,
    source_revision: &str,
    provider: &str,
    config_signature: &str,
    normalized_dir: &Path,
    expected_active_version_id: Option<&str>,
) -> Result<(String, i64, i64, String, bool), String> {
    import_normalized_dir_with_options(
        workspace_dir,
        conn,
        document_id,
        source_revision,
        provider,
        config_signature,
        normalized_dir,
        ParsedImportOptions {
            expected_active_version_id,
            activate: true,
            job_id: None,
            version_id_override: None,
        },
    )
}

pub fn import_normalized_dir_with_options(
    workspace_dir: &Path,
    conn: &mut rusqlite::Connection,
    document_id: &str,
    source_revision: &str,
    provider: &str,
    config_signature: &str,
    normalized_dir: &Path,
    options: ParsedImportOptions<'_>,
) -> Result<(String, i64, i64, String, bool), String> {
    let expected_active_version_id = options.expected_active_version_id;
    let version_id_override = options.version_id_override.map(|v| v.to_string());
    // 0. 严格校验 document_id
    if document_id.is_empty()
        || !document_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("文档 ID 包含非法字符: {}", document_id));
    }

    let doc_exists: bool = conn
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            [document_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !doc_exists {
        return Err(format!("文档 ID 不存在于 documents 表中: {}", document_id));
    }

    let blocks_file = normalized_dir.join("blocks.json");
    if !blocks_file.is_file() {
        return Err(format!("归一化目录中缺少 blocks.json: {:?}", blocks_file));
    }

    let staging_root = workspace_dir.join("staging");
    fs::create_dir_all(&staging_root)
        .map_err(|e| format!("创建 staging 目录失败: {}", e))?;

    let temp_id = format!("staging_{}", Uuid::new_v4().simple());
    let staging_dir = staging_root.join(&temp_id);
    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("创建临时导入暂存区失败: {}", e))?;

    let doc_versions_dir = workspace_dir
        .join("documents")
        .join(document_id)
        .join("versions");

    let mut staging_success = false;

    let staging_res = (|| -> Result<(String, i64, i64, String), String> {
        let meta = fs::metadata(&blocks_file)
            .map_err(|e| format!("无法读取源 blocks.json 元数据: {}", e))?;
        if meta.len() > MAX_BLOCKS_JSON_SIZE {
            return Err(format!(
                "源 blocks.json 文件大小 ({} bytes) 超过 50MB 上限",
                meta.len()
            ));
        }

        let raw_blocks = fs::read_to_string(&blocks_file)
            .map_err(|e| format!("读取源 blocks.json 失败: {}", e))?;
        let json_val: serde_json::Value = serde_json::from_str(&raw_blocks)
            .map_err(|e| format!("源 blocks.json 不是合法的 JSON 语法: {}", e))?;
        let arr = json_val
            .as_array()
            .ok_or_else(|| "blocks.json 顶层必须为包含结构块的 JSON 数组".to_string())?;

        let block_count = arr.len() as i64;
        if arr.len() > MAX_BLOCKS_COUNT {
            return Err(format!(
                "文档包含 {} 个结构块，超出只读原型承载范围 (上限 {} 块)",
                arr.len(),
                MAX_BLOCKS_COUNT
            ));
        }

        let required_assets = extract_required_assets(arr)?;

        // 写入暂存 blocks.json
        let dest_blocks = staging_dir.join("blocks.json");
        fs::write(&dest_blocks, &raw_blocks)
            .map_err(|e| format!("写入暂存 blocks.json 失败: {}", e))?;

        // 复制 content.md 与 source-map.json
        let src_content_md = normalized_dir.join("content.md");
        if src_content_md.is_file() {
            fs::copy(&src_content_md, staging_dir.join("content.md"))
                .map_err(|e| format!("复制 content.md 失败: {}", e))?;
        }
        let src_source_map = normalized_dir.join("source-map.json");
        if src_source_map.is_file() {
            fs::copy(&src_source_map, staging_dir.join("source-map.json"))
                .map_err(|e| format!("复制 source-map.json 失败: {}", e))?;
        }

        // 复制合法资产
        let src_assets = normalized_dir.join("assets");
        let dest_assets = staging_dir.join("assets");
        let asset_count = copy_safe_assets(&src_assets, &dest_assets)?;

        // 严格校验：blocks 引用的所有本地图片资产必须全部存在且已安全落盘
        for req in &required_assets {
            let req_path = dest_assets.join(req);
            if !req_path.is_file() {
                return Err(format!("缺少必需的本地图片资产: assets/{}", req));
            }
        }

        // 生成 version_id 并写入 manifest.json。
        // 任务入库使用固定版本号（ver_<job_id>），崩溃重试时不会产生第二个版本目录。
        let version_id = version_id_override
            .clone()
            .unwrap_or_else(|| format!("ver_{}_{}", db::now_ms(), Uuid::new_v4().simple()));
        let manifest = ParsedWorkspaceManifest {
            version_id: version_id.clone(),
            document_id: document_id.to_string(),
            source_revision: source_revision.to_string(),
            provider: provider.to_string(),
            block_count,
            asset_count,
            created_at: db::now_ms(),
        };
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("序列化 manifest.json 失败: {}", e))?;
        fs::write(staging_dir.join("manifest.json"), manifest_json)
            .map_err(|e| format!("写入 manifest.json 失败: {}", e))?;

        // 原子落盘到目标版本目录
        fs::create_dir_all(&doc_versions_dir)
            .map_err(|e| format!("创建版本目标目录失败: {}", e))?;

        let target_version_dir = doc_versions_dir.join(&version_id);
        // 仅当使用固定版本号恢复时，才允许清理上次崩溃留下的同名目录
        if version_id_override.is_some() && target_version_dir.exists() {
            let _ = safe_remove_dir_all(&target_version_dir, &doc_versions_dir);
        }
        fs::rename(&staging_dir, &target_version_dir)
            .map_err(|e| format!("原子移动解析版本目录失败: {}", e))?;

        staging_success = true;
        let rel_path = format!("documents/{}/versions/{}", document_id, version_id);
        Ok((version_id, block_count, asset_count, rel_path))
    })();

    if !staging_success {
        let _ = safe_remove_dir_all(&staging_dir, &staging_root);
    }
    let (version_id, block_count, asset_count, storage_rel_path) = staging_res?;

    // 条件化登记版本 (若源文件修改或预期 active 版本改变，则保存但置 is_active = 0)
    let record = ParsedDocumentVersionRecord {
        version_id: version_id.clone(),
        document_id: document_id.to_string(),
        source_revision: source_revision.to_string(),
        provider: provider.to_string(),
        config_signature: config_signature.to_string(),
        storage_rel_path: storage_rel_path.clone(),
        block_count,
        asset_count,
        is_active: 1, // 初始意图激活
        created_at: db::now_ms(),
    };

    let target_version_dir = doc_versions_dir.join(&version_id);

    // 任务入库：版本登记与“任务成功”更新在同一个 SQLite 事务内完成；
    // 手动导入仍使用原有的条件登记逻辑。
    let db_result = match options.job_id {
        Some(job_id) => db::record_parsed_version_and_finish_job(
            conn,
            &record,
            source_revision,
            expected_active_version_id,
            job_id,
            options.activate,
        ),
        None => db::record_parsed_version_conditional(
            conn,
            &record,
            source_revision,
            expected_active_version_id,
        ),
    };

    let activated = match db_result {
        Ok(act) => act,
        Err(e) => {
            let _ = safe_remove_dir_all(&target_version_dir, &doc_versions_dir);
            return Err(e);
        }
    };

    Ok((version_id, block_count, asset_count, storage_rel_path, activated))
}

/// 获取激活版本业务逻辑
pub fn get_active_internal(
    workspace_dir: &Path,
    conn: &rusqlite::Connection,
    preview_state: &ParsedPreviewState,
    document_id: &str,
) -> Result<Option<ActiveParsedWorkspaceResponse>, String> {
    let record = db::get_active_parsed_version(conn, document_id)?;
    let record = match record {
        Some(r) => r,
        None => return Ok(None),
    };

    // 校验 storage_rel_path 路径片段合法性
    let rel_path = Path::new(&record.storage_rel_path);
    if !rel_path
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return Err("存储相对路径包含非法路径片段".to_string());
    }

    let version_dir = workspace_dir.join(rel_path);
    if !version_dir.is_dir() {
        return Ok(None);
    }

    if workspace_dir.is_dir() {
        let canonical_ws = workspace_dir
            .canonicalize()
            .map_err(|e| format!("解析工作区路径失败: {}", e))?;
        let canonical_ver = version_dir
            .canonicalize()
            .map_err(|e| format!("解析版本目录失败: {}", e))?;
        if !canonical_ver.starts_with(&canonical_ws) {
            return Err("解析版本目录越界逃逸".to_string());
        }
    }

    let blocks_file = version_dir.join("blocks.json");
    if !blocks_file.is_file() {
        return Ok(None);
    }

    let raw_json = fs::read_to_string(&blocks_file)
        .map_err(|e| format!("读取解析结果 blocks.json 失败: {}", e))?;

    let session_id = format!("sess_ws_{}", Uuid::new_v4().simple());
    let session = ParsedPreviewSession {
        session_id: session_id.clone(),
        blocks_path: blocks_file.clone(),
        doc_dir: version_dir.clone(),
        assets_dir: version_dir.join("assets"),
        has_assets: record.asset_count > 0,
    };

    {
        let mut lock = preview_state.sessions.lock().map_err(|e| e.to_string())?;
        lock.insert(session_id.clone(), session);
    }

    Ok(Some(ActiveParsedWorkspaceResponse {
        version_id: record.version_id,
        document_id: record.document_id,
        source_revision: record.source_revision,
        provider: record.provider,
        block_count: record.block_count,
        asset_count: record.asset_count,
        created_at: record.created_at,
        session_id,
        blocks_path: blocks_file.to_string_lossy().to_string(),
        doc_dir: version_dir.to_string_lossy().to_string(),
        raw_json,
        has_assets: record.asset_count > 0,
    }))
}

// ================= Tauri IPC Commands =================

/// 将指定本地解析结果目录导入并持久化纳管到应用私有「隐式解析工作区」
#[tauri::command]
pub fn parsed_workspace_import_dir(
    app_handle: AppHandle,
    db_state: tauri::State<'_, DbState>,
    preview_state: tauri::State<'_, ParsedPreviewState>,
    document_id: String,
    source_revision: String,
    source_blocks_path: String,
    provider: String,
) -> Result<ActiveParsedWorkspaceResponse, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 路径失败: {}", e))?;
    let workspace_dir = app_data_dir.join("parsed_workspace");

    let mut conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    import_dir_internal(
        &workspace_dir,
        &mut conn,
        &preview_state,
        &document_id,
        &source_revision,
        &source_blocks_path,
        &provider,
    )
}

/// 查询指定 document_id 当前激活的解析版本，并安全注册读取会话
#[tauri::command]
pub fn parsed_workspace_get_active(
    app_handle: AppHandle,
    db_state: tauri::State<'_, DbState>,
    preview_state: tauri::State<'_, ParsedPreviewState>,
    document_id: String,
) -> Result<Option<ActiveParsedWorkspaceResponse>, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 路径失败: {}", e))?;
    let workspace_dir = app_data_dir.join("parsed_workspace");

    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    get_active_internal(
        &workspace_dir,
        &conn,
        &preview_state,
        &document_id,
    )
}

// ================= 单元测试 =================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn setup_test_env() -> (PathBuf, Connection, ParsedPreviewState) {
        let temp_dir = std::env::temp_dir().join(format!("flowread_ws_test_{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                revision TEXT NOT NULL DEFAULT '',
                last_read_position TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE parsed_document_versions (
                version_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                source_revision TEXT NOT NULL,
                provider TEXT NOT NULL,
                config_signature TEXT NOT NULL,
                storage_rel_path TEXT NOT NULL,
                block_count INTEGER NOT NULL DEFAULT 0,
                asset_count INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_parsed_doc_single_active 
            ON parsed_document_versions(document_id) 
            WHERE is_active = 1;

            CREATE TABLE source_anchors (
                anchor_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                document_revision TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL,
                excerpt TEXT NOT NULL,
                location_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE cards (
                card_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                anchor_id TEXT REFERENCES source_anchors(anchor_id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                depth TEXT NOT NULL DEFAULT 'quick',
                status TEXT NOT NULL DEFAULT 'completed',
                user_prompt TEXT NOT NULL DEFAULT '',
                ai_response TEXT NOT NULL DEFAULT '',
                model_name TEXT NOT NULL DEFAULT '',
                error_message TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE highlights (
                highlight_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                anchor_id TEXT NOT NULL REFERENCES source_anchors(anchor_id) ON DELETE CASCADE,
                color TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE assets (
                asset_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            ",
        ).unwrap();

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES ('doc_123', 'C:\\test\\book.pdf', 'Book.pdf', 1024, 'rev_1', 1000, 1000)",
            [],
        ).unwrap();

        let state = ParsedPreviewState::new();
        (temp_dir, conn, state)
    }

    #[test]
    fn test_import_and_staging_atomicity() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("source_export");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();

        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            r#"[
                {"id":"b1","type":"paragraph","content":"test paragraph"},
                {"id":"b2","type":"image","asset_ref":"assets/fig1.jpg"},
                {"id":"b3","type":"paragraph","content":"refer to ![](assets/fig2.png)"}
            ]"#,
        ).unwrap();

        fs::write(src_dir.join("content.md"), "# Test Markdown").unwrap();
        fs::write(src_dir.join("source-map.json"), "{}").unwrap();
        fs::write(src_assets.join("fig1.jpg"), b"fake_fig1_jpg").unwrap();
        fs::write(src_assets.join("fig2.png"), b"fake_fig2_png").unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");

        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "mineru",
        ).unwrap();

        assert_eq!(res.document_id, "doc_123");
        assert_eq!(res.source_revision, "rev_1");
        assert_eq!(res.block_count, 3);
        assert_eq!(res.asset_count, 2);
        assert_eq!(res.has_assets, true);

        // 验证 staging 暂存区已被彻底清空
        let staging_root = ws_dir.join("staging");
        if staging_root.exists() {
            let entries: Vec<_> = fs::read_dir(&staging_root).unwrap().collect();
            assert!(entries.is_empty(), "staging 目录中不应留有未清理的暂存残留");
        }

        // 验证目标版本目录包含完整文件
        let version_dir = Path::new(&res.doc_dir);
        assert!(version_dir.join("blocks.json").is_file());
        assert!(version_dir.join("manifest.json").is_file());
        assert!(version_dir.join("content.md").is_file());
        assert!(version_dir.join("source-map.json").is_file());
        assert!(version_dir.join("assets").join("fig1.jpg").is_file());
        assert!(version_dir.join("assets").join("fig2.png").is_file());

        // 验证 manifest 结构
        let manifest_str = fs::read_to_string(version_dir.join("manifest.json")).unwrap();
        let manifest: ParsedWorkspaceManifest = serde_json::from_str(&manifest_str).unwrap();
        assert_eq!(manifest.version_id, res.version_id);
        assert_eq!(manifest.block_count, 3);
        assert_eq!(manifest.asset_count, 2);

        // 验证查询激活版本
        let active = get_active_internal(&ws_dir, &conn, &preview_state, "doc_123").unwrap();
        assert!(active.is_some());
        let act = active.unwrap();
        assert_eq!(act.version_id, res.version_id);
        assert_eq!(act.block_count, 3);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_active_version_uniqueness_and_transaction_rollback() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_multi");
        fs::create_dir_all(&src_dir).unwrap();
        let src_blocks = src_dir.join("blocks.json");
        fs::write(&src_blocks, "[{\"id\":\"b1\"}]").unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");

        // 导入版本 1
        let ver1 = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "v1_provider",
        ).unwrap();

        // 导入版本 2
        let ver2 = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_2",
            &src_blocks.to_string_lossy(),
            "v2_provider",
        ).unwrap();

        assert_ne!(ver1.version_id, ver2.version_id);

        // 检查 SQLite 中版本 1 置为 0，版本 2 置为 1
        let v1_active: i64 = conn.query_row(
            "SELECT is_active FROM parsed_document_versions WHERE version_id = ?1",
            [&ver1.version_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(v1_active, 0);

        let v2_active: i64 = conn.query_row(
            "SELECT is_active FROM parsed_document_versions WHERE version_id = ?1",
            [&ver2.version_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(v2_active, 1);

        // 验证单一激活部分唯一索引：尝试强行插入另一个 is_active=1 会被 SQLite 拒绝
        let conflict_res = conn.execute(
            "INSERT INTO parsed_document_versions (version_id, document_id, source_revision, provider, config_signature, storage_rel_path, is_active, created_at)
             VALUES ('ver_conflict', 'doc_123', 'rev_x', 'p', 'sig', 'path', 1, 9999)",
            [],
        );
        assert!(conflict_res.is_err(), "唯一索引必须阻止同一 document_id 存在多个 is_active = 1");

        // 验证事务回滚防护：
        // 针对已存在激活版本的同一文档（doc_123），在 record_parsed_version 插入时触发实际数据库错误
        // 使用 SQLite 触发器拒绝带有特定 provider 的新版本插入
        conn.execute(
            "CREATE TRIGGER test_fail_parsed_insert
             BEFORE INSERT ON parsed_document_versions
             WHEN NEW.provider = 'fail_trigger_provider'
             BEGIN
                 SELECT RAISE(ABORT, 'Simulated DB failure via trigger');
             END;",
            [],
        ).unwrap();

        let trigger_fail_res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_fail",
            &src_blocks.to_string_lossy(),
            "fail_trigger_provider",
        );
        assert!(trigger_fail_res.is_err(), "触发器拒绝插入必须导致导入报错");

        // 验证关键安全断言：
        // 1. 旧激活版本（ver2）必须仍为激活版本且未受任何损坏
        let active = get_active_internal(&ws_dir, &conn, &preview_state, "doc_123").unwrap().unwrap();
        assert_eq!(active.version_id, ver2.version_id);
        let is_act: i64 = conn.query_row(
            "SELECT is_active FROM parsed_document_versions WHERE version_id = ?1",
            [&ver2.version_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(is_act, 1);

        // 2. 旧版本的落盘目录和资产完好无损
        let old_ver_dir = ws_dir.join("documents").join("doc_123").join("versions").join(&ver2.version_id);
        assert!(old_ver_dir.is_dir(), "旧版本目录必须保持完好");
        assert!(old_ver_dir.join("blocks.json").is_file(), "旧版本 blocks.json 必须完好");

        // 3. 本次因 DB 事务失败而撤销的新增版本目录必须被严格清理，不得残留无主脏目录
        let versions_dir = ws_dir.join("documents").join("doc_123").join("versions");
        let version_dirs_count = fs::read_dir(&versions_dir).unwrap().count();
        // 原先有 ver1 和 ver2 两个目录，本次失败的新版本目录被清理后仍然恰好为 2
        assert_eq!(version_dirs_count, 2, "失败的新建版本目录必须已被清理，仅保留原有的两个版本目录");

        // 4. 数据库中记录数量仍为 2，未产生孤立脏记录
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM parsed_document_versions",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 2);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_malicious_asset_traversal_rejected() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_evil_traversal");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();

        // 场景 A: asset_ref 尝试向上跳出 assets/
        let evil_blocks_a = src_dir.join("blocks_evil_a.json");
        fs::write(
            &evil_blocks_a,
            r#"[{"id":"b1","type":"image","asset_ref":"../../secret.png"}]"#,
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let res_a = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &evil_blocks_a.to_string_lossy(),
            "mineru",
        );
        assert!(res_a.is_err());
        assert!(res_a.unwrap_err().contains("包含非法或逃逸的图片资产路径"));

        // 场景 B: content 内的 Markdown 尝试跳出 assets/
        let evil_blocks_b = src_dir.join("blocks_evil_b.json");
        fs::write(
            &evil_blocks_b,
            r#"[{"id":"b2","type":"paragraph","content":"![leak](../../windows/win.ini)"}]"#,
        ).unwrap();

        let res_b = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &evil_blocks_b.to_string_lossy(),
            "mineru",
        );
        assert!(res_b.is_err());

        // 验证 staging 目录被彻底清理
        let staging_root = ws_dir.join("staging");
        if staging_root.exists() {
            let entries: Vec<_> = fs::read_dir(&staging_root).unwrap().collect();
            assert!(entries.is_empty(), "失败后 staging 目录必须为空");
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_malicious_storage_rel_path_rejected() {
        let (temp_dir, conn, preview_state) = setup_test_env();
        let ws_dir = temp_dir.join("parsed_workspace");
        fs::create_dir_all(&ws_dir).unwrap();

        // 模拟数据库中被篡改为越界逃逸路径
        conn.execute(
            "INSERT INTO parsed_document_versions (version_id, document_id, source_revision, provider, config_signature, storage_rel_path, is_active, created_at)
             VALUES ('ver_bad_path', 'doc_123', 'rev_1', 'p', 'sig', '../../windows/system32', 1, 1000)",
            [],
        ).unwrap();

        let res = get_active_internal(&ws_dir, &conn, &preview_state, "doc_123");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("存储相对路径包含非法路径片段"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_symlink_interception() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_symlink");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();

        let secret_file = temp_dir.join("secret_data.txt");
        fs::write(&secret_file, b"sensitive_token").unwrap();

        let src_blocks = src_dir.join("blocks.json");
        fs::write(&src_blocks, "[]").unwrap();

        // 写入普通合法文件
        fs::write(src_assets.join("normal.png"), b"normal_image").unwrap();

        // 尝试创建指向敏感文件的软链接
        #[cfg(windows)]
        let symlink_res = std::os::windows::fs::symlink_file(&secret_file, src_assets.join("symlink.png"));
        #[cfg(unix)]
        let symlink_res = std::os::unix::fs::symlink(&secret_file, src_assets.join("symlink.png"));

        match symlink_res {
            Ok(_) => {
                let ws_dir = temp_dir.join("parsed_workspace");
                let res = import_dir_internal(
                    &ws_dir,
                    &mut conn,
                    &preview_state,
                    "doc_123",
                    "rev_1",
                    &src_blocks.to_string_lossy(),
                    "provider",
                ).unwrap();

                // 软链接必须被拦截，仅普通图片被复制
                assert_eq!(res.asset_count, 1);
                let version_assets = Path::new(&res.doc_dir).join("assets");
                assert!(version_assets.join("normal.png").is_file());
                assert!(!version_assets.join("symlink.png").exists());
            }
            Err(e) => {
                println!(
                    "跳过软链接测试：当前 Windows 环境无管理员/开发者模式权限创建软链接 ({})",
                    e
                );
            }
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_nested_asset_directory_structure_preserved() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_nested");
        let src_assets = src_dir.join("assets");
        let deep_dir = src_assets.join("figures").join("deep");
        fs::create_dir_all(&deep_dir).unwrap();

        fs::write(deep_dir.join("chart.png"), b"deep_chart_bytes").unwrap();

        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            r#"[
                {"id":"b1","type":"image","asset_ref":"assets/figures/deep/chart.png"}
            ]"#,
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        ).unwrap();

        assert_eq!(res.asset_count, 1);
        let deep_target = Path::new(&res.doc_dir)
            .join("assets")
            .join("figures")
            .join("deep")
            .join("chart.png");
        assert!(deep_target.is_file(), "嵌套目录下的 chart.png 必须被完整保留结构复制");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_missing_required_asset_aborts_import() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_missing_asset");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();

        // blocks.json 声明了 missing.jpg，但在源 assets 中不存在
        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            r#"[
                {"id":"b1","type":"image","asset_ref":"assets/missing.jpg"}
            ]"#,
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("缺少必需的本地图片资产: assets/missing.jpg"));

        // 验证 staging 已被清理，且没有在数据库产生记录
        let staging_root = ws_dir.join("staging");
        if staging_root.exists() {
            let entries: Vec<_> = fs::read_dir(&staging_root).unwrap().collect();
            assert!(entries.is_empty());
        }

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM parsed_document_versions",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_invalid_document_id_aborts_import() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_invalid_doc");
        fs::create_dir_all(&src_dir).unwrap();
        let src_blocks = src_dir.join("blocks.json");
        fs::write(&src_blocks, "[]").unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");

        // 1. 特殊字符与路径逃逸字符
        let res1 = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "../doc_evil",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );
        assert!(res1.is_err());
        assert!(res1.unwrap_err().contains("包含非法字符"));

        // 2. 数据库中不存在的 document_id
        let res2 = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_not_in_db",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );
        assert!(res2.is_err());
        assert!(res2.unwrap_err().contains("不存在于 documents 表中"));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_oversized_blocks_count_aborts_import() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_oversized");
        fs::create_dir_all(&src_dir).unwrap();

        // 构造超过 2000 个结构块的 JSON
        let mut blocks = Vec::new();
        for i in 0..2005 {
            blocks.push(serde_json::json!({
                "id": format!("blk_{}", i),
                "type": "paragraph",
                "content": "text"
            }));
        }
        let src_blocks = src_dir.join("blocks.json");
        fs::write(&src_blocks, serde_json::to_string(&blocks).unwrap()).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("超出只读原型承载范围 (上限 2000 块)"));

        // 验证 staging 已被清理
        let staging_root = ws_dir.join("staging");
        if staging_root.exists() {
            let entries: Vec<_> = fs::read_dir(&staging_root).unwrap().collect();
            assert!(entries.is_empty());
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_delete_card_does_not_affect_parsed_workspace_assets() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_card_test");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();
        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            r#"[{"id":"b1","type":"image","asset_ref":"assets/circuit.png"}]"#,
        ).unwrap();
        fs::write(src_assets.join("circuit.png"), b"circuit_image_bytes").unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");

        // 1. 导入解析版本
        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "mineru",
        ).unwrap();

        let circuit_path = Path::new(&res.doc_dir).join("assets").join("circuit.png");
        assert!(circuit_path.is_file(), "工作区图片应正常导入");

        // 2. 创建卡片、锚点与卡片资产
        let card_assets_dir = temp_dir.join("card_assets");
        fs::create_dir_all(&card_assets_dir).unwrap();
        fs::write(card_assets_dir.join("card_clip.png"), b"card_clip_bytes").unwrap();

        conn.execute(
            "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
             VALUES ('anc_1', 'doc_123', 'rev_1', 'pdf_text', 'some excerpt', '{\"pageNumber\":1}', 1000)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, user_prompt, ai_response, created_at, updated_at)
             VALUES ('crd_1', 'doc_123', 'anc_1', 'Ask', 'prompt', 'ans', 1000, 1000)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO assets (asset_id, document_id, file_name, file_path, mime_type, created_at)
             VALUES ('ast_1', 'doc_123', 'card_clip.png', ?1, 'image/png', 1000)",
            [card_assets_dir.join("card_clip.png").to_string_lossy().to_string()],
        ).unwrap();

        // 3. 调用生产真实的 delete_card_internal
        db::delete_card_internal(&conn, &card_assets_dir, "crd_1").unwrap();

        // 4. 关键断言：删除卡片和锚点绝不影响隐式工作区中的 blocks.json 与正文插图
        assert!(circuit_path.is_file(), "删除卡片后，parsed_workspace 中的正文插图必须完好无损！");
        let blocks_path = Path::new(&res.doc_dir).join("blocks.json");
        assert!(blocks_path.is_file(), "删除卡片后，parsed_workspace 中的 blocks.json 必须完好无损！");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_staging_rename_failure_cleanup() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_rename_fail");
        fs::create_dir_all(&src_dir).unwrap();
        let src_blocks = src_dir.join("blocks.json");
        fs::write(&src_blocks, "[]").unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");

        // 制造发布失败条件：在 doc_versions_dir 位置预先创建一个同名普通文件（而非目录），
        // 使目标目录创建或 rename 失败
        let doc_versions_dir = ws_dir.join("documents").join("doc_123").join("versions");
        fs::create_dir_all(doc_versions_dir.parent().unwrap()).unwrap();
        fs::write(&doc_versions_dir, b"blocking_file").unwrap();

        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );

        assert!(res.is_err());
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("创建版本目标目录失败") || err_msg.contains("原子移动"));

        // 验证 staging 临时目录被安全清理
        let staging_root = ws_dir.join("staging");
        if staging_root.exists() {
            let entries: Vec<_> = fs::read_dir(&staging_root).unwrap().collect();
            assert!(entries.is_empty(), "发布失败后 staging 目录必须为空");
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_unicode_kelvin_sign_no_panic() {
        let mut refs = Vec::new();
        // 包含 Kelvin 字符 K (U+212A, 3字节UTF-8)，不应 panic 且能正常提取
        let content = "K<img src=\"assets/kelvin.png\">";
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert_eq!(refs, vec!["kelvin.png"]);
    }

    #[test]
    fn test_code_block_images_ignored() {
        let mut refs = Vec::new();
        let content = r#"
Here is some normal text.

```markdown
![code_image](assets/not_exist_in_fenced.png)
```

And inline code: `![inline](assets/not_exist_in_inline.png)`.

    ![indented](assets/not_exist_in_indented.png)

Finally a real image:
![real](assets/real.png)
"#;
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert_eq!(refs, vec!["real.png"]);
    }

    #[test]
    fn test_markdown_title_and_reference_images() {
        let mut refs = Vec::new();
        let content = r#"
![fig1](assets/diagram1.png "My Diagram 1")
![fig2][ref_label]

[ref_label]: ./assets/diagram2.png "Ref Diagram 2"
"#;
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert!(refs.contains(&"diagram1.png".to_string()));
        assert!(refs.contains(&"diagram2.png".to_string()));
    }

    #[test]
    fn test_html_img_whitespace_and_protocol_relative() {
        let mut refs = Vec::new();
        let content = r#"
<img 
    src = "assets/spaced.png" 
    alt="spaced" />
<img src='assets/single_quoted.png'>
<img src="//cdn.example.com/ext.png">
"#;
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert!(refs.contains(&"spaced.png".to_string()));
        assert!(refs.contains(&"single_quoted.png".to_string()));
        // 外部 CDN 不应作为本地资产
        assert!(!refs.iter().any(|r| r.contains("ext.png")));
    }

    #[test]
    fn test_import_and_read_asset_e2e() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_e2e_read");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();

        fs::write(src_assets.join("circuit.png"), b"e2e_circuit_bytes").unwrap();
        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            r#"[{"id":"b1","type":"image","asset_ref":"assets/circuit.png"}]"#,
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let resp = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "mineru",
        ).unwrap();

        // 关键断言：导入后直接通过返回的 session_id 读取各种形式的相对引用
        let bytes1 = crate::parsed_preview::read_asset_internal(
            &resp.session_id,
            "assets/circuit.png",
            &preview_state.sessions,
        ).unwrap();
        assert_eq!(bytes1, b"e2e_circuit_bytes");

        let bytes2 = crate::parsed_preview::read_asset_internal(
            &resp.session_id,
            "./assets/circuit.png",
            &preview_state.sessions,
        ).unwrap();
        assert_eq!(bytes2, b"e2e_circuit_bytes");

        let bytes3 = crate::parsed_preview::read_asset_internal(
            &resp.session_id,
            "circuit.png",
            &preview_state.sessions,
        ).unwrap();
        assert_eq!(bytes3, b"e2e_circuit_bytes");

        let bytes4 = crate::parsed_preview::read_asset_internal(
            &resp.session_id,
            "./circuit.png",
            &preview_state.sessions,
        ).unwrap();
        assert_eq!(bytes4, b"e2e_circuit_bytes");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_consecutive_indented_code_ignored() {
        let mut refs = Vec::new();
        let content = "Normal text.\n\n    first line of indented code\n    ![code image](missing.png)\n\nAfter code block text.\n![real](assets/real.png)\n";
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert!(!refs.iter().any(|r| r.contains("missing.png")));
        assert_eq!(refs, vec!["real.png"]);

        // 端到端导入测试：确保因代码块缺图不会导致 import_dir_internal 报错
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_indented_code");
        let src_assets = src_dir.join("assets");
        fs::create_dir_all(&src_assets).unwrap();
        fs::write(src_assets.join("real.png"), b"real_bytes").unwrap();

        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            serde_json::json!([
                {
                    "id": "b1",
                    "type": "paragraph",
                    "content": content
                }
            ]).to_string(),
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let res = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        );
        assert!(res.is_ok(), "代码示例缺图不应阻断导入: {:?}", res.err());
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_multi_backtick_inline_code_span() {
        let mut refs = Vec::new();
        let content = r#"
Here is double backtick code: ``![fake](fake1.png)``.
Here is double backtick containing a single backtick: ``code ` with backtick and ![fake](fake2.png)``.
Here is single backtick code: `![fake](fake3.png)`.
Outside code, real image:
![real](assets/real_multi_bt.png)
"#;
        extract_image_refs_from_content(content, &mut refs).unwrap();
        assert!(!refs.iter().any(|r| r.contains("fake1.png")));
        assert!(!refs.iter().any(|r| r.contains("fake2.png")));
        assert!(!refs.iter().any(|r| r.contains("fake3.png")));
        assert_eq!(refs, vec!["real_multi_bt.png"]);
    }

    #[test]
    fn test_unquoted_html_img_src_not_truncated_at_slash() {
        let (temp_dir, mut conn, preview_state) = setup_test_env();
        let src_dir = temp_dir.join("src_unquoted_img");
        let src_assets = src_dir.join("assets");
        let sub_dir = src_assets.join("sub");
        fs::create_dir_all(&sub_dir).unwrap();

        fs::write(sub_dir.join("a.png"), b"sub_a_bytes").unwrap();

        // 1. 测试提取: <img src=sub/a.png>, <img src=https://example.com/a.png>
        let mut refs = Vec::new();
        let html_content = r#"
<p><img src=sub/a.png></p>
<p><img src=https://example.com/a.png></p>
"#;
        extract_image_refs_from_content(html_content, &mut refs).unwrap();
        assert_eq!(refs, vec!["sub/a.png"]);

        // 2. 端到端测试: <img src=sub/a.png> 正确导入并通过 session 读取
        let src_blocks = src_dir.join("blocks.json");
        fs::write(
            &src_blocks,
            serde_json::json!([
                {
                    "id": "b1",
                    "type": "paragraph",
                    "content": "<img src=sub/a.png>"
                }
            ]).to_string(),
        ).unwrap();

        let ws_dir = temp_dir.join("parsed_workspace");
        let resp = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_1",
            &src_blocks.to_string_lossy(),
            "provider",
        ).unwrap();

        let read_bytes = crate::parsed_preview::read_asset_internal(
            &resp.session_id,
            "sub/a.png",
            &preview_state.sessions,
        ).unwrap();
        assert_eq!(read_bytes, b"sub_a_bytes");

        // 3. 测试 <img src=assets/a.png>: 当文件缺失时导入失败，旧激活版本保持可用
        let src_dir_missing = temp_dir.join("src_unquoted_missing");
        let src_assets_missing = src_dir_missing.join("assets");
        fs::create_dir_all(&src_assets_missing).unwrap();
        let src_blocks_missing = src_dir_missing.join("blocks.json");
        fs::write(
            &src_blocks_missing,
            serde_json::json!([
                {
                    "id": "b2",
                    "type": "paragraph",
                    "content": "<img src=assets/a.png>"
                }
            ]).to_string(),
        ).unwrap();

        let res_missing = import_dir_internal(
            &ws_dir,
            &mut conn,
            &preview_state,
            "doc_123",
            "rev_2",
            &src_blocks_missing.to_string_lossy(),
            "provider",
        );
        assert!(res_missing.is_err());
        assert!(res_missing.unwrap_err().contains("缺少必需的本地图片资产: assets/a.png"));

        // 验证旧激活版本仍然可用
        let active_opt = get_active_internal(&ws_dir, &conn, &preview_state, "doc_123").unwrap();
        assert!(active_opt.is_some());
        assert_eq!(active_opt.unwrap().version_id, resp.version_id);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
