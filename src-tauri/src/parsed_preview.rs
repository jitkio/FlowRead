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

    // 清洗路径：禁止遍历字符与绝对路径前缀
    let trimmed = asset_ref.trim();
    if trimmed.contains("..") || trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(format!("非法资产引用路径 (禁止跨目录逃逸): {}", asset_ref));
    }
    if trimmed.contains(':') {
        return Err(format!("非法资产引用路径 (禁止盘符引用): {}", asset_ref));
    }

    // 允许以 assets/ 或 assets\ 开头，进行相对剥离
    let clean_ref = if trimmed.starts_with("assets/") || trimmed.starts_with("assets\\") {
        &trimmed[7..]
    } else {
        trimmed
    };

    let target_path = session.assets_dir.join(clean_ref);
    if !target_path.exists() {
        return Err(format!("资产文件不存在: {}", clean_ref));
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

        // 4. 越界路径攻击防御检测
        let err_traversal = read_asset_internal(&info.session_id, "../secret.txt", &state_sessions);
        assert!(err_traversal.is_err());
        assert!(err_traversal.unwrap_err().contains("跨目录逃逸"));

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
