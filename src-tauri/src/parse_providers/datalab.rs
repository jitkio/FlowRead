use std::fs;
use std::path::{Component, Path, PathBuf};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

use super::{
    build_api_client, build_storage_client, classed, classify_reqwest_error, download_to_file,
    file_body, get_datalab_base_url, has_string_value, is_valid_datalab_api_origin, pick_string,
    read_json_limited, ProviderErrorClass, API_TIMEOUT, MAX_IMAGE_BYTES, MAX_JSON_BYTES,
    TRANSFER_TIMEOUT,
};

/// 外置结果 JSON 的上限（比普通 API 响应宽松，但仍有边界）。
const MAX_RESULT_JSON_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct DatalabClient {
    pub api_key: String,
    api_client: Client,
    storage_client: Client,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatalabSubmitInfo {
    pub request_id: String,
    pub request_check_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DatalabStatusResult {
    pub status: String, // "processing" | "done" | "failed"
    pub raw_status: String,
    pub success: Option<bool>,
    pub error: Option<String>,
    pub result_url: Option<String>,
    pub data: serde_json::Value,
}

impl DatalabClient {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            api_client: build_api_client(API_TIMEOUT),
            storage_client: build_storage_client(TRANSFER_TIMEOUT),
        }
    }

    /// 1. 提交 PDF 文档到 Datalab Convert API（multipart 流式上传，不整份读入内存）
    pub async fn submit_document(&self, pdf_path: &Path) -> Result<DatalabSubmitInfo, String> {
        let file_meta = fs::metadata(pdf_path)
            .map_err(|e| format!("读取待解析 PDF 文件元数据失败: {}", e))?;
        if !file_meta.is_file() {
            return Err("待解析文件不是常规文件".to_string());
        }
        let file_len = file_meta.len();

        let filename = pdf_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document.pdf")
            .to_string();

        let base_url = get_datalab_base_url();
        let request_url_str = format!("{}/convert", base_url.trim_end_matches('/'));
        let request_url = Url::parse(&request_url_str)
            .map_err(|e| format!("无效的 Datalab 请求 URL: {}", e))?;

        if !is_valid_datalab_api_origin(&request_url) {
            return Err(format!("拒绝向非官方 Datalab API 地址发送敏感凭据: {}", request_url));
        }

        let body = file_body(pdf_path).await?;
        let part = Part::stream_with_length(body, file_len)
            .file_name(filename)
            .mime_str("application/pdf")
            .map_err(|e| format!("构建 multipart PDF 失败: {}", e))?;

        let form = Form::new()
            .part("file", part)
            .text("mode", "balanced")
            .text("output_format", "markdown,json,html")
            .text("add_block_ids", "true")
            .text("disable_image_extraction", "false")
            .text("disable_image_captions", "true")
            .text("paginate", "false")
            .text("merge_cross_page", "false")
            .text("skip_cache", "true");

        let resp = self
            .api_client
            .post(request_url)
            .header("X-API-Key", self.api_key.trim())
            .multipart(form)
            .send()
            .await
            .map_err(|e| classed(classify_reqwest_error(&e), format!("提交文档到 Datalab 网络失败: {}", e)))?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(classed(
                ProviderErrorClass::Auth,
                format!("Datalab 认证拒绝 (HTTP {}): API Key 无效或未授权", status.as_u16()),
            ));
        }

        let resp_json = read_json_limited(resp, MAX_JSON_BYTES)
            .await
            .map_err(|e| classed(ProviderErrorClass::Protocol, e))?;

        if !status.is_success() {
            let error_msg = pick_string(&resp_json, &["error", "message"])
                .unwrap_or_else(|| "未知转换错误".to_string());
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("Datalab 提交失败 (HTTP {}): {}", status.as_u16(), error_msg),
            ));
        }

        let request_id = pick_string(&resp_json, &["request_id", "id"]).unwrap_or_default();

        let mut request_check_url =
            pick_string(&resp_json, &["request_check_url"]).unwrap_or_default();

        if request_check_url.is_empty() && !request_id.is_empty() {
            request_check_url = format!("{}/convert/{}", base_url.trim_end_matches('/'), request_id);
        }

        if request_check_url.is_empty() {
            return Err(classed(ProviderErrorClass::Protocol, "Datalab 响应缺少 request_check_url"));
        }

        Ok(DatalabSubmitInfo {
            request_id,
            request_check_url,
        })
    }

    /// 2. 查询 Datalab 任务处理状态
    pub async fn check_status(&self, request_check_url: &str) -> Result<DatalabStatusResult, String> {
        let request_url = Url::parse(request_check_url)
            .map_err(|e| format!("无效的 Datalab 检查 URL: {}", e))?;

        let mut req_builder = self.api_client.get(request_url.clone());
        // 凭据保护：仅当检查地址确实处于官方 API origin 时附加 API Key
        if is_valid_datalab_api_origin(&request_url) {
            req_builder = req_builder.header("X-API-Key", self.api_key.trim());
        }

        let resp = req_builder
            .send()
            .await
            .map_err(|e| classed(ProviderErrorClass::Rejected, format!("查询 Datalab 状态网络失败: {}", e)))?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(classed(
                ProviderErrorClass::Auth,
                format!("Datalab 认证拒绝 (HTTP {}): API Key 无效或已过期", status.as_u16()),
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
                format!("FLOWREAD_HTTP_429:{}:Datalab 请求频次受限", retry_after),
            ));
        }

        if status.is_server_error() {
            let code = status.as_u16();
            let err_body = read_json_limited(resp, MAX_JSON_BYTES).await.ok();
            let err_msg = err_body
                .as_ref()
                .and_then(|j| pick_string(j, &["error", "message"]))
                .unwrap_or_else(|| "Datalab 服务端异常".to_string());
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("FLOWREAD_HTTP_5XX:{}:{}", code, err_msg),
            ));
        }

        if !status.is_success() {
            let code = status.as_u16();
            let err_body = read_json_limited(resp, MAX_JSON_BYTES).await.ok();
            let err_msg = err_body
                .as_ref()
                .and_then(|j| pick_string(j, &["error", "message"]))
                .unwrap_or_else(|| format!("HTTP 状态码: {}", code));
            return Err(classed(
                ProviderErrorClass::Rejected,
                format!("Datalab 状态查询失败 (HTTP {}): {}", code, err_msg),
            ));
        }

        let resp_json = read_json_limited(resp, MAX_JSON_BYTES)
            .await
            .map_err(|e| classed(ProviderErrorClass::Rejected, e))?;

        let status_str = resp_json
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("processing")
            .to_ascii_lowercase();

        let success = resp_json.get("success").and_then(|v| v.as_bool());
        let error_val = pick_string(&resp_json, &["error"]);
        let result_url = pick_string(&resp_json, &["result_url"]);

        // 统一状态映射：
        // 规范强制："status='complete' 后仍检查 success 和 error；complete 不等于解析成功。"
        let mapped_status = if status_str == "complete" {
            if success == Some(false) || error_val.is_some() {
                "failed"
            } else {
                "done"
            }
        } else if matches!(status_str.as_str(), "error" | "failed") {
            "failed"
        } else {
            "processing"
        };

        Ok(DatalabStatusResult {
            status: mapped_status.to_string(),
            raw_status: status_str,
            success,
            error: error_val,
            result_url,
            data: resp_json,
        })
    }

    /// 3. 保存原始结果与提取图片到 raw_dir/
    ///
    /// 返回非致命的告警（例如可选图片下载失败）。必需资产缺失会在归一化阶段明确失败。
    pub async fn save_results(
        &self,
        check_result: &DatalabStatusResult,
        dest_raw_dir: &Path,
    ) -> Result<Vec<String>, String> {
        fs::create_dir_all(dest_raw_dir)
            .map_err(|e| format!("创建原始结果目录失败: {}", e))?;

        let images_dir = dest_raw_dir.join("images");
        fs::create_dir_all(&images_dir)
            .map_err(|e| format!("创建原始图片目录失败: {}", e))?;

        let mut warnings: Vec<String> = Vec::new();
        let mut res_data = check_result.data.clone();

        // 内联结果是否“真的完整”：字段存在但为 null / 空字符串都不算有内容
        let has_inline = has_string_value(&res_data, &["markdown", "md", "html"])
            || res_data
                .get("json")
                .map(|v| !v.is_null())
                .unwrap_or(false)
            || res_data
                .get("children")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false)
            || res_data
                .get("pages")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);

        // 外置 result_url：只有内联结果确实缺失时才需要下载完整结果
        if let Some(ref r_url) = check_result.result_url {
            if !has_inline {
                let parsed = Url::parse(r_url)
                    .map_err(|e| format!("Datalab result_url 非法: {}", e))?;
                let same_api = is_valid_datalab_api_origin(&parsed);
                let client = if same_api { &self.api_client } else { &self.storage_client };

                let mut req = client.get(parsed.clone());
                if same_api {
                    req = req.header("X-API-Key", self.api_key.trim());
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| format!("下载 Datalab 完整结果失败: {}", e))?;
                if !resp.status().is_success() {
                    return Err(format!(
                        "下载 Datalab 完整结果失败 (HTTP {})",
                        resp.status().as_u16()
                    ));
                }
                let downloaded = read_json_limited(resp, MAX_RESULT_JSON_BYTES)
                    .await
                    .map_err(|e| format!("解析 Datalab 完整结果失败: {}", e))?;
                res_data = merge_result_metadata(downloaded, &check_result.data);
            }
        }

        // 保存完成响应元数据（保留 failed_pages 等诊断信息）
        fs::write(
            dest_raw_dir.join("datalab_response.json"),
            serde_json::to_string_pretty(&res_data)
                .map_err(|e| format!("序列化 datalab_response.json 失败: {}", e))?,
        )
        .map_err(|e| format!("保存 datalab_response.json 失败: {}", e))?;

        // markdown：字段为 null 时自动回退到 md
        if let Some(md) = pick_string(&res_data, &["markdown", "md"]) {
            if let Err(e) = fs::write(dest_raw_dir.join("result.md"), md) {
                warnings.push(format!("保存 result.md 失败: {}", e));
            }
        }

        // html：字段为 null 时不做任何事，不写空文件
        if let Some(html) = pick_string(&res_data, &["html"]) {
            if let Err(e) = fs::write(dest_raw_dir.join("result.html"), html) {
                warnings.push(format!("保存 result.html 失败: {}", e));
            }
        }

        // 结构化结果：优先 json，其次 pages / children；重包装时必须保留顶层 metadata
        let final_json = build_result_json(&res_data);

        fs::write(
            dest_raw_dir.join("result.json"),
            serde_json::to_string_pretty(&final_json)
                .map_err(|e| format!("序列化 result.json 失败: {}", e))?,
        )
        .map_err(|e| format!("保存 result.json 失败: {}", e))?;

        // 图片：结果树里每个结构块都可能带 images（Base64 或外置 URL），必须递归收集。
        let mut image_entries: Vec<(String, serde_json::Value)> = Vec::new();
        collect_image_entries(&res_data, &mut image_entries);
        let mut seen_entries: std::collections::HashSet<String> = std::collections::HashSet::new();
        image_entries.retain(|(name, value)| {
            seen_entries.insert(format!("{}={}", name, value))
        });

        let mut manifest: std::collections::HashMap<String, String> = std::collections::HashMap::new();

        {
            for (img_name, img_val) in image_entries {
                let Some(target_path) = safe_relative_image_path(&images_dir, &img_name) else {
                    warnings.push(format!("忽略非法的图片名称: {}", img_name));
                    continue;
                };

                if let Some(parent) = target_path.parent() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        warnings.push(format!("创建图片子目录失败 ({}): {}", img_name, e));
                        continue;
                    }
                }

                let result = if let Some(val_str) = img_val.as_str() {
                    if val_str.starts_with("http://") || val_str.starts_with("https://") {
                        download_to_file(
                            &self.storage_client,
                            val_str,
                            &target_path,
                            MAX_IMAGE_BYTES,
                        )
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                    } else {
                        decode_base64_image(val_str)
                            .and_then(|bytes| fs::write(&target_path, bytes).map_err(|e| e.to_string()))
                    }
                } else {
                    Err("图片字段既不是 URL 也不是 Base64 字符串".to_string())
                };

                match result {
                    Ok(()) => {
                        if let Ok(rel) = target_path.strip_prefix(dest_raw_dir) {
                            manifest.insert(
                                img_name.clone(),
                                rel.to_string_lossy().replace('\\', "/"),
                            );
                        }
                    }
                    Err(e) => {
                        warnings.push(format!("图片 {} 未能保存: {}", img_name, e));
                    }
                }
            }
        }

        // 保存持久图片映射 manifest 供归一化阶段精确反查原始引用
        if !manifest.is_empty() {
            if let Ok(json_str) = serde_json::to_string_pretty(&manifest) {
                let _ = fs::write(dest_raw_dir.join("images_manifest.json"), json_str);
            }
        }

        Ok(warnings)
    }
}

