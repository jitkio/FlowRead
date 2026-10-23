use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use uuid::Uuid;

use crate::db::{self, DbState, ParseJobDto, ParseJobRecord};
use crate::parse_normalize::{
    normalize_datalab_results, normalize_mineru_results, safe_extract_zip,
};
use crate::parse_providers::datalab::DatalabClient;
use crate::parse_providers::mineru::MinerUClient;
use crate::parse_providers::{classify_error_message, ProviderErrorClass};
use crate::parse_settings::{
    self, get_settings_internal, provider_credential_status, save_settings_internal,
    validate_provider_name, ParseSettingsResponse, ParseSettingsSaveRequest,
    ProviderTokenClearRequest, ProviderTokenResult, ProviderTokenSetRequest, PROVIDER_DATALAB,
    PROVIDER_MINERU,
};
use crate::parsed_workspace::{import_normalized_dir_with_options, ParsedImportOptions};

// ================= Error Codes =================

pub const ERR_NOT_FOUND: &str = "ERR_NOT_FOUND";
pub const ERR_AUTH_REJECTED: &str = "ERR_AUTH_REJECTED";
pub const ERR_CREDENTIAL_STORE: &str = "ERR_CREDENTIAL_STORE";
pub const ERR_SOURCE_CHANGED: &str = "ERR_SOURCE_CHANGED";
pub const ERR_SUBMISSION_TIMEOUT: &str = "ERR_SUBMISSION_TIMEOUT";
pub const ERR_REMOTE_FAILED: &str = "ERR_REMOTE_FAILED";
pub const ERR_POLL_FAILED: &str = "ERR_POLL_FAILED";
pub const ERR_DOWNLOAD_FAILED: &str = "ERR_DOWNLOAD_FAILED";
pub const ERR_NORMALIZE_FAILED: &str = "ERR_NORMALIZE_FAILED";
pub const ERR_IMPORT_FAILED: &str = "ERR_IMPORT_FAILED";
pub const ERR_CANCELLED: &str = "ERR_CANCELLED";
pub const ERR_FILE_NOT_FOUND: &str = "ERR_FILE_NOT_FOUND";
pub const ERR_INVALID_ARGUMENT: &str = "ERR_INVALID_ARGUMENT";
pub const ERR_INTERRUPTED: &str = "ERR_INTERRUPTED";

