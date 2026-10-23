use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use uuid::Uuid;

/// 限制最大预览 JSON 为 30MB，防止恶意/异常巨大文件耗尽内存
const MAX_PREVIEW_JSON_BYTES: u64 = 30 * 1024 * 1024;

/// 预览会话结构体，记录允许访问的文档目录与资产目录
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ParsedPreviewSession {
    pub session_id: String,
    pub blocks_path: PathBuf,
    pub doc_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub has_assets: bool,
}

/// 预览全局状态，隔离不同打开会话
pub struct ParsedPreviewState {
    pub sessions: Mutex<HashMap<String, ParsedPreviewSession>>,
}

impl ParsedPreviewState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// 打开结果返回数据结构
#[derive(Debug, Serialize, Clone)]
pub struct ParsedPreviewInfo {
    pub session_id: String,
    pub blocks_path: String,
    pub doc_dir: String,
    pub raw_json: String,
    pub has_assets: bool,
}

/// 打开并校验解析结果 blocks.json，建立临时只读预览会话
#[tauri::command]
pub fn parsed_preview_open(
    path: String,
    state: tauri::State<'_, ParsedPreviewState>,
) -> Result<ParsedPreviewInfo, String> {
    open_preview_internal(&path, &state.sessions)
}

/// 读取指定会话 assets 目录内的图片资产
/// 严格执行路径越界防护，禁止跨目录逃逸
#[tauri::command]
pub fn parsed_preview_read_asset(
    session_id: String,
    asset_ref: String,
    state: tauri::State<'_, ParsedPreviewState>,
) -> Result<Vec<u8>, String> {
    read_asset_internal(&session_id, &asset_ref, &state.sessions)
}

/// 关闭并释放预览会话
#[tauri::command]
pub fn parsed_preview_close(
    session_id: String,
    state: tauri::State<'_, ParsedPreviewState>,
) -> Result<(), String> {
    close_preview_internal(&session_id, &state.sessions)
}

// 内部逻辑函数，便于单元测试脱离 tauri::State
pub fn open_preview_internal(
    path_str: &str,
    sessions_lock: &Mutex<HashMap<String, ParsedPreviewSession>>,
) -> Result<ParsedPreviewInfo, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path_str));
    }
    if !p.is_file() {
        return Err(format!("指定路径不是普通文件: {}", path_str));
    }

    let meta = fs::metadata(p).map_err(|e| format!("获取文件元信息失败: {}", e))?;
    if meta.len() > MAX_PREVIEW_JSON_BYTES {
        return Err(format!(
            "文件体积 ({} 字节) 超出预览原型支持上限 ({} 字节)",
            meta.len(),
            MAX_PREVIEW_JSON_BYTES
        ));
    }

    let canonical_path = p
        .canonicalize()
        .map_err(|e| format!("解析规范化路径失败: {}", e))?;
    let doc_dir = canonical_path
        .parent()
        .ok_or_else(|| "无法获取文档所在上级目录".to_string())?
        .to_path_buf();

    let assets_dir = doc_dir.join("assets");
    let has_assets = assets_dir.is_dir();

    let raw_json = fs::read_to_string(&canonical_path)
        .map_err(|e| format!("读取解析结果 JSON 失败: {}", e))?;

    let session_id = Uuid::new_v4().to_string();
    let session = ParsedPreviewSession {
        session_id: session_id.clone(),
        blocks_path: canonical_path.clone(),
        doc_dir: doc_dir.clone(),
        assets_dir,
        has_assets,
    };

    let mut lock = sessions_lock
        .lock()
        .map_err(|e| format!("预览状态锁争用异常: {}", e))?;
    lock.insert(session_id.clone(), session);

    Ok(ParsedPreviewInfo {
        session_id,
        blocks_path: canonical_path.to_string_lossy().to_string(),
        doc_dir: doc_dir.to_string_lossy().to_string(),
        raw_json,
        has_assets,
    })
}