/// 递归收集结果树中所有 `images` 映射（每个块都可能自带图片）。
fn collect_image_entries(value: &serde_json::Value, out: &mut Vec<(String, serde_json::Value)>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(images) = map.get("images").and_then(|v| v.as_object()) {
                for (name, val) in images {
                    out.push((name.clone(), val.clone()));
                }
            }
            for (key, child) in map {
                if key == "images" {
                    continue;
                }
                collect_image_entries(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_image_entries(item, out);
            }
        }
        _ => {}
    }
}

fn decode_base64_image(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let payload = match value.find(',') {
        Some(idx) => &value[idx + 1..],
        None => value,
    };
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Base64 解码失败: {}", e))
}

/// 把图片名称规范为 images/ 下的安全相对路径；拒绝绝对路径与 `..` 逃逸。
fn safe_relative_image_path(images_dir: &Path, name: &str) -> Option<PathBuf> {
    let normalized = name.replace('\\', "/");
    let candidate = Path::new(&normalized);
    if candidate.is_absolute() {
        return None;
    }
    for comp in candidate.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => return None,
        }
    }
    let rel: PathBuf = candidate
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(images_dir.join(rel))
}

/// 下载到的完整结果如果缺少诊断元数据，用状态响应补齐；
/// 重包装 children 时绝不能再丢掉顶层 metadata / failed_pages。
fn merge_result_metadata(mut downloaded: serde_json::Value, status: &serde_json::Value) -> serde_json::Value {
    if let Some(obj) = downloaded.as_object_mut() {
        for key in ["metadata", "failed_pages", "success", "status", "page_count", "runtime"] {
            if obj.get(key).is_none() {
                if let Some(v) = status.get(key) {
                    obj.insert(key.to_string(), v.clone());
                }
            }
        }

        // metadata 内部的 failed_pages 也要保留
        if let Some(status_meta) = status.get("metadata") {
            if let Some(meta) = obj.get_mut("metadata").and_then(|m| m.as_object_mut()) {
                if meta.get("failed_pages").is_none() {
                    if let Some(fp) = status_meta.get("failed_pages") {
                        meta.insert("failed_pages".to_string(), fp.clone());
                    }
                }
            }
        }
    }
    downloaded
}