const MAX_POLL_DURATION: Duration = Duration::from_secs(30 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_CONSECUTIVE_POLL_ERRORS: u32 = 5;

// ================= Parse Manager State =================

pub struct ParseManager {
    pub app_handle: AppHandle,
    /// 每个正在执行的任务对应一个取消信号；取消时直接打断在途网络 future
    pub cancel_senders: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    pub notify_tx: tokio::sync::mpsc::Sender<()>,
    pub is_running: Arc<AtomicBool>,
}

impl ParseManager {
    pub fn new(app_handle: AppHandle) -> (Self, tokio::sync::mpsc::Receiver<()>) {
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        let manager = Self {
            app_handle,
            cancel_senders: Arc::new(Mutex::new(HashMap::new())),
            notify_tx: tx,
            is_running: Arc::new(AtomicBool::new(false)),
        };
        (manager, rx)
    }

    pub fn trigger_runner(&self) {
        let _ = self.notify_tx.try_send(());
    }

    /// 取消在途网络请求（若该任务正在执行）
    pub fn signal_cancel(&self, job_id: &str) {
        let senders = self.cancel_senders.lock().unwrap();
        if let Some(tx) = senders.get(job_id) {
            let _ = tx.send(true);
        }
    }
}

// ================= Request / Response Payloads =================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseJobStartRequest {
    #[serde(alias = "source_path")]
    pub source_path: String,
    #[serde(alias = "provider")]
    pub provider: Option<String>,
    #[serde(alias = "force_new")]
    pub force_new: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseJobListRequest {
    #[serde(default, alias = "document_id")]
    pub document_id: Option<String>,
    #[serde(default, alias = "active_only")]
    pub active_only: Option<bool>,
    #[serde(default = "default_list_limit", alias = "limit")]
    pub limit: Option<i64>,
    #[serde(default, alias = "cursor")]
    pub cursor: Option<String>,
}

fn default_list_limit() -> Option<i64> {
    Some(50)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseJobListResponse {
    pub items: Vec<ParseJobDto>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseJobResultResponse {
    pub document_id: String,
    pub source_revision: String,
    pub version_id: String,
    pub blocks_path: String,
    pub activated: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseServiceHealthDto {
    pub scheduler_status: String, // "idle" | "busy" | "error"
    pub current_job_id: Option<String>,
    pub current_job_stage: Option<String>,
    pub last_scheduler_error: Option<String>,
    pub last_scheduler_error_at: Option<i64>,
    pub last_heartbeat_at: i64,
}

static SCHEDULER_HEALTH: Mutex<Option<ParseServiceHealthDto>> = Mutex::new(None);

pub fn get_service_health() -> ParseServiceHealthDto {
    let lock = SCHEDULER_HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    match lock.as_ref() {
        Some(h) => h.clone(),
        None => ParseServiceHealthDto {
            scheduler_status: "idle".to_string(),
            current_job_id: None,
            current_job_stage: None,
            last_scheduler_error: None,
            last_scheduler_error_at: None,
            last_heartbeat_at: 0,
        },
    }
}

pub fn record_scheduler_idle() {
    let mut lock = SCHEDULER_HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    let last_err = lock.as_ref().and_then(|h| h.last_scheduler_error.clone());
    let last_err_at = lock.as_ref().and_then(|h| h.last_scheduler_error_at);
    *lock = Some(ParseServiceHealthDto {
        scheduler_status: if last_err.is_some() {
            "error".to_string()
        } else {
            "idle".to_string()
        },
        current_job_id: None,
        current_job_stage: None,
        last_scheduler_error: last_err,
        last_scheduler_error_at: last_err_at,
        last_heartbeat_at: db::now_ms(),
    });
}

pub fn record_scheduler_busy(job_id: &str, stage: Option<&str>) {
    let mut lock = SCHEDULER_HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    let last_err = lock.as_ref().and_then(|h| h.last_scheduler_error.clone());
    let last_err_at = lock.as_ref().and_then(|h| h.last_scheduler_error_at);
    let stage_to_set = match stage {
        Some(s) => Some(s.to_string()),
        None => lock.as_ref().and_then(|h| h.current_job_stage.clone()),
    };
    *lock = Some(ParseServiceHealthDto {
        scheduler_status: "busy".to_string(),
        current_job_id: Some(job_id.to_string()),
        current_job_stage: stage_to_set,
        last_scheduler_error: last_err,
        last_scheduler_error_at: last_err_at,
        last_heartbeat_at: db::now_ms(),
    });
}

pub fn record_scheduler_error(err: &str) {
    let mut lock = SCHEDULER_HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    let now = db::now_ms();
    let current_job = lock.as_ref().and_then(|h| h.current_job_id.clone());
    let current_stage = lock.as_ref().and_then(|h| h.current_job_stage.clone());
    *lock = Some(ParseServiceHealthDto {
        scheduler_status: "error".to_string(),
        current_job_id: current_job,
        current_job_stage: current_stage,
        last_scheduler_error: Some(err.to_string()),
        last_scheduler_error_at: Some(now),
        last_heartbeat_at: now,
    });
}

pub fn clear_scheduler_error() {
    let mut lock = SCHEDULER_HEALTH.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut h) = *lock {
        h.last_scheduler_error = None;
        h.last_scheduler_error_at = None;
        if h.scheduler_status == "error" {
            h.scheduler_status = if h.current_job_id.is_some() {
                "busy".to_string()
            } else {
                "idle".to_string()
            };
        }
    }
}

// ================= File & Hash Helpers =================

pub fn compute_file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("打开文件计算哈希失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("读取文件内容计算哈希失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 边复制边计算哈希，避免大文件一次性读入内存。
fn copy_with_hash(src: &Path, dst: &Path) -> Result<String, String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建快照目录失败: {}", e))?;
    }
    let mut input = File::open(src).map_err(|e| format!("打开源 PDF 失败: {}", e))?;
    let mut output = File::create(dst).map_err(|e| format!("创建私有快照失败: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = input
            .read(&mut buffer)
            .map_err(|e| format!("读取源 PDF 失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        output
            .write_all(&buffer[..n])
            .map_err(|e| format!("写入私有快照失败: {}", e))?;
    }
    output.flush().map_err(|e| format!("刷新私有快照失败: {}", e))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn file_revision(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!("{}-{}", meta.len(), mtime))
}

pub fn get_config_signature(provider: &str) -> &'static str {
    match provider {
        PROVIDER_MINERU => "mineru:vlm:formula:table:ch",
        PROVIDER_DATALAB => "datalab:balanced:images:nocaptions",
        _ => "default",
    }
}

// ================= Worker Pipeline =================

/// 任务运行时依赖：仅依赖数据库、工作区目录与取消信号，
/// 不依赖 Tauri AppHandle，便于离线测试直接驱动完整协调层。
pub struct JobRuntime<'a> {
    pub workspace_dir: PathBuf,
    pub conn: &'a Mutex<rusqlite::Connection>,
    pub cancel: watch::Receiver<bool>,
}

impl<'a> JobRuntime<'a> {
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .conn
            .lock()
            .map_err(|e| format!("数据库连接不可用: {}", e))?;
        f(&guard)
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
}

/// 等待一个网络 future，但取消信号到达时立即放弃等待。
async fn cancellable<T>(
    rx: &mut watch::Receiver<bool>,
    fut: impl std::future::Future<Output = T>,
) -> Option<T> {
    if *rx.borrow() {
        return None;
    }
    tokio::select! {
        value = fut => Some(value),
        changed = rx.changed() => {
            let _ = changed;
            None
        }
    }
}

fn transition(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    status: &str,
    can_cancel: bool,
    can_resume: bool,
    error: Option<(&str, String)>,
) -> Result<bool, String> {
    let (code, message) = match error {
        Some((c, m)) => (Some(c), Some(m)),
        None => (None, None),
    };
    let changed = rt.with_conn(|conn| {
        db::transition_parse_job_status(
            conn,
            &job.job_id,
            status,
            can_cancel as i64,
            can_resume as i64,
            code,
            message.as_deref(),
        )
    })?;
    if changed {
        job.status = status.to_string();
        job.progress_percent = None;
        job.can_cancel = can_cancel as i64;
        job.can_resume = can_resume as i64;
        job.error_code = code.map(|c| c.to_string());
        job.error_message = message;
        record_scheduler_busy(&job.job_id, Some(status));
    }
    Ok(changed)
}

fn apply_terminal_fields(
    job: &mut ParseJobRecord,
    status: &str,
    code: &str,
    message: &str,
    can_cancel: bool,
    can_resume: bool,
) {
    job.status = status.to_string();
    job.error_code = Some(code.to_string());
    job.error_message = Some(message.to_string());
    job.can_cancel = can_cancel as i64;
    job.can_resume = can_resume as i64;
    job.progress_percent = None;
}

/// 终止型状态更新：条件更新优先；只有任务确实处于 importing（条件更新不覆盖该状态）
/// 时才强制写入，绝不会覆盖已取消或已成功的任务。
fn finish_job_state(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    status: &str,
    code: &str,
    message: &str,
    can_cancel: bool,
    can_resume: bool,
) -> Result<(), String> {
    apply_terminal_fields(job, status, code, message, can_cancel, can_resume);

    let changed = rt.with_conn(|conn| {
        db::transition_parse_job_status(
            conn,
            &job.job_id,
            status,
            can_cancel as i64,
            can_resume as i64,
            Some(code),
            Some(message),
        )
    })?;
    if changed {
        return Ok(());
    }

    let current = rt.with_conn(|conn| db::get_parse_job(conn, &job.job_id))?;
    match current {
        Some(rec) if rec.status == "importing" => {
            rt.with_conn(|conn| db::update_parse_job(conn, job))
        }
        // 已取消 / 已成功：保持数据库中的既有状态，不做覆盖
        _ => Ok(()),
    }
}

fn fail_job(rt: &JobRuntime<'_>, job: &mut ParseJobRecord, code: &str, message: &str) -> Result<(), String> {
    finish_job_state(rt, job, "failed", code, message, false, true)
}

fn pause_job(rt: &JobRuntime<'_>, job: &mut ParseJobRecord, code: &str, message: &str) -> Result<(), String> {
    finish_job_state(rt, job, "paused", code, message, true, true)
}

/// 只有拿到可靠远端 ID 时“继续”才有意义（只能核查，不能重新提交）。
pub fn submission_unknown_can_resume(job: &ParseJobRecord) -> bool {
    job.remote_submitted == 1 && job.remote_id.is_some()
}

fn mark_submission_unknown(rt: &JobRuntime<'_>, job: &mut ParseJobRecord, message: &str) -> Result<(), String> {
    // 没有远端 ID 时明确不可继续，由用户用“重新解析”创建新任务。
    let can_resume = submission_unknown_can_resume(job);
    finish_job_state(
        rt,
        job,
        "submission_unknown",
        ERR_SUBMISSION_TIMEOUT,
        &format!(
            "首次提交请求未确认，服务商可能已受理；如确认需要重试，请使用“重新解析”创建新任务: {}",
            message
        ),
        false,
        can_resume,
    )
}

/// 完整任务流水线。返回 Err 表示基础设施故障（例如关键检查点写库失败），
/// 由调用方记录并把任务转为可恢复状态；返回 Ok 时任务一定处于明确状态。
pub async fn run_job_pipeline(
    rt: &mut JobRuntime<'_>,
    job: &mut ParseJobRecord,
) -> Result<(), String> {
    let job_dir = rt.workspace_dir.join("jobs").join(&job.job_id);
    let input_dir = job_dir.join("input");
    let raw_dir = job_dir.join("raw");
    let normalized_dir = job_dir.join("normalized");
    for dir in [&input_dir, &raw_dir, &normalized_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("创建任务私有目录失败: {}", e))?;
    }

    if rt.is_cancelled() {
        return Ok(());
    }

    // ---------- 阶段 0：已发出提交请求但没有远端标识 ----------
    // 这是“服务商可能已受理、本地却没保存 ID”的窗口：绝不能重新 POST，
    // 与显示状态（preparing/paused/queued）无关，只看持久化的提交意图。
    if job.submit_attempted == 1 && job.remote_submitted == 0 {
        mark_submission_unknown(
            rt,
            job,
            "上次提交请求已发出，但未保存远端标识，无法确认服务商是否已受理",
        )?;
        return Ok(());
    }

    let mut resume_diag: Option<String> = None;

    // ---------- 阶段 1：已有完整归一化产物 → 纯本地入库 ----------
    if job.normalized_ready == 1 {
        match validate_normalized_dir(&normalized_dir) {
            Ok(_) => {
                return import_phase(rt, job, &normalized_dir).await;
            }
            Err(e) => {
                let diag = format!("归一化检查点无效（{}），已回退到上一阶段", e);
                eprintln!("[FlowRead] {}", diag);
                resume_diag = Some(diag);
                reset_checkpoint(rt, job, CheckpointField::Normalized)?;
            }
        }
    }

    // ---------- 阶段 2：raw 产物已完整 → 本地归一化后入库 ----------
    if job.artifacts_downloaded == 1 {
        match validate_raw_artifacts(&job.provider, &raw_dir) {
            Ok(_) => {
                return normalize_then_import(rt, job, &raw_dir, &normalized_dir).await;
            }
            Err(e) => {
                let diag = format!("已下载产物检查点无效（{}），已回退到云端阶段", e);
                eprintln!("[FlowRead] {}", diag);
                resume_diag = Some(diag);
                reset_checkpoint(rt, job, CheckpointField::Downloaded)?;
            }
        }
    }

    // ---------- 阶段 3：远端流程（只有这里才需要凭据与网络） ----------
    if !transition(rt, job, "preparing", true, false, None)? {
        return Ok(());
    }

    let snapshot = input_dir.join("source.pdf");
    let snapshot_valid = if snapshot.is_file() {
        let snapshot_for_hash = snapshot.clone();
        let expected_hash = job.source_hash.clone();
        match tokio::task::spawn_blocking(move || compute_file_sha256(&snapshot_for_hash)).await {
            Ok(Ok(hash)) => hash == expected_hash,
            Ok(Err(e)) => {
                eprintln!("[FlowRead] 校验私有快照失败，将重新复制: {}", e);
                false
            }
            Err(e) => {
                eprintln!("[FlowRead] 校验快照任务失败，将重新复制: {}", e);
                false
            }
        }
    } else {
        false
    };

    if !snapshot_valid {
        let src = PathBuf::from(&job.source_path);
        if !src.is_file() {
            fail_job_with_diag(
                rt,
                job,
                ERR_FILE_NOT_FOUND,
                "源 PDF 不存在，且没有可用的私有快照，也没有已完成的本地产物",
                resume_diag.as_deref(),
            )?;
            return Ok(());
        }

        let src_for_copy = src.clone();
        let snapshot_for_copy = snapshot.clone();
        let hash = tokio::task::spawn_blocking(move || {
            copy_with_hash(&src_for_copy, &snapshot_for_copy)
        })
        .await
        .map_err(|e| format!("复制私有快照任务失败: {}", e))??;
        if hash != job.source_hash {
            fail_job(
                rt,
                job,
                ERR_SOURCE_CHANGED,
                "源 PDF 在任务建立后发生变更（哈希与任务记录不一致）",
            )?;
            return Ok(());
        }

        job.snapshot_rel_path = Some("input/source.pdf".to_string());
        checkpoint(rt, job, "preparing")?;
    }

    // 凭据：区分“未配置”与“读取失败”
    let token = match parse_settings::get_provider_token(&job.provider) {
        Ok(Some(t)) => t,
        Ok(None) => {
            pause_job_with_diag(
                rt,
                job,
                ERR_AUTH_REJECTED,
                "未配置对应服务商 Token，请在解析服务设置中保存后继续任务",
                resume_diag.as_deref(),
            )?;
            return Ok(());
        }
        Err(e) => {
            pause_job_with_diag(
                rt,
                job,
                ERR_CREDENTIAL_STORE,
                &format!("读取系统凭据失败（不是未配置）: {}", e),
                resume_diag.as_deref(),
            )?;
            return Ok(());
        }
    };

    // 复用服务商客户端连接池，避免每次轮询重新创建 Client
    let mineru_client = if job.provider == PROVIDER_MINERU {
        Some(MinerUClient::new(token.clone()))
    } else {
        None
    };
    let datalab_client = if job.provider == PROVIDER_DATALAB {
        Some(DatalabClient::new(token.clone()))
    } else {
        None
    };

    // ---------- 阶段 4：提交（提交意图先落盘） ----------
    if job.remote_submitted == 0 {
        if !transition(rt, job, "submitting", true, false, None)? {
            return Ok(());
        }

        // 关键：在发出请求之前持久化“已进入可能被受理阶段”。
        // 该标记不随 preparing/paused/queued 等显示状态变化而丢失。
        job.submit_attempted = 1;
        checkpoint(rt, job, "submitting")?;

        let submit_result: Option<Result<SubmitOutcome, String>> = match job.provider.as_str() {
            PROVIDER_MINERU => {
                let client = mineru_client.as_ref().unwrap();
                cancellable(
                    &mut rt.cancel,
                    client.create_batch(&snapshot, &job.job_id, None),
                )
                .await
                .map(|r| {
                    r.map(|info| SubmitOutcome {
                        remote_id: info.batch_id,
                        remote_meta: info.upload_url,
                        upload_included: false,
                    })
                })
            }
            PROVIDER_DATALAB => {
                let client = datalab_client.as_ref().unwrap();
                cancellable(&mut rt.cancel, client.submit_document(&snapshot))
                    .await
                    .map(|r| {
                        r.map(|info| SubmitOutcome {
                            remote_id: info.request_id,
                            remote_meta: info.request_check_url,
                            upload_included: true,
                        })
                    })
            }
            _ => {
                fail_job(rt, job, ERR_INVALID_ARGUMENT, "未知服务商")?;
                return Ok(());
            }
        };

        let Some(submit_result) = submit_result else {
            // 已取消：提交意图仍保留，后续恢复会走“待确认”，不会再 POST
            return Ok(());
        };

        match submit_result {
            Ok(outcome) => {
                job.remote_id = Some(outcome.remote_id);
                job.remote_meta_json = Some(outcome.remote_meta);
                job.remote_submitted = 1;
                if outcome.upload_included {
                    job.upload_completed = 1;
                }
                // 写库失败会让 submit_attempted=1 保留，恢复时进入待确认而不是重提
                checkpoint(rt, job, "submitting")?;
            }
            Err(e) => {
                match classify_error_message(&e) {
                    ProviderErrorClass::Auth => {
                        // 明确未被受理：清除提交意图，允许配置凭据后继续
                        job.submit_attempted = 0;
                        let _ = checkpoint(rt, job, "submitting");
                        pause_job(rt, job, ERR_AUTH_REJECTED, &e)?;
                    }
                    ProviderErrorClass::Rejected => {
                        job.submit_attempted = 0;
                        let _ = checkpoint(rt, job, "submitting");
                        fail_job(rt, job, ERR_REMOTE_FAILED, &e)?;
                    }
                    ProviderErrorClass::Uncertain | ProviderErrorClass::Protocol => {
                        // 可能已受理：保留提交意图，进入待确认
                        mark_submission_unknown(rt, job, &e)?;
                    }
                }
                return Ok(());
            }
        }
    }

    // ---------- 阶段 5：上传（已完成上传不得重复 PUT） ----------
    if job.provider == PROVIDER_MINERU && job.upload_completed == 0 {
        if !transition(rt, job, "uploading", true, false, None)? {
            return Ok(());
        }
        let upload_url = job.remote_meta_json.clone().unwrap_or_default();
        if upload_url.is_empty() {
            fail_job(rt, job, ERR_REMOTE_FAILED, "缺少 MinerU 直传地址")?;
            return Ok(());
        }
        let client = mineru_client.as_ref().unwrap();
        let result = cancellable(&mut rt.cancel, client.upload_file(&upload_url, &snapshot)).await;
        match result {
            None => return Ok(()),
            Some(Ok(())) => {
                job.upload_completed = 1;
                checkpoint(rt, job, "uploading")?;
            }
            Some(Err(e)) => {
                fail_job(rt, job, ERR_REMOTE_FAILED, &format!("上传 PDF 失败: {}", e))?;
                return Ok(());
            }
        }
    }

    // ---------- 阶段 6：轮询 ----------
    if !transition(rt, job, "processing", true, false, None)? {
        return Ok(());
    }

    let mut download_target_url: Option<String> = None;
    let mut datalab_status_result: Option<crate::parse_providers::datalab::DatalabStatusResult> =
        None;

    let poll_start = Instant::now();
    let mut consecutive_errors = 0u32;

    loop {
        if rt.is_cancelled() {
            return Ok(());
        }
        if poll_start.elapsed() > MAX_POLL_DURATION {
            pause_job(
                rt,
                job,
                ERR_POLL_FAILED,
                "云端解析等待超时，已保留远端任务 ID，可稍后继续任务",
            )?;
            return Ok(());
        }

        let poll_outcome = match job.provider.as_str() {
            PROVIDER_MINERU => {
                let client = mineru_client.as_ref().unwrap();
                let batch_id = job.remote_id.clone().unwrap_or_default();
                let res = cancellable(&mut rt.cancel, client.check_batch_status(&batch_id)).await;
                match res {
                    None => return Ok(()),
                    Some(Err(e)) => Err(e),
                    Some(Ok(st)) => {
                        // 接收 extract_progress 真实页数并受状态保护原子写入数据库
                        let effective_completed = st.completed_pages.or(job.completed_pages);
                        let effective_total = st.total_pages.or(job.total_pages);

                        if effective_completed.is_some() || effective_total.is_some() {
                            match rt.with_conn(|conn| {
                                db::update_parse_job_progress(
                                    conn,
                                    &job.job_id,
                                    effective_completed,
                                    effective_total,
                                )
                            }) {
                                Ok(db::ProgressUpdateOutcome::Updated(new_seq)) => {
                                    job.completed_pages = effective_completed;
                                    job.total_pages = effective_total;
                                    job.update_seq = new_seq;
                                    job.updated_at = db::now_ms();
                                    record_scheduler_busy(&job.job_id, Some("processing"));
                                }
                                Ok(db::ProgressUpdateOutcome::NotProcessing) => {
                                    // 任务已取消或脱离 processing 状态，立即停止，不污染终态记录
                                    return Ok(());
                                }
                                Ok(db::ProgressUpdateOutcome::NoChange) => {
                                    record_scheduler_busy(&job.job_id, Some("processing"));
                                }
                                Err(e) => {
                                    eprintln!("[FlowRead] 进度写入失败 ({}): {}", job.job_id, e);
                                }
                            }
                        } else {
                            record_scheduler_busy(&job.job_id, Some("processing"));
                        }

                        if st.status == "done" {
                            download_target_url = st.full_zip_url;
                            Ok(true)
                        } else if st.status == "failed" {
                            fail_job(
                                rt,
                                job,
                                ERR_REMOTE_FAILED,
                                &st.error_message.unwrap_or_else(|| "MinerU 解析失败".to_string()),
                            )?;
                            return Ok(());
                        } else {
                            Ok(false)
                        }
                    }
                }
            }
            PROVIDER_DATALAB => {
                let client = datalab_client.as_ref().unwrap();
                let check_url = job.remote_meta_json.clone().unwrap_or_default();
                let res = cancellable(&mut rt.cancel, client.check_status(&check_url)).await;
                match res {
                    None => return Ok(()),
                    Some(Err(e)) => Err(e),
                    Some(Ok(st)) => {
                        record_scheduler_busy(&job.job_id, Some("processing"));
                        if st.status == "done" {
                            datalab_status_result = Some(st);
                            Ok(true)
                        } else if st.status == "failed" {
                            fail_job(
                                rt,
                                job,
                                ERR_REMOTE_FAILED,
                                &st.error.unwrap_or_else(|| "Datalab 转换失败".to_string()),
                            )?;
                            return Ok(());
                        } else {
                            Ok(false)
                        }
                    }
                }
            }
            _ => Ok(true),
        };

        match poll_outcome {
            Ok(true) => break,
            Ok(false) => {
                consecutive_errors = 0;
            }
            Err(e) => {
                if classify_error_message(&e) == ProviderErrorClass::Auth {
                    pause_job(rt, job, ERR_AUTH_REJECTED, &e)?;
                    return Ok(());
                }
                consecutive_errors += 1;

                if let Some(rest) = e.strip_prefix("FLOWREAD_HTTP_429:") {
                    let parts: Vec<&str> = rest.splitn(2, ':').collect();
                    let retry_secs = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(5).clamp(2, 30);
                    if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                        pause_job(
                            rt,
                            job,
                            ERR_POLL_FAILED,
                            &format!("连续多次请求受限 (429)，已保留远端任务 ID: {}", e),
                        )?;
                        return Ok(());
                    }
                    if cancellable(&mut rt.cancel, tokio::time::sleep(Duration::from_secs(retry_secs)))
                        .await
                        .is_none()
                    {
                        return Ok(());
                    }
                    continue;
                }

                if e.contains("FLOWREAD_HTTP_5XX") {
                    let backoff_secs = (2 * consecutive_errors as u64).clamp(2, 30);
                    if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                        pause_job(
                            rt,
                            job,
                            ERR_POLL_FAILED,
                            &format!("连续 {} 次服务端异常，已保留远端任务 ID: {}", consecutive_errors, e),
                        )?;
                        return Ok(());
                    }
                    if cancellable(&mut rt.cancel, tokio::time::sleep(Duration::from_secs(backoff_secs)))
                        .await
                        .is_none()
                    {
                        return Ok(());
                    }
                    continue;
                }

                if consecutive_errors >= MAX_CONSECUTIVE_POLL_ERRORS {
                    pause_job(
                        rt,
                        job,
                        ERR_POLL_FAILED,
                        &format!("连续 {} 次查询失败，已保留远端任务 ID: {}", consecutive_errors, e),
                    )?;
                    return Ok(());
                }
            }
        }

        if cancellable(&mut rt.cancel, tokio::time::sleep(POLL_INTERVAL))
            .await
            .is_none()
        {
            return Ok(());
        }
    }

    // ---------- 阶段 7：下载（已下载则跳过） ----------
    if !transition(rt, job, "downloading", true, false, None)? {
        return Ok(());
    }

    match job.provider.as_str() {
        PROVIDER_MINERU => {
            let Some(zip_url) = download_target_url else {
                fail_job(
                    rt,
                    job,
                    ERR_REMOTE_FAILED,
                    "MinerU 已完成但未返回产物下载地址",
                )?;
                return Ok(());
            };
            let client = mineru_client.as_ref().unwrap();
            let zip_path = raw_dir.join("mineru_result.zip");
            let downloaded =
                cancellable(&mut rt.cancel, client.download_zip(&zip_url, &zip_path)).await;
            match downloaded {
                None => return Ok(()),
                Some(Err(e)) => {
                    fail_job(rt, job, ERR_DOWNLOAD_FAILED, &format!("下载产物失败: {}", e))?;
                    return Ok(());
                }
                Some(Ok(_)) => {}
            }

            let extracted_dir = raw_dir.join("extracted");
            if extracted_dir.exists() {
                let _ = fs::remove_dir_all(&extracted_dir);
            }
            if let Err(e) = safe_extract_zip(&zip_path, &extracted_dir) {
                fail_job(
                    rt,
                    job,
                    ERR_NORMALIZE_FAILED,
                    &format!("解压 MinerU 产物失败: {}", e),
                )?;
                return Ok(());
            }
        }
        PROVIDER_DATALAB => {
            let Some(status) = datalab_status_result else {
                fail_job(rt, job, ERR_REMOTE_FAILED, "缺少 Datalab 完成状态")?;
                return Ok(());
            };
            let client = datalab_client.as_ref().unwrap();
            let saved = cancellable(&mut rt.cancel, client.save_results(&status, &raw_dir)).await;
            match saved {
                None => return Ok(()),
                Some(Err(e)) => {
                    fail_job(rt, job, ERR_DOWNLOAD_FAILED, &format!("保存产物失败: {}", e))?;
                    return Ok(());
                }
                Some(Ok(warnings)) => {
                    if !warnings.is_empty() {
                        let _ = fs::write(
                            job_dir.join("download-warnings.json"),
                            serde_json::to_string_pretty(&warnings).unwrap_or_default(),
                        );
                    }
                }
            }
        }
        _ => {}
    }

    job.artifacts_downloaded = 1;
    checkpoint(rt, job, "downloading")?;

    // ---------- 阶段 8：归一化后入库 ----------
    normalize_then_import(rt, job, &raw_dir, &normalized_dir).await
}

