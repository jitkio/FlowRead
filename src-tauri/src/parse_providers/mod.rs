use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use bytes::Bytes;
use reqwest::redirect::Policy;
use reqwest::{Client, Response, Url};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

pub mod datalab;
pub mod mineru;

/// 提交阶段的错误分类：决定任务应该失败、暂停，还是进入“是否已受理未知”。
///
/// 不能靠匹配错误字符串里的“超时”来判断：这里按 `reqwest::Error` 的类型标志
/// 与 HTTP 状态码分类，再把类别编码进错误消息前缀，供任务层稳定解析。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorClass {
    /// 认证失败：需要用户重新配置凭据
    Auth,
    /// 明确未被受理（参数非法、4xx、上传失败等）
    Rejected,
    /// 可能已被服务商受理（请求已发出但响应丢失/超时/协议不完整）
    Uncertain,
    /// 响应缺少关键标识（可能已创建任务，但本地拿不到 ID）
    Protocol,
}

impl ProviderErrorClass {
    pub fn tag(self) -> &'static str {
        match self {
            ProviderErrorClass::Auth => "AUTH",
            ProviderErrorClass::Rejected => "REJECTED",
            ProviderErrorClass::Uncertain => "UNCERTAIN",
            ProviderErrorClass::Protocol => "PROTOCOL",
        }
    }
}

const ERROR_CLASS_PREFIX: &str = "FLOWREAD_CLASS:";

pub fn classed(class: ProviderErrorClass, message: impl Into<String>) -> String {
    format!("{}{}|{}", ERROR_CLASS_PREFIX, class.tag(), message.into())
}

pub fn classify_error_message(message: &str) -> ProviderErrorClass {
    if let Some(rest) = message.strip_prefix(ERROR_CLASS_PREFIX) {
        if let Some((tag, _)) = rest.split_once('|') {
            return match tag {
                "AUTH" => ProviderErrorClass::Auth,
                "UNCERTAIN" => ProviderErrorClass::Uncertain,
                "PROTOCOL" => ProviderErrorClass::Protocol,
                _ => ProviderErrorClass::Rejected,
            };
        }
    }
    ProviderErrorClass::Rejected
}

/// 把请求错误映射为“是否可能已被受理”的保守分类：
/// 连接/发送/读取响应阶段的任何失败都可能发生在服务端已受理之后。
pub fn classify_reqwest_error(err: &reqwest::Error) -> ProviderErrorClass {
    if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() || err.is_decode() {
        ProviderErrorClass::Uncertain
    } else {
        ProviderErrorClass::Rejected
    }
}

/// 服务端 JSON 响应上限：避免异常响应把内存打满。
pub const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
/// 结果包（ZIP / PDF 结果）上限。
pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// 单张图片资产上限。
pub const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// 上传 / 下载单次请求的最长等待时间。
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// 普通 API 请求超时。
pub const API_TIMEOUT: Duration = Duration::from_secs(60);

static TEST_MINERU_BASE_URL: Mutex<Option<String>> = Mutex::new(None);
static TEST_DATALAB_BASE_URL: Mutex<Option<String>> = Mutex::new(None);

pub fn set_test_mineru_base_url(url: Option<String>) {
    let mut lock = TEST_MINERU_BASE_URL.lock().unwrap();
    *lock = url;
}

pub fn set_test_datalab_base_url(url: Option<String>) {
    let mut lock = TEST_DATALAB_BASE_URL.lock().unwrap();
    *lock = url;
}

pub fn get_mineru_base_url() -> String {
    let lock = TEST_MINERU_BASE_URL.lock().unwrap();
    if let Some(ref u) = *lock {
        return u.clone();
    }
    "https://mineru.net/api/v4".to_string()
}

pub fn get_datalab_base_url() -> String {
    let lock = TEST_DATALAB_BASE_URL.lock().unwrap();
    if let Some(ref u) = *lock {
        return u.clone();
    }
    "https://www.datalab.to/api/v1".to_string()
}

pub fn is_valid_mineru_api_origin(url: &Url) -> bool {
    let lock = TEST_MINERU_BASE_URL.lock().unwrap();
    if let Some(ref test_base) = *lock {
        if let Ok(test_url) = Url::parse(test_base) {
            if url.origin() == test_url.origin() {
                return true;
            }
        }
    }
    drop(lock);

    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(host) => host == "mineru.net" || host.ends_with(".mineru.net"),
        None => false,
    }
}

pub fn is_valid_datalab_api_origin(url: &Url) -> bool {
    let lock = TEST_DATALAB_BASE_URL.lock().unwrap();
    if let Some(ref test_base) = *lock {
        if let Ok(test_url) = Url::parse(test_base) {
            if url.origin() == test_url.origin() {
                return true;
            }
        }
    }
    drop(lock);

    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(host) => host == "www.datalab.to" || host == "datalab.to",
        None => false,
    }
}

