use std::fs;
use std::path::Path;
use epub::doc::EpubDoc;

/// 读取普通文本文件（.txt / .md）内容
fn read_plain_text_file(path: &Path, file_path_str: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => format!("文件不存在: {}", file_path_str),
        std::io::ErrorKind::PermissionDenied => format!("读取文件权限不足: {}", file_path_str),
        std::io::ErrorKind::InvalidData => {
            format!("文件编码非有效 UTF-8，暂不支持解析: {}", file_path_str)
        }
        _ => format!("读取文件失败 ({}): {}", err, file_path_str),
    })
}

/// 解析 .epub 电子书文件，逐章提取 HTML 并清洗为纯文本后合并返回
fn parse_epub_file(path: &Path, file_path_str: &str) -> Result<String, String> {
    // 实例化 EpubDoc，捕获文件打开或结构损坏异常
    let mut doc = EpubDoc::new(path)
        .map_err(|err| format!("打开或解析 EPUB 失败 ({}): {}", err, file_path_str))?;

    let mut chapters: Vec<String> = Vec::new();

    // 遍历 EPUB 的所有章节（通过 get_current_str 与 go_next）
    loop {
        if let Some((html_content, _mime)) = doc.get_current_str() {
            // 使用 html2text 清洗章节 HTML 标签，保留纯文本，设定合理换行宽度避免过早折行
            match html2text::from_read(html_content.as_bytes(), 10000) {
                Ok(plain_text) => {
                    let trimmed = plain_text.trim();
                    if !trimmed.is_empty() {
                        chapters.push(trimmed.to_string());
                    }
                }
                Err(err) => {
                    eprintln!(
                        "[FlowRead] 警告: 章节 HTML 转文本失败 ({}), 跳过该章节",
                        err
                    );
                }
            }
        }

        if !doc.go_next() {
            break;
        }
    }

    if chapters.is_empty() {
        return Err(format!(
            "EPUB 文件未解析出任何可读文本内容: {}",
            file_path_str
        ));
    }

    // 按章节顺序，以双换行拼接成单一长文，供给前端虚拟滚动
    Ok(chapters.join("\n\n"))
}

/// 读取本地文件（支持 .txt, .md 以及 .epub）
///
/// # 参数
/// * `file_path`: 文件的绝对路径
///
/// # 返回值
/// * `Ok(String)`: 文件内容纯文本
/// * `Err(String)`: 错误提示信息
#[tauri::command]
fn read_local_file(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);

    // 校验路径是否存在
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    // 校验路径是否为文件
    if !path.is_file() {
        return Err(format!("指定路径不是有效的文件: {}", file_path));
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "epub" => parse_epub_file(path, &file_path),
        _ => read_plain_text_file(path, &file_path),
    }
}

/// 文件元数据结构体
#[derive(serde::Serialize)]
pub struct FileMetadata {
    pub size: u64,
}

/// 快速获取文件元数据（仅读取文件大小，不读取文件内容），耗时微秒级
#[tauri::command]
fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let metadata = fs::metadata(&path)
        .map_err(|err| format!("获取文件元数据失败 ({}): {}", err, path))?;

    if !metadata.is_file() {
        return Err(format!("指定路径不是有效的文件: {}", path));
    }

    Ok(FileMetadata {
        size: metadata.len(),
    })
}

/// 按需读取本地文件的指定字节范围 [start, end)
/// 严格直接返回 Vec<u8> 二进制块，禁止 Base64 包装以彻底消除 IPC 传输冗余与内存膨胀
#[tauri::command]
fn read_file_chunk(path: String, start: u64, end: u64) -> Result<Vec<u8>, String> {
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(&path)
        .map_err(|err| format!("打开文件失败 ({}): {}", err, path))?;

    let file_len = file
        .metadata()
        .map_err(|err| format!("获取文件长度失败 ({}): {}", err, path))?
        .len();

    if start >= file_len || start >= end {
        return Ok(Vec::new());
    }

    let actual_end = end.min(file_len);
    let chunk_size = (actual_end - start) as usize;

    file.seek(SeekFrom::Start(start))
        .map_err(|err| format!("文件指针定位失败 ({}): {}", err, path))?;

    let mut buffer = vec![0u8; chunk_size];
    file.read_exact(&mut buffer)
        .map_err(|err| format!("读取文件切片失败 ({}): {}", err, path))?;

    Ok(buffer)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_local_file,
            get_file_metadata,
            read_file_chunk
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