/// 归一化并在写检查点后进入入库；归一化失败时给出明确状态。
async fn normalize_then_import(
    rt: &mut JobRuntime<'_>,
    job: &mut ParseJobRecord,
    raw_dir: &Path,
    normalized_dir: &Path,
) -> Result<(), String> {
    if !transition(rt, job, "normalizing", true, false, None)? {
        return Ok(());
    }

    let provider = job.provider.clone();
    let raw_for_norm = raw_dir.to_path_buf();
    let norm_for_norm = normalized_dir.to_path_buf();
    let result = tokio::task::spawn_blocking(move || match provider.as_str() {
        PROVIDER_MINERU => normalize_mineru_results(&raw_for_norm, &norm_for_norm),
        PROVIDER_DATALAB => normalize_datalab_results(&raw_for_norm, &norm_for_norm),
        _ => Err("未知服务商".to_string()),
    })
    .await
    .map_err(|e| format!("归一化任务执行失败: {}", e))?;

    match result {
        Ok(_) => {
            // 归一化已完成；若此刻已被取消，下面的检查点写入会因状态不符而失败并停止
            run_before_normalized_checkpoint_barrier(&job.job_id);
            job.normalized_ready = 1;
            checkpoint(rt, job, "normalizing")?;
        }
        Err(e) => {
            fail_job(rt, job, ERR_NORMALIZE_FAILED, &format!("归一化失败: {}", e))?;
            return Ok(());
        }
    }

    import_phase(rt, job, normalized_dir).await
}

