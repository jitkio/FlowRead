//! MinerU 真实产物离线回放
//!
//! 链路：原始分册目录 → 生产 `normalize_mineru_results` → blocks.json/assets
//!       → 隔离的隐式工作区导入（临时 SQLite + 独立工作区目录）
//!       → 经生产预览会话（`open_preview_internal` / `read_asset_internal`）做阅读器数据校验
//!
//! 约束：
//! - 默认不联网、不读取任何凭据；只依赖文件系统与生产归一化/工作区函数；
//! - 工作区与数据库一律落在专用输出目录（不触碰用户真实数据库与工作区）；
//! - 原始产物目录只读；输出目录带标记文件，重复回放时只清理自己生成的目录；
//! - 分册页码与整本源页码分离：没有可靠 manifest 时按独立分册处理，页码保留分册局部值。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db;
use crate::parse_normalize::{
    detect_mineru_v2, find_mineru_content_list_file, mineru_v2_runs_to_text,
    normalize_mineru_results, ParsedBlock,
};
use crate::parsed_preview::{
    close_preview_internal, open_preview_internal, read_asset_internal, ParsedPreviewState,
};
use crate::parsed_workspace::{
    get_active_internal, import_normalized_dir_with_options, ParsedImportOptions,
};

/// 回放输出目录的标记文件：只有带此标记的目录才允许被重复回放清理
const REPLAY_MARKER_FILE: &str = ".flowread_replay_marker";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReplayCheck {
    pub name: String,
    pub passed: bool,
    pub details: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReplayReport {
    pub input_dir: String,
    pub output_dir: String,
    pub content_list_file: String,
    pub content_list_format: String, // "v2" | "v1"
    pub input_pages: usize,
    pub input_blocks: usize,
    pub input_type_counts: BTreeMap<String, usize>,
    pub output_blocks: usize,
    pub output_type_counts: BTreeMap<String, usize>,
    pub normalization_warnings: Vec<String>,
    pub version_id: String,
    pub document_id: String,
    pub workspace_doc_dir: String,
    /// 可直接传给“打开解析结果预览”的 blocks.json 路径（隔离输出目录内）
    pub preview_blocks_path: String,
    pub checks: Vec<ReplayCheck>,
    pub overall_pass: bool,
}

/// 输入侧的统计与期望：从原始 content_list 中提取，作为输出对账基准
struct InputBaseline {
    format: String,
    pages: usize,
    total_blocks: usize,
    type_counts: BTreeMap<String, usize>,
    /// (reading index 1-based, page 1-based) — 与归一化产物的 page_source 对账
    block_pages: Vec<usize>,
    titles: Vec<String>,          // v2 title_content 文字（v1 无层级标题类型，置空）
    title_levels: Vec<Option<i64>>,
    table_captions: Vec<String>,
    table_html_nonempty: usize,
    table_cells_samples: Vec<Vec<String>>, // 每张表的代表性单元格纯文本（最多 5 个）
    equations_total: usize,
    equations_with_source: usize,
    image_refs: Vec<String>,      // image/chart 的图片相对路径（images/xxx.jpg）
    image_captions: Vec<String>,  // image/chart 的图注文字
}

/// v2 runs 数组提取文字：直接复用生产拼接函数，
/// 保证对账基线与归一化输出语义完全一致（行内公式同样补 `$...$`）
fn baseline_v2_runs_text(runs: &[serde_json::Value]) -> String {
    mineru_v2_runs_to_text(runs).trim().to_string()
}

/// 宽松文本比对：剥离公式定界符 `$` 与 Markdown 标题前缀 `#` 后折叠空白，
/// 再判断是否包含。用于“文字是否保留”的对账——归一化会给行内公式补 `$...$`、
/// 会为标题补 `#` 层级前缀，逐字符相等会把这些合法加工误判为内容丢失。
fn loose_contains(haystack: &str, needle: &str) -> bool {
    fn normalize(s: &str) -> String {
        s.replace('$', "")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
            .trim_start_matches('#')
            .trim()
            .to_string()
    }
    let h = normalize(haystack);
    let n = normalize(needle);
    !n.is_empty() && h.contains(&n)
}

/// 从 HTML 表格中提取代表性单元格纯文本（去标签、去 `$` 定界，保留单词空格）
fn baseline_table_cell_samples(html: &str) -> Vec<String> {
    let cell_re = regex::Regex::new(r"<t[dh][^>]*>(.*?)</t[dh]>").unwrap();
    let tag_re = regex::Regex::new(r"<[^>]+>").unwrap();
    let mut samples = Vec::new();
    for cap in cell_re.captures_iter(html) {
        let inner = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let plain = tag_re
            .replace_all(inner, "")
            .replace('$', "")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ");
        if plain.len() >= 2 && !samples.iter().any(|s: &String| *s == plain) {
            samples.push(plain);
        }
        if samples.len() >= 5 {
            break;
        }
    }
    samples
}

/// 解析输入 content_list，建立对账基准
fn collect_input_baseline(content_list_path: &Path) -> Result<InputBaseline, String> {
    let raw = fs::read_to_string(content_list_path)
        .map_err(|e| format!("读取输入结构文件失败: {}", e))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("输入结构文件语法错误: {}", e))?;
    let top = parsed
        .as_array()
        .ok_or_else(|| "输入结构文件顶层必须是数组".to_string())?;

    let is_v2 = detect_mineru_v2(top);
    let mut baseline = InputBaseline {
        format: if is_v2 { "v2".to_string() } else { "v1".to_string() },
        pages: 0,
        total_blocks: 0,
        type_counts: BTreeMap::new(),
        block_pages: Vec::new(),
        titles: Vec::new(),
        title_levels: Vec::new(),
        table_captions: Vec::new(),
        table_html_nonempty: 0,
        table_cells_samples: Vec::new(),
        equations_total: 0,
        equations_with_source: 0,
        image_refs: Vec::new(),
        image_captions: Vec::new(),
    };

    let push_block = |baseline: &mut InputBaseline, block: &serde_json::Value, page: usize| {
        let raw_type = block
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        *baseline.type_counts.entry(raw_type.clone()).or_insert(0) += 1;
        baseline.total_blocks += 1;
        baseline.block_pages.push(page);

        if is_v2 {
            let content = block.get("content");
            match raw_type.as_str() {
                "title" | "heading" => {
                    let c = content.and_then(|v| v.as_object());
                    let text = c
                        .and_then(|m| m.get("title_content"))
                        .and_then(|v| v.as_array())
                        .map(|runs| baseline_v2_runs_text(runs))
                        .unwrap_or_default();
                    let level = c.and_then(|m| m.get("level")).and_then(|v| v.as_i64());
                    if !text.is_empty() {
                        baseline.titles.push(text);
                        baseline.title_levels.push(level);
                    }
                }
                "table" => {
                    let c = content.and_then(|v| v.as_object());
                    let html = c
                        .and_then(|m| m.get("html"))
                        .or_else(|| c.and_then(|m| m.get("table_body")))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !html.trim().is_empty() {
                        baseline.table_html_nonempty += 1;
                        baseline.table_cells_samples.push(baseline_table_cell_samples(html));
                    }
                    let caption = c
                        .and_then(|m| m.get("table_caption"))
                        .and_then(|v| v.as_array())
                        .map(|runs| baseline_v2_runs_text(runs))
                        .unwrap_or_default();
                    if !caption.is_empty() {
                        baseline.table_captions.push(caption);
                    }
                }
                t if t.contains("equation") || t.contains("formula") => {
                    baseline.equations_total += 1;
                    let math = content
                        .and_then(|v| v.get("math_content"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !math.trim().is_empty() {
                        baseline.equations_with_source += 1;
                    }
                }
                "image" | "chart" | "figure" => {
                    if let Some(path) = content
                        .and_then(|v| v.get("image_source"))
                        .and_then(|v| v.get("path"))
                        .and_then(|v| v.as_str())
                    {
                        baseline.image_refs.push(path.trim().to_string());
                    }
                    let caps_key = if raw_type == "chart" { "chart_caption" } else { "image_caption" };
                    let caption = content
                        .and_then(|v| v.get(caps_key))
                        .and_then(|v| v.as_array())
                        .map(|runs| baseline_v2_runs_text(runs))
                        .unwrap_or_default();
                    if !caption.is_empty() {
                        baseline.image_captions.push(caption);
                    }
                }
                _ => {}
            }
        } else {
            match raw_type.as_str() {
                "title" => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !text.trim().is_empty() {
                        baseline.titles.push(text.trim().to_string());
                        baseline.title_levels.push(None);
                    }
                }
                "table" => {
                    let body = block.get("table_body").and_then(|v| v.as_str()).unwrap_or("");
                    if !body.trim().is_empty() {
                        baseline.table_html_nonempty += 1;
                        baseline.table_cells_samples.push(baseline_table_cell_samples(body));
                    }
                    let caption = block
                        .get("table_caption")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<&str>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    if !caption.trim().is_empty() {
                        baseline.table_captions.push(caption.trim().to_string());
                    }
                }
                t if t.contains("equation") || t.contains("formula") => {
                    baseline.equations_total += 1;
                    let math = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    if !math.trim().is_empty() {
                        baseline.equations_with_source += 1;
                    }
                }
                "image" | "chart" | "figure" => {
                    if let Some(path) = block.get("img_path").and_then(|v| v.as_str()) {
                        baseline.image_refs.push(path.trim().to_string());
                    }
                    let caps_key = if raw_type == "chart" { "chart_caption" } else { "image_caption" };
                    let caption = block
                        .get(caps_key)
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<&str>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    if !caption.trim().is_empty() {
                        baseline.image_captions.push(caption.trim().to_string());
                    }
                }
                _ => {}
            }
        }
    };

    if is_v2 && top.iter().any(|p| p.is_array()) {
        baseline.pages = top.len();
        for (p_idx, page_val) in top.iter().enumerate() {
            if let Some(page_blocks) = page_val.as_array() {
                for block in page_blocks {
                    push_block(&mut baseline, block, p_idx + 1);
                }
            }
        }
    } else {
        let max_page = top
            .iter()
            .filter_map(|b| b.get("page_idx").and_then(|v| v.as_i64()))
            .max()
            .unwrap_or(0);
        baseline.pages = (max_page + 1).max(1) as usize;
        for block in top {
            let page = block
                .get("page_idx")
                .and_then(|v| v.as_i64())
                .map(|v| (v + 1) as usize)
                .unwrap_or(1);
            push_block(&mut baseline, block, page);
        }
    }

    Ok(baseline)
}

/// 建立回放专用 SQLite schema（documents + parsed_document_versions），
/// 与生产 parsed_document_versions 表结构一致，但落在隔离的临时数据库文件。
fn setup_replay_db(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开回放数据库失败: {}", e))?;
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

        CREATE UNIQUE INDEX idx_parsed_doc_single_active
            ON parsed_document_versions(document_id) WHERE is_active = 1;
        ",
    )
    .map_err(|e| format!("创建回放数据库 schema 失败: {}", e))?;
    Ok(conn)
}