/// 带凭据的 API 客户端：只允许“同源重定向”，避免自定义鉴权头被带到第三方域。
///
/// reqwest 默认策略在跨域重定向时不会移除自定义头（例如 `X-API-Key` /
/// `Authorization`），因此必须在客户端层面直接拒绝跨域跳转。
pub fn build_api_client(timeout: Duration) -> Client {
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().is_empty() {
                return attempt.follow();
            }
            let first = &attempt.previous()[0];
            let same_origin = attempt.url().origin() == first.origin();
            if same_origin && attempt.previous().len() < 4 {
                attempt.follow()
            } else {
                attempt.error("拒绝向非官方地址重定向，避免凭据泄漏")
            }
        }))
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// 产物 / 对象存储客户端：不携带任何厂家凭据，允许有限次数重定向。
pub fn build_storage_client(timeout: Duration) -> Client {
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::limited(5))
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// 读取受体积上限保护的 JSON 响应。
pub async fn read_json_limited(resp: Response, limit: u64) -> Result<Value, String> {
    if let Some(len) = resp.content_length() {
        if len > limit {
            return Err(format!("响应体过大 ({} 字节，上限 {} 字节)", len, limit));
        }
    }

    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取响应数据流失败: {}", e))?
    {
        if (buf.len() as u64 + chunk.len() as u64) > limit {
            return Err(format!("响应体超过上限 ({} 字节)", limit));
        }
        buf.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&buf).map_err(|e| format!("解析响应 JSON 失败: {}", e))
}

/// 以流式方式把本地文件作为请求体，避免 `fs::read` 一次性把整份 PDF 读入内存。
pub async fn file_body(path: &Path) -> Result<reqwest::Body, String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("打开待上传文件失败: {}", e))?;

    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 64 * 1024];
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取待上传文件失败: {}", e))?;
        if n == 0 {
            Ok::<_, String>(None)
        } else {
            buf.truncate(n);
            Ok(Some((Bytes::from(buf), file)))
        }
    });

    Ok(reqwest::Body::wrap_stream(stream))
}

#[derive(Debug, PartialEq, Eq)]
pub enum DownloadError {
    InvalidUrl(String),
    Network(String),
    HttpError(u16),
    Oversized { size: u64, max: u64 },
    LocalIo(String),
    EmptyContent,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::InvalidUrl(msg) => write!(f, "无效的下载地址: {}", msg),
            DownloadError::Network(msg) => write!(f, "网络传输失败: {}", msg),
            DownloadError::HttpError(status) => write!(f, "下载失败 (HTTP {})", status),
            DownloadError::Oversized { size, max } => {
                write!(f, "下载内容过大 ({} 字节，上限 {} 字节)", size, max)
            }
            DownloadError::LocalIo(msg) => write!(f, "本地文件读写失败: {}", msg),
            DownloadError::EmptyContent => write!(f, "下载内容为空"),
        }
    }
}

impl std::error::Error for DownloadError {}

impl DownloadError {
    /// 仅底层网络连接建立、DNS 解析或数据流中断等网络层问题允许考虑通道回退
    pub fn is_retryable_network(&self) -> bool {
        matches!(self, DownloadError::Network(_))
    }
}

/// 流式下载到临时文件，校验大小后原子改名为目标文件。
/// 失败时删除临时文件，绝不留下“看起来完整”的半截产物。
pub async fn download_to_file(
    client: &Client,
    url: &str,
    dest: &Path,
    max_bytes: u64,
) -> Result<u64, DownloadError> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| DownloadError::LocalIo(format!("创建下载目录失败: {}", e)))?;
    }

    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| DownloadError::Network(format!("下载请求失败: {}", e)))?;

    if !resp.status().is_success() {
        return Err(DownloadError::HttpError(resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len > max_bytes {
            return Err(DownloadError::Oversized {
                size: len,
                max: max_bytes,
            });
        }
    }

    let tmp_path = dest.with_extension("part");
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| DownloadError::LocalIo(format!("创建临时下载文件失败: {}", e)))?;

    let mut total: u64 = 0;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                total += chunk.len() as u64;
                if total > max_bytes {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(DownloadError::Oversized {
                        size: total,
                        max: max_bytes,
                    });
                }
                if let Err(e) = file.write_all(&chunk).await {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(DownloadError::LocalIo(format!("写入下载文件失败: {}", e)));
                }
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp_path).await;
                return Err(DownloadError::Network(format!("下载数据流中断: {}", e)));
            }
        }
    }

    if total == 0 {
        drop(file);
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(DownloadError::EmptyContent);
    }

    file.flush()
        .await
        .map_err(|e| DownloadError::LocalIo(format!("刷新下载文件失败: {}", e)))?;
    drop(file);

    if dest.exists() {
        tokio::fs::remove_file(dest)
            .await
            .map_err(|e| DownloadError::LocalIo(format!("替换旧下载文件失败: {}", e)))?;
    }
    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| DownloadError::LocalIo(format!("发布下载文件失败: {}", e)))?;

    Ok(total)
}

