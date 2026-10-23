use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_BLOCKS_COUNT: usize = 2000;
pub const MAX_ZIP_ENTRIES: usize = 5000;
pub const MAX_ZIP_TOTAL_BYTES: u64 = 200 * 1024 * 1024; // 200MB
pub const MAX_ZIP_SINGLE_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100MB

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InlineRun {
    pub r#type: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedBlock {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_type: Option<String>,
    pub reading_order: i64,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_runs: Option<Vec<InlineRun>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    /// 表格/插图脚注（MinerU table_footnote / image_footnote / chart_footnote）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footnote: Option<String>,
    /// 标题层级（MinerU v2 content.level；1 为章级、2 为节级）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_level: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub in_image_text: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_sample: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_source: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_bbox: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_bbox: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pt_bbox: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate_system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_node: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseDiagnostics {
    pub provider: String,
    pub total_blocks: usize,
    pub normalized_body_blocks: usize,
    pub formulas_count: usize,
    pub tables_count: usize,
    pub images_count: usize,
    pub total_asset_files: usize,
    pub missing_images: Vec<String>,
    pub warnings: Vec<String>,
    pub failed_pages: Vec<serde_json::Value>,
}

// ================= Coordinate Normalization =================

pub fn normalize_bbox_grid_1000(raw_bbox: &[f64]) -> Option<[f64; 4]> {
    if raw_bbox.len() != 4 {
        return None;
    }
    let x0 = raw_bbox[0];
    let y0 = raw_bbox[1];
    let x1 = raw_bbox[2];
    let y1 = raw_bbox[3];

    // 拒绝反向或退化坐标 (x1 <= x0 || y1 <= y0)
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    // 范围合理性校验 [0..1000.5]
    if x0 < 0.0 || y0 < 0.0 || x1 > 1000.5 || y1 > 1000.5 {
        return None;
    }

    let norm_x0 = (x0 / 1000.0).clamp(0.0, 1.0);
    let norm_y0 = (y0 / 1000.0).clamp(0.0, 1.0);
    let norm_x1 = (x1 / 1000.0).clamp(0.0, 1.0);
    let norm_y1 = (y1 / 1000.0).clamp(0.0, 1.0);

    Some([
        (norm_x0 * 100000.0).round() / 100000.0,
        (norm_y0 * 100000.0).round() / 100000.0,
        (norm_x1 * 100000.0).round() / 100000.0,
        (norm_y1 * 100000.0).round() / 100000.0,
    ])
}

pub fn normalize_bbox_pixel(raw_bbox: &[f64], page_w: f64, page_h: f64) -> Option<[f64; 4]> {
    if raw_bbox.len() != 4 || page_w <= 0.0 || page_h <= 0.0 {
        return None;
    }
    let x0 = raw_bbox[0];
    let y0 = raw_bbox[1];
    let x1 = raw_bbox[2];
    let y1 = raw_bbox[3];

    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    if x0 < 0.0 || y0 < 0.0 || x1 > page_w * 1.05 || y1 > page_h * 1.05 {
        return None;
    }

    let norm_x0 = (x0 / page_w).clamp(0.0, 1.0);
    let norm_y0 = (y0 / page_h).clamp(0.0, 1.0);
    let norm_x1 = (x1 / page_w).clamp(0.0, 1.0);
    let norm_y1 = (y1 / page_h).clamp(0.0, 1.0);

    Some([
        (norm_x0 * 100000.0).round() / 100000.0,
        (norm_y0 * 100000.0).round() / 100000.0,
        (norm_x1 * 100000.0).round() / 100000.0,
        (norm_y1 * 100000.0).round() / 100000.0,
    ])
}

// ================= Continuous Markdown Builder =================

pub fn build_continuous_markdown(blocks: &[ParsedBlock]) -> String {
    let mut sections = Vec::new();
    for b in blocks {
        let b_type = b.r#type.as_str();
        if matches!(
            b_type,
            "page_header" | "page_number" | "page_footer" | "PageHeader" | "PageFooter" | "PageNumber"
        ) {
            continue;
        }

        let content = b.content.trim();
        let asset_ref = b.asset_ref.as_deref();
        let caption = b.caption.as_deref().unwrap_or("").trim();
        let footnote = b.footnote.as_deref().unwrap_or("").trim();

        match b_type {
            "heading" => {
                if !content.is_empty() {
                    // v2 标题内容自带 Markdown 层级前缀（如 "## 4.5.3 ..."），不得二次加前缀
                    if has_markdown_heading_prefix(content) {
                        sections.push(content.to_string());
                    } else {
                        sections.push(format!("## {}", content));
                    }
                }
            }
            "formula" => {
                if !content.is_empty() {
                    if content.starts_with("$$") && content.ends_with("$$") {
                        sections.push(content.to_string());
                    } else {
                        sections.push(format!("$$\n{}\n$$", content));
                    }
                }
            }
            "image" => {
                let mut img_parts = Vec::new();
                if let Some(ref_path) = asset_ref {
                    let alt_text = if !caption.is_empty() { caption } else { ref_path };
                    img_parts.push(format!("![{}](assets/{})", alt_text, ref_path));
                }
                if !caption.is_empty() {
                    img_parts.push(format!("*{}*", caption));
                }
                if !footnote.is_empty() {
                    img_parts.push(format!("*{}*", footnote));
                }
                if !img_parts.is_empty() {
                    sections.push(img_parts.join("\n\n"));
                }
            }
            "table" => {
                // 表格：图注在上、结构正文居中、脚注在下；不得只输出表格而丢图注脚注
                if content.is_empty() && caption.is_empty() && footnote.is_empty() {
                    // 完全空表格（结构缺失且无备援）：保留占位诊断，避免静默消失
                    sections.push("<!-- 表格内容为空：结构 HTML 与图注均缺失 -->".to_string());
                } else {
                    let mut parts = Vec::new();
                    if !caption.is_empty() {
                        parts.push(format!("*{}*", caption));
                    }
                    if !content.is_empty() {
                        parts.push(content.to_string());
                    }
                    if !footnote.is_empty() {
                        parts.push(format!("*{}*", footnote));
                    }
                    sections.push(parts.join("\n\n"));
                }
            }
            "caption" => {
                if !content.is_empty() {
                    sections.push(format!("*{}*", content));
                }
            }
            _ => {
                if !content.is_empty() {
                    sections.push(content.to_string());
                }
            }
        }
    }

    if sections.is_empty() {
        String::new()
    } else {
        format!("{}\n", sections.join("\n\n"))
    }
}

// ================= Safe ZIP Extraction =================

pub fn safe_extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("创建解压目录失败: {}", e))?;
    let canonical_dest = dest_dir
        .canonicalize()
        .map_err(|e| format!("解析解压目标目录失败: {}", e))?;

    let file = File::open(zip_path).map_err(|e| format!("打开 ZIP 文件失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 文件失败: {}", e))?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!(
            "ZIP 条目数 ({}) 超过安全上限 ({})",
            archive.len(),
            MAX_ZIP_ENTRIES
        ));
    }

    let mut extracted_files = Vec::new();
    let mut total_decompressed_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目 #{} 失败: {}", i, e))?;

        let entry_name = entry.name().to_string();

        // 严格防御路径穿越与非法前缀
        if entry_name.contains("..")
            || entry_name.starts_with('/')
            || entry_name.starts_with('\\')
            || (entry_name.len() >= 2 && entry_name.chars().nth(1) == Some(':'))
        {
            return Err(format!("ZIP 条目包含非法路径穿越片段: {}", entry_name));
        }

        let rel_path = Path::new(&entry_name);
        for comp in rel_path.components() {
            if !matches!(comp, std::path::Component::Normal(_)) {
                return Err(format!("ZIP 条目包含非常规路径组件: {}", entry_name));
            }
        }

        let target_path = canonical_dest.join(rel_path);

        if entry.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("创建 ZIP 子目录失败: {}", e))?;
            continue;
        }

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标父目录失败: {}", e))?;
        }

        let entry_size = entry.size();
        if entry_size > MAX_ZIP_SINGLE_FILE_BYTES {
            return Err(format!(
                "ZIP 条目 '{}' 解压后大小 ({} 字节) 超出单个条目上限",
                entry_name, entry_size
            ));
        }

        total_decompressed_bytes += entry_size;
        if total_decompressed_bytes > MAX_ZIP_TOTAL_BYTES {
            return Err(format!(
                "ZIP 解压总大小 ({} 字节) 超出安全上限 ({} 字节)",
                total_decompressed_bytes, MAX_ZIP_TOTAL_BYTES
            ));
        }

        let mut outfile = File::create(&target_path)
            .map_err(|e| format!("创建解压目标文件失败: {}", e))?;

        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| format!("写入解压数据失败 ({}): {}", entry_name, e))?;

        // 校验目标路径不越界
        if let Ok(c) = target_path.canonicalize() {
            if !c.starts_with(&canonical_dest) {
                let _ = fs::remove_file(&target_path);
                return Err(format!("ZIP 条目越界逃逸: {}", entry_name));
            }
        }

        extracted_files.push(target_path);
    }

    Ok(extracted_files)
}

// ================= Image Collection and Deduplication =================

/// 图片引用映射：同时保留“相对路径身份”和“文件名别名”，
/// 内容哈希只用于去重，不能用它代替引用身份。
#[derive(Debug, Default, Clone)]
pub struct ImageAssetMap {
    by_rel: HashMap<String, String>,
    by_basename: HashMap<String, Vec<String>>,
}

impl ImageAssetMap {
    pub fn len(&self) -> usize {
        self.by_rel.len()
    }

    /// 解析正文中的图片引用：
    /// 1. 完整相对路径精确匹配；
    /// 2. 直接给出 assets 内的文件名；
    /// 3. 只有文件名且唯一时才允许回退；多个候选视为歧义并报错，绝不随便选一张。
    pub fn resolve(&self, raw_ref: &str) -> Result<String, String> {
        let normalized = normalize_image_ref(raw_ref);
        if normalized.is_empty() {
            return Err("图片引用为空".to_string());
        }
        if let Some(asset) = self.by_rel.get(&normalized) {
            return Ok(asset.clone());
        }
        let base = Path::new(&normalized)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&normalized)
            .to_string();

        match self.by_basename.get(&base) {
            Some(candidates) if candidates.len() == 1 => self
                .by_rel
                .get(&candidates[0])
                .cloned()
                .ok_or_else(|| format!("图片引用无法解析: {}", raw_ref)),
            Some(candidates) if candidates.len() > 1 => Err(format!(
                "图片引用存在歧义：'{}' 同时匹配 {}，请使用完整相对路径",
                raw_ref,
                candidates.join(", ")
            )),
            _ => Err(format!("缺少必需的本地图片资产: {}", raw_ref)),
        }
    }
}

fn normalize_image_ref(raw: &str) -> String {
    let mut value = raw.trim().replace('\\', "/");
    while let Some(rest) = value.strip_prefix("./") {
        value = rest.to_string();
    }
    if let Some(rest) = value.strip_prefix("assets/") {
        value = rest.to_string();
    }
    value
}

pub fn collect_and_copy_images(
    search_root: &Path,
    assets_dest: &Path,
) -> Result<(ImageAssetMap, usize), String> {
    fs::create_dir_all(assets_dest)
        .map_err(|e| format!("创建 assets 目录失败: {}", e))?;

    let allowed_exts = ["png", "jpg", "jpeg", "webp", "svg", "gif"];
    let mut map = ImageAssetMap::default();
    let mut file_hashes: HashMap<String, String> = HashMap::new(); // hash -> asset filename
    let mut total_copied = 0;

    // 先收集全部候选文件（稳定排序，避免不同文件系统顺序导致映射漂移）
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();
    fn walk(
        current: &Path,
        root: &Path,
        assets_dest: &Path,
        allowed_exts: &[&str],
        out: &mut Vec<(String, PathBuf)>,
    ) {
        let entries = match fs::read_dir(current) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path != assets_dest {
                    walk(&path, root, assets_dest, allowed_exts, out);
                }
            } else if path.is_file() {
                // 与工作区导入保持一致：符号链接一律不复制
                if fs::symlink_metadata(&path)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    continue;
                }
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !allowed_exts.contains(&ext.as_str()) {
                    continue;
                }
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if !rel.is_empty() {
                    out.push((rel, path));
                }
            }
        }
    }

    walk(search_root, search_root, assets_dest, &allowed_exts, &mut candidates);
    candidates.sort_by(|a, b| a.0.cmp(&b.0));

    for (rel, path) in candidates {
        let basename = Path::new(&rel)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if basename.is_empty() {
            continue;
        }

        // 流式计算哈希，避免整张图片读入内存
        let mut hasher = Sha256::new();
        {
            let mut f = File::open(&path)
                .map_err(|e| format!("打开图片资产失败 ({}): {}", rel, e))?;
            let mut buffer = [0u8; 65536];
            loop {
                let n = f
                    .read(&mut buffer)
                    .map_err(|e| format!("读取图片资产失败 ({}): {}", rel, e))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
            }
        }
        let hash_str = format!("{:x}", hasher.finalize());

        map.by_basename
            .entry(basename.clone())
            .or_default()
            .push(rel.clone());

        if let Some(existing) = file_hashes.get(&hash_str) {
            map.by_rel.insert(rel.clone(), existing.clone());
            if let Some(stripped) = rel.strip_prefix("images/") {
                map.by_rel.entry(stripped.to_string()).or_insert_with(|| existing.clone());
            }
            continue;
        }

        let mut target_name = basename.clone();
        if assets_dest.join(&target_name).exists() {
            let stem = Path::new(&basename)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image");
            let ext = Path::new(&basename)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("png");
            let mut counter = 2;
            loop {
                let candidate = format!("{}_{}.{}", stem, counter, ext);
                if !assets_dest.join(&candidate).exists() {
                    target_name = candidate;
                    break;
                }
                counter += 1;
            }
        }

        fs::copy(&path, assets_dest.join(&target_name))
            .map_err(|e| format!("复制图片资产失败 ({}): {}", rel, e))?;

        file_hashes.insert(hash_str, target_name.clone());
        map.by_rel.insert(rel.clone(), target_name.clone());
        if let Some(stripped) = rel.strip_prefix("images/") {
            map.by_rel.entry(stripped.to_string()).or_insert_with(|| target_name.clone());
        }
        total_copied += 1;
    }

    Ok((map, total_copied))
}