/// 入库阶段：先进入 normalizing（本地恢复时状态可能仍是 processing/paused），
/// 再以原子条件更新领取执行权。
async fn import_phase(
    rt: &mut JobRuntime<'_>,
    job: &mut ParseJobRecord,
    normalized_dir: &Path,
) -> Result<(), String> {
    // 确保领取执行权前状态为 normalizing：取消/成功/入库中会在这里直接失败并停止
    if !transition(rt, job, "normalizing", true, false, None)? {
        return Ok(());
    }

    run_before_import_barrier(&job.job_id);
    let began = rt.with_conn(|conn| db::try_begin_parse_import(conn, &job.job_id))?;
    if !began {
        // 区分：已取消 / 其它执行者已领取 / 状态异常（不能静默留在 processing）
        let current = rt
            .with_conn(|conn| db::get_parse_job(conn, &job.job_id))?
            .ok_or_else(|| "解析任务不存在".to_string())?;
        match current.status.as_str() {
            "cancelled" | "succeeded" | "importing" => return Ok(()),
            other => {
                pause_job(
                    rt,
                    job,
                    ERR_IMPORT_FAILED,
                    &format!(
                        "无法取得入库执行权（当前状态 '{}'），任务保持可继续",
                        other
                    ),
                )?;
                return Ok(());
            }
        }
    }

    let latest = rt.with_conn(|conn| db::get_parse_job(conn, &job.job_id))?;
    match latest {
        Some(record) if record.status == "importing" => {
            *job = record;
            record_scheduler_busy(&job.job_id, Some("importing"));
        }
        _ => return Ok(()),
    }

    let version_id = format!("ver_{}", job.job_id);
    let baseline = job.activation_baseline_version_id.clone();
    let allow_activation = !source_revision_changed(job);

    let import_result = {
        let mut guard = rt
            .conn
            .lock()
            .map_err(|e| format!("数据库连接不可用: {}", e))?;
        import_normalized_dir_with_options(
            &rt.workspace_dir,
            &mut guard,
            &job.document_id,
            &job.source_revision,
            &job.provider,
            &job.config_signature,
            normalized_dir,
            ParsedImportOptions {
                expected_active_version_id: baseline.as_deref(),
                activate: allow_activation,
                job_id: Some(&job.job_id),
                version_id_override: Some(&version_id),
            },
        )
    };

    match import_result {
        Ok((version_id, _blocks, _assets, _rel, activated)) => {
            // 版本登记与任务成功已在同一事务内完成，这里只同步内存对象，
            // 不能再整条写回（否则会覆盖事务刚写入的状态）。
            job.status = "succeeded".to_string();
            job.version_id = Some(version_id);
            job.activated = if activated { 1 } else { 0 };
            job.can_cancel = 0;
            job.can_resume = 0;
            job.progress_percent = Some(100);
            job.error_code = None;
            job.error_message = None;
            Ok(())
        }
        Err(e) => {
            // 入库失败可能是“任务已被取消”导致的事务回滚：此时不得覆盖取消状态
            let current = rt.with_conn(|conn| db::get_parse_job(conn, &job.job_id))?;
            if matches!(&current, Some(rec) if rec.status == "cancelled") {
                return Ok(());
            }
            job.status = "failed".to_string();
            job.error_code = Some(ERR_IMPORT_FAILED.to_string());
            job.error_message = Some(format!("解析结果入库失败: {}", e));
            job.can_cancel = 0;
            job.can_resume = 1;
            job.progress_percent = None;
            // 仅在任务仍处于 importing 时写回，避免覆盖其它执行者/取消后的新状态
            let _ = rt.with_conn(|conn| {
                db::update_parse_job_if_status(conn, job, "importing").map(|_| ())
            });
            Ok(())
        }
    }
}