/// 从 JSON 对象中按顺序取第一个“非 null 且非空字符串”的字段。
/// 字段存在但为 null 时必须继续回退，不能直接当作“有值”。
pub fn pick_string(obj: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            if let Some(s) = v.as_str() {
                if !s.trim().is_empty() {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

/// 判断 JSON 中某个键是否有“有效的字符串内容”（而不是存在但为 null）。
pub fn has_string_value(obj: &Value, keys: &[&str]) -> bool {
    pick_string(obj, keys).is_some()
}

pub static TEST_PROVIDER_MUTEX: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mineru_api_origin_safety() {
        let _guard = TEST_PROVIDER_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        set_test_mineru_base_url(None);

        assert!(is_valid_mineru_api_origin(&Url::parse("https://mineru.net/api/v4/file-urls/batch").unwrap()));
        assert!(is_valid_mineru_api_origin(&Url::parse("https://api.mineru.net/v4/batch").unwrap()));

        // HTTP 拒绝
        assert!(!is_valid_mineru_api_origin(&Url::parse("http://mineru.net/api/v4").unwrap()));

        // 外部对象存储 (OSS/S3) 绝对不作为 API Origin，防止鉴权 Token 泄露
        assert!(!is_valid_mineru_api_origin(&Url::parse("https://mineru-oss.oss-cn-beijing.aliyuncs.com/upload/abc").unwrap()));
        assert!(!is_valid_mineru_api_origin(&Url::parse("https://s3.amazonaws.com/bucket/key").unwrap()));
        assert!(!is_valid_mineru_api_origin(&Url::parse("https://evil-attacker.com/mineru.net").unwrap()));
    }

    #[test]
    fn test_datalab_api_origin_safety() {
        let _guard = TEST_PROVIDER_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        set_test_datalab_base_url(None);

        assert!(is_valid_datalab_api_origin(&Url::parse("https://www.datalab.to/api/v1/marker").unwrap()));
        assert!(is_valid_datalab_api_origin(&Url::parse("https://datalab.to/api/v1/marker").unwrap()));

        // HTTP 拒绝
        assert!(!is_valid_datalab_api_origin(&Url::parse("http://www.datalab.to/api/v1").unwrap()));

        // 外部对象存储或第三方域名拒绝
        assert!(!is_valid_datalab_api_origin(&Url::parse("https://datalab-results.s3.amazonaws.com/123").unwrap()));
        assert!(!is_valid_datalab_api_origin(&Url::parse("https://evil.com/datalab.to").unwrap()));
    }

    #[test]
    fn test_pick_string_skips_null_and_empty() {
        let v = serde_json::json!({
            "markdown": null,
            "html": "",
            "content": "  real content  "
        });
        assert_eq!(
            pick_string(&v, &["markdown", "html", "content"]),
            Some("  real content  ".to_string())
        );
        assert!(!has_string_value(&v, &["markdown", "html"]));
        assert!(has_string_value(&v, &["markdown", "content"]));
    }

    #[test]
    fn test_mineru_cdn_url_validation_strict() {
        use super::mineru::is_eligible_mineru_cdn_url;

        // 真实合法 HTTPS 目标
        assert!(is_eligible_mineru_cdn_url("https://cdn-mineru.openxlab.org.cn/model/file.zip"));

        // HTTP 拒绝（绝不降级明文 HTTP）
        assert!(!is_eligible_mineru_cdn_url("http://cdn-mineru.openxlab.org.cn/model/file.zip"));

        // 域名仅出现在路径中
        assert!(!is_eligible_mineru_cdn_url("https://example.com/cdn-mineru.openxlab.org.cn/file.zip"));

        // 域名仅出现在查询参数中
        assert!(!is_eligible_mineru_cdn_url("https://example.com/download?url=https://cdn-mineru.openxlab.org.cn"));

        // 相似前缀或后缀恶意域名
        assert!(!is_eligible_mineru_cdn_url("https://fake-cdn-mineru.openxlab.org.cn/file.zip"));
        assert!(!is_eligible_mineru_cdn_url("https://cdn-mineru.openxlab.org.cn.attacker.com/file.zip"));

        // 无效 URL
        assert!(!is_eligible_mineru_cdn_url("not a url at all"));
    }

    #[test]
    fn test_download_error_retryability_boundaries() {
        // 仅网络/连接传输失败允许触发有限直连回退
        let net_err = DownloadError::Network("Connection reset by peer".to_string());
        assert!(net_err.is_retryable_network());

        // HTTP 明确拒绝（403/404 等）不得重复下载
        let http_403 = DownloadError::HttpError(403);
        assert!(!http_403.is_retryable_network());
        let http_404 = DownloadError::HttpError(404);
        assert!(!http_404.is_retryable_network());

        // 文件大小超限绝对不可重试
        let oversized = DownloadError::Oversized {
            size: 50_000_000,
            max: 30_000_000,
        };
        assert!(!oversized.is_retryable_network());

        // 本地磁盘写入/权限错误不可重试
        let io_err = DownloadError::LocalIo("No space left on device".to_string());
        assert!(!io_err.is_retryable_network());

        // 空内容不可重试
        let empty = DownloadError::EmptyContent;
        assert!(!empty.is_retryable_network());
    }
}