/// 校验输出目录可安全使用：不存在则创建；存在则必须是此前回放自己生成的目录
fn prepare_output_dir(output_dir: &Path) -> Result<(), String> {
    if output_dir.exists() {
        let marker = output_dir.join(REPLAY_MARKER_FILE);
        if !marker.is_file() {
            return Err(format!(
                "输出目录已存在且不含回放标记文件，拒绝覆盖: {}",
                output_dir.display()
            ));
        }
        // 只清理我们自己生成的目录（逐层校验标记文件仍在）
        fs::remove_dir_all(output_dir)
            .map_err(|e| format!("清理既有回放输出目录失败: {}", e))?;
    }
    fs::create_dir_all(output_dir).map_err(|e| format!("创建回放输出目录失败: {}", e))?;
    fs::write(
        output_dir.join(REPLAY_MARKER_FILE),
        "generated by mineru_offline_replay; safe to delete",
    )
    .map_err(|e| format!("写入回放标记文件失败: {}", e))?;
    Ok(())
}

/// 主回放入口：复用生产归一化与隐式工作区导入，全程离线。
///
/// `raw_part_dir`：原始分册产物目录（含 images/ 与 content_list(_v2).json；只读）
/// `output_root`：回放输出根目录（新建隔离子目录 `<part_name>/`）
pub fn run_mineru_offline_replay(
    raw_part_dir: &Path,
    output_root: &Path,
) -> Result<ReplayReport, String> {
    if !raw_part_dir.is_dir() {
        return Err(format!("原始分册目录不存在: {}", raw_part_dir.display()));
    }
    let part_name = raw_part_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("part")
        .to_string();

    let search_root = if raw_part_dir.join("extracted").is_dir() {
        raw_part_dir.join("extracted")
    } else {
        raw_part_dir.to_path_buf()
    };

    // 1. 与生产完全相同的结构文件选择与 v1/v2 识别
    let content_list_path = find_mineru_content_list_file(&search_root).ok_or_else(|| {
        format!(
            "原始目录中未找到 content_list.json / content_list_v2.json: {}",
            raw_part_dir.display()
        )
    })?;
    let baseline = collect_input_baseline(&content_list_path)?;
    if baseline.total_blocks == 0 {
        return Err("输入结构文件中没有任何结构块".to_string());
    }

    // 2. 隔离输出目录
    let output_dir = output_root.join(&part_name);
    prepare_output_dir(&output_dir)?;
    let normalized_dir = output_dir.join("normalized");
    let workspace_dir = output_dir.join("workspace");
    let db_path = output_dir.join("replay.db");

    // 3. 生产归一化
    let diagnostics = normalize_mineru_results(raw_part_dir, &normalized_dir)?;

    // 4. 隔离工作区导入（临时 SQLite + 独立工作区目录）
    let mut conn = setup_replay_db(&db_path)?;
    let canonical_raw = raw_part_dir
        .canonicalize()
        .map_err(|e| format!("规范化原始目录路径失败: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(fs::read(&content_list_path).map_err(|e| format!("读取结构文件失败: {}", e))?);
    let source_revision = format!("offline-replay:{:x}", hasher.finalize());
    let document_id = format!("replay_{}", part_name);

    conn.execute(
        "INSERT INTO documents (id, file_path, display_name, file_size, revision, last_read_position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, NULL, ?5, ?5)",
        rusqlite::params![
            document_id,
            canonical_raw.to_string_lossy(),
            part_name,
            source_revision,
            db::now_ms()
        ],
    )
    .map_err(|e| format!("登记回放文档失败: {}", e))?;

    let (version_id, block_count, _asset_count, _rel, _activated) =
        import_normalized_dir_with_options(
            &workspace_dir,
            &mut conn,
            &document_id,
            &source_revision,
            "mineru",
            "mineru:offline-replay",
            &normalized_dir,
            ParsedImportOptions {
                expected_active_version_id: None,
                activate: true,
                job_id: None,
                version_id_override: None,
            },
        )?;

    // 5. 生产“取激活版本 + 建预览会话”链路读取回工作区产物
    let preview_state = ParsedPreviewState::new();
    let active = get_active_internal(&workspace_dir, &conn, &preview_state, &document_id)?
        .ok_or_else(|| "导入后未找到激活的解析版本".to_string())?;
    let blocks_text = fs::read_to_string(&active.blocks_path)
        .map_err(|e| format!("读取工作区 blocks.json 失败: {}", e))?;
    let blocks: Vec<ParsedBlock> = serde_json::from_str(&blocks_text)
        .map_err(|e| format!("工作区 blocks.json 语法错误: {}", e))?;

    // 6. 校验
    let mut checks: Vec<ReplayCheck> = Vec::new();

    // 6.1 块对账：输入每个块必须出现在输出中（含页眉/页码/页脚，前端显示时另作过滤）
    {
        let mut out_counts: BTreeMap<String, usize> = BTreeMap::new();
        for b in &blocks {
            *out_counts.entry(b.r#type.clone()).or_insert(0) += 1;
        }
        let mut details = format!(
            "输入 {} 块 / 输出 {} 块；类型映射: ",
            baseline.total_blocks,
            blocks.len()
        );
        for (t, c) in &baseline.type_counts {
            details.push_str(&format!("{}×{}→", t, c));
        }
        details.push_str(" ; 输出类型: ");
        for (t, c) in &out_counts {
            details.push_str(&format!("{}×{} ", t, c));
        }
        let passed = baseline.total_blocks == blocks.len();
        checks.push(ReplayCheck {
            name: "块对账".to_string(),
            passed,
            details,
        });

        // 对账副本供报告使用
        let _ = &out_counts;
    }

    // 6.2 标题：输入侧每个标题文字都必须出现在某个输出 heading 块中（前缀感知）
    {
        let headings: Vec<&ParsedBlock> =
            blocks.iter().filter(|b| b.r#type == "heading").collect();
        let mut missing = Vec::new();
        for title in &baseline.titles {
            let found = headings
                .iter()
                .any(|h| loose_contains(&h.content, title));
            if !found {
                missing.push(title.clone());
            }
        }
        let level_mismatch = baseline
            .title_levels
            .iter()
            .zip(baseline.titles.iter())
            .filter(|(lvl, title)| {
                if let Some(l) = lvl {
                    !headings
                        .iter()
                        .any(|h| loose_contains(&h.content, title) && h.heading_level == Some(*l))
                } else {
                    false
                }
            })
            .count();
        let empty_headings = headings.iter().filter(|h| h.content.trim_matches('#').trim().is_empty()).count();
        let passed = missing.is_empty() && level_mismatch == 0 && empty_headings == 0;
        checks.push(ReplayCheck {
            name: "标题内容与层级".to_string(),
            passed,
            details: format!(
                "输入标题 {} 个，输出 heading 块 {} 个，缺失 {} 个，层级不符 {} 个，空标题 {} 个{}{}",
                baseline.titles.len(),
                headings.len(),
                missing.len(),
                level_mismatch,
                empty_headings,
                if missing.is_empty() { String::new() } else { format!("；缺失: {}", missing.join(" | ")) },
                if baseline.format == "v1" { "（v1 无标题层级字段）" } else { "" }
            ),
        });
    }

    // 6.3 表格：HTML 主体、代表性单元格、图注、备援图片
    {
        let tables: Vec<&ParsedBlock> = blocks.iter().filter(|b| b.r#type == "table").collect();
        let mut problems = Vec::new();
        for (idx, samples) in baseline.table_cells_samples.iter().enumerate() {
            let table = tables.get(idx);
            match table {
                None => problems.push(format!("第 {} 张表在输出中缺失", idx + 1)),
                Some(t) => {
                    for sample in samples {
                        if !loose_contains(&t.content, sample) {
                            problems.push(format!("第 {} 张表缺少代表单元格 '{}'", idx + 1, sample));
                        }
                    }
                    if t.content_format.as_deref() != Some("html") {
                        problems.push(format!("第 {} 张表 content_format 不是 html", idx + 1));
                    }
                }
            }
        }
        for caption in &baseline.table_captions {
            if !tables.iter().any(|t| {
                t.caption
                    .as_deref()
                    .map(|c| loose_contains(c, caption))
                    .unwrap_or(false)
            }) {
                problems.push(format!("表注缺失: {}", caption));
            }
        }
        checks.push(ReplayCheck {
            name: "表格内容与图注".to_string(),
            passed: problems.is_empty(),
            details: format!(
                "输入有结构表格 {} 张，输出表格块 {} 个；{}",
                baseline.table_html_nonempty,
                tables.len(),
                if problems.is_empty() { "单元格/图注核对通过".to_string() } else { problems.join("；") }
            ),
        });
    }

    // 6.4 独立公式：数量与源码非空
    {
        let formulas: Vec<&ParsedBlock> = blocks.iter().filter(|b| b.r#type == "formula").collect();
        let empty = formulas.iter().filter(|f| f.content.trim().is_empty()).count();
        let not_latex = formulas
            .iter()
            .filter(|f| f.content_format.as_deref() != Some("latex"))
            .count();
        let passed = formulas.len() == baseline.equations_total && empty == 0 && not_latex == 0;
        checks.push(ReplayCheck {
            name: "独立公式源码".to_string(),
            passed,
            details: format!(
                "输入公式 {} 个（含源码 {}），输出 formula 块 {} 个，空源码 {} 个，非 latex {} 个",
                baseline.equations_total,
                baseline.equations_with_source,
                formulas.len(),
                empty,
                not_latex
            ),
        });
    }

    // 6.5 图片资产：每个输入引用在输出中有块、经会话读取字节与原始文件一致
    {
        let mut problems = Vec::new();
        let image_blocks: Vec<&ParsedBlock> =
            blocks.iter().filter(|b| b.r#type == "image").collect();
        for ref_path in &baseline.image_refs {
            let raw_file = search_root.join(ref_path);
            let raw_bytes = match fs::read(&raw_file) {
                Ok(b) => b,
                Err(e) => {
                    problems.push(format!("原始图片不可读 {}: {}", ref_path, e));
                    continue;
                }
            };
            let mut hasher = Sha256::new();
            hasher.update(&raw_bytes);
            let raw_hash = format!("{:x}", hasher.finalize());

            let found = image_blocks.iter().any(|b| {
                b.asset_ref.as_deref().map(|a| {
                    read_asset_internal(&active.session_id, a, &preview_state.sessions)
                        .map(|bytes| {
                            let mut h = Sha256::new();
                            h.update(&bytes);
                            format!("{:x}", h.finalize()) == raw_hash
                        })
                        .unwrap_or(false)
                }).unwrap_or(false)
            });
            if !found {
                problems.push(format!("图片引用未找到字节一致的资产: {}", ref_path));
            }
        }
        for caption in &baseline.image_captions {
            if !image_blocks.iter().any(|b| {
                b.caption
                    .as_deref()
                    .map(|c| loose_contains(c, caption))
                    .unwrap_or(false)
            }) {
                problems.push(format!("图注缺失: {}", caption));
            }
        }
        checks.push(ReplayCheck {
            name: "图片资产与图注".to_string(),
            passed: problems.is_empty(),
            details: format!(
                "输入图片引用 {} 个，输出 image 块 {} 个；{}",
                baseline.image_refs.len(),
                image_blocks.len(),
                if problems.is_empty() { "字节级对账通过".to_string() } else { problems.join("；") }
            ),
        });
    }

    // 6.6 页码与块顺序：分册局部页码、每页块数、reading_order 连续递增
    {
        let mut problems = Vec::new();
        for (idx, b) in blocks.iter().enumerate() {
            let expected_order = (idx + 1) as i64;
            if b.reading_order != expected_order {
                problems.push(format!("第 {} 块 reading_order={} 不连续", idx + 1, b.reading_order));
                break;
            }
        }
        for b in &blocks {
            let page = b.page_source.unwrap_or(-1);
            if page < 1 || page as usize > baseline.pages {
                problems.push(format!("块 {} 页码 {} 超出分册范围 1..{}", b.id, page, baseline.pages));
                break;
            }
        }
        // 逐页对账：输入每页块数 == 输出每页块数
        let mut in_per_page: BTreeMap<usize, usize> = BTreeMap::new();
        for p in &baseline.block_pages {
            *in_per_page.entry(*p).or_insert(0) += 1;
        }
        let mut out_per_page: BTreeMap<usize, usize> = BTreeMap::new();
        for b in &blocks {
            *out_per_page.entry(b.page_source.unwrap_or(-1) as usize).or_insert(0) += 1;
        }
        for (page, in_count) in &in_per_page {
            let out_count = out_per_page.get(page).copied().unwrap_or(0);
            if *in_count != out_count {
                problems.push(format!("第 {} 页输入 {} 块 / 输出 {} 块不一致", page, in_count, out_count));
            }
        }
        checks.push(ReplayCheck {
            name: "页码与块顺序".to_string(),
            passed: problems.is_empty(),
            details: if problems.is_empty() {
                format!("{} 页逐页块数一致，reading_order 连续递增（分册局部页码，未做整书页码映射）", baseline.pages)
            } else {
                problems.join("；")
            },
        });
    }

    // 6.7 content.md 代表性内容
    {
        let md_path = normalized_dir.join("content.md");
        let md = fs::read_to_string(&md_path).unwrap_or_default();
        let mut problems = Vec::new();
        if md.is_empty() {
            problems.push("content.md 为空".to_string());
        }
        if let Some(first_title) = baseline.titles.first() {
            if !md.is_empty() && !loose_contains(&md, first_title) {
                problems.push(format!("content.md 缺少标题: {}", first_title));
            }
        }
        if let Some(first_caption) = baseline.table_captions.first() {
            if !md.is_empty() && !loose_contains(&md, first_caption) {
                problems.push(format!("content.md 缺少表注: {}", first_caption));
            }
        }
        checks.push(ReplayCheck {
            name: "content.md 代表性内容".to_string(),
            passed: problems.is_empty(),
            details: if problems.is_empty() {
                format!("content.md 包含标题与表注代表内容（{} 字节）", md.len())
            } else {
                problems.join("；")
            },
        });
    }

    // 6.8 工作区导入与会话读取
    {
        let preview_open = open_preview_internal(&active.blocks_path, &preview_state.sessions);
        let ok_session = preview_open.is_ok();
        if let Ok(info) = &preview_open {
            let _ = close_preview_internal(&info.session_id, &preview_state.sessions);
        }
        let passed = block_count as usize == blocks.len()
            && active.has_assets == baseline.image_refs.first().is_some()
            && ok_session;
        checks.push(ReplayCheck {
            name: "工作区导入与会话读取".to_string(),
            passed,
            details: format!(
                "version_id={}，登记块数 {} / 实际 {}，assets {}，blocks.json 可经开预览会话读取: {}",
                version_id,
                block_count,
                blocks.len(),
                active.has_assets,
                ok_session
            ),
        });
    }

    let overall_pass = checks.iter().all(|c| c.passed);

    let report = ReplayReport {
        input_dir: raw_part_dir.to_string_lossy().to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        content_list_file: content_list_path.to_string_lossy().to_string(),
        content_list_format: baseline.format.clone(),
        input_pages: baseline.pages,
        input_blocks: baseline.total_blocks,
        input_type_counts: baseline.type_counts.clone(),
        output_blocks: blocks.len(),
        output_type_counts: {
            let mut m: BTreeMap<String, usize> = BTreeMap::new();
            for b in &blocks {
                *m.entry(b.r#type.clone()).or_insert(0) += 1;
            }
            m
        },
        normalization_warnings: diagnostics.warnings.clone(),
        version_id: version_id.clone(),
        document_id: document_id.clone(),
        workspace_doc_dir: active.doc_dir.clone(),
        preview_blocks_path: active.blocks_path.clone(),
        checks,
        overall_pass,
    };

    // 7. 写报告（JSON + Markdown）
    let report_json = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("序列化回放报告失败: {}", e))?;
    fs::write(output_dir.join("replay-report.json"), &report_json)
        .map_err(|e| format!("写入 replay-report.json 失败: {}", e))?;
    fs::write(
        output_dir.join("replay-report.md"),
        render_report_markdown(&report),
    )
    .map_err(|e| format!("写入 replay-report.md 失败: {}", e))?;

    Ok(report)
}

fn render_report_markdown(report: &ReplayReport) -> String {
    let mut out = String::new();
    out.push_str("# MinerU 真实产物离线回放报告\n\n");
    out.push_str(&format!("- 输入目录：`{}`\n", report.input_dir));
    out.push_str(&format!("- 结构文件：`{}`（{} 格式）\n", report.content_list_file, report.content_list_format));
    out.push_str(&format!("- 输入：{} 页 / {} 块\n", report.input_pages, report.input_blocks));
    out.push_str(&format!("- 输出：{} 块\n", report.output_blocks));
    out.push_str(&format!("- 隔离工作区：`{}`\n", report.workspace_doc_dir));
    out.push_str(&format!("- 版本：`{}` / 文档：`{}`\n", report.version_id, report.document_id));
    out.push_str(&format!(
        "- 预览入口（可用于应用内“打开解析结果预览”）：`{}`\n",
        report.preview_blocks_path
    ));
    out.push_str(&format!("- 总体结果：**{}**\n\n", if report.overall_pass { "通过" } else { "未通过" }));

    out.push_str("## 输入 → 输出类型对账\n\n| 输入类型 | 数量 |\n| --- | ---: |\n");
    for (t, c) in &report.input_type_counts {
        out.push_str(&format!("| {} | {} |\n", t, c));
    }
    out.push_str("\n| 输出类型 | 数量 |\n| --- | ---: |\n");
    for (t, c) in &report.output_type_counts {
        out.push_str(&format!("| {} | {} |\n", t, c));
    }

    out.push_str("\n## 校验项\n\n| 校验项 | 结果 | 说明 |\n| --- | --- | --- |\n");
    for c in &report.checks {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            c.name,
            if c.passed { "通过" } else { "**未通过**" },
            c.details.replace('|', "\\|").replace('\n', " ")
        ));
    }

    if !report.normalization_warnings.is_empty() {
        out.push_str("\n## 归一化警告\n\n");
        for w in &report.normalization_warnings {
            out.push_str(&format!("- {}\n", w));
        }
    }
    out
}

/// 供 CLI 使用的便捷封装：返回 (报告, 报告 JSON 路径, 报告 MD 路径)
pub fn run_and_report(
    raw_part_dir: &Path,
    output_root: &Path,
) -> Result<(ReplayReport, PathBuf, PathBuf), String> {
    let report = run_mineru_offline_replay(raw_part_dir, output_root)?;
    let part_name = raw_part_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("part")
        .to_string();
    let out_dir = output_root.join(part_name);
    Ok((
        report,
        out_dir.join("replay-report.json"),
        out_dir.join("replay-report.md"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static REPLAY_TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn replay_temp_dir(tag: &str) -> PathBuf {
        let seq = REPLAY_TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "flowread_mineru_replay_{}_{}_{}",
            std::process::id(),
            seq,
            tag
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 合成 fixture 完整回放：生产归一化 → 隔离工作区导入 → 会话校验全通过
    #[test]
    fn test_replay_synthetic_fixture_end_to_end() {
        let temp = replay_temp_dir("synthetic");
        let out_root = temp.join("out");
        let raw_dir = temp.join("part_synth");
        fs::create_dir_all(raw_dir.join("images")).unwrap();

        let fig_bytes = b"synth_fig_bytes";
        fs::write(raw_dir.join("images").join("fig_a.jpg"), fig_bytes).unwrap();

        let content_list = serde_json::json!([
            [
                { "type": "page_header", "content": { "page_header_content": [
                    { "type": "text", "content": "Running Head" } ] }, "bbox": [1, 1, 2, 2] },
                { "type": "title", "content": { "title_content": [
                    { "type": "text", "content": "1.1 Sample Heading" } ], "level": 2 },
                  "bbox": [1, 1, 2, 2] },
                { "type": "paragraph", "content": { "paragraph_content": [
                    { "type": "text", "content": "Body with " },
                    { "type": "equation_inline", "content": "V _ { g }" },
                    { "type": "text", "content": " inline." } ] }, "bbox": [1, 1, 2, 2] },
                { "type": "equation_interline", "content": {
                    "math_content": "E = m c ^ { 2 }", "math_type": "latex",
                    "image_source": { "path": "images/fig_a.jpg" } }, "bbox": [1, 1, 2, 2] },
                { "type": "image", "content": {
                    "image_source": { "path": "images/fig_a.jpg" },
                    "image_caption": [ { "type": "text", "content": "Fig. 1 Sample" } ],
                    "image_footnote": [] }, "bbox": [1, 1, 2, 2] },
                { "type": "table", "content": {
                    "image_source": { "path": "images/fig_a.jpg" },
                    "table_caption": [ { "type": "text", "content": "Table 1 Sample" } ],
                    "table_footnote": [],
                    "html": "<table><tr><td>CellA</td><td> $x _ { 1 }$ </td></tr></table>",
                    "table_type": "simple_table", "table_nest_level": 0 }, "bbox": [1, 1, 2, 2] },
                { "type": "page_number", "content": { "page_number_content": [
                    { "type": "text", "content": "1" } ] }, "bbox": [1, 1, 2, 2] }
            ]
        ]);
        fs::write(
            raw_dir.join("fixture_content_list_v2.json"),
            content_list.to_string(),
        )
        .unwrap();

        let (report, json_path, md_path) = run_and_report(&raw_dir, &out_root).unwrap();

        assert!(report.overall_pass, "合成 fixture 回放应全部通过: {:?}", report.checks);
        assert_eq!(report.input_blocks, 7);
        assert_eq!(report.output_blocks, 7);
        assert_eq!(report.input_pages, 1);
        assert!(json_path.is_file() && md_path.is_file());

        // 产物落在隔离输出目录，原始目录未被写入
        assert!(out_root.join("part_synth").join("normalized").join("blocks.json").is_file());
        assert!(out_root.join("part_synth").join("workspace").is_dir());
        assert!(out_root.join("part_synth").join("replay.db").is_file());
        assert!(!raw_dir.join("replay.db").exists());
        assert!(!raw_dir.join("normalized").exists());

        // 工作区 blocks.json 可直接经开预览会话读取（“打开解析结果预览”同源路径）
        let state = ParsedPreviewState::new();
        let info = open_preview_internal(&report.preview_blocks_path, &state.sessions).unwrap();
        assert!(info.has_assets);
        close_preview_internal(&info.session_id, &state.sessions).unwrap();
    }

    /// model.json 单独存在时必须明确失败，不得当作 content_list 回退
    #[test]
    fn test_replay_model_json_only_fails_clearly() {
        let temp = replay_temp_dir("model_only");
        let raw_dir = temp.join("part_bad");
        fs::create_dir_all(raw_dir.join("images")).unwrap();
        fs::write(
            raw_dir.join("xxx_model.json"),
            serde_json::json!([{ "layout_dets": [], "page_info": {} }]).to_string(),
        )
        .unwrap();

        let err = run_mineru_offline_replay(&raw_dir, &temp.join("out")).unwrap_err();
        assert!(
            err.contains("content_list"),
            "缺结构文件必须明确报错: {}",
            err
        );
    }

    /// 损坏 JSON 必须明确失败
    #[test]
    fn test_replay_corrupt_json_fails_clearly() {
        let temp = replay_temp_dir("corrupt");
        let raw_dir = temp.join("part_corrupt");
        fs::create_dir_all(raw_dir.join("images")).unwrap();
        fs::write(raw_dir.join("content_list_v2.json"), "{ not valid json !!!").unwrap();

        let err = run_mineru_offline_replay(&raw_dir, &temp.join("out")).unwrap_err();
        assert!(
            err.contains("语法错误") || err.contains("读取") || err.contains("content_list"),
            "损坏 JSON 必须明确失败: {}",
            err
        );
    }

    /// 缺必需图片必须明确失败（不得静默输出空图块）
    #[test]
    fn test_replay_missing_required_image_fails() {
        let temp = replay_temp_dir("missing_img");
        let raw_dir = temp.join("part_missing");
        fs::create_dir_all(raw_dir.join("images")).unwrap();

        let content_list = serde_json::json!([
            [
                { "type": "paragraph", "content": { "paragraph_content": [
                    { "type": "text", "content": "Body" } ] }, "bbox": [1, 1, 2, 2] },
                { "type": "image", "content": {
                    "image_source": { "path": "images/not_on_disk.jpg" },
                    "image_caption": [ { "type": "text", "content": "Missing fig" } ],
                    "image_footnote": [] }, "bbox": [1, 1, 2, 2] }
            ]
        ]);
        fs::write(raw_dir.join("content_list_v2.json"), content_list.to_string()).unwrap();

        let err = run_mineru_offline_replay(&raw_dir, &temp.join("out")).unwrap_err();
        assert!(
            err.contains("图片") || err.contains("image") || err.contains("资产"),
            "缺必需图片必须明确失败: {}",
            err
        );
    }

    /// 输出目录带标记时可安全重复回放；无标记的用户目录绝不覆盖
    #[test]
    fn test_replay_output_dir_safety() {
        let temp = replay_temp_dir("safety");
        let occupied = temp.join("user_data");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("keep.txt"), b"user data").unwrap();

        let err = prepare_output_dir(&occupied).unwrap_err();
        assert!(err.contains("拒绝覆盖"), "必须拒绝覆盖无标记目录: {}", err);
        assert!(occupied.join("keep.txt").is_file(), "用户文件不得被触碰");

        // 带标记目录允许清理重建
        let replay_dir = temp.join("out").join("part_x");
        fs::create_dir_all(&replay_dir).unwrap();
        fs::write(replay_dir.join(REPLAY_MARKER_FILE), b"marker").unwrap();
        fs::write(replay_dir.join("stale.txt"), b"old").unwrap();
        prepare_output_dir(&replay_dir).unwrap();
        assert!(!replay_dir.join("stale.txt").exists());
        assert!(replay_dir.join(REPLAY_MARKER_FILE).is_file());
    }
}