/// 检查点字段枚举：回退时明确要清除哪一个
enum CheckpointField {
    Normalized,
    Downloaded,
}

/// 检查点回退：只清空本地进度字段，不改状态；状态已变化则停止当前执行。
fn reset_checkpoint(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    field: CheckpointField,
) -> Result<(), String> {
    let current = rt
        .with_conn(|conn| db::get_parse_job(conn, &job.job_id))?
        .ok_or_else(|| "解析任务不存在".to_string())?;

    match field {
        CheckpointField::Normalized => {
            job.normalized_ready = 0;
        }
        CheckpointField::Downloaded => {
            job.artifacts_downloaded = 0;
            job.normalized_ready = 0;
        }
    }

    checkpoint(rt, job, &current.status)
}

/// 检查点写入：只写本地进度，状态不符（例如刚被取消）时返回错误中止当前执行。
fn checkpoint(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    expected_status: &str,
) -> Result<(), String> {
    job.updated_at = db::now_ms();
    let new_seq = rt.with_conn(|conn| db::update_parse_job_checkpoint(conn, job, expected_status))?;
    job.update_seq = new_seq;
    Ok(())
}

/// 源文件修订是否已变化；源文件不存在时以已校验的本地产物为准（不因此阻止激活）。
fn source_revision_changed(job: &ParseJobRecord) -> bool {
    let path = Path::new(&job.source_path);
    if !path.is_file() {
        return false;
    }
    match file_revision(path) {
        Ok(revision) => revision != job.source_revision,
        Err(_) => true,
    }
}

/// 归一化产物校验：不能只看 blocks.json 是否存在，还要确认内容非空且引用的资产齐全。
fn validate_normalized_dir(dir: &Path) -> Result<usize, String> {
    use std::path::Component;

    let blocks_path = dir.join("blocks.json");
    if !blocks_path.is_file() {
        return Err("blocks.json 缺失".to_string());
    }
    let text = fs::read_to_string(&blocks_path)
        .map_err(|e| format!("读取 blocks.json 失败: {}", e))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("blocks.json 语法错误: {}", e))?;
    let blocks = value
        .as_array()
        .ok_or_else(|| "blocks.json 顶层不是数组".to_string())?;
    if blocks.is_empty() {
        return Err("blocks.json 为空".to_string());
    }

    let assets_dir = dir.join("assets");
    for block in blocks {
        if let Some(asset) = block.get("asset_ref").and_then(|v| v.as_str()) {
            if asset.trim().is_empty() {
                continue;
            }
            let rel = Path::new(asset);
            if rel.is_absolute()
                || rel
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
            {
                return Err(format!("非法资产引用: {}", asset));
            }
            if !assets_dir.join(rel).is_file() {
                return Err(format!("资产缺失: {}", asset));
            }
        }
    }

    Ok(blocks.len())
}