/// 构造最终 result.json：
/// - 已经是含 children 的对象：原样使用；
/// - json 为对象/数组：以 children 承载，但保留其它顶层元数据；
/// - 其它：回退整份响应。
fn build_result_json(res_data: &serde_json::Value) -> serde_json::Value {
    if let Some(obj) = res_data.as_object() {
        if obj.get("children").map(|v| v.is_array()).unwrap_or(false) {
            return res_data.clone();
        }
    }

    let structural = res_data.get("json").filter(|v| !v.is_null()).or_else(|| {
        res_data
            .get("pages")
            .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
    });

    match structural {
        Some(serde_json::Value::Object(obj)) if obj.get("children").is_some() => {
            // 用结构化对象作为基础，但补齐顶层元数据（不覆盖已有字段）
            let mut merged = res_data.clone();
            if let Some(merged_obj) = merged.as_object_mut() {
                for (k, v) in obj {
                    merged_obj.insert(k.clone(), v.clone());
                }
                merged
            } else {
                serde_json::Value::Object(obj.clone())
            }
        }
        Some(serde_json::Value::Array(items)) => {
            let mut obj = serde_json::Map::new();
            obj.insert(
                "children".to_string(),
                serde_json::Value::Array(items.clone()),
            );
            // 保留顶层 metadata / failed_pages / status 等诊断字段
            if let Some(src) = res_data.as_object() {
                for (k, v) in src {
                    if k == "json" || k == "children" {
                        continue;
                    }
                    obj.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            serde_json::Value::Object(obj)
        }
        _ => res_data.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_result_json_preserves_metadata_when_wrapping_array() {
        let raw = serde_json::json!({
            "status": "complete",
            "metadata": { "failed_pages": [3], "page_count": 4 },
            "json": [ { "block_type": "text" } ]
        });
        let built = build_result_json(&raw);
        assert!(built.get("children").and_then(|v| v.as_array()).is_some());
        assert_eq!(
            built
                .get("metadata")
                .and_then(|m| m.get("failed_pages"))
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(1),
            "重包装 children 时必须保留 metadata.failed_pages"
        );
        assert_eq!(built.get("status").and_then(|v| v.as_str()), Some("complete"));
    }

    #[test]
    fn test_safe_relative_image_path_rejects_traversal() {
        let base = Path::new("C:/tmp/images");
        assert!(safe_relative_image_path(base, "../evil.png").is_none());
        assert!(safe_relative_image_path(base, "C:/evil.png").is_none());
        assert!(safe_relative_image_path(base, "a/fig.png").is_some());
        assert_eq!(
            safe_relative_image_path(base, "a\\fig.png").unwrap(),
            base.join("a").join("fig.png")
        );
    }
}
