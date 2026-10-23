/**
 * FlowRead - PDF 云端解析服务前端契约（与后端固定 IPC 一致）
 *
 * 注意：
 * 1. 本文件的字段名必须与后端 `docs/PARSE_SERVICE_API.md` 一致；
 * 2. 所有网络请求都由 Rust 后端发起，前端只通过 parserService 调用 IPC；
 * 3. request 内部使用 snake_case，顶层参数按各命令约定（如 `jobId`）。
 */

export type ParseProvider = "mineru" | "datalab";

export type ParseJobStatus =
  | "queued"
  | "preparing"
  | "submitting"
  | "uploading"
  | "processing"
  | "downloading"
  | "normalizing"
  | "importing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused"
  | "submission_unknown";

/** 单家解析服务的凭据配置状态（不包含 Token 明文） */
export interface ParseProviderStatus {
  provider: ParseProvider;
  display_name: string;
  credential_configured: boolean;
}

export interface ParseSettings {
  default_provider: ParseProvider;
  providers: ParseProviderStatus[];
}

/** parse_job_start / parse_job_get / parse_job_list 返回的任务 DTO */
export interface ParseJobDto {
  job_id: string;
  document_id: string | null;
  source_path: string;
  document_name: string;
  source_revision: string | null;
  provider: ParseProvider;
  status: ParseJobStatus;
  /** 0-100；未知时为 null，界面不得编造百分比 */
  progress_percent: number | null;
  completed_pages: number | null;
  total_pages: number | null;
  version_id: string | null;
  activated: boolean | null;
  can_cancel: boolean;
  can_resume: boolean;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  /** 单调递增，用于忽略乱序旧响应 */
  update_seq: number;
}

export interface ParseJobListResponse {
  items: ParseJobDto[];
  next_cursor: string | null;
}

export interface ParseJobResult {
  document_id: string;
  source_revision: string;
  version_id: string;
  blocks_path: string;
  activated: boolean;
}

export interface ParseJobListRequest {
  document_id: string | null;
  active_only: boolean;
  limit: number;
  cursor: string | null;
}

export interface StartParseJobRequest {
  source_path: string;
  provider: ParseProvider;
  force_new: boolean;
}

export interface ParseSettingsSaveRequest {
  default_provider: ParseProvider;
}

export interface ParseProviderTokenRequest {
  provider: ParseProvider;
  token: string;
}

/** 任务是否已经结束（不会再自行变化） */
export function isTerminalParseStatus(status: ParseJobStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "paused" ||
    status === "submission_unknown"
  );
}

export interface ParseServiceHealthDto {
  scheduler_status: "idle" | "busy" | "error";
  current_job_id: string | null;
  current_job_stage: string | null;
  last_scheduler_error: string | null;
  last_scheduler_error_at: number | null;
  last_heartbeat_at: number;
}

/** 阶段中文标签：进度未知时界面只显示阶段，不编造百分比 */
export function parseStatusLabel(status: ParseJobStatus): string {
  switch (status) {
    case "queued":
      return "排队";
    case "preparing":
      return "准备文件";
    case "submitting":
      return "提交";
    case "uploading":
      return "上传";
    case "processing":
      return "服务商排队/解析";
    case "downloading":
      return "下载";
    case "normalizing":
      return "整理内容";
    case "importing":
      return "写入本地";
    case "succeeded":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已停止";
    case "paused":
      return "已暂停";
    case "submission_unknown":
      return "状态待确认";
    default:
      return "未知状态";
  }
}

export function parseProviderLabel(provider: ParseProvider): string {
  return provider === "datalab" ? "Datalab Convert" : "MinerU";
}