/// raw 产物校验：确认可供归一化使用的结构文件真实存在且可解析。
fn validate_raw_artifacts(provider: &str, raw_dir: &Path) -> Result<(), String> {
    match provider {
        PROVIDER_MINERU => {
            let extracted = raw_dir.join("extracted");
            if !extracted.is_dir() {
                return Err("MinerU 解压目录缺失".to_string());
            }
            // 与归一化器的查找顺序保持一致：content_list 系列或 model.json
            let has_structures = find_file_with_suffix(&extracted, "content_list", ".json").is_some()
                || find_file_with_suffix(&extracted, "model", ".json").is_some();
            if !has_structures {
                return Err("MinerU 缺少 content_list.json / model.json".to_string());
            }
            Ok(())
        }
        PROVIDER_DATALAB => {
            let result = raw_dir.join("result.json");
            if !result.is_file() {
                return Err("Datalab result.json 缺失".to_string());
            }
            let text = fs::read_to_string(&result)
                .map_err(|e| format!("读取 Datalab result.json 失败: {}", e))?;
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Datalab result.json 语法错误: {}", e))?;
            let has_children = value
                .get("children")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            if !has_children {
                return Err("Datalab result.json 缺少有效 children".to_string());
            }
            Ok(())
        }
        _ => Err("未知服务商".to_string()),
    }
}

fn find_file_with_suffix(dir: &Path, keyword: &str, suffix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_with_suffix(&path, keyword, suffix) {
                return Some(found);
            }
        } else if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if name.contains(keyword) && name.ends_with(suffix) {
                return Some(path);
            }
        }
    }
    None
}

/// 错误信息附带“检查点回退”诊断，避免只看到“未配置 Token”而不知道产物已失效。
fn pause_job_with_diag(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    code: &str,
    message: &str,
    diag: Option<&str>,
) -> Result<(), String> {
    let full = match diag {
        Some(d) => format!("{}（{}）", message, d),
        None => message.to_string(),
    };
    pause_job(rt, job, code, &full)
}

fn fail_job_with_diag(
    rt: &JobRuntime<'_>,
    job: &mut ParseJobRecord,
    code: &str,
    message: &str,
    diag: Option<&str>,
) -> Result<(), String> {
    let full = match diag {
        Some(d) => format!("{}（{}）", message, d),
        None => message.to_string(),
    };
    fail_job(rt, job, code, &full)
}

/// 流水线返回错误（基础设施故障）时的收尾：
/// 若提交可能已被受理，转 `submission_unknown`，绝不包装成普通可恢复 paused。
pub fn handle_pipeline_failure(
    rt: &JobRuntime<'_>,
    job_id: &str,
    error: &str,
) -> Result<(), String> {
    let Some(mut job) = rt.with_conn(|conn| db::get_parse_job(conn, job_id))? else {
        return Ok(());
    };

    match job.status.as_str() {
        "cancelled" | "succeeded" | "importing" => return Ok(()),
        _ => {}
    }

    if job.submit_attempted == 1 && job.remote_submitted == 0 {
        return mark_submission_unknown(
            rt,
            &mut job,
            &format!("任务执行中断，无法确认提交结果: {}", error),
        );
    }

    transition(
        rt,
        &mut job,
        "paused",
        true,
        true,
        Some((
            ERR_INTERRUPTED,
            format!("任务执行中断，可继续恢复: {}", error),
        )),
    )
    .map(|_| ())
}

/// 测试专用：在“归一化完成、即将写入 normalized_ready 检查点”处设置可控屏障。
/// 用于验证检查点写入不会覆盖已经成功的取消。
#[cfg(test)]
pub static TEST_BEFORE_NORMALIZED_CHECKPOINT: Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>> =
    Mutex::new(None);

fn run_before_normalized_checkpoint_barrier(job_id: &str) {
    #[cfg(test)]
    {
        let guard = TEST_BEFORE_NORMALIZED_CHECKPOINT
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(hook) = guard.as_ref() {
            hook(job_id);
        }
    }
    #[cfg(not(test))]
    let _ = job_id;
}

/// 测试专用：在“归一化完成、即将取得入库执行权”处设置可控屏障，
/// 用于确定性验证“归一化期间取消后不会入库”。生产构建中不存在该钩子。
#[cfg(test)]
pub static TEST_BEFORE_IMPORT_BARRIER: Mutex<Option<Box<dyn Fn(&str) + Send + Sync>>> =
    Mutex::new(None);

fn run_before_import_barrier(job_id: &str) {
    #[cfg(test)]
    {
        let guard = TEST_BEFORE_IMPORT_BARRIER
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(hook) = guard.as_ref() {
            hook(job_id);
        }
    }
    #[cfg(not(test))]
    let _ = job_id;
}

struct SubmitOutcome {
    remote_id: String,
    remote_meta: String,
    upload_included: bool,
}

// ================= Worker Loop =================

#[derive(Debug, PartialEq, Eq)]
pub enum ScheduleStepOutcome {
    /// 队列为空，无待处理任务
    Idle,
    /// 成功取出一条任务并执行完毕
    Executed { job_id: String, success: bool },
    /// 数据库锁获取失败或查询队列异常
    QueueError(String),
}

/// 可测试的单次调度函数：
/// 供后台真实 worker_loop 与集成测试共同调用，统一出队调度逻辑。
///
/// 1. 尝试获取数据库锁与出队查询，若发生 SQL、列映射或连接异常，向上传播为 QueueError；
/// 2. 若队列为空，返回 Idle；
/// 3. 若有 queued 任务，完整取出后执行 pipeline，支持取消与异常恢复，返回 Executed。
pub async fn schedule_next_job_once(
    db_conn: &Mutex<rusqlite::Connection>,
    workspace_dir: &Path,
    cancel_senders: &Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
) -> ScheduleStepOutcome {
    let next_job = {
        let guard = match db_conn.lock() {
            Ok(g) => g,
            Err(e) => {
                let err_msg = format!("获取数据库锁失败: {}", e);
                record_scheduler_error(&err_msg);
                return ScheduleStepOutcome::QueueError(err_msg);
            }
        };
        match db::get_next_queued_job(&guard) {
            Ok(Some(job)) => job,
            Ok(None) => {
                clear_scheduler_error();
                record_scheduler_idle();
                return ScheduleStepOutcome::Idle;
            }
            Err(e) => {
                record_scheduler_error(&e);
                return ScheduleStepOutcome::QueueError(e);
            }
        }
    };

    let job_id = next_job.job_id.clone();
    record_scheduler_busy(&job_id, Some(&next_job.status));

    let (tx, rx) = watch::channel(false);
    if let Ok(mut senders) = cancel_senders.lock() {
        senders.insert(job_id.clone(), tx);
    }

    let mut runtime = JobRuntime {
        workspace_dir: workspace_dir.to_path_buf(),
        conn: db_conn,
        cancel: rx,
    };

    let mut record = next_job;
    let pipeline_res = run_job_pipeline(&mut runtime, &mut record).await;
    let success = match pipeline_res {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[FlowRead] 解析任务执行中断 ({}): {}", job_id, e);
            if let Err(handler_err) = handle_pipeline_failure(&runtime, &job_id, &e) {
                eprintln!("[FlowRead] 记录任务中断状态失败 ({}): {}", job_id, handler_err);
            }
            false
        }
    };

    if let Ok(mut senders) = cancel_senders.lock() {
        senders.remove(&job_id);
    }
    record_scheduler_idle();

    ScheduleStepOutcome::Executed { job_id, success }
}

pub async fn run_worker_loop(
    app_handle: AppHandle,
    cancel_senders: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    mut notify_rx: tokio::sync::mpsc::Receiver<()>,
) {
    loop {
        let app_data_dir = match app_handle.path().app_data_dir() {
            Ok(p) => p,
            Err(e) => {
                let err_msg = format!("无法获取应用数据目录: {}", e);
                eprintln!("[FlowRead] {}", err_msg);
                record_scheduler_error(&err_msg);
                let _ = tokio::time::timeout(Duration::from_secs(3), notify_rx.recv()).await;
                continue;
            }
        };
        let workspace_dir = app_data_dir.join("parsed_workspace");
        let db_state = app_handle.state::<DbState>();

        match schedule_next_job_once(&db_state.conn, &workspace_dir, &cancel_senders).await {
            ScheduleStepOutcome::Idle => {
                let _ = tokio::time::timeout(Duration::from_secs(3), notify_rx.recv()).await;
            }
            ScheduleStepOutcome::Executed { .. } => {
                // 刚完成一个任务，不额外睡眠，直接进入下一次循环检查队列
            }
            ScheduleStepOutcome::QueueError(e) => {
                eprintln!("[FlowRead] 调度队列读取异常: {}", e);
                let _ = tokio::time::timeout(Duration::from_secs(3), notify_rx.recv()).await;
            }
        }
    }
}