/// 解码 Datalab HTML 中的常见实体（公式里的 `&amp;` 必须还原成 `&`）。
fn decode_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// 对普通正文中的 HTML 实体进行安全解码：
/// 解码 &quot;, &#39;, &nbsp; 等，但保留 &lt; 与 &gt; 为 HTML 实体，
/// 确保传给下游 Markdown/HTML 阅读器时能够正确渲染为字符 `<` 与 `>`，
/// 而不会被当作 HTML 元素解析或丢弃（例如 &lt;node&gt; 若过早解码为 <node>，进入阅读器会被视为未知 HTML 标签而消失）。
fn decode_safe_text_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        if rest.starts_with("&lt;") {
            out.push_str("&lt;");
            i += 4;
        } else if rest.starts_with("&gt;") {
            out.push_str("&gt;");
            i += 4;
        } else if rest.starts_with("&quot;") {
            out.push('"');
            i += 6;
        } else if rest.starts_with("&#39;") {
            out.push('\'');
            i += 5;
        } else if rest.starts_with("&nbsp;") {
            out.push(' ');
            i += 6;
        } else if rest.starts_with("&amp;") {
            out.push('&');
            i += 5;
        } else {
            let ch = rest.chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// 处理 HTML 格式文本块中的数学公式与标签：
/// 1. 提取所有 <math>...</math>，其内部解码 HTML 实体（如 &lt; -> <, &amp; -> &），并替换为唯一的非标签占位符；
/// 2. 对外部 HTML 结构执行标签剥离（如 <p>, <div>, <b> 等），保留 &lt;node&gt; 等字面量实体不被破坏；
/// 3. 对剥离标签后的普通文本进行安全实体解码；
/// 4. 还原公式占位符为 $...$（公式源码不经过任何删除 HTML 标签的正则）。
fn process_html_text_and_math(
    html: &str,
    math_re: &regex::Regex,
    strip_tag_re: &regex::Regex,
) -> (String, Vec<(String, String)>) {
    let mut math_items: Vec<(String, String)> = Vec::new();

    let with_placeholders = math_re
        .replace_all(html, |caps: &regex::Captures| {
            let inner = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            let formula = decode_html_entities(inner);
            let placeholder = format!("\u{E000}MATH_FR_{}\u{E001}", math_items.len());
            math_items.push((placeholder.clone(), formula));
            format!(" {} ", placeholder)
        })
        .to_string();

    let stripped = strip_tag_re.replace_all(&with_placeholders, "").to_string();
    let mut text_cleaned = decode_safe_text_entities(&stripped);

    for (ph, formula) in &math_items {
        text_cleaned = text_cleaned.replace(ph, &format!("${}$", formula));
    }

    (text_cleaned.trim().to_string(), math_items)
}


/// 从 HTML 片段中取第一个 `<img src="...">` 引用。
fn extract_img_src(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(pos) = lower[cursor..].find("<img") {
        let start = cursor + pos;
        let rest = &html[start..];
        let rest_lower = &lower[start..];
        let tag_end = rest_lower.find('>')?;
        let tag = &rest[..tag_end];
        let tag_lower = &rest_lower[..tag_end];
        if let Some(src_pos) = tag_lower.find("src=") {
            let after = &tag[src_pos + 4..];
            let after = after.trim_start();
            let value = if let Some(stripped) = after.strip_prefix('"') {
                stripped.split('"').next().unwrap_or("")
            } else if let Some(stripped) = after.strip_prefix('\'') {
                stripped.split('\'').next().unwrap_or("")
            } else {
                after.split_whitespace().next().unwrap_or("")
            };
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        cursor = start + tag_end + 1;
        if cursor >= html.len() {
            break;
        }
    }
    None
}

/// 有效内容检查：不能把“块很多但全是空内容”当成成功，同时兼容整页只有图片的正常文档。
fn ensure_meaningful_content(provider: &str, blocks: &[ParsedBlock]) -> Result<(), String> {
    let body_like = blocks
        .iter()
        .filter(|b| {
            matches!(
                b.r#type.as_str(),
                "paragraph" | "heading" | "formula" | "table" | "caption"
            )
        })
        .count();
    let has_text = blocks.iter().any(|b| {
        !b.content.trim().is_empty() && !b.content.trim_start().starts_with("<!-- 未识别结构")
    });
    let has_image = blocks
        .iter()
        .any(|b| b.r#type == "image" && b.asset_ref.is_some());

    if body_like == 0 && !has_image {
        return Err(format!(
            "{} 结果没有可阅读的正文或图片块（仅页眉页脚或空块），不能视为解析成功",
            provider
        ));
    }
    if !has_text && !has_image {
        return Err(format!(
            "{} 结果的所有结构块内容均为空，不能视为完整解析",
            provider
        ));
    }
    Ok(())
}

// ================= MinerU Normalization =================

/// 在目录中递归查找指定后缀名的 JSON 文件（不区分 UUID 前缀文件名）
fn find_json_with_suffix(dir: &Path, target_suffix: &str) -> Option<PathBuf> {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(found) = find_json_with_suffix(&p, target_suffix) {
                    return Some(found);
                }
            } else if p.is_file() {
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name.ends_with(target_suffix) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// 定位 MinerU 结构文件：优先 content_list_v2.json，其次 content_list.json。
/// model.json 是版面检测原始输出（layout_dets/page_info），
/// 绝不是 content_list 的等价物，不得仅凭文件名回退使用。
/// 生产归一化与离线回放必须共用本函数，保证选文件逻辑只有一份。
pub fn find_mineru_content_list_file(search_root: &Path) -> Option<PathBuf> {
    find_json_with_suffix(search_root, "content_list_v2.json")
        .or_else(|| find_json_with_suffix(search_root, "content_list.json"))
}

/// 依据真实产物结构识别 v2：
/// - 顶层为二维数组（每页一个块数组），或
/// - 平铺数组中存在 content 为 JSON 对象的块（v2 块正文均为 content 对象，v1 均为字符串字段）
pub fn detect_mineru_v2(top_array: &[serde_json::Value]) -> bool {
    if top_array.iter().any(|p| p.is_array()) {
        return true;
    }
    top_array
        .iter()
        .any(|item| item.get("content").map(|c| c.is_object()).unwrap_or(false))
}

/// MinerU v2 结构块 content 内 runs 数组的公共形状：
/// `[{ "type": "text" | "equation_inline", "content": "..." }, ...]`
/// 文本 run 直接拼接；行内公式 run 包装为 `$...$` 供阅读器渲染。
/// 离线回放的“期望文本”基线必须复用本函数，保证对账与生产拼接语义一致。
pub fn mineru_v2_runs_to_text(runs: &[serde_json::Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for run in runs {
        let r_type = run
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("text");
        let r_content = run
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if r_content.is_empty() {
            continue;
        }
        if r_type == "equation_inline" || r_type == "equation" || r_type == "math" {
            let trimmed = r_content.trim();
            if trimmed.starts_with('$') && trimmed.ends_with('$') && trimmed.len() >= 2 {
                parts.push(format!(" {} ", trimmed));
            } else {
                parts.push(format!(" ${}$ ", trimmed));
            }
        } else {
            parts.push(r_content.to_string());
        }
    }
    parts.join("")
}

/// 读取 v2 content 对象中的图注/脚注字段（runs 数组），返回非空拼接文本
fn mineru_v2_runs_field(
    content_obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    let runs = content_obj.get(key)?.as_array()?;
    let joined = mineru_v2_runs_to_text(runs);
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 读取 v2 content 对象中的 image_source.path（图片/表格截图/公式源图引用）
fn mineru_v2_image_source_path(
    content_obj: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    content_obj
        .get("image_source")
        .and_then(|v| v.get("path"))
        .and_then(|p| p.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// v1 content_list 中图注/脚注字段为纯字符串数组：`["Fig. ..."]`
fn mineru_v1_string_list(item: &serde_json::Value, key: &str) -> Option<String> {
    let arr = item.get(key)?.as_array()?;
    let joined = arr
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<&str>>()
        .join(" ");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// v1 块的图片引用：img_path 字段（images/xxx.jpg）
fn mineru_v1_img_path(item: &serde_json::Value) -> Option<String> {
    item.get("img_path")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 对未识别结构块的兜底文本提取：从任意 JSON 值中收集字符串，
/// 用于诊断展示，避免整类内容静默消失。限制深度防止病态嵌套。
fn mineru_collect_diagnostic_text(value: &serde_json::Value, depth: usize, out: &mut String) {
    if depth > 4 || out.len() > 2000 {
        return;
    }
    match value {
        serde_json::Value::String(s) => {
            if !s.trim().is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s.trim());
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                mineru_collect_diagnostic_text(v, depth + 1, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == "bbox" || k == "image_source" {
                    continue;
                }
                mineru_collect_diagnostic_text(v, depth + 1, out);
            }
        }
        _ => {}
    }
}

/// 标题块内容是否已带 Markdown 层级前缀（如 "## 4.5.3 ..."），
/// 用于 build_continuous_markdown 避免二次加前缀。
fn has_markdown_heading_prefix(content: &str) -> bool {
    let trimmed = content.trim_start();
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ')
}

pub fn normalize_mineru_results(
    raw_dir: &Path,
    normalized_dir: &Path,
) -> Result<ParseDiagnostics, String> {
    let assets_dir = normalized_dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("创建 normalized/assets 失败: {}", e))?;

    let search_root = if raw_dir.join("extracted").is_dir() {
        raw_dir.join("extracted")
    } else {
        raw_dir.to_path_buf()
    };

    // 1. 复制所有图片到 assets/（原始资产一律保留，图片是否引用以结构化字段为准）
    let (image_mapping, total_asset_files) = collect_and_copy_images(&search_root, &assets_dir)?;

    // 2. 查找结构文件：优先 content_list_v2.json，其次 content_list.json。
    //    model.json 是版面检测原始输出（layout_dets/page_info），
    //    不是 content_list 的等价物，绝不能仅凭文件名回退使用。
    let json_file = find_mineru_content_list_file(&search_root).ok_or_else(|| {
        "MinerU 原始输出中未找到 content_list.json 或 content_list_v2.json 结构文件 \
         (model.json 是版面检测原始输出，不能作为 content_list 的回退)"
            .to_string()
    })?;

    let raw_json_str = fs::read_to_string(&json_file)
        .map_err(|e| format!("读取 MinerU JSON 文件失败: {}", e))?;
    let parsed_json: serde_json::Value = serde_json::from_str(&raw_json_str)
        .map_err(|e| format!("MinerU 结构文件语法错误: {}", e))?;

    let top_array = parsed_json
        .as_array()
        .ok_or_else(|| "MinerU 结构文件顶层必须为块数组（v1）或按页分组的二维数组（v2）".to_string())?;

    // 3. 依据真实结构识别 v1/v2：
    //    - v2: 顶层为二维数组（每页一个块数组）；或平铺数组中存在 content 为对象的块
    //    - v1: 平铺数组，块字段为 text/img_path/table_body 等纯字符串
    let nested_v2 = top_array.iter().any(|p| p.is_array());
    let flat_v2 = !nested_v2 && detect_mineru_v2(top_array);

    let mut raw_items: Vec<(usize, serde_json::Value, bool)> = Vec::new(); // (页码, 块, is_v2)

    if nested_v2 {
        for (p_idx, p_val) in top_array.iter().enumerate() {
            if let Some(blocks_arr) = p_val.as_array() {
                for b in blocks_arr {
                    raw_items.push((p_idx + 1, b.clone(), true));
                }
            }
        }
    } else if flat_v2 {
        for item in top_array {
            let p_idx = item
                .get("page_idx")
                .and_then(|v| v.as_i64())
                .map(|v| (v + 1) as usize)
                .unwrap_or(1);
            raw_items.push((p_idx, item.clone(), true));
        }
    } else {
        for item in top_array {
            let p_idx = item
                .get("page_idx")
                .and_then(|v| v.as_i64())
                .map(|v| (v + 1) as usize)
                .unwrap_or(1);
            raw_items.push((p_idx, item.clone(), false));
        }
    }

    let mut blocks: Vec<ParsedBlock> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut reading_order = 1i64;

    for (page_num, item, is_v2) in raw_items {
        let raw_type = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let raw_bbox: Option<Vec<f64>> = item.get("bbox").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|val| val.as_f64())
                    .collect::<Vec<f64>>()
            })
        });

        let norm_bbox = raw_bbox
            .as_ref()
            .and_then(|bb| normalize_bbox_grid_1000(bb));

        let mut content_text = String::new();
        let mut content_format = "markdown".to_string();
        let mut inline_runs: Option<Vec<InlineRun>> = None;
        let mut asset_ref: Option<String> = None;
        let mut caption: Option<String> = None;
        let mut footnote: Option<String> = None;
        let mut heading_level: Option<i64> = None;

        // 解析图片引用（失败必须明确报错，不能静默丢图）
        let resolve_asset = |img_path: &str| -> Result<String, String> {
            image_mapping.resolve(img_path).map_err(|e| {
                format!("MinerU 图片引用无法解析 ({}): {}", img_path, e)
            })
        };

        if is_v2 {
            let c_obj = item
                .get("content")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();

            match raw_type.as_str() {
                // v2 标题：文字位于 content.title_content（runs 数组），层级位于 content.level
                "title" | "heading" => {
                    if let Some(runs) = c_obj.get("title_content").and_then(|v| v.as_array()) {
                        content_text = mineru_v2_runs_to_text(runs).trim().to_string();
                    }
                    if content_text.is_empty() {
                        warnings.push(format!(
                            "MinerU v2 标题块 (页 {}, 块 #{}) 缺少 title_content 文字",
                            page_num, reading_order
                        ));
                    }
                    if let Some(level) = c_obj.get("level").and_then(|v| v.as_i64()) {
                        heading_level = Some(level);
                        // 层级信息以 Markdown 前缀承载，现有阅读器 (ReactMarkdown) 可直接按 h1-h6 渲染
                        if (1..=6).contains(&level) {
                            content_text = format!(
                                "{} {}",
                                "#".repeat(level as usize),
                                content_text
                            );
                        }
                    }
                }
                // v2 段落：content.paragraph_content 为 runs 数组，保留行内公式顺序
                "paragraph" | "text" => {
                    if let Some(p_content) =
                        c_obj.get("paragraph_content").and_then(|v| v.as_array())
                    {
                        let mut runs = Vec::new();
                        let mut text_parts = Vec::new();
                        for run_val in p_content {
                            let r_type = run_val
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("text")
                                .to_string();
                            let r_content = run_val
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();

                            runs.push(InlineRun {
                                r#type: r_type.clone(),
                                content: r_content.clone(),
                            });

                            if r_type == "equation_inline" {
                                let math_trimmed = r_content.trim();
                                if math_trimmed.starts_with('$')
                                    && math_trimmed.ends_with('$')
                                {
                                    text_parts.push(format!(" {} ", math_trimmed));
                                } else {
                                    text_parts.push(format!(" ${}$ ", math_trimmed));
                                }
                            } else {
                                text_parts.push(r_content);
                            }
                        }
                        content_text = text_parts.join("");
                        inline_runs = Some(runs);
                    } else {
                        warnings.push(format!(
                            "MinerU v2 段落块 (页 {}, 块 #{}) 缺少 paragraph_content，内容为空",
                            page_num, reading_order
                        ));
                    }
                }
                // v2 独立公式：content.math_content (LaTeX 源码) + image_source (公式截图备援)
                t if t.contains("equation") || t.contains("formula") => {
                    content_text = c_obj
                        .get("math_content")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    content_format = "latex".to_string();
                    if content_text.is_empty() {
                        warnings.push(format!(
                            "MinerU v2 公式块 (页 {}, 块 #{}) 缺少 math_content 源码",
                            page_num, reading_order
                        ));
                    }
                    if let Some(img_path) = mineru_v2_image_source_path(&c_obj) {
                        asset_ref = Some(resolve_asset(&img_path)?);
                    }
                }
                // v2 插图/图表：content.image_source.path + 图注/脚注 runs
                "image" | "chart" | "figure" => {
                    let caps_key = match raw_type.as_str() {
                        "chart" => "chart_caption",
                        _ => "image_caption",
                    };
                    let foot_key = match raw_type.as_str() {
                        "chart" => "chart_footnote",
                        _ => "image_footnote",
                    };
                    caption = mineru_v2_runs_field(&c_obj, caps_key);
                    footnote = mineru_v2_runs_field(&c_obj, foot_key);
                    // 图片块正文沿用图注文本（阅读器 ImageBlockView 以 caption 优先展示）
                    if let Some(cap) = caption.as_deref() {
                        content_text = cap.to_string();
                    }
                    match mineru_v2_image_source_path(&c_obj) {
                        Some(img_path) => {
                            asset_ref = Some(resolve_asset(&img_path)?);
                        }
                        None => {
                            warnings.push(format!(
                                "MinerU v2 {} 块 (页 {}, 块 #{}) 缺少 image_source 图片引用",
                                raw_type, page_num, reading_order
                            ));
                        }
                    }
                }
                // v2 表格：正文 HTML 位于 content.html（非 table_body），
                // 同时保留 table_caption / table_footnote / image_source（表格截图备援）
                "table" => {
                    let html = c_obj
                        .get("html")
                        .or_else(|| c_obj.get("table_body"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    if html.is_empty() {
                        warnings.push(format!(
                            "MinerU v2 表格块 (页 {}, 块 #{}) 缺少 html 表格结构，\
                             将依赖备援图片降级显示",
                            page_num, reading_order
                        ));
                    } else {
                        content_text = html;
                        content_format = "html".to_string();
                    }
                    caption = mineru_v2_runs_field(&c_obj, "table_caption");
                    footnote = mineru_v2_runs_field(&c_obj, "table_footnote");
                    if let Some(img_path) = mineru_v2_image_source_path(&c_obj) {
                        asset_ref = Some(resolve_asset(&img_path)?);
                    }
                }
                // v2 页眉/页码/页脚：content.{type}_content runs
                "page_header" | "page_number" | "page_footer" => {
                    let field = format!("{}_content", raw_type);
                    if let Some(items) = c_obj.get(&field).and_then(|v| v.as_array()) {
                        content_text = mineru_v2_runs_to_text(items).trim().to_string();
                    }
                }
                // v2 未识别类型：提取诊断文本并明确警告，绝不静默输出空块
                other => {
                    let mut diag = String::new();
                    mineru_collect_diagnostic_text(&serde_json::Value::Object(c_obj.clone()), 0, &mut diag);
                    if !diag.is_empty() {
                        content_text = format!("<!-- 未识别结构: {} -->\n{}", other, diag);
                    } else {
                        content_text = format!("<!-- 未识别结构: {} -->", other);
                    }
                    warnings.push(format!(
                        "MinerU v2 出现未识别块类型 '{}' (页 {}, 块 #{})，已保留诊断内容",
                        other, page_num, reading_order
                    ));
                }
            }
        } else {
            // ---------- v1 content_list ----------
            let text_field = item
                .get("text")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            match raw_type.as_str() {
                "text" => {
                    content_text = text_field.unwrap_or_default();
                }
                "title" => {
                    content_text = text_field.unwrap_or_default();
                }
                "header" => {
                    // 真实 v1 产物中 header 是每页书眉（v2 对应 page_header），不是文档标题
                    content_text = text_field.unwrap_or_default();
                }
                "footer" => {
                    content_text = text_field.unwrap_or_default();
                }
                "page_number" => {
                    content_text = text_field.unwrap_or_default();
                }
                t if t.contains("equation") || t.contains("formula") => {
                    // v1 公式：text 内为 $$...$$ 包裹的 LaTeX 源码；img_path 为公式截图
                    content_text = text_field.unwrap_or_default();
                    content_format = "latex".to_string();
                    if content_text.is_empty() {
                        warnings.push(format!(
                            "MinerU v1 公式块 (页 {}, 块 #{}) 缺少 text 源码",
                            page_num, reading_order
                        ));
                    }
                    if let Some(img_path) = mineru_v1_img_path(&item) {
                        asset_ref = Some(resolve_asset(&img_path)?);
                    }
                }
                "image" | "figure" => {
                    caption = mineru_v1_string_list(&item, "image_caption");
                    footnote = mineru_v1_string_list(&item, "image_footnote");
                    if let Some(cap) = caption.as_deref() {
                        content_text = cap.to_string();
                    }
                    match mineru_v1_img_path(&item) {
                        Some(img_path) => {
                            asset_ref = Some(resolve_asset(&img_path)?);
                        }
                        None => {
                            warnings.push(format!(
                                "MinerU v1 图片块 (页 {}, 块 #{}) 缺少 img_path 图片引用",
                                page_num, reading_order
                            ));
                        }
                    }
                }
                // v1 图表：与 image 同构（img_path + chart_caption/chart_footnote），
                // 此前未解析 chart 的图片引用导致电路图/图表丢失
                "chart" => {
                    caption = mineru_v1_string_list(&item, "chart_caption");
                    footnote = mineru_v1_string_list(&item, "chart_footnote");
                    if let Some(cap) = caption.as_deref() {
                        content_text = cap.to_string();
                    }
                    match mineru_v1_img_path(&item) {
                        Some(img_path) => {
                            asset_ref = Some(resolve_asset(&img_path)?);
                        }
                        None => {
                            warnings.push(format!(
                                "MinerU v1 chart 块 (页 {}, 块 #{}) 缺少 img_path 图片引用",
                                page_num, reading_order
                            ));
                        }
                    }
                }
                // v1 表格：正文 HTML 位于 table_body；table_caption/table_footnote 为字符串数组；
                // img_path 为表格截图备援
                "table" => {
                    let body = item
                        .get("table_body")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    if body.is_empty() {
                        warnings.push(format!(
                            "MinerU v1 表格块 (页 {}, 块 #{}) 缺少 table_body，\
                             将依赖备援图片降级显示",
                            page_num, reading_order
                        ));
                    } else {
                        content_text = body;
                        content_format = "html".to_string();
                    }
                    caption = mineru_v1_string_list(&item, "table_caption");
                    footnote = mineru_v1_string_list(&item, "table_footnote");
                    if let Some(img_path) = mineru_v1_img_path(&item) {
                        asset_ref = Some(resolve_asset(&img_path)?);
                    }
                }
                "caption" | "table_caption" | "image_caption" | "chart_caption" => {
                    content_text = text_field.unwrap_or_default();
                }
                other => {
                    let mut diag = String::new();
                    mineru_collect_diagnostic_text(&item, 0, &mut diag);
                    if !diag.is_empty() {
                        content_text = format!("<!-- 未识别结构: {} -->\n{}", other, diag);
                    } else {
                        content_text = format!("<!-- 未识别结构: {} -->", other);
                    }
                    warnings.push(format!(
                        "MinerU v1 出现未识别块类型 '{}' (页 {}, 块 #{})，已保留诊断内容",
                        other, page_num, reading_order
                    ));
                }
            }
        }

        // 统一类型映射：v1 的 header/footer 是页眉/页脚（与 v2 page_header/page_footer 对齐），
        // 不再误判为文档标题
        let unified_type = match raw_type.as_str() {
            "paragraph" | "text" => "paragraph",
            "title" | "heading" => "heading",
            t if t.contains("equation") || t.contains("formula") => "formula",
            "image" | "chart" | "figure" => "image",
            "table" => "table",
            "caption" | "table_caption" | "image_caption" | "chart_caption" => "caption",
            "header" | "page_header" => "page_header",
            "footer" | "page_footer" => "page_footer",
            "page_number" => "page_number",
            _ => "unknown",
        };

        let block_id = format!("mineru_blk_{:04}", reading_order);
        let server_id = item.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

        blocks.push(ParsedBlock {
            id: block_id,
            server_id,
            r#type: unified_type.to_string(),
            raw_type: Some(raw_type),
            reading_order,
            content: content_text,
            content_format: Some(content_format),
            inline_runs,
            asset_ref,
            caption,
            footnote,
            heading_level,
            in_image_text: Vec::new(),
            page_sample: Some(page_num as i64),
            page_source: Some(page_num as i64),
            raw_bbox,
            normalized_bbox: norm_bbox,
            pt_bbox: None,
            coordinate_system: Some("mineru_grid_1000".to_string()),
            raw_node: None,
            parse_error: None,
        });

        reading_order += 1;
    }

    if blocks.is_empty() {
        return Err("MinerU 结果未解析出任何有效结构块".to_string());
    }
    ensure_meaningful_content("MinerU", &blocks)?;

    if blocks.len() > MAX_BLOCKS_COUNT {
        return Err(format!(
            "文档包含 {} 个结构块，超出只读原型承载范围 (上限 {} 块)",
            blocks.len(),
            MAX_BLOCKS_COUNT
        ));
    }

    // 检查必需图片资产是否存在
    let mut missing_images = Vec::new();
    for b in &blocks {
        if let Some(ref r) = b.asset_ref {
            if !assets_dir.join(r).is_file() {
                missing_images.push(r.clone());
            }
        }
    }

    if !missing_images.is_empty() {
        return Err(format!(
            "缺少必需的本地图片资产: assets/{}",
            missing_images.join(", assets/")
        ));
    }

    // 生成 content.md
    let continuous_md = build_continuous_markdown(&blocks);
    fs::write(normalized_dir.join("content.md"), continuous_md)
        .map_err(|e| format!("写入 content.md 失败: {}", e))?;

    // 生成 source-map.json
    let mut source_map_blocks = serde_json::Map::new();
    for b in &blocks {
        let mut entry = serde_json::Map::new();
        entry.insert("page_sample".to_string(), serde_json::to_value(b.page_sample).unwrap());
        entry.insert("page_source".to_string(), serde_json::to_value(b.page_source).unwrap());
        entry.insert("normalized_bbox".to_string(), serde_json::to_value(&b.normalized_bbox).unwrap());
        entry.insert("raw_bbox".to_string(), serde_json::to_value(&b.raw_bbox).unwrap());
        source_map_blocks.insert(b.id.clone(), serde_json::Value::Object(entry));
    }
    let mut source_map = serde_json::Map::new();
    source_map.insert("blocks".to_string(), serde_json::Value::Object(source_map_blocks));
    fs::write(
        normalized_dir.join("source-map.json"),
        serde_json::to_string_pretty(&source_map).unwrap(),
    )
    .map_err(|e| format!("写入 source-map.json 失败: {}", e))?;

    // 生成 blocks.json
    fs::write(
        normalized_dir.join("blocks.json"),
        serde_json::to_string_pretty(&blocks).unwrap(),
    )
    .map_err(|e| format!("写入 blocks.json 失败: {}", e))?;

    let diag = ParseDiagnostics {
        provider: "mineru".to_string(),
        total_blocks: blocks.len(),
        normalized_body_blocks: blocks
            .iter()
            .filter(|b| !matches!(b.r#type.as_str(), "page_header" | "page_number" | "page_footer"))
            .count(),
        formulas_count: blocks.iter().filter(|b| b.r#type == "formula").count(),
        tables_count: blocks.iter().filter(|b| b.r#type == "table").count(),
        images_count: blocks.iter().filter(|b| b.r#type == "image").count(),
        total_asset_files,
        missing_images,
        warnings,
        failed_pages: Vec::new(),
    };

    fs::write(
        normalized_dir.join("diagnostics.json"),
        serde_json::to_string_pretty(&diag).unwrap(),
    )
    .map_err(|e| format!("写入 diagnostics.json 失败: {}", e))?;

    Ok(diag)
}

// ================= Datalab Normalization =================

pub fn normalize_datalab_results(
    raw_dir: &Path,
    normalized_dir: &Path,
) -> Result<ParseDiagnostics, String> {
    let assets_dir = normalized_dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("创建 normalized/assets 失败: {}", e))?;

    // 1. 复制所有图片到 assets/
    let (mut image_mapping, total_asset_files) = collect_and_copy_images(raw_dir, &assets_dir)?;

    // 1.1 加载持久图片映射 images_manifest.json（如存在，建立原始引用到落盘资产的直接基准映射）
    let manifest_file = raw_dir.join("images_manifest.json");
    if manifest_file.is_file() {
        if let Ok(manifest_content) = fs::read_to_string(&manifest_file) {
            if let Ok(manifest_map) = serde_json::from_str::<HashMap<String, String>>(&manifest_content) {
                for (orig_ref, saved_rel) in manifest_map {
                    let norm_saved = normalize_image_ref(&saved_rel);
                    if let Some(asset) = image_mapping.by_rel.get(&norm_saved).cloned() {
                        image_mapping.by_rel.insert(normalize_image_ref(&orig_ref), asset);
                    }
                }
            }
        }
    }

    // 2. 读取 result.json
    let result_json_file = raw_dir.join("result.json");
    if !result_json_file.is_file() {
        return Err("Datalab 原始输出中未找到 result.json 结构树文件".to_string());
    }

    let raw_json_str = fs::read_to_string(&result_json_file)
        .map_err(|e| format!("读取 Datalab result.json 失败: {}", e))?;
    let raw_json: serde_json::Value = serde_json::from_str(&raw_json_str)
        .map_err(|e| format!("Datalab result.json 语法错误: {}", e))?;

    // 检查响应中的 failed_pages
    let mut failed_pages = Vec::new();
    if let Some(fp) = raw_json
        .get("metadata")
        .and_then(|m| m.get("failed_pages"))
        .and_then(|v| v.as_array())
    {
        failed_pages = fp.clone();
    }

    if !failed_pages.is_empty() {
        // 产品没有“部分成功”流程：非空失败页必须明确失败，保留原始产物与诊断，
        // 不能把缺页的结果激活成完整版本。
        let failed_desc = failed_pages
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let diag = ParseDiagnostics {
            provider: "datalab".to_string(),
            total_blocks: 0,
            normalized_body_blocks: 0,
            formulas_count: 0,
            tables_count: 0,
            images_count: 0,
            total_asset_files: 0,
            missing_images: Vec::new(),
            warnings: vec![format!("Datalab 报告失败页: {}", failed_desc)],
            failed_pages: failed_pages.clone(),
        };
        let _ = fs::write(
            normalized_dir.join("diagnostics.json"),
            serde_json::to_string_pretty(&diag).unwrap_or_default(),
        );
        return Err(format!(
            "Datalab 报告 {} 页解析失败（{}），不生成完整解析版本",
            failed_pages.len(),
            failed_desc
        ));
    }

    let mut blocks: Vec<ParsedBlock> = Vec::new();
    let warnings: Vec<String> = Vec::new();
    let mut reading_order = 1i64;

    let math_re = regex::Regex::new(r"<math[^>]*>(.*?)</math>").map_err(|e| e.to_string())?;
    let img_text_re = regex::Regex::new(r#"<p class=["']img-text["']>(.*?)</p>"#).map_err(|e| e.to_string())?;
    let strip_tag_re = regex::Regex::new(r"<[^>]+>").map_err(|e| e.to_string())?;

    if let Some(pages_list) = raw_json.get("children").and_then(|v| v.as_array()) {
        for (p_idx, page_node) in pages_list.iter().enumerate() {
            // 获取当前页面像素尺寸 (page_node.bbox: [0, 0, W_px, H_px])
            let page_dim: Option<(f64, f64)> = page_node
                .get("bbox")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    if arr.len() >= 4 {
                        let w = arr[2].as_f64()?;
                        let h = arr[3].as_f64()?;
                        if w > 0.0 && h > 0.0 {
                            Some((w, h))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                });

            let child_blocks = page_node
                .get("children")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            for item in child_blocks {
                let raw_type = item
                    .get("block_type")
                    .or_else(|| item.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                let raw_bbox: Option<Vec<f64>> = item.get("bbox").and_then(|v| {
                    v.as_array().map(|arr| {
                        arr.iter().filter_map(|val| val.as_f64()).collect::<Vec<f64>>()
                    })
                });

                let norm_bbox = match (raw_bbox.as_ref(), page_dim) {
                    (Some(bb), Some((pw, ph))) => normalize_bbox_pixel(bb, pw, ph),
                    _ => None,
                };

                // 区分数据源格式：优先 markdown，其次 html，再次 content/text；
                // 必须按“有效字符串值”回退，保留来源格式信息，不能一律提前全局实体解码后删标签。
                let (picked_format, raw_content) = if let Some(s) = crate::parse_providers::pick_string(&item, &["markdown", "md"]) {
                    ("markdown", s)
                } else if let Some(s) = crate::parse_providers::pick_string(&item, &["html"]) {
                    ("html", s)
                } else if let Some(s) = crate::parse_providers::pick_string(&item, &["content", "text"]) {
                    ("text", s)
                } else {
                    ("empty", String::new())
                };

                let is_html_source = picked_format == "html" || (picked_format == "empty" && raw_content.contains('<'));

                let mut content_val = String::new();
                let mut content_format = if picked_format == "html" { "html".to_string() } else { "markdown".to_string() };
                let mut inline_runs: Option<Vec<InlineRun>> = None;
                let mut in_image_text = Vec::new();
                let mut asset_ref: Option<String> = None;
                let mut caption_text: Option<String> = None;

                // 提取图片资产引用：优先从结构块 images 映射（取首个键），若缺失或为空则回退到 HTML <img src="...">
                let img_key = item
                    .get("images")
                    .and_then(|v| v.as_object())
                    .and_then(|m| {
                        let mut keys: Vec<&String> = m.keys().collect();
                        keys.sort();
                        keys.first().cloned().cloned()
                    })
                    .or_else(|| extract_img_src(&raw_content));

                if let Some(ref key) = img_key {
                    asset_ref = Some(image_mapping.resolve(key).map_err(|e| {
                        format!("Datalab 图片引用无法解析 ({}): {}", key, e)
                    })?);
                }


                let unified_type: &'static str;
                let raw_type_lower = raw_type.to_ascii_lowercase();

                if matches!(raw_type_lower.as_str(), "equation" | "formula") {
                    unified_type = "formula";
                    content_format = "latex".to_string();
                    if let Some(caps) = math_re.captures(&raw_content) {
                        let inner = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                        content_val = decode_html_entities(inner);
                    } else if is_html_source {
                        let stripped = strip_tag_re.replace_all(&raw_content, "").trim().to_string();
                        content_val = decode_html_entities(&stripped);
                    } else {
                        content_val = decode_html_entities(raw_content.trim());
                    }
                } else if matches!(raw_type_lower.as_str(), "figure" | "diagram" | "picture" | "image") {
                    unified_type = "image";
                    content_format = "markdown".to_string();

                    // 提取图内 OCR 文本（<p class="img-text">）并与正文分离，数学片段保护为 $...$
                    for cap in img_text_re.captures_iter(&raw_content) {
                        if let Some(m) = cap.get(1) {
                            let (clean, _) = process_html_text_and_math(m.as_str(), &math_re, &strip_tag_re);
                            if !clean.is_empty() {
                                in_image_text.push(clean);
                            }
                        }
                    }

                    if let Some(ref aref) = asset_ref {
                        content_val = format!("![{}](assets/{})", aref, aref);
                    }
                } else if matches!(
                    raw_type_lower.as_str(),
                    "text" | "paragraph" | "caption" | "heading" | "sectionheader" | "title"
                ) {
                    if matches!(raw_type_lower.as_str(), "heading" | "sectionheader" | "title") {
                        unified_type = "heading";
                    } else if raw_type_lower == "caption" {
                        unified_type = "caption";
                    } else {
                        unified_type = "paragraph";
                    }

                    content_format = "markdown".to_string();

                    let converted = if is_html_source {
                        let (clean, _) = process_html_text_and_math(&raw_content, &math_re, &strip_tag_re);
                        clean
                    } else {
                        math_re
                            .replace_all(&raw_content, |caps: &regex::Captures| {
                                let inner = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                                format!(" ${}$ ", decode_html_entities(inner))
                            })
                            .trim()
                            .to_string()
                    };

                    content_val = converted.clone();
                    if unified_type == "caption" {
                        caption_text = Some(converted.clone());
                    }

                    // 构建 inline_runs
                    let mut runs = Vec::new();
                    let mut last_idx = 0;
                    for m in converted.match_indices('$') {
                        let idx = m.0;
                        if idx > last_idx {
                            let text_chunk = converted[last_idx..idx].to_string();
                            if !text_chunk.is_empty() {
                                runs.push(InlineRun {
                                    r#type: "text".to_string(),
                                    content: text_chunk,
                                });
                            }
                        }
                        // 寻找闭合 $
                        if let Some(close_idx) = converted[idx + 1..].find('$') {
                            let math_content = &converted[idx + 1..idx + 1 + close_idx];
                            runs.push(InlineRun {
                                r#type: "equation_inline".to_string(),
                                content: math_content.to_string(),
                            });
                            last_idx = idx + 1 + close_idx + 1;
                        } else {
                            break;
                        }
                    }
                    if last_idx < converted.len() {
                        let text_chunk = converted[last_idx..].to_string();
                        if !text_chunk.is_empty() {
                            runs.push(InlineRun {
                                r#type: "text".to_string(),
                                content: text_chunk,
                            });
                        }
                    }
                    inline_runs = Some(runs);
                } else if raw_type_lower == "table" {
                    unified_type = "table";
                    content_format = if raw_content.contains("<table") || is_html_source {
                        "html".to_string()
                    } else {
                        "markdown".to_string()
                    };
                    if content_format == "html" {
                        // 保留 HTML 表格结构与实体（不提前解码实体以防生成新标签或破坏单元格结构），仅将单元格内的 <math> 转换为 $...$
                        content_val = math_re
                            .replace_all(&raw_content, |caps: &regex::Captures| {
                                let inner = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                                format!("${}$", decode_html_entities(inner))
                            })
                            .to_string();
                    } else {
                        content_val = raw_content;
                    }
                } else if matches!(
                    raw_type_lower.as_str(),
                    "pageheader" | "page_header" | "pagefooter" | "page_footer" | "pagenumber" | "page_number"
                ) {
                    unified_type = match raw_type_lower.as_str() {
                        "pageheader" | "page_header" => "page_header",
                        "pagenumber" | "page_number" => "page_number",
                        _ => "page_footer",
                    };
                    content_val = if is_html_source {
                        strip_tag_re.replace_all(&raw_content, "").trim().to_string()
                    } else {
                        raw_content.trim().to_string()
                    };
                } else {
                    unified_type = "unknown";
                    content_val = format!("<!-- 未识别结构: {} -->\n{}", raw_type, raw_content);
                }

                let block_id = format!("datalab_blk_{:04}", reading_order);
                let server_id = item.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

                blocks.push(ParsedBlock {
                    id: block_id,
                    server_id,
                    r#type: unified_type.to_string(),
                    raw_type: Some(raw_type),
                    reading_order,
                    content: content_val,
                    content_format: Some(content_format),
                    inline_runs,
                    asset_ref,
                    caption: caption_text,
                    footnote: None,
                    heading_level: None,
                    in_image_text,
                    page_sample: Some((p_idx + 1) as i64),
                    page_source: Some((p_idx + 1) as i64),
                    raw_bbox,
                    normalized_bbox: norm_bbox,
                    pt_bbox: None,
                    coordinate_system: Some("datalab_pixel".to_string()),
                    raw_node: None,
                    parse_error: None,
                });

                reading_order += 1;
            }
        }
    }

    if blocks.is_empty() {
        return Err("Datalab 结果未解析出任何有效结构块".to_string());
    }
    ensure_meaningful_content("Datalab", &blocks)?;

    if blocks.len() > MAX_BLOCKS_COUNT {
        return Err(format!(
            "文档包含 {} 个结构块，超出只读原型承载范围 (上限 {} 块)",
            blocks.len(),
            MAX_BLOCKS_COUNT
        ));
    }

    // 检查必需图片资产是否存在
    let mut missing_images = Vec::new();
    for b in &blocks {
        if let Some(ref r) = b.asset_ref {
            if !assets_dir.join(r).is_file() {
                missing_images.push(r.clone());
            }
        }
    }

    if !missing_images.is_empty() {
        return Err(format!(
            "缺少必需的本地图片资产: assets/{}",
            missing_images.join(", assets/")
        ));
    }

    // 生成 content.md
    let continuous_md = build_continuous_markdown(&blocks);
    fs::write(normalized_dir.join("content.md"), continuous_md)
        .map_err(|e| format!("写入 content.md 失败: {}", e))?;

    // 生成 source-map.json
    let mut source_map_blocks = serde_json::Map::new();
    for b in &blocks {
        let mut entry = serde_json::Map::new();
        entry.insert("page_sample".to_string(), serde_json::to_value(b.page_sample).unwrap());
        entry.insert("page_source".to_string(), serde_json::to_value(b.page_source).unwrap());
        entry.insert("normalized_bbox".to_string(), serde_json::to_value(&b.normalized_bbox).unwrap());
        entry.insert("raw_bbox".to_string(), serde_json::to_value(&b.raw_bbox).unwrap());
        source_map_blocks.insert(b.id.clone(), serde_json::Value::Object(entry));
    }
    let mut source_map = serde_json::Map::new();
    source_map.insert("blocks".to_string(), serde_json::Value::Object(source_map_blocks));
    fs::write(
        normalized_dir.join("source-map.json"),
        serde_json::to_string_pretty(&source_map).unwrap(),
    )
    .map_err(|e| format!("写入 source-map.json 失败: {}", e))?;

    // 生成 blocks.json
    fs::write(
        normalized_dir.join("blocks.json"),
        serde_json::to_string_pretty(&blocks).unwrap(),
    )
    .map_err(|e| format!("写入 blocks.json 失败: {}", e))?;

    let diag = ParseDiagnostics {
        provider: "datalab".to_string(),
        total_blocks: blocks.len(),
        normalized_body_blocks: blocks
            .iter()
            .filter(|b| !matches!(b.r#type.as_str(), "page_header" | "page_number" | "page_footer"))
            .count(),
        formulas_count: blocks.iter().filter(|b| b.r#type == "formula").count(),
        tables_count: blocks.iter().filter(|b| b.r#type == "table").count(),
        images_count: blocks.iter().filter(|b| b.r#type == "image").count(),
        total_asset_files,
        missing_images,
        warnings,
        failed_pages,
    };

    fs::write(
        normalized_dir.join("diagnostics.json"),
        serde_json::to_string_pretty(&diag).unwrap(),
    )
    .map_err(|e| format!("写入 diagnostics.json 失败: {}", e))?;

    Ok(diag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{}_{}", prefix, uuid::Uuid::new_v4().simple()));
            let _ = fs::create_dir_all(&path);
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn test_normalize_bbox_grid_1000_valid_and_clamping() {
        // 标准合法框
        let res = normalize_bbox_grid_1000(&[100.0, 200.0, 500.0, 600.0]);
        assert_eq!(res, Some([0.1, 0.2, 0.5, 0.6]));

        // 边界框
        let boundary = normalize_bbox_grid_1000(&[0.0, 0.0, 1000.0, 1000.0]);
        assert_eq!(boundary, Some([0.0, 0.0, 1.0, 1.0]));

        // 反向坐标 (x1 <= x0) 拒绝
        assert_eq!(normalize_bbox_grid_1000(&[500.0, 200.0, 100.0, 600.0]), None);

        // 反向坐标 (y1 <= y0) 拒绝
        assert_eq!(normalize_bbox_grid_1000(&[100.0, 600.0, 500.0, 200.0]), None);

        // 零面积 / 退化线段 拒绝
        assert_eq!(normalize_bbox_grid_1000(&[100.0, 100.0, 100.0, 500.0]), None);
        assert_eq!(normalize_bbox_grid_1000(&[100.0, 100.0, 500.0, 100.0]), None);

        // 负数坐标拒绝
        assert_eq!(normalize_bbox_grid_1000(&[-10.0, 0.0, 500.0, 500.0]), None);

        // 严重越界 (>1000.5) 拒绝
        assert_eq!(normalize_bbox_grid_1000(&[0.0, 0.0, 1200.0, 500.0]), None);
    }

    #[test]
    fn test_normalize_bbox_pixel_valid_and_rejection() {
        let page_w = 1000.0;
        let page_h = 2000.0;

        // 标准像素框
        let res = normalize_bbox_pixel(&[100.0, 200.0, 500.0, 800.0], page_w, page_h);
        assert_eq!(res, Some([0.1, 0.1, 0.5, 0.4]));

        // 非法页面尺寸拒绝
        assert_eq!(normalize_bbox_pixel(&[10.0, 10.0, 50.0, 50.0], 0.0, 1000.0), None);
        assert_eq!(normalize_bbox_pixel(&[10.0, 10.0, 50.0, 50.0], 1000.0, -10.0), None);

        // 反向坐标拒绝
        assert_eq!(normalize_bbox_pixel(&[500.0, 200.0, 100.0, 800.0], page_w, page_h), None);
        assert_eq!(normalize_bbox_pixel(&[100.0, 800.0, 500.0, 200.0], page_w, page_h), None);

        // 严重越界 (>1.05 * dim) 拒绝
        assert_eq!(normalize_bbox_pixel(&[0.0, 0.0, 1200.0, 500.0], page_w, page_h), None);
    }

    #[test]
    fn test_build_continuous_markdown_filtering() {
        let blocks = vec![
            ParsedBlock {
                id: "b_hdr".to_string(),
                server_id: None,
                r#type: "page_header".to_string(),
                raw_type: Some("page_header".to_string()),
                reading_order: 1,
                content: "Header text that must not appear in markdown".to_string(),
                content_format: None,
                inline_runs: None,
                asset_ref: None,
                caption: None,
                footnote: None,
                heading_level: None,
                in_image_text: Vec::new(),
                page_sample: Some(1),
                page_source: Some(1),
                raw_bbox: None,
                normalized_bbox: None,
                pt_bbox: None,
                coordinate_system: None,
                raw_node: None,
                parse_error: None,
            },
            ParsedBlock {
                id: "b_text".to_string(),
                server_id: None,
                r#type: "text".to_string(),
                raw_type: Some("text".to_string()),
                reading_order: 2,
                content: "First paragraph of real content.".to_string(),
                content_format: None,
                inline_runs: None,
                asset_ref: None,
                caption: None,
                footnote: None,
                heading_level: None,
                in_image_text: Vec::new(),
                page_sample: Some(1),
                page_source: Some(1),
                raw_bbox: None,
                normalized_bbox: None,
                pt_bbox: None,
                coordinate_system: None,
                raw_node: None,
                parse_error: None,
            },
            ParsedBlock {
                id: "b_math".to_string(),
                server_id: None,
                r#type: "formula".to_string(),
                raw_type: Some("equation".to_string()),
                reading_order: 3,
                content: r"\int_0^1 x dx".to_string(),
                content_format: Some("latex".to_string()),
                inline_runs: None,
                asset_ref: None,
                caption: None,
                footnote: None,
                heading_level: None,
                in_image_text: Vec::new(),
                page_sample: Some(1),
                page_source: Some(1),
                raw_bbox: None,
                normalized_bbox: None,
                pt_bbox: None,
                coordinate_system: None,
                raw_node: None,
                parse_error: None,
            },
            ParsedBlock {
                id: "b_img".to_string(),
                server_id: None,
                r#type: "image".to_string(),
                raw_type: Some("figure".to_string()),
                reading_order: 4,
                content: "Figure 1: Test architecture".to_string(),
                content_format: None,
                inline_runs: None,
                asset_ref: Some("fig1.png".to_string()),
                caption: Some("Figure 1: Test architecture".to_string()),
                footnote: None,
                heading_level: None,
                in_image_text: Vec::new(),
                page_sample: Some(1),
                page_source: Some(1),
                raw_bbox: None,
                normalized_bbox: None,
                pt_bbox: None,
                coordinate_system: None,
                raw_node: None,
                parse_error: None,
            },
            ParsedBlock {
                id: "b_ftr".to_string(),
                server_id: None,
                r#type: "page_footer".to_string(),
                raw_type: Some("page_footer".to_string()),
                reading_order: 5,
                content: "Footer page 1".to_string(),
                content_format: None,
                inline_runs: None,
                asset_ref: None,
                caption: None,
                footnote: None,
                heading_level: None,
                in_image_text: Vec::new(),
                page_sample: Some(1),
                page_source: Some(1),
                raw_bbox: None,
                normalized_bbox: None,
                pt_bbox: None,
                coordinate_system: None,
                raw_node: None,
                parse_error: None,
            },
        ];

        let md = build_continuous_markdown(&blocks);
        // 页眉与页脚严禁出现在正文 markdown 中
        assert!(!md.contains("Header text"));
        assert!(!md.contains("Footer page 1"));

        // 正文存在
        assert!(md.contains("First paragraph of real content."));
        // 独立公式包含 $$ 包装
        assert!(md.contains("$$\n\\int_0^1 x dx\n$$"));
        // 图片带 caption 与 assets/ 引用
        assert!(md.contains("![Figure 1: Test architecture](assets/fig1.png)"));
    }

    #[test]
    fn test_safe_extract_zip_prevents_traversal() {
        let temp_dir = TestTempDir::new("evil_zip");
        let zip_path = temp_dir.path().join("evil.zip");
        let extract_dest = temp_dir.path().join("dest");

        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();

            // 写入包含非法穿越路径的条目
            let _ = zip.start_file("../evil.txt", options);
            let _ = zip.write_all(b"malicious content");
            let _ = zip.finish();
        }

        let res = safe_extract_zip(&zip_path, &extract_dest);
        assert!(res.is_err(), "包含 .. 的 ZIP 条目必须被拦截拒绝");
        let err_msg = res.unwrap_err();
        assert!(err_msg.contains("非法路径穿越"));
    }

    #[test]
    fn test_collect_and_copy_images_deduplication() {
        let temp_dir = TestTempDir::new("img_dedup");
        let src_dir = temp_dir.path().join("src");
        let dir_a = src_dir.join("sub_a");
        let dir_b = src_dir.join("sub_b");
        let assets_dest = temp_dir.path().join("normalized").join("assets");

        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        // 两个内容完全一致的图片 (不同文件名/不同目录)
        fs::write(dir_a.join("image_1.png"), b"identical_png_bytes").unwrap();
        fs::write(dir_b.join("image_1_copy.png"), b"identical_png_bytes").unwrap();

        // 另一个不同内容的图片
        fs::write(dir_b.join("image_2.png"), b"different_png_bytes").unwrap();

        let (mapping, total_copied) = collect_and_copy_images(&src_dir, &assets_dest).unwrap();

        // 重复内容被哈希去重，只落盘 2 个唯一文件
        assert_eq!(total_copied, 2);

        // 不同路径引用同一内容：允许共享资产，但两个引用都必须能解析
        let a = mapping.resolve("sub_a/image_1.png").unwrap();
        let b = mapping.resolve("sub_b/image_1_copy.png").unwrap();
        assert_eq!(a, b, "同内容不同路径可共享同一资产");
        assert_eq!(
            fs::read(assets_dest.join(&a)).unwrap(),
            b"identical_png_bytes",
            "asset_ref 必须指向真实字节"
        );

        let c = mapping.resolve("sub_b/image_2.png").unwrap();
        assert_ne!(a, c);
        assert_eq!(fs::read(assets_dest.join(&c)).unwrap(), b"different_png_bytes");

        // 只有 basename 且唯一时允许回退
        assert_eq!(mapping.resolve("image_2.png").unwrap(), c);
    }

    #[test]
    fn test_same_basename_different_content_is_ambiguous() {
        let temp_dir = TestTempDir::new("img_ambiguous");
        let src_dir = temp_dir.path().join("src");
        let assets_dest = temp_dir.path().join("normalized").join("assets");
        fs::create_dir_all(src_dir.join("a")).unwrap();
        fs::create_dir_all(src_dir.join("b")).unwrap();

        fs::write(src_dir.join("a").join("fig.png"), b"AAAA").unwrap();
        fs::write(src_dir.join("b").join("fig.png"), b"BBBB").unwrap();

        let (mapping, _) = collect_and_copy_images(&src_dir, &assets_dest).unwrap();

        // 只有文件名且存在多个候选 → 明确歧义，不能随便选一张
        let err = mapping.resolve("fig.png").unwrap_err();
        assert!(err.contains("歧义"), "同名不同内容必须报歧义: {}", err);

        // 完整相对路径必须各自指向正确字节
        let asset_a = mapping.resolve("a/fig.png").unwrap();
        let asset_b = mapping.resolve("b/fig.png").unwrap();
        assert_ne!(asset_a, asset_b);
        assert_eq!(fs::read(assets_dest.join(&asset_a)).unwrap(), b"AAAA");
        assert_eq!(fs::read(assets_dest.join(&asset_b)).unwrap(), b"BBBB");
    }

    #[test]
    fn test_mineru_normalization_flow() {
        let temp_dir = TestTempDir::new("mineru_norm");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(raw_dir.join("images")).unwrap();

        // 准备图片
        fs::write(raw_dir.join("images").join("fig_test.png"), b"test_img_bytes").unwrap();

        // 准备 MinerU content_list.json（真实 v1 形状）
        let content_list = serde_json::json!([
            {
                "type": "text",
                "text": "Hello MinerU extraction",
                "page_idx": 0,
                "bbox": [100, 100, 800, 200]
            },
            {
                "type": "equation",
                "img_path": "images/fig_test.png",
                "text": "$$E = mc^2$$",
                "text_format": "latex",
                "page_idx": 0,
                "bbox": [150, 250, 600, 350]
            },
            {
                "type": "image",
                "img_path": "images/fig_test.png",
                "image_caption": ["Sample Image Caption"],
                "image_footnote": [],
                "page_idx": 0,
                "bbox": [100, 400, 900, 700]
            },
            {
                "type": "header",
                "text": "Page Header 1",
                "page_idx": 0,
                "bbox": [100, 50, 900, 80]
            }
        ]);
        fs::write(raw_dir.join("content_list.json"), content_list.to_string()).unwrap();

        let diag = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.total_blocks, 4);
        assert_eq!(diag.normalized_body_blocks, 3); // 页眉不计入 body
        assert_eq!(diag.formulas_count, 1);
        assert_eq!(diag.images_count, 1);

        // 产物文件齐全
        assert!(normalized_dir.join("blocks.json").is_file());
        assert!(normalized_dir.join("content.md").is_file());
        assert!(normalized_dir.join("source-map.json").is_file());
        assert!(normalized_dir.join("diagnostics.json").is_file());
        assert!(normalized_dir.join("assets").join("fig_test.png").is_file());

        let blocks_content = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_content).unwrap();
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].normalized_bbox, Some([0.1, 0.1, 0.8, 0.2]));

        // v1 真实结构：header 是页眉而非文档标题
        assert_eq!(blocks[3].r#type, "page_header");
        assert_eq!(blocks[3].content, "Page Header 1");
        // v1 公式：$$ 包裹源码 + latex 格式 + 公式截图资产引用
        assert_eq!(blocks[1].r#type, "formula");
        assert_eq!(blocks[1].content_format.as_deref(), Some("latex"));
        assert_eq!(blocks[1].asset_ref.as_deref(), Some("fig_test.png"));
        // v1 图片图注保留
        assert_eq!(blocks[2].caption.as_deref(), Some("Sample Image Caption"));
    }

    // ---------- 真实 MinerU 结构（脱敏 fixture） ----------

    const MINERU_V2_REAL_SHAPE: &str =
        include_str!("../tests/fixtures/mineru_v2_real_shape.json");
    const MINERU_V1_REAL_SHAPE: &str =
        include_str!("../tests/fixtures/mineru_v1_real_shape.json");

    fn write_mineru_fixture_images(raw_dir: &Path, names: &[(&str, &[u8])]) {
        let img_dir = raw_dir.join("images");
        fs::create_dir_all(&img_dir).unwrap();
        for (name, bytes) in names {
            fs::write(img_dir.join(name), bytes).unwrap();
        }
    }

    #[test]
    fn test_mineru_v2_real_shape_fixture() {
        let temp_dir = TestTempDir::new("mineru_v2_real");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        let fig_bytes = b"v2_real_circuit_bytes";
        let eq_bytes = b"v2_real_formula_snapshot";
        let table_bytes = b"v2_real_table_snapshot";
        let chart_bytes = b"v2_real_chart_bytes";
        write_mineru_fixture_images(
            &raw_dir,
            &[
                ("fig_circuit.jpg", fig_bytes),
                ("eq_snapshot.jpg", eq_bytes),
                ("table_snapshot.jpg", table_bytes),
                ("chart_curve.jpg", chart_bytes),
            ],
        );

        // 结构文件必须命名为 content_list_v2.json 才会被优先选中
        fs::write(
            raw_dir.join("xxx_content_list_v2.json"),
            MINERU_V2_REAL_SHAPE,
        )
        .unwrap();

        let diag = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.total_blocks, 10, "fixture 共 10 块");
        assert_eq!(diag.formulas_count, 1);
        assert_eq!(diag.tables_count, 1);
        assert_eq!(diag.images_count, 2); // image + chart
        assert!(diag.warnings.is_empty(), "真实形状不应产生警告: {:?}", diag.warnings);

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();

        // --- v2 标题：文字来自 title_content，层级来自 content.level ---
        let h2 = blocks
            .iter()
            .find(|b| b.content.contains("4.5.3 Sample Section Title"))
            .expect("v2 二级标题必须保留文字");
        assert_eq!(h2.r#type, "heading");
        assert_eq!(h2.heading_level, Some(2));
        assert!(
            h2.content.trim_start_matches('#').trim() == "4.5.3 Sample Section Title",
            "标题内容不应被改写: {}",
            h2.content
        );

        let h1 = blocks
            .iter()
            .find(|b| b.content.contains("The Chapter Level Title"))
            .expect("v2 一级标题必须保留");
        assert_eq!(h1.heading_level, Some(1));

        // --- v2 表格：正文 HTML 位于 content.html（非 table_body） ---
        let table = blocks
            .iter()
            .find(|b| b.r#type == "table")
            .expect("必须解析出表格块");
        assert!(table.content.contains("<table"), "表格 HTML 主体必须保留: {}", table.content);
        assert!(
            table.content.contains("rowspan=\"2\""),
            "合并单元格必须保留: {}",
            table.content
        );
        assert!(
            table.content.contains("$V _ { F }$"),
            "单元格内公式必须保留: {}",
            table.content
        );
        assert!(
            table.content.contains("SAMPLE-DEVICE-01"),
            "代表性单元格文本必须保留: {}",
            table.content
        );
        assert_eq!(table.content_format.as_deref(), Some("html"));
        assert_eq!(
            table.caption.as_deref(),
            Some("Table 4.6 Characteristics of sample devices")
        );
        assert_eq!(
            table.footnote.as_deref(),
            Some("Notes: values are typical at 25 C.")
        );
        // 表格截图备援引用保留且指向真实字节
        let table_asset = table.asset_ref.as_deref().expect("表格截图备援必须保留");
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(table_asset)).unwrap(),
            table_bytes,
            "表格备援图片必须对应原始字节"
        );

        // --- v2 独立公式：math_content 源码 + 公式截图 ---
        let formula = blocks
            .iter()
            .find(|b| b.r#type == "formula")
            .expect("必须解析出公式块");
        assert!(formula.content.contains("W _ { C }"), "公式源码必须保留: {}", formula.content);
        assert!(formula.content.contains("\\tag{4.41}"));
        assert_eq!(formula.content_format.as_deref(), Some("latex"));
        let eq_asset = formula.asset_ref.as_deref().expect("公式截图引用必须保留");
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(eq_asset)).unwrap(),
            eq_bytes
        );

        // --- v2 段落：行内公式顺序保留 ---
        let para = blocks
            .iter()
            .find(|b| b.r#type == "paragraph")
            .expect("必须解析出段落块");
        assert!(para.content.contains("illustrated in Fig. 4.68"));
        assert!(para.content.contains("$\\nu _ { A } ( t )$"));
        assert!(para.content.contains("$V _ { g }$"));
        assert!(para.inline_runs.is_some());

        // --- v2 插图：image_source + 图注；chart：chart_caption + chart_footnote ---
        let image = blocks
            .iter()
            .find(|b| b.r#type == "image" && b.caption.as_deref().map(|c| c.contains("Fig. 4.68")).unwrap_or(false))
            .expect("必须解析出带图注的插图块");
        let img_asset = image.asset_ref.as_deref().unwrap();
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(img_asset)).unwrap(),
            fig_bytes,
            "电路图引用必须对应正确资产字节"
        );

        let chart = blocks
            .iter()
            .find(|b| b.raw_type.as_deref() == Some("chart"))
            .expect("必须解析出 chart 块");
        assert_eq!(
            chart.caption.as_deref(),
            Some("Fig. 4.77 Sample efficiency vs. switching frequency, based on Eq. (4.52)")
        );
        assert_eq!(chart.footnote.as_deref(), Some("Chart footnote sample"));
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(chart.asset_ref.as_deref().unwrap())).unwrap(),
            chart_bytes
        );

        // --- v2 页眉/页码/页脚映射 ---
        let header = blocks.iter().find(|b| b.r#type == "page_header").unwrap();
        assert_eq!(header.content, "4 Switch Realization");
        let number = blocks.iter().find(|b| b.r#type == "page_number").unwrap();
        assert_eq!(number.content, "118");
        let footer = blocks.iter().find(|b| b.r#type == "page_footer").unwrap();
        assert_eq!(footer.content, "Sample footer line with attribution");

        // --- 页码与顺序：v2 页号来自二维数组下标 ---
        assert_eq!(header.page_source, Some(1));
        assert_eq!(h1.page_source, Some(2));
        let orders: Vec<i64> = blocks.iter().map(|b| b.reading_order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted, "reading_order 必须严格递增");
        assert_eq!(orders.first(), Some(&1));

        // --- content.md：标题层级、表格、图注脚注、公式 ---
        let md = fs::read_to_string(normalized_dir.join("content.md")).unwrap();
        assert!(md.contains("## 4.5.3 Sample Section Title"), "md 标题不得二次加前缀");
        assert!(md.contains("# The Chapter Level Title"));
        assert!(!md.contains("## # The Chapter Level Title"));
        assert!(md.contains("Table 4.6 Characteristics of sample devices"));
        assert!(md.contains("Notes: values are typical at 25 C."));
        assert!(md.contains("<table"));
        assert!(md.contains("$$"));
        assert!(md.contains("assets/"));
        // 页眉页脚页码不进入正文 markdown
        assert!(!md.contains("4 Switch Realization"));
        assert!(!md.contains("Sample footer line"));
        assert!(!md.contains("118"));
    }

    /// 归一化产物与提交的前端回归 fixture 保持一致（防漂移）：
    /// 前端测试直接使用 tests/fixtures/mineru_v2_real_shape_normalized.json 验证阅读器渲染，
    /// 若归一化逻辑变更导致产物变化，本测试失败，必须同步重新生成该 fixture。
    #[test]
    fn test_mineru_v2_normalized_fixture_no_drift() {
        let temp_dir = TestTempDir::new("mineru_v2_drift");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();
        write_mineru_fixture_images(
            &raw_dir,
            &[
                ("fig_circuit.jpg", b"v2_real_circuit_bytes"),
                ("eq_snapshot.jpg", b"v2_real_formula_snapshot"),
                ("table_snapshot.jpg", b"v2_real_table_snapshot"),
                ("chart_curve.jpg", b"v2_real_chart_bytes"),
            ],
        );
        fs::write(
            raw_dir.join("xxx_content_list_v2.json"),
            MINERU_V2_REAL_SHAPE,
        )
        .unwrap();

        normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        let produced: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(normalized_dir.join("blocks.json")).unwrap(),
        )
        .unwrap();
        let committed: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/mineru_v2_real_shape_normalized.json"
        ))
        .unwrap();

        assert_eq!(
            produced,
            committed,
            "归一化产物与提交 fixture 不一致：请重新生成 \
             src-tauri/tests/fixtures/mineru_v2_real_shape_normalized.json \
             （可用离线回放入口或本测试调试输出）"
        );
    }

    #[test]
    fn test_mineru_v1_real_shape_fixture() {
        let temp_dir = TestTempDir::new("mineru_v1_real");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        let fig_bytes = b"v1_fig_bytes";
        let chart_bytes = b"v1_chart_bytes";
        let table_bytes = b"v1_table_bytes";
        let eq_bytes = b"v1_eq_bytes";
        write_mineru_fixture_images(
            &raw_dir,
            &[
                ("fig_v1.jpg", fig_bytes),
                ("chart_v1.jpg", chart_bytes),
                ("table_v1.jpg", table_bytes),
                ("eq_v1.jpg", eq_bytes),
            ],
        );

        fs::write(raw_dir.join("content_list.json"), MINERU_V1_REAL_SHAPE).unwrap();

        let diag = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.total_blocks, 8);
        assert!(diag.warnings.is_empty(), "v1 真实形状不应警告: {:?}", diag.warnings);

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();

        // v1 header/footer 是页眉/页脚，不是文档标题
        let header = blocks.iter().find(|b| b.raw_type.as_deref() == Some("header")).unwrap();
        assert_eq!(header.r#type, "page_header");
        assert_eq!(header.content, "4 Switch Realization");
        let footer = blocks.iter().find(|b| b.raw_type.as_deref() == Some("footer")).unwrap();
        assert_eq!(footer.r#type, "page_footer");
        assert_eq!(footer.content, "Sample v1 footer");

        // v1 表格：table_body HTML + table_caption/table_footnote + 截图备援
        let table = blocks.iter().find(|b| b.r#type == "table").unwrap();
        assert!(table.content.contains("<table"));
        assert!(table.content.contains("colspan=\"2\""));
        assert!(table.content.contains("$x _ { 1 }$"));
        assert_eq!(table.caption.as_deref(), Some("Table 1.1 Sample v1 table"));
        assert_eq!(table.footnote.as_deref(), Some("Note: sample v1 footnote"));
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(table.asset_ref.as_deref().unwrap())).unwrap(),
            table_bytes
        );

        // v1 chart：img_path 图片引用 + chart_caption/chart_footnote
        let chart = blocks.iter().find(|b| b.raw_type.as_deref() == Some("chart")).unwrap();
        assert_eq!(chart.r#type, "image");
        assert_eq!(chart.caption.as_deref(), Some("Fig. 1.2 Sample v1 chart"));
        assert_eq!(chart.footnote.as_deref(), Some("Chart footnote v1"));
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(chart.asset_ref.as_deref().unwrap())).unwrap(),
            chart_bytes
        );

        // v1 image：img_path + image_caption
        let image = blocks.iter().find(|b| b.raw_type.as_deref() == Some("image")).unwrap();
        assert_eq!(image.caption.as_deref(), Some("Fig. 1.1 Sample v1 figure"));
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(image.asset_ref.as_deref().unwrap())).unwrap(),
            fig_bytes
        );

        // v1 公式：$$ 包裹源码保留 + latex + 截图
        let formula = blocks.iter().find(|b| b.r#type == "formula").unwrap();
        assert!(formula.content.contains("$$"));
        assert!(formula.content.contains("\\sum _ { i } V _ { i } ^ { 2 }"));
        assert_eq!(formula.content_format.as_deref(), Some("latex"));
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(formula.asset_ref.as_deref().unwrap())).unwrap(),
            eq_bytes
        );

        // v1 段落保留行内公式
        let para = blocks.iter().find(|b| b.r#type == "paragraph").unwrap();
        assert!(para.content.contains("$V _ { g }$"));

        // 页码：来自 page_idx
        assert_eq!(para.page_source, Some(1));
        assert_eq!(chart.page_source, Some(2));
    }

    #[test]
    fn test_mineru_model_json_not_used_as_fallback() {
        let temp_dir = TestTempDir::new("mineru_model_only");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        // 只有 model.json（版面检测原始输出）：layout_dets/page_info，绝不能当 content_list 用
        let model_json = serde_json::json!([
            {
                "layout_dets": [
                    { "cls_id": 16, "label": "number", "score": 0.89, "bbox": [139, 100, 183, 126], "index": 1 },
                    { "cls_id": 7, "label": "figure_title", "score": 0.91, "bbox": [135, 222, 460, 285], "index": 3 }
                ],
                "page_info": { "page_no": 1, "height": 1405, "width": 992 }
            }
        ]);
        fs::write(raw_dir.join("xxx_model.json"), model_json.to_string()).unwrap();

        let err = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap_err();
        assert!(
            err.contains("model.json") && err.contains("不能作为"),
            "必须明确拒绝 model.json 回退: {}",
            err
        );
        assert!(!normalized_dir.join("blocks.json").exists());
    }

    #[test]
    fn test_mineru_v2_unknown_type_diagnostic() {
        let temp_dir = TestTempDir::new("mineru_v2_unknown");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        let content_list = serde_json::json!([
            [
                { "type": "paragraph", "content": { "paragraph_content": [
                    { "type": "text", "content": "Body text keeps pipeline valid." }
                ]}, "bbox": [95, 90, 851, 160] },
                { "type": "weird_future_type", "content": {
                    "some_text_field": "Diagnostic payload must not silently vanish"
                }, "bbox": [95, 200, 851, 260] }
            ]
        ]);
        fs::write(
            raw_dir.join("content_list_v2.json"),
            content_list.to_string(),
        )
        .unwrap();

        let diag = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        assert!(
            !diag.warnings.is_empty(),
            "未知类型必须留下警告: {:?}",
            diag.warnings
        );
        assert!(diag.warnings[0].contains("weird_future_type"));

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();
        let unknown = blocks.iter().find(|b| b.r#type == "unknown").unwrap();
        assert!(
            unknown.content.contains("未识别结构: weird_future_type"),
            "未知块必须保留诊断前缀: {}",
            unknown.content
        );
        assert!(
            unknown.content.contains("Diagnostic payload must not silently vanish"),
            "未知块内容不得静默丢弃: {}",
            unknown.content
        );
    }

    #[test]
    fn test_mineru_v2_empty_table_degrades_to_backup_image() {
        let temp_dir = TestTempDir::new("mineru_v2_empty_table");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(raw_dir.join("images")).unwrap();

        fs::write(raw_dir.join("images").join("table_shot.jpg"), b"table_shot_bytes").unwrap();

        let content_list = serde_json::json!([
            [
                { "type": "paragraph", "content": { "paragraph_content": [
                    { "type": "text", "content": "Body text keeps pipeline valid." }
                ]}, "bbox": [95, 90, 851, 160] },
                { "type": "table", "content": {
                    "image_source": { "path": "images/table_shot.jpg" },
                    "table_caption": [ { "type": "text", "content": "Table X Backup only" } ],
                    "table_footnote": [],
                    "html": "",
                    "table_type": "complex_table",
                    "table_nest_level": 0
                }, "bbox": [95, 200, 851, 400] }
            ]
        ]);
        fs::write(raw_dir.join("content_list_v2.json"), content_list.to_string()).unwrap();

        let diag = normalize_mineru_results(&raw_dir, &normalized_dir).unwrap();
        assert!(
            diag.warnings.iter().any(|w| w.contains("缺少 html 表格结构")),
            "空结构表格必须产生降级警告: {:?}",
            diag.warnings
        );

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();
        let table = blocks.iter().find(|b| b.r#type == "table").unwrap();
        assert!(table.content.is_empty(), "结构缺失时不得伪造表格内容");
        assert_eq!(
            table.asset_ref.as_deref(),
            Some("table_shot.jpg"),
            "必须保留备援图片引用供阅读器降级显示"
        );
        assert_eq!(table.caption.as_deref(), Some("Table X Backup only"));

        // content.md 中空表格不静默消失
        let md = fs::read_to_string(normalized_dir.join("content.md")).unwrap();
        assert!(md.contains("Table X Backup only"));
    }

    #[test]
    fn test_datalab_normalization_flow() {
        let temp_dir = TestTempDir::new("datalab_norm");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        fs::write(raw_dir.join("graph.png"), b"graph_bytes").unwrap();

        // 准备 Datalab result.json
        let result_json = serde_json::json!({
            "metadata": {
                "page_count": 1,
                "failed_pages": []
            },
            "children": [
                {
                    "block_type": "page",
                    "bbox": [0, 0, 1000, 1500],
                    "children": [
                        {
                            "block_type": "text",
                            "html": "<p>Datalab extracted paragraph</p>",
                            "bbox": [100, 150, 900, 300]
                        },
                        {
                            "block_type": "equation",
                            "html": "<math>\\alpha + \\beta</math>",
                            "bbox": [200, 350, 800, 500]
                        },
                        {
                            "block_type": "figure",
                            "image": "graph.png",
                            "html": "<p class='img-text'>Figure A: Performance Graph</p>",
                            "bbox": [100, 550, 900, 1100]
                        }
                    ]
                }
            ]
        });
        fs::write(raw_dir.join("result.json"), result_json.to_string()).unwrap();

        let diag = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.total_blocks, 3);
        assert_eq!(diag.formulas_count, 1);
        assert_eq!(diag.images_count, 1);

        assert!(normalized_dir.join("blocks.json").is_file());
        assert!(normalized_dir.join("content.md").is_file());
        assert!(normalized_dir.join("assets").join("graph.png").is_file());
    }

    #[test]
    fn test_missing_image_asset_rejection() {
        let temp_dir = TestTempDir::new("missing_img");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        // 引用了一个不存在的图片
        let content_list = serde_json::json!([
            {
                "type": "image",
                "img_path": "images/non_existent.png",
                "page_idx": 0,
                "bbox": [100, 100, 800, 800]
            }
        ]);
        fs::write(raw_dir.join("content_list.json"), content_list.to_string()).unwrap();

        let res = normalize_mineru_results(&raw_dir, &normalized_dir);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("缺少必需的本地图片资产"));
    }

    #[test]
    fn test_oversized_blocks_count_rejection() {
        let temp_dir = TestTempDir::new("oversized_blocks");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        // 生成超过 MAX_BLOCKS_COUNT (2000) 的条目
        let mut items = Vec::new();
        for i in 0..2005 {
            items.push(serde_json::json!({
                "type": "text",
                "text": format!("Paragraph {}", i),
                "page_idx": 0,
                "bbox": [100, 100, 800, 200]
            }));
        }
        fs::write(raw_dir.join("content_list.json"), serde_json::Value::Array(items).to_string()).unwrap();

        let res = normalize_mineru_results(&raw_dir, &normalized_dir);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("超出只读原型承载范围"));
    }

    // ---------- 真实 Datalab 结构（脱敏 fixture） ----------

    const DATALAB_FIXTURE: &str =
        include_str!("../tests/fixtures/datalab_null_markdown.json");

    fn write_datalab_fixture(raw_dir: &Path, json_text: &str) -> Vec<u8> {
        use base64::Engine;
        fs::create_dir_all(raw_dir.join("images")).unwrap();
        fs::write(raw_dir.join("result.json"), json_text).unwrap();

        let fixture: serde_json::Value = serde_json::from_str(DATALAB_FIXTURE).unwrap();
        let b64 = fixture["children"][0]["children"][3]["images"]["fig.png"]
            .as_str()
            .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        fs::write(raw_dir.join("images").join("fig.png"), &bytes).unwrap();
        bytes
    }

    #[test]
    fn test_datalab_real_fixture_null_markdown_uses_html() {
        let temp_dir = TestTempDir::new("datalab_fixture");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        let png = write_datalab_fixture(&raw_dir, DATALAB_FIXTURE);

        let diag = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap();
        assert!(diag.failed_pages.is_empty());

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();

        // 正文：markdown 为 null 时必须回退到 html
        let text = blocks
            .iter()
            .find(|b| b.r#type == "paragraph")
            .expect("应解析出正文块");
        assert!(
            text.content.contains("With the switch in position 1"),
            "正文内容丢失: {}",
            text.content
        );
        assert!(
            text.content.contains("$v_L$"),
            "行内公式未转换: {}",
            text.content
        );

        // 公式：MathML + HTML 实体必须解码为合法 LaTeX
        let formula = blocks
            .iter()
            .find(|b| b.r#type == "formula")
            .expect("应解析出公式块");
        assert!(
            formula.content.contains("v_L &= V_g"),
            "公式实体未解码或内容丢失: {}",
            formula.content
        );
        assert_eq!(formula.content_format.as_deref(), Some("latex"));

        // 图注
        let caption = blocks
            .iter()
            .find(|b| b.r#type == "caption")
            .expect("应解析出图注块");
        assert!(caption.content.contains("Fig. 2.13"));
        assert!(caption.content.contains("practical diode"));

        // 图片引用必须指向正确字节（不是“文件存在”）
        let image = blocks
            .iter()
            .find(|b| b.r#type == "image")
            .expect("应解析出图片块");
        let asset_ref = image.asset_ref.clone().expect("图片块必须有 asset_ref");
        assert_eq!(
            fs::read(normalized_dir.join("assets").join(&asset_ref)).unwrap(),
            png,
            "asset_ref 必须对应原始图片字节"
        );

        // 页信息与诊断
        assert_eq!(image.page_source, Some(1));
        assert!(image.normalized_bbox.is_some());

        let md = fs::read_to_string(normalized_dir.join("content.md")).unwrap();
        assert!(md.contains("With the switch in position 1"));
        assert!(md.contains("Fig. 2.13"));
        assert!(md.contains("assets/"));
    }

    #[test]
    fn test_datalab_failed_pages_reject_result() {
        let temp_dir = TestTempDir::new("datalab_failed_pages");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        write_datalab_fixture(&raw_dir, DATALAB_FIXTURE);

        let mut fixture: serde_json::Value = serde_json::from_str(DATALAB_FIXTURE).unwrap();
        fixture["metadata"]["failed_pages"] = serde_json::json!([0]);
        fs::write(raw_dir.join("result.json"), fixture.to_string()).unwrap();

        let err = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap_err();
        assert!(err.contains("失败"), "必须明确报告失败页: {}", err);
        assert!(
            !normalized_dir.join("blocks.json").exists(),
            "存在失败页时不得生成完整版本"
        );

        let diagnostics = fs::read_to_string(normalized_dir.join("diagnostics.json")).unwrap();
        let diag: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
        assert_eq!(diag["failed_pages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_datalab_all_empty_blocks_rejected() {
        let temp_dir = TestTempDir::new("datalab_empty");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        let empty = serde_json::json!({
            "children": [{
                "block_type": "Page",
                "bbox": [0, 0, 100, 100],
                "children": [
                    { "block_type": "Text", "html": "", "markdown": null, "images": {}, "bbox": [0,0,10,10] },
                    { "block_type": "Text", "html": null, "markdown": null, "images": {}, "bbox": [0,10,10,20] }
                ]
            }],
            "metadata": { "failed_pages": [] }
        });
        fs::write(raw_dir.join("result.json"), empty.to_string()).unwrap();

        let err = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap_err();
        assert!(
            err.contains("空") || err.contains("没有可阅读"),
            "全空块不能视为解析成功: {}",
            err
        );
    }

    #[test]
    fn test_html_entities_and_formula_order() {
        let temp_dir = TestTempDir::new("html_entities_order");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");
        fs::create_dir_all(&raw_dir).unwrap();

        let result_json = serde_json::json!({
            "metadata": { "failed_pages": [] },
            "children": [{
                "block_type": "Page",
                "bbox": [0, 0, 1000, 1000],
                "children": [
                    {
                        "block_type": "Text",
                        "html": "<p>Keep <math>x &lt; y</math> and keep this tail.</p>",
                        "markdown": null,
                        "bbox": [10, 10, 900, 50]
                    },
                    {
                        "block_type": "Text",
                        "html": "<p>Use &lt;node&gt; here.</p>",
                        "markdown": null,
                        "bbox": [10, 60, 900, 100]
                    },
                    {
                        "block_type": "Text",
                        "html": "<p>Compare <math>a &lt; b</math> and <math>c &gt; d</math> here</p>",
                        "markdown": null,
                        "bbox": [10, 110, 900, 150]
                    },
                    {
                        "block_type": "Equation",
                        "html": "<p><math display=\"block\">x &lt; y \\tag{1}</math></p>",
                        "markdown": null,
                        "bbox": [10, 160, 900, 200]
                    },
                    {
                        "block_type": "Table",
                        "html": "<table><tr><td>Cell with <math>x &lt; y</math></td><td>&lt;td&gt; literal tag</td></tr></table>",
                        "markdown": null,
                        "bbox": [10, 210, 900, 300]
                    },
                    {
                        "block_type": "Caption",
                        "html": "<p><b>Fig. 1</b>: Diode when <math>x &lt; y</math></p>",
                        "markdown": null,
                        "bbox": [10, 310, 900, 350]
                    }
                ]
            }]
        });
        fs::write(raw_dir.join("result.json"), result_json.to_string()).unwrap();

        let diag = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.failed_pages.len(), 0);

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();

        // 1. Keep <math>x &lt; y</math> and keep this tail.
        let b1 = &blocks[0];
        assert!(
            b1.content.contains("Keep"),
            "必须保留前缀 Keep: {}",
            b1.content
        );
        assert!(
            b1.content.contains("$x < y$"),
            "必须正确提取公式 $x < y$: {}",
            b1.content
        );
        assert!(
            b1.content.contains("and keep this tail."),
            "不得因先解码实体导致比较符被删标签吞掉尾部正文: {}",
            b1.content
        );

        // 2. Use &lt;node&gt; here.
        let b2 = &blocks[1];
        assert!(
            b2.content.contains("&lt;node&gt;"),
            "字面 <node> 必须保留为实体 &lt;node&gt; 以防被阅读器当作 HTML 标签丢弃: {}",
            b2.content
        );
        assert!(
            !b2.content.contains("Use  here."),
            "不得将 <node> 作为标签误删: {}",
            b2.content
        );

        // 3. 多个公式
        let b3 = &blocks[2];
        assert!(b3.content.contains("$a < b$") && b3.content.contains("$c > d$") && b3.content.contains("here"));

        // 4. 公式块
        let b4 = &blocks[3];
        assert_eq!(b4.r#type, "formula");
        assert!(b4.content.contains("x < y"), "公式内部实体必须解码为合法 LaTeX: {}", b4.content);

        // 5. 表格
        let b5 = &blocks[4];
        assert_eq!(b5.r#type, "table");
        assert!(b5.content.contains("&lt;td&gt;"), "表格内部字面标签实体不得被解码为真实标签: {}", b5.content);

        // 6. 图注
        let b6 = &blocks[5];
        assert_eq!(b6.r#type, "caption");
        assert!(b6.content.contains("$x < y$") && b6.content.contains("Diode when"));
    }

    #[tokio::test]
    async fn test_datalab_e2e_images_save_and_normalize() {
        use base64::Engine;
        let temp_dir = TestTempDir::new("datalab_e2e_images");
        let raw_dir = temp_dir.path().join("raw");
        let normalized_dir = temp_dir.path().join("normalized");

        let bytes_a = b"PNG_DATA_A_CONTENT";
        let bytes_b = b"PNG_DATA_B_DIFFERENT";
        let bytes_c = b"PNG_DATA_A_CONTENT"; // same content as A, different path

        let b64_a = base64::engine::general_purpose::STANDARD.encode(bytes_a);
        let b64_b = base64::engine::general_purpose::STANDARD.encode(bytes_b);
        let b64_c = base64::engine::general_purpose::STANDARD.encode(bytes_c);

        let data = serde_json::json!({
            "status": "complete",
            "success": true,
            "children": [{
                "block_type": "Page",
                "bbox": [0, 0, 1000, 1000],
                "children": [
                    {
                        "block_type": "Text",
                        "html": "<p>Image Test Intro</p>",
                        "bbox": [0, 0, 100, 50]
                    },
                    {
                        "block_type": "Figure",
                        "images": {
                            "a/fig.png": format!("data:image/png;base64,{}", b64_a)
                        },
                        "bbox": [0, 50, 200, 200]
                    },
                    {
                        "block_type": "Figure",
                        "images": {
                            "b/fig.png": format!("data:image/png;base64,{}", b64_b)
                        },
                        "bbox": [0, 200, 200, 400]
                    },
                    {
                        "block_type": "Figure",
                        "images": {
                            "c/fig.png": format!("data:image/png;base64,{}", b64_c)
                        },
                        "bbox": [0, 400, 200, 600]
                    }
                ]
            }],
            "metadata": { "failed_pages": [] }
        });

        let status_res = crate::parse_providers::datalab::DatalabStatusResult {
            status: "done".to_string(),
            raw_status: "complete".to_string(),
            success: Some(true),
            error: None,
            result_url: None,
            data: data.clone(),
        };

        let client = crate::parse_providers::datalab::DatalabClient::new("dummy_key".to_string());
        let warnings = client.save_results(&status_res, &raw_dir).await.unwrap();
        assert!(warnings.is_empty(), "保存结果不应有警告: {:?}", warnings);

        let diag = normalize_datalab_results(&raw_dir, &normalized_dir).unwrap();
        assert_eq!(diag.images_count, 3);

        let blocks_text = fs::read_to_string(normalized_dir.join("blocks.json")).unwrap();
        let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text).unwrap();

        let fig_a = blocks.iter().find(|b| b.id == "datalab_blk_0002").unwrap();
        let fig_b = blocks.iter().find(|b| b.id == "datalab_blk_0003").unwrap();
        let fig_c = blocks.iter().find(|b| b.id == "datalab_blk_0004").unwrap();

        let ref_a = fig_a.asset_ref.as_ref().unwrap();
        let ref_b = fig_b.asset_ref.as_ref().unwrap();
        let ref_c = fig_c.asset_ref.as_ref().unwrap();

        // a/fig.png 与 b/fig.png 内容不同，必须落盘为不同资产
        assert_ne!(ref_a, ref_b, "不同内容图片不能共享 asset_ref");
        assert_eq!(fs::read(normalized_dir.join("assets").join(ref_a)).unwrap(), bytes_a);
        assert_eq!(fs::read(normalized_dir.join("assets").join(ref_b)).unwrap(), bytes_b);

        // a/fig.png 与 c/fig.png 内容相同但路径不同，按哈希去重共享同一资产
        assert_eq!(ref_a, ref_c, "相同内容不同路径应哈希去重");

        // 测试裸文件名歧义：当只有 a/fig.png 与 b/fig.png 时，若结构块引用了未带路径的 fig.png，候选不唯一必须报歧义
        let mut ambiguous_data = data.clone();
        // 移除非歧义的 c，并加入一个仅引用裸 basename "fig.png" 的块
        ambiguous_data["children"][0]["children"].as_array_mut().unwrap().retain(|b| {
            b.get("images").and_then(|m| m.get("c/fig.png")).is_none()
        });
        ambiguous_data["children"][0]["children"].as_array_mut().unwrap().push(serde_json::json!({
            "block_type": "Figure",
            "html": "<img src=\"fig.png\"/>",
            "images": {},
            "bbox": [0, 600, 200, 800]
        }));
        let amb_raw = temp_dir.path().join("raw_ambiguous");
        let amb_norm = temp_dir.path().join("norm_ambiguous");
        let amb_status = crate::parse_providers::datalab::DatalabStatusResult {
            status: "done".to_string(),
            raw_status: "complete".to_string(),
            success: Some(true),
            error: None,
            result_url: None,
            data: ambiguous_data,
        };
        client.save_results(&amb_status, &amb_raw).await.unwrap();
        let amb_err = normalize_datalab_results(&amb_raw, &amb_norm).unwrap_err();
        assert!(amb_err.contains("歧义"), "缺少路径且候选不唯一的 fig.png 必须报歧义: {}", amb_err);
    }
}

