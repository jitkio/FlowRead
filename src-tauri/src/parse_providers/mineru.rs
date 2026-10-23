use std::fs;
use std::path::Path;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

use super::{
    build_api_client, build_storage_client, classed, classify_reqwest_error, download_to_file,
    file_body, get_mineru_base_url, is_valid_mineru_api_origin, read_json_limited,
    ProviderErrorClass, API_TIMEOUT, MAX_ARCHIVE_BYTES, MAX_JSON_BYTES, TRANSFER_TIMEOUT,
};

#[derive(Debug, Clone)]
pub struct MinerUClient {
    pub api_token: String,
    /// 携带 Authorization 的 API 客户端（拒绝跨域重定向）
    api_client: Client,
    /// 直传 / 产物下载客户端（不携带任何厂家凭据）
    storage_client: Client,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MinerUBatchInfo {
    pub batch_id: String,
    pub upload_url: String,
    pub data_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MinerUStatusResult {
    pub batch_id: String,
    pub state: String,
    pub status: String, // "processing" | "done" | "failed"
    pub full_zip_url: Option<String>,
    pub error_message: Option<String>,
    pub completed_pages: Option<i64>,
    pub total_pages: Option<i64>,
}

/// 精确判定是否为国内 cdn-mineru.openxlab.org.cn 的 HTTPS 资源。
/// 必须通过标准 URL 解析器验证协议为 HTTPS 且 Host 严格精确匹配，
/// 严禁使用字符串 contains，防止域名出现在路径、查询参数或伪造二级域名中误触发。
pub fn is_eligible_mineru_cdn_url(url_str: &str) -> bool {
    match Url::parse(url_str) {
        Ok(parsed) => {
            parsed.scheme() == "https"
                && parsed.host_str() == Some("cdn-mineru.openxlab.org.cn")
        }
        Err(_) => false,
    }
}

impl MinerUClient {
    pub fn new(api_token: String) -> Self {
        Self {
            api_token,
            api_client: build_api_client(API_TIMEOUT),
            storage_client: build_storage_client(TRANSFER_TIMEOUT),
        }
    }

    /// 1. 向 MinerU 申请批量任务与直传地址 (不直接上传文件内容)
    /// 确保调用方在取得 batch_id 后立即落盘，杜绝上传后由于崩溃丢弃 ID
    pub async fn create_batch(
        &self,
        pdf_path: &Path,
        case_id: &str,
        data_id: Option<&str>,
    ) -> Result<MinerUBatchInfo, String> {
        let file_meta = fs::metadata(pdf_path)
            .map_err(|e| format!("读取待解析 PDF 文件元数据失败: {}", e))?;
        if !file_meta.is_file() {
            return Err("待解析文件不是常规文件".to_string());
        }

        let filename = pdf_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document.pdf")
            .to_string();

        let target_data_id = data_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{}_{}", case_id, crate::db::now_ms()));

        let base_url = get_mineru_base_url();
        let request_url_str = format!("{}/file-urls/batch", base_url.trim_end_matches('/'));
        let request_url = Url::parse(&request_url_str)
            .map_err(|e| format!("无效的 MinerU 请求 URL ({}): {}", request_url_str, e))?;

        if !is_valid_mineru_api_origin(&request_url) {
            return Err(format!("拒绝向非官方 MinerU API 地址发送敏感凭据: {}", request_url));
        }

        let payload = serde_json::json!({
            "model_version": "vlm",
            "enable_formula": true,
            "enable_table": true,
            "language": "ch",
            "files": [
                {
                    "name": filename,
                    "data_id": target_data_id,
                    "is_ocr": true,
                }
            ]
        });

        let resp = self
            .api_client
            .post(request_url)
            .header("Authorization", format!("Bearer {}", self.api_token.trim()))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|e| classed(classify_reqwest_error(&e), format!("网络请求创建 MinerU 批次失败: {}", e)))?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(classed(
                ProviderErrorClass::Auth,
                format!("MinerU 认证拒绝 (HTTP {}): API Token 无效或已过期", status.as_u16()),
            ));
        }

        let resp_json = read_json_limited(resp, MAX_JSON_BYTES)
            .await
            .map_err(|e| classed(ProviderErrorClass::Protocol, e))?;

        let code = resp_json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = resp_json
                .get("msg")
                .or_else(|| resp_json.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知业务错误");
            if code == 401 || code == 403 || msg.to_lowercase().contains("token") || msg.to_lowercase().contains("auth") {
                return Err(classed(ProviderErrorClass::Auth, format!("MinerU 认证拒绝: {}", msg)));
            }
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("MinerU 批次申请失败 (代码 {}): {}", code, msg),
            ));
        }

        let data = resp_json
            .get("data")
            .ok_or_else(|| classed(ProviderErrorClass::Protocol, "MinerU 响应缺少 data 字段"))?;
        let batch_id = data
            .get("batch_id")
            .and_then(|b| b.as_str())
            .ok_or_else(|| classed(ProviderErrorClass::Protocol, "MinerU 响应缺少 batch_id"))?
            .to_string();

        let file_urls = data
            .get("file_urls")
            .and_then(|f| f.as_array())
            .ok_or_else(|| classed(ProviderErrorClass::Protocol, "MinerU 响应缺少 file_urls 列表"))?;

        if file_urls.is_empty() {
            return Err(classed(ProviderErrorClass::Protocol, "MinerU 响应 file_urls 为空"));
        }

        let first_entry = &file_urls[0];
        let upload_url = if let Some(s) = first_entry.as_str() {
            s.to_string()
        } else if let Some(obj) = first_entry.as_object() {
            obj.get("file_url")
                .or_else(|| obj.get("upload_url"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            return Err(classed(ProviderErrorClass::Protocol, "无法解析 MinerU 直传地址"));
        };

        if upload_url.is_empty() {
            return Err(classed(ProviderErrorClass::Protocol, "MinerU 直传地址为空"));
        }

        Ok(MinerUBatchInfo {
            batch_id,
            upload_url,
            data_id: target_data_id,
        })
    }

    /// 2. PUT 上传 PDF 二进制数据到直传地址 (严禁附带厂商 Authorization 凭据)。
    /// 使用流式请求体，避免把整份 PDF 读入内存。
    pub async fn upload_file(&self, upload_url: &str, pdf_path: &Path) -> Result<(), String> {
        let file_len = fs::metadata(pdf_path)
            .map_err(|e| format!("读取待上传文件长度失败: {}", e))?
            .len();

        let body = file_body(pdf_path).await?;

        // 严格遵循规范：直传 presigned URL 严禁附带厂商 Authorization 头
        let resp = self
            .storage_client
            .put(upload_url)
            .header("Content-Length", file_len.to_string())
            .body(body)
            .send()
            .await
            .map_err(|e| classed(ProviderErrorClass::Rejected, format!("上传 PDF 到直传地址网络失败: {}", e)))?;

        let status = resp.status();
        if !status.is_success() {
            let error_body = resp.text().await.unwrap_or_default();
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("上传 PDF 到直传地址失败 (HTTP {}): {}", status.as_u16(), error_body),
            ));
        }

        Ok(())
    }

    /// 3. 查询 MinerU 批量处理结果
    pub async fn check_batch_status(&self, batch_id: &str) -> Result<MinerUStatusResult, String> {
        let base_url = get_mineru_base_url();
        let request_url_str = format!("{}/extract-results/batch/{}", base_url.trim_end_matches('/'), batch_id);
        let request_url = Url::parse(&request_url_str)
            .map_err(|e| format!("无效的 MinerU 查询 URL: {}", e))?;

        if !is_valid_mineru_api_origin(&request_url) {
            return Err(format!("拒绝向非官方 MinerU API 地址发送敏感凭据: {}", request_url));
        }

        let resp = self
            .api_client
            .get(request_url)
            .header("Authorization", format!("Bearer {}", self.api_token.trim()))
            .send()
            .await
            .map_err(|e| classed(ProviderErrorClass::Rejected, format!("查询 MinerU 批次状态网络失败: {}", e)))?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(classed(
                ProviderErrorClass::Auth,
                format!("MinerU 认证拒绝 (HTTP {}): API Token 无效或已过期", status.as_u16()),
            ));
        }

        if status.as_u16() == 429 {
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(5);
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("FLOWREAD_HTTP_429:{}:MinerU 请求频次受限", retry_after),
            ));
        }

        if status.is_server_error() {
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("FLOWREAD_HTTP_5XX:{}:MinerU 服务端异常", status.as_u16()),
            ));
        }

        if !status.is_success() {
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("MinerU 状态查询失败 (HTTP {})", status.as_u16()),
            ));
        }

        let resp_json = read_json_limited(resp, MAX_JSON_BYTES)
            .await
            .map_err(|e| classed(ProviderErrorClass::Rejected, e))?;

        let code = resp_json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 {
            let msg = resp_json
                .get("msg")
                .or_else(|| resp_json.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知查询错误");
            if code == 401 || code == 403 {
                return Err(classed(ProviderErrorClass::Auth, format!("MinerU 认证拒绝: {}", msg)));
            }
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("MinerU 状态查询失败 (代码 {}): {}", code, msg),
            ));
        }

        let data = resp_json
            .get("data")
            .ok_or_else(|| classed(ProviderErrorClass::Rejected, "MinerU 响应缺少 data 字段"))?;
        let extract_result = data
            .get("extract_result")
            .and_then(|e| e.as_array())
            .ok_or_else(|| classed(ProviderErrorClass::Rejected, "MinerU 响应缺少 extract_result 数组"))?;

        if extract_result.is_empty() {
            return Ok(MinerUStatusResult {
                batch_id: batch_id.to_string(),
                state: "pending".to_string(),
                status: "processing".to_string(),
                full_zip_url: None,
                error_message: None,
                completed_pages: None,
                total_pages: None,
            });
        }

        let first = &extract_result[0];
        let state = first
            .get("state")
            .and_then(|s| s.as_str())
            .unwrap_or("processing")
            .to_ascii_lowercase();

        let full_zip_url = first.get("full_zip_url").and_then(|u| u.as_str()).map(|s| s.to_string());
        let err_msg = first.get("err_msg").and_then(|e| e.as_str()).map(|s| s.to_string());

        let (completed_pages, total_pages) = if let Some(prog) = first.get("extract_progress") {
            let completed = prog
                .get("extracted_pages")
                .or_else(|| prog.get("completed_pages"))
                .and_then(|v| v.as_i64());
            let total = prog.get("total_pages").and_then(|v| v.as_i64());
            (completed, total)
        } else {
            let completed = first
                .get("completed_pages")
                .or_else(|| first.get("extracted_pages"))
                .and_then(|v| v.as_i64());
            let total = first.get("total_pages").and_then(|v| v.as_i64());
            (completed, total)
        };

        let mapped_status = match state.as_str() {
            "done" => "done",
            "failed" => "failed",
            _ => "processing", // "waiting-file", "pending", "running", "converting"
        };

        Ok(MinerUStatusResult {
            batch_id: batch_id.to_string(),
            state,
            status: mapped_status.to_string(),
            full_zip_url,
            error_message: err_msg,
            completed_pages,
            total_pages,
        })
    }

    /// 4. 下载 MinerU 产物 ZIP（流式落盘 + 大小上限 + 完成后原子改名，严禁附带厂家凭据）
    pub async fn download_zip(&self, full_zip_url: &str, dest_zip_path: &Path) -> Result<u64, String> {
        let first_try = download_to_file(
            &self.storage_client,
            full_zip_url,
            dest_zip_path,
            MAX_ARCHIVE_BYTES,
        )
        .await;

        match first_try {
            Ok(bytes) => Ok(bytes),
            Err(orig_err) => {
                // 仅当错误为底层网络/连接传输失败，且目标严格为 https://cdn-mineru.openxlab.org.cn 时，
                // 进行一次且仅一次有限直连回退。超限、本地写盘失败、明确 HTTP 拒绝绝不重复下载。
                if orig_err.is_retryable_network() && is_eligible_mineru_cdn_url(full_zip_url) {
                    eprintln!(
                        "[FlowRead] MinerU CDN 网络层下载中断 ({})，尝试临时地址覆盖直连国内备用节点下载...",
                        orig_err
                    );
                    use std::net::SocketAddr;
                    // 注意与限制说明：
                    // 1. 此处预置的 IPv4 地址为当前由官方 DNS 解析获得的国内节点，仅作为“临时地址覆盖（Temporary Address Override）”，
                    //    而非服务商承诺的永久官方备用地址；若未来节点变更需依赖标准 DNS 或配置更新。
                    // 2. `no_proxy()` 仅能指示 HTTP/SOCKS 客户端绕过标准环境变量代理（如 HTTP_PROXY/ALL_PROXY），
                    //    对于操作系统内核级虚拟网卡（TUN 模式）全局强行接管的流量，无法宣称或保证绕过。
                    // 3. 严格保留原生 TLS 证书与主机名 SNI 校验，绝不降级 HTTP 或跳过证书验证。
                    let cdn_addrs = [
                        SocketAddr::from(([183, 192, 178, 58], 443)),
                        SocketAddr::from(([36, 156, 3, 108], 443)),
                        SocketAddr::from(([183, 192, 178, 57], 443)),
                        SocketAddr::from(([183, 192, 178, 62], 443)),
                        SocketAddr::from(([183, 192, 178, 61], 443)),
                        SocketAddr::from(([183, 192, 178, 60], 443)),
                        SocketAddr::from(([183, 192, 178, 59], 443)),
                        SocketAddr::from(([36, 156, 3, 184], 443)),
                    ];
                    let direct_client = match reqwest::Client::builder()
                        .timeout(crate::parse_providers::TRANSFER_TIMEOUT)
                        .redirect(reqwest::redirect::Policy::limited(5))
                        .no_proxy()
                        .resolve_to_addrs("cdn-mineru.openxlab.org.cn", &cdn_addrs)
                        .build()
                    {
                        Ok(c) => c,
                        Err(build_err) => {
                            // 创建回退客户端失败必须明确返回诊断，绝不能静默换回原客户端
                            return Err(classed(
                                ProviderErrorClass::Rejected,
                                format!(
                                    "创建国内 CDN 直连回退客户端失败: {}; 原始网络错误: {}",
                                    build_err, orig_err
                                ),
                            ));
                        }
                    };

                    download_to_file(
                        &direct_client,
                        full_zip_url,
                        dest_zip_path,
                        MAX_ARCHIVE_BYTES,
                    )
                    .await
                    .map_err(|e| {
                        classed(
                            ProviderErrorClass::Rejected,
                            format!("临时地址直连国内节点亦失败: {}; 原始错误: {}", e, orig_err),
                        )
                    })
                } else {
                    Err(classed(ProviderErrorClass::Rejected, orig_err.to_string()))
                }
            }
        }
    }
}