// ================= Tauri IPC Commands =================

/// 1. 获取解析设置
#[tauri::command]
pub fn parse_settings_get(
    db_state: tauri::State<'_, DbState>,
) -> Result<ParseSettingsResponse, String> {
    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    get_settings_internal(&conn)
}

/// 2. 保存解析设置 (请求体支持 request 对象或顶层 default_provider)
#[tauri::command]
pub fn parse_settings_save(
    db_state: tauri::State<'_, DbState>,
    request: Option<ParseSettingsSaveRequest>,
    default_provider: Option<String>,
) -> Result<ParseSettingsResponse, String> {
    let target = request
        .map(|r| r.default_provider)
        .or(default_provider)
        .ok_or_else(|| "缺少 default_provider 参数".to_string())?;

    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    save_settings_internal(&conn, &target)
}

/// 3. 保存服务商 Token 凭据
#[tauri::command]
pub fn parse_provider_set_token(
    request: Option<ProviderTokenSetRequest>,
    provider: Option<String>,
    token: Option<String>,
) -> Result<ProviderTokenResult, String> {
    let (p, t) = match request {
        Some(r) => (r.provider, r.token),
        None => (
            provider.ok_or_else(|| "缺少 provider 参数".to_string())?,
            token.ok_or_else(|| "缺少 token 参数".to_string())?,
        ),
    };

    let canonical = validate_provider_name(&p)?;
    parse_settings::set_provider_token(canonical, &t)?;

    // 保存成功只代表“已写入并回读确认”，不表示服务商已验证。
    Ok(ProviderTokenResult {
        provider: canonical.to_string(),
        display_name: parse_settings::get_provider_display_name(canonical).to_string(),
        credential_configured: provider_credential_status(canonical)?,
    })
}

/// 4. 清除服务商 Token 凭据
#[tauri::command]
pub fn parse_provider_clear_token(
    request: Option<ProviderTokenClearRequest>,
    provider: Option<String>,
) -> Result<ProviderTokenResult, String> {
    let p = match request {
        Some(r) => r.provider,
        None => provider.ok_or_else(|| "缺少 provider 参数".to_string())?,
    };

    let canonical = validate_provider_name(&p)?;
    parse_settings::clear_provider_token(canonical)?;

    Ok(ProviderTokenResult {
        provider: canonical.to_string(),
        display_name: parse_settings::get_provider_display_name(canonical).to_string(),
        credential_configured: provider_credential_status(canonical)?,
    })
}

/// 5. 启动解析任务
#[tauri::command]
pub fn parse_job_start(
    app_handle: AppHandle,
    db_state: tauri::State<'_, DbState>,
    manager: tauri::State<'_, ParseManager>,
    request: Option<ParseJobStartRequest>,
    source_path: Option<String>,
    provider: Option<String>,
    force_new: Option<bool>,
) -> Result<ParseJobDto, String> {
    let (target_path, target_provider, is_force_new) = match request {
        Some(r) => (r.source_path, r.provider, r.force_new.unwrap_or(false)),
        None => (
            source_path.ok_or_else(|| "缺少 source_path 参数".to_string())?,
            provider,
            force_new.unwrap_or(false),
        ),
    };

    let p_path = Path::new(&target_path);
    if !p_path.is_file() {
        return Err(format!("指定路径不存在或非普通文件: {}", target_path));
    }

    let ext = p_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "pdf" {
        return Err("当前云端解析仅支持 PDF 文档".to_string());
    }

    let meta = fs::metadata(p_path).map_err(|e| format!("获取文件元数据失败: {}", e))?;
    let file_size = meta.len() as i64;
    let source_revision = file_revision(p_path)?;
    let doc_name = p_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf")
        .to_string();

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 路径失败: {}", e))?;
    let workspace_dir = app_data_dir.join("parsed_workspace");

    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;

    let provider_name = match target_provider {
        Some(ref p) if !p.trim().is_empty() => validate_provider_name(p)?.to_string(),
        _ => db::get_app_setting(&conn, parse_settings::DEFAULT_PROVIDER_KEY)?
            .unwrap_or_else(|| PROVIDER_MINERU.to_string()),
    };

    let doc = db::get_or_create_document_internal(
        &conn,
        &target_path,
        &doc_name,
        file_size,
        Some(&source_revision),
    )?;

    let source_hash = compute_file_sha256(p_path)?;
    let config_signature = get_config_signature(&provider_name).to_string();

    // 非 force_new：只允许在同一文档、同一路径内复用任务
    if !is_force_new {
        if let Some(active_job) = db::find_active_parse_job(
            &conn,
            &doc.id,
            &target_path,
            &source_hash,
            &provider_name,
            &config_signature,
        )? {
            return Ok(active_job.to_dto());
        }

        if let Some(succeeded_job) = db::find_latest_succeeded_job(
            &conn,
            &doc.id,
            &target_path,
            &source_hash,
            &provider_name,
            &config_signature,
        )? {
            // 复用前确认版本与必要文件仍然可用
            if let Some(version_id) = succeeded_job.version_id.as_deref() {
                if version_usable(&conn, &workspace_dir, version_id) {
                    return Ok(succeeded_job.to_dto());
                }
            }
        }
    }

    // 只有创建新任务才需要凭据；已存在的任务即使凭据被清除也应能查询/复用
    match provider_credential_status(&provider_name) {
        Ok(true) => {}
        Ok(false) => {
            return Err(format!(
                "未配置服务商 '{}' 的 API Token，请先在解析设置中保存 Token",
                provider_name
            ));
        }
        Err(e) => {
            return Err(format!("读取服务商凭据失败（不是未配置）: {}", e));
        }
    }

    // 任务创建时固定激活基准：恢复时不能把“最新激活版本”当成旧任务基准
    let baseline_version_id = db::get_active_parsed_version(&conn, &doc.id)?
        .map(|record| record.version_id);

    let now = db::now_ms();
    let job_id = format!("job_{}_{}", now, Uuid::new_v4().simple());

    let record = ParseJobRecord {
        job_id: job_id.clone(),
        document_id: doc.id,
        source_path: target_path,
        document_name: doc_name,
        source_hash,
        source_revision,
        provider: provider_name,
        config_signature,
        status: "queued".to_string(),
        progress_percent: None,
        completed_pages: None,
        total_pages: None,
        remote_id: None,
        remote_meta_json: None,
        version_id: None,
        activated: 0,
        can_cancel: 1,
        can_resume: 0,
        error_code: None,
        error_message: None,
        update_seq: 1,
        created_at: now,
        updated_at: now,
        snapshot_rel_path: None,
        remote_submitted: 0,
        upload_completed: 0,
        artifacts_downloaded: 0,
        normalized_ready: 0,
        activation_baseline_version_id: baseline_version_id,
        submit_attempted: 0,
    };

    db::insert_parse_job(&conn, &record)?;
    drop(conn);

    manager.trigger_runner();

    Ok(record.to_dto())
}

fn version_usable(
    conn: &rusqlite::Connection,
    workspace_dir: &Path,
    version_id: &str,
) -> bool {
    let rel: Option<String> = conn
        .query_row(
            "SELECT storage_rel_path FROM parsed_document_versions WHERE version_id = ?1",
            rusqlite::params![version_id],
            |r| r.get(0),
        )
        .ok();
    match rel {
        Some(rel) => {
            let dir = workspace_dir.join(rel);
            dir.join("blocks.json").is_file()
        }
        None => false,
    }
}