/// 标准化并校验本地资产相对路径
/// 规则：
/// 1. 外部资源（http://, https://, data:, blob:, //）返回 Ok(None)，不当作缺失本地文件；
/// 2. 绝对路径（以 / 或 \ 开头，或包含 Windows 盘符如 C:）与路径穿越（包含 ..）严格报错拦截，绝不通过截断伪装成本地相对路径；
/// 3. 支持合法格式：assets/a.png, ./assets/a.png, a.png, ./a.png, assets/sub/a.png；
/// 4. 统一返回相对于 assets/ 目录的子路径，格式统一为正斜杠（如 "a.png", "sub/a.png"）。
pub fn clean_local_asset_path(raw: &str) -> Result<Option<String>, String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }

    // 1. 检查外部链接（支持协议相对 URL //example.com/a.png）
    if s.starts_with("//")
        || s.to_ascii_lowercase().starts_with("http://")
        || s.to_ascii_lowercase().starts_with("https://")
        || s.to_ascii_lowercase().starts_with("data:")
        || s.to_ascii_lowercase().starts_with("blob:")
    {
        return Ok(None);
    }

    // 剥离查询参数和锚点（例如 assets/a.png?v=1#hash）
    if let Some(pos) = s.find(['?', '#']) {
        s = &s[..pos];
    }
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }

    // 2. 严厉防御绝对路径与跨盘符访问：严禁截断伪装
    if s.starts_with('/') || s.starts_with('\\') || s.contains(':') {
        return Err(format!("非法资产引用路径 (禁止盘符或绝对路径): {}", raw));
    }

    // 允许且仅允许前导的 ./ 或 .\ 相对路径声明
    let mut clean_str = s;
    while clean_str.starts_with("./") || clean_str.starts_with(".\\") {
        clean_str = &clean_str[2..];
    }
    let clean_str = clean_str.trim();
    if clean_str.is_empty() {
        return Ok(None);
    }

    // 剥离 ./ 后若仍是以 / 或 \ 开头，则为伪装的根路径，立即拒绝
    if clean_str.starts_with('/') || clean_str.starts_with('\\') {
        return Err(format!("非法资产引用路径 (禁止盘符或绝对路径): {}", raw));
    }

    let p = Path::new(clean_str);
    // 按路径组件严格检查：禁止包含 ParentDir (..)、RootDir、Prefix 等
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(_) => {}
            _ => return Err(format!("非法资产引用路径 (禁止跨目录逃逸或包含非法组件): {}", raw)),
        }
    }

    // 3. 提取相对于 assets 目录的路径
    let first_is_assets = p.components().next().map_or(false, |c| {
        if let std::path::Component::Normal(os) = c {
            os.to_str().map_or(false, |name| name.eq_ignore_ascii_case("assets"))
        } else {
            false
        }
    });

    let subpath = if first_is_assets {
        let mut iter = p.components();
        iter.next(); // 跳过 assets
        iter.as_path()
    } else {
        p
    };

    let subpath_str = subpath.to_string_lossy().replace('\\', "/");
    let subpath_trimmed = subpath_str.trim();
    if subpath_trimmed.is_empty() {
        return Ok(None);
    }

    Ok(Some(subpath_trimmed.to_string()))
}

pub fn read_asset_internal(
    session_id: &str,
    asset_ref: &str,
    sessions_lock: &Mutex<HashMap<String, ParsedPreviewSession>>,
) -> Result<Vec<u8>, String> {
    let session = {
        let lock = sessions_lock
            .lock()
            .map_err(|e| format!("预览状态锁争用异常: {}", e))?;
        lock.get(session_id)
            .cloned()
            .ok_or_else(|| "预览会话不存在或已关闭".to_string())?
    };

    if !session.has_assets {
        return Err("当前解析产物未包含 assets 目录".to_string());
    }

    let clean_subpath = match clean_local_asset_path(asset_ref)? {
        Some(p) => p,
        None => return Err(format!("外部资源或非本地文件不可通过本地预览会话读取: {}", asset_ref)),
    };

    let clean_path = Path::new(&clean_subpath);
    let target_path = session.assets_dir.join(clean_path);
    if !target_path.exists() {
        return Err(format!("资产文件不存在: {}", clean_subpath));
    }

    // 排除符号链接
    if let Ok(sym_meta) = fs::symlink_metadata(&target_path) {
        if sym_meta.file_type().is_symlink() {
            return Err("安全拦截：禁止访问符号链接资产".to_string());
        }
    }

    let canonical_assets = session
        .assets_dir
        .canonicalize()
        .map_err(|e| format!("无法定位 assets 目录: {}", e))?;
    let canonical_target = target_path
        .canonicalize()
        .map_err(|e| format!("无法定位目标资产: {}", e))?;

    // 核心安全约束：目标资产必须严格落在 assets 规范目录下
    if !canonical_target.starts_with(&canonical_assets) {
        return Err("资产路径安全校验失败: 试图访问 assets 外部文件".to_string());
    }
    if !canonical_target.is_file() {
        return Err("指定资产目标不是普通文件".to_string());
    }

    fs::read(&canonical_target).map_err(|e| format!("读取图片资产失败: {}", e))
}

pub fn close_preview_internal(
    session_id: &str,
    sessions_lock: &Mutex<HashMap<String, ParsedPreviewSession>>,
) -> Result<(), String> {
    let mut lock = sessions_lock
        .lock()
        .map_err(|e| format!("预览状态锁争用异常: {}", e))?;
    lock.remove(session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_parsed_preview_lifecycle_and_boundary() {
        let temp_dir = std::env::temp_dir().join(format!("flowread_test_{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).unwrap();
        let assets_dir = temp_dir.join("assets");
        fs::create_dir_all(&assets_dir).unwrap();

        let blocks_file = temp_dir.join("blocks.json");
        let mut f = fs::File::create(&blocks_file).unwrap();
        writeln!(f, "[{{\"id\":\"test_1\",\"type\":\"paragraph\",\"content\":\"hello\"}}]").unwrap();

        let asset_file = assets_dir.join("pic1.jpg");
        let mut af = fs::File::create(&asset_file).unwrap();
        af.write_all(b"fake_jpeg_bytes").unwrap();

        let outside_file = temp_dir.join("secret.txt");
        let mut of = fs::File::create(&outside_file).unwrap();
        of.write_all(b"sensitive_info").unwrap();

        let state_sessions = Mutex::new(HashMap::new());

        // 1. 打开有效文件
        let info = open_preview_internal(&blocks_file.to_string_lossy(), &state_sessions).unwrap();
        assert_eq!(info.has_assets, true);
        assert!(info.raw_json.contains("hello"));

        // 2. 读取有效资产
        let data = read_asset_internal(&info.session_id, "pic1.jpg", &state_sessions).unwrap();
        assert_eq!(data, b"fake_jpeg_bytes");

        // 3. 读取带 assets/ 前缀的资产
        let data2 = read_asset_internal(&info.session_id, "assets/pic1.jpg", &state_sessions).unwrap();
        assert_eq!(data2, b"fake_jpeg_bytes");

        // 3b. 读取带 ./assets/ 和 ./ 前缀的资产
        let data_dot_assets = read_asset_internal(&info.session_id, "./assets/pic1.jpg", &state_sessions).unwrap();
        assert_eq!(data_dot_assets, b"fake_jpeg_bytes");
        let data_dot = read_asset_internal(&info.session_id, "./pic1.jpg", &state_sessions).unwrap();
        assert_eq!(data_dot, b"fake_jpeg_bytes");

        // 3c. 读取嵌套目录资产
        let sub_dir = assets_dir.join("sub");
        fs::create_dir_all(&sub_dir).unwrap();
        fs::write(sub_dir.join("deep.png"), b"deep_bytes").unwrap();
        let data_deep = read_asset_internal(&info.session_id, "assets/sub/deep.png", &state_sessions).unwrap();
        assert_eq!(data_deep, b"deep_bytes");
        let data_deep_dot = read_asset_internal(&info.session_id, "./assets/sub/deep.png", &state_sessions).unwrap();
        assert_eq!(data_deep_dot, b"deep_bytes");

        // 4. 越界路径攻击防御检测
        let err_traversal = read_asset_internal(&info.session_id, "../secret.txt", &state_sessions);
        assert!(err_traversal.is_err());
        assert!(err_traversal.unwrap_err().contains("跨目录逃逸"));

        // 4b. 绝对路径与跨盘符拦截检测（不得截断伪装）
        let err_abs = read_asset_internal(&info.session_id, "/pic1.jpg", &state_sessions);
        assert!(err_abs.is_err());
        assert!(err_abs.unwrap_err().contains("禁止盘符或绝对路径"));

        // 4c. 外部资源拦截检测
        let err_ext = read_asset_internal(&info.session_id, "//example.com/pic1.jpg", &state_sessions);
        assert!(err_ext.is_err());
        assert!(err_ext.unwrap_err().contains("外部资源或非本地文件"));

        // 5. 不存在资产
        let err_missing = read_asset_internal(&info.session_id, "not_exist.jpg", &state_sessions);
        assert!(err_missing.is_err());

        // 6. 关闭会话
        close_preview_internal(&info.session_id, &state_sessions).unwrap();

        // 7. 关闭后再次读取应报错
        let err_after_close = read_asset_internal(&info.session_id, "pic1.jpg", &state_sessions);
        assert!(err_after_close.is_err());
        assert!(err_after_close.unwrap_err().contains("会话不存在"));

        // 清理临时文件
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