/// 6. 获取任务状态
#[tauri::command]
pub fn parse_job_get(
    db_state: tauri::State<'_, DbState>,
    job_id: Option<String>,
) -> Result<ParseJobDto, String> {
    let j_id = job_id.ok_or_else(|| "缺少 jobId 参数".to_string())?;
    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    let job = db::get_parse_job(&conn, &j_id)?
        .ok_or_else(|| format!("解析任务不存在: {}", j_id))?;
    Ok(job.to_dto())
}

/// 7. 取消任务：先打断在途请求，再用条件更新原子决定取消是否生效。
#[tauri::command]
pub fn parse_job_cancel(
    app_handle: AppHandle,
    db_state: tauri::State<'_, DbState>,
    manager: tauri::State<'_, ParseManager>,
    job_id: Option<String>,
) -> Result<ParseJobDto, String> {
    let j_id = job_id.ok_or_else(|| "缺少 jobId 参数".to_string())?;
    manager.signal_cancel(&j_id);

    let outcome = {
        let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
        db::cancel_parse_job_cas(&conn, &j_id)?
    };

    match outcome {
        db::CancelOutcome::Cancelled(job) => {
            // 取消成功：清理本任务自己的临时产物（快照、部分下载），
            // 已入库的版本目录位于 documents/ 下，不受影响。
            if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
                let job_dir = app_data_dir
                    .join("parsed_workspace")
                    .join("jobs")
                    .join(&job.job_id);
                if job_dir.exists() {
                    if let Err(e) = fs::remove_dir_all(&job_dir) {
                        eprintln!("[FlowRead] 清理已取消任务产物失败 ({}): {}", job.job_id, e);
                    }
                }
            }
            Ok(job.to_dto())
        }
        db::CancelOutcome::Rejected(job) => Ok(job.to_dto()),
        db::CancelOutcome::NotFound => Err(format!("解析任务不存在: {}", j_id)),
    }
}

/// 恢复策略：只有能够确定“不会重复提交”的状态才允许普通继续。
fn resume_decision(job: &ParseJobRecord) -> Result<(), String> {
    match job.status.as_str() {
        "paused" | "failed" => Ok(()),
        "submission_unknown" => {
            if job.remote_id.is_some() && job.remote_submitted == 1 {
                // 有可靠远端 ID：可以继续核查，不会再次提交
                Ok(())
            } else {
                Err(
                    "暂时无法确认服务商是否已受理本次任务，普通“继续”不会重新提交；如确认需要重试，请使用“重新解析”创建新任务"
                        .to_string(),
                )
            }
        }
        "cancelled" => Err("任务已停止，如需重新解析请创建新任务".to_string()),
        "succeeded" => Err("任务已完成，无需继续".to_string()),
        "queued" | "preparing" | "submitting" | "uploading" | "processing" | "downloading"
        | "normalizing" | "importing" => Err(format!("当前任务状态为 '{}'，不可重复继续", job.status)),
        other => Err(format!("当前任务状态为 '{}'，不可恢复", other)),
    }
}

/// 8. 恢复暂停/失败任务
#[tauri::command]
pub fn parse_job_resume(
    db_state: tauri::State<'_, DbState>,
    manager: tauri::State<'_, ParseManager>,
    job_id: Option<String>,
) -> Result<ParseJobDto, String> {
    let j_id = job_id.ok_or_else(|| "缺少 jobId 参数".to_string())?;
    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    let job = db::get_parse_job(&conn, &j_id)?
        .ok_or_else(|| format!("解析任务不存在: {}", j_id))?;

    resume_decision(&job)?;

    // 从检查点继续：状态回到 queued，保留 remote_id / 快照 / 已上传 / 已下载标记
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                status = 'queued', can_cancel = 1, can_resume = 0,
                error_code = NULL, error_message = NULL, progress_percent = NULL,
                update_seq = update_seq + 1, updated_at = ?1
             WHERE job_id = ?2 AND can_resume = 1",
            rusqlite::params![db::now_ms(), j_id],
        )
        .map_err(|e| format!("恢复解析任务失败: {}", e))?;

    if updated != 1 {
        return Err("任务状态已变化，无法恢复".to_string());
    }

    let refreshed = db::get_parse_job(&conn, &j_id)?
        .ok_or_else(|| format!("解析任务不存在: {}", j_id))?;
    drop(conn);

    manager.trigger_runner();
    Ok(refreshed.to_dto())
}

/// 9. 任务列表查询
#[tauri::command]
pub fn parse_job_list(
    db_state: tauri::State<'_, DbState>,
    request: Option<ParseJobListRequest>,
    document_id: Option<String>,
    active_only: Option<bool>,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<ParseJobListResponse, String> {
    let (doc_id, act_only, lim, cur) = match request {
        Some(r) => (
            r.document_id,
            r.active_only.unwrap_or(false),
            r.limit.unwrap_or(50),
            r.cursor,
        ),
        None => (
            document_id,
            active_only.unwrap_or(false),
            limit.unwrap_or(50),
            cursor,
        ),
    };

    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    let (records, next_cursor) = db::list_parse_jobs_internal(
        &conn,
        doc_id.as_deref(),
        act_only,
        lim,
        cur.as_deref(),
    )?;

    let items = records.iter().map(|r| r.to_dto()).collect();

    Ok(ParseJobListResponse { items, next_cursor })
}

/// 10. 获取任务落盘产物元数据 (绝不创建阅读 session)
#[tauri::command]
pub fn parse_job_result(
    app_handle: AppHandle,
    db_state: tauri::State<'_, DbState>,
    job_id: Option<String>,
) -> Result<ParseJobResultResponse, String> {
    let j_id = job_id.ok_or_else(|| "缺少 jobId 参数".to_string())?;
    let conn = db_state.conn.lock().map_err(|e| e.to_string())?;
    let job = db::get_parse_job(&conn, &j_id)?
        .ok_or_else(|| format!("解析任务不存在: {}", j_id))?;

    let version_id = job
        .version_id
        .ok_or_else(|| "该解析任务尚未生成有效解析版本".to_string())?;

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 路径失败: {}", e))?;
    let workspace_dir = app_data_dir.join("parsed_workspace");

    let (storage_rel_path, is_active): (String, i64) = conn
        .query_row(
            "SELECT storage_rel_path, is_active FROM parsed_document_versions WHERE version_id = ?1",
            rusqlite::params![version_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("查询解析版本元数据失败: {}", e))?;

    // job_id ↔ version_id 必须唯一对应：若同一版本被别的任务引用，说明关联已损坏
    if let Some(owner) = db::find_parse_job_by_version(&conn, &version_id)? {
        if owner.job_id != j_id {
            return Err(format!(
                "解析版本 {} 关联到其它任务 ({}), 数据关联异常",
                version_id, owner.job_id
            ));
        }
    }

    let version_dir = workspace_dir.join(&storage_rel_path);
    let blocks_path = version_dir.join("blocks.json");
    if !blocks_path.is_file() {
        return Err(format!("版本 blocks.json 不存在: {:?}", blocks_path));
    }

    Ok(ParseJobResultResponse {
        document_id: job.document_id,
        source_revision: job.source_revision,
        version_id,
        blocks_path: blocks_path.to_string_lossy().to_string(),
        activated: is_active == 1,
    })
}

/// 11. 获取解析调度器运行与健康状态（只读）
#[tauri::command]
pub fn parse_service_health() -> Result<ParseServiceHealthDto, String> {
    Ok(get_service_health())
}

/// 应用启动时调用：把上次异常退出遗留的中间态任务转成可恢复状态，
/// 并对“入库阶段崩溃”的任务做一次核对。
pub fn recover_interrupted_jobs(conn: &rusqlite::Connection) -> Result<usize, String> {
    let changed = db::recover_interrupted_parse_jobs(conn)?;
    Ok(changed)
}

// ================= Tests =================
#[cfg(test)]
mod tests;
