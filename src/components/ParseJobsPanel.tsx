import React, { useEffect, useState } from "react";
import {
  ParseJobDto,
  ParseServiceHealthDto,
  isTerminalParseStatus,
  parseProviderLabel,
  parseStatusLabel,
} from "../types/parserService";
import "./PdfParseFlow.css";

export interface ParseJobsPanelProps {
  isOpen: boolean;
  jobs: ParseJobDto[];
  loading: boolean;
  errorMessage: string | null;
  nextCursor: string | null;
  loadingMore?: boolean;
  /** 正在执行取消/继续/重试的任务 */
  busyJobIds: string[];
  currentDocumentId: string | null;
  serviceHealth?: ParseServiceHealthDto | null;
  onClose: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onCancel: (job: ParseJobDto) => void;
  onResume: (job: ParseJobDto) => void;
  onRetry: (job: ParseJobDto) => void;
  onViewResult: (job: ParseJobDto) => void;
  onOpenResultDocument: (job: ParseJobDto) => void;
}

function formatTime(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return "";
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}:${pad(d.getSeconds())}`;
  } catch {
    return "";
  }
}

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "0秒";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) {
    return remSec > 0 ? `${minutes}分${remSec}秒` : `${minutes}分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}小时${remMin}分`;
}

/**
 * 诊断信息脱敏处理：
 * 绝不向剪贴板或用户界面输出明文 Token、签名 query 参数或代理密码。
 */
function sanitizeDiagnosticText(text: string): string {
  if (!text) return "";
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(?:token|api[_-]?key|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/(Signature|X-Amz-Signature|sig)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s?#]+(\?[^\s#]+)?/gi, (match) => {
      try {
        const u = new URL(match);
        return `${u.origin}${u.pathname}`;
      } catch {
        return match.split("?")[0];
      }
    });
}

function generateJobDiagnosticReport(
  job: ParseJobDto,
  health?: ParseServiceHealthDto | null,
  nowMs = Date.now()
): string {
  const terminal = isTerminalParseStatus(job.status);
  const timeSinceUpdate = terminal
    ? "已终态"
    : formatDuration(Math.max(0, nowMs - job.updated_at));
  const totalDuration = formatDuration(Math.max(0, (terminal ? job.updated_at : nowMs) - job.created_at));

  let pagesText: string;
  if (job.status === "succeeded") {
    if (job.completed_pages != null && job.total_pages != null) {
      pagesText = `解析已完成 (云端最后一次返回: ${job.completed_pages}/${job.total_pages} 页)`;
    } else {
      pagesText = "解析已完成 (服务商直接返回完成，未提供分步页数)";
    }
  } else {
    pagesText =
      job.completed_pages != null && job.total_pages != null
        ? `${job.completed_pages}/${job.total_pages} 页`
        : job.completed_pages != null
          ? `${job.completed_pages}/未知 页`
          : job.total_pages != null
            ? `未知/${job.total_pages} 页`
            : "未知";
  }

  const recentActivity =
    health?.last_heartbeat_at && health.last_heartbeat_at > 0
      ? formatTime(health.last_heartbeat_at)
      : "尚无活动记录";

  const lines = [
    "=== FlowRead 解析任务诊断报告 ===",
    `任务 ID: ${job.job_id}`,
    `文档名称: ${job.document_name}`,
    `源文件路径: ${job.source_path}`,
    `服务商: ${parseProviderLabel(job.provider)}`,
    `当前状态: ${parseStatusLabel(job.status)} (${job.status})`,
    `更新序号: ${job.update_seq}`,
    `创建时间: ${formatTime(job.created_at)}`,
    `最近更新: ${formatTime(job.updated_at)}`,
    `距最近更新: ${timeSinceUpdate}`,
    `累计耗时: ${totalDuration} (含排队与等待，非纯云端解析耗时)`,
    `已解析页数/总页数: ${pagesText}`,
    `后台调度状态: ${health?.scheduler_status ?? "未知"}`,
    `当前后台任务: ${health?.current_job_id ?? "无"}`,
    `当前后台阶段: ${health?.current_job_stage ? parseStatusLabel(health.current_job_stage as any) : "无"}`,
    `最近后台活动: ${recentActivity}`,
    `错误码: ${job.error_code || "无"}`,
    `错误摘要: ${sanitizeDiagnosticText(job.error_message || "无")}`,
    `可否取消: ${job.can_cancel ? "是" : "否"}`,
    `可否继续: ${job.can_resume ? "是" : "否"}`,
    `版本 ID: ${job.version_id || "无"}`,
    `报告生成时间: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

/**
 * 解析任务面板：只展示任务元数据与真实进度，不加载正文、大 JSON、图片或阅读 session。
 * 关闭面板不会取消任务；轮询由 App 中的应用级跟踪器统一负责。
 */
export default function ParseJobsPanel({
  isOpen,
  jobs,
  loading,
  errorMessage,
  nextCursor,
  loadingMore = false,
  busyJobIds,
  currentDocumentId,
  serviceHealth,
  onClose,
  onRefresh,
  onLoadMore,
  onCancel,
  onResume,
  onRetry,
  onViewResult,
  onOpenResultDocument,
}: ParseJobsPanelProps): React.JSX.Element | null {
  const [now, setNow] = useState<number>(Date.now());
  const [expandedDiagJobIds, setExpandedDiagJobIds] = useState<Set<string>>(new Set());
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const [copiedSchedulerDiag, setCopiedSchedulerDiag] = useState<boolean>(false);

  // 面板打开期间每秒更新当前时间，以便阶段耗时平滑跳动
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isOpen]);

  // Esc 仅关闭面板，不会取消任何任务
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isBusy = (jobId: string): boolean => busyJobIds.includes(jobId);

  const toggleExpandDiag = (jobId: string): void => {
    setExpandedDiagJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  const copyJobDiagnostics = async (job: ParseJobDto): Promise<void> => {
    const report = generateJobDiagnosticReport(job, serviceHealth, now);
    try {
      await navigator.clipboard.writeText(report);
      setCopiedJobId(job.job_id);
      setTimeout(() => setCopiedJobId(null), 2500);
    } catch {
      // 剪贴板拒绝时不崩溃
    }
  };

  const copySchedulerDiagnostics = async (): Promise<void> => {
    if (!serviceHealth) return;
    const report = [
      "=== FlowRead 调度诊断报告 ===",
      `调度器状态: ${serviceHealth.scheduler_status}`,
      `最近异常信息: ${sanitizeDiagnosticText(serviceHealth.last_scheduler_error || "无")}`,
      `异常发生时间: ${formatTime(serviceHealth.last_scheduler_error_at)}`,
      `最近后台活动: ${serviceHealth.last_heartbeat_at && serviceHealth.last_heartbeat_at > 0 ? formatTime(serviceHealth.last_heartbeat_at) : "尚无活动记录"}`,
      `当前执行任务ID: ${serviceHealth.current_job_id || "无"}`,
      `当前执行阶段: ${serviceHealth.current_job_stage || "无"}`,
      `报告生成时间: ${new Date().toISOString()}`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      setCopiedSchedulerDiag(true);
      setTimeout(() => setCopiedSchedulerDiag(false), 2500);
    } catch {
      // 剪贴板拒绝时不崩溃
    }
  };

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="parse-modal-card parse-jobs-modal"
        role="dialog"
        aria-modal="true"
        aria-label="解析任务"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">解析任务</h2>
            <span className="settings-modal-subtitle">
              后台任务在面板关闭后仍继续；本列表不加载正文与图片
            </span>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            ×
          </button>
        </div>

        <div className="parse-modal-body parse-jobs-body">
          {/* 后台调度服务异常横幅：不再表现成正常运行 */}
          {serviceHealth?.scheduler_status === "error" && (
            <div className="parse-service-alert-banner" role="alert">
              <div className="parse-service-alert-header">
                <span className="parse-service-alert-badge">调度异常</span>
                <span className="parse-service-alert-title">
                  后台任务调度器异常，新排队任务暂未开始执行
                </span>
              </div>
              <div className="parse-service-alert-msg">
                {serviceHealth.last_scheduler_error || "任务队列读取发生异常"}
                {serviceHealth.last_scheduler_error_at ? (
                  <span className="parse-service-alert-time">
                    （记录于 {formatTime(serviceHealth.last_scheduler_error_at)}）
                  </span>
                ) : null}
              </div>
              <div className="parse-service-alert-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary parse-btn-small"
                  onClick={() => void copySchedulerDiagnostics()}
                >
                  {copiedSchedulerDiag ? "已复制调度诊断" : "复制调度诊断"}
                </button>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="parse-error-text parse-jobs-error">
              任务状态刷新失败：{errorMessage}
            </div>
          )}

          {loading && jobs.length === 0 && <div className="parse-hint">正在加载任务…</div>}

          {!loading && jobs.length === 0 && !errorMessage && (
            <div className="parse-empty-state">
              还没有解析任务。可从「工作区 → 导入 PDF 并解析…」或「工具 → 解析当前 PDF…」开始。
            </div>
          )}

          <ul className="parse-job-list">
            {jobs.map((job) => {
              const busy = isBusy(job.job_id);
              const terminal = isTerminalParseStatus(job.status);
              const showProgress = typeof job.progress_percent === "number";
              const hasPages =
                typeof job.completed_pages === "number" && typeof job.total_pages === "number";
              const canOpenResult =
                job.status === "succeeded" &&
                !!job.version_id &&
                job.activated === true &&
                !!job.document_id &&
                job.document_id === currentDocumentId;

              // 排队状态细化：区分“等待前一任务”与“后台调度异常”
              let displayStatus = parseStatusLabel(job.status);
              let queuedNotice: string | null = null;
              if (job.status === "queued") {
                if (serviceHealth?.scheduler_status === "error") {
                  displayStatus = "排队（后台调度异常）";
                  queuedNotice = "后台调度器发生异常，任务暂未开始；请查看上方调度异常报告。";
                } else if (
                  serviceHealth?.scheduler_status === "busy" &&
                  serviceHealth?.current_job_id &&
                  serviceHealth.current_job_id !== job.job_id
                ) {
                  displayStatus = "排队（等待前一任务）";
                  queuedNotice = `前序任务执行中（阶段: ${
                    serviceHealth.current_job_stage
                      ? parseStatusLabel(serviceHealth.current_job_stage as any)
                      : "处理中"
                  }），完成后将自动开始。`;
                } else {
                  displayStatus = "排队";
                  queuedNotice = "等待后台调度器取出执行…";
                }
              }

              const isDiagExpanded = expandedDiagJobIds.has(job.job_id);
              const hasError =
                job.status === "failed" ||
                job.status === "paused" ||
                job.status === "submission_unknown" ||
                !!job.error_message ||
                !!job.error_code;

              return (
                <li key={job.job_id} className="parse-job-item" data-status={job.status}>
                  <div className="parse-job-head">
                    <span className="parse-job-name" title={job.source_path}>
                      {job.document_name || job.source_path}
                    </span>
                    <span className="parse-job-provider">{parseProviderLabel(job.provider)}</span>
                    <span className={`parse-job-status is-${job.status}`}>
                      {displayStatus}
                    </span>
                  </div>

                  {/* 元数据：创建时间、更新时间、阶段耗时 / 总耗时 */}
                  <div className="parse-job-meta">
                    <span>创建: {formatTime(job.created_at)}</span>
                    <span>更新: {formatTime(job.updated_at)}</span>
                    {!terminal && (
                      <span className="parse-job-duration">
                        距最近更新 {formatDuration(Math.max(0, now - job.updated_at))}
                      </span>
                    )}
                    {terminal && (
                      <span className="parse-job-duration">
                        总历时 {formatDuration(Math.max(0, job.updated_at - job.created_at))}（含排队与等待）
                      </span>
                    )}
                    {job.status === "succeeded" && job.version_id && (
                      <span>版本 {job.version_id}</span>
                    )}
                  </div>

                  {/* 排队阶段说明 */}
                  {queuedNotice && (
                    <div className="parse-job-stage-note parse-job-queued-note">
                      {queuedNotice}
                    </div>
                  )}

                  {/* 页数进度说明：成功状态清楚标为“解析已完成”并注明云端最后快照 */}
                  {job.status === "succeeded" ? (
                    <div className="parse-job-pages-note">
                      <span>
                        <strong>解析已完成</strong>
                        {hasPages ? (
                          <span className="parse-job-pages-hint">
                            （云端最后一次返回：{job.completed_pages}/{job.total_pages} 页，服务商已确认全部处理完成）
                          </span>
                        ) : (
                          <span className="parse-job-pages-hint">
                            （服务商直接返回完成，未提供分步页数）
                          </span>
                        )}
                      </span>
                    </div>
                  ) : (
                    hasPages && (
                      <div className="parse-job-pages-note">
                        <span>
                          云端解析进度:{" "}
                          <strong>
                            {job.completed_pages}/{job.total_pages} 页
                          </strong>
                        </span>
                        <span className="parse-job-pages-hint">
                          （云端解析阶段进度，非全流程完成比例）
                        </span>
                      </div>
                    )
                  )}

                  {/* 真实百分比（若后端明确给出） */}
                  {showProgress && !terminal && (
                    <div className="parse-progress-row">
                      <div className="parse-progress-track">
                        <div
                          className="parse-progress-fill"
                          style={{
                            width: `${Math.min(100, Math.max(0, job.progress_percent as number))}%`,
                          }}
                        />
                      </div>
                      <span className="parse-progress-text">
                        {Math.round(job.progress_percent as number)}%
                      </span>
                    </div>
                  )}

                  {/* 进度未知且无页数时的阶段说明 */}
                  {!showProgress && !hasPages && !terminal && job.status !== "queued" && (
                    <div className="parse-job-stage-note">
                      进度未知，仅显示当前阶段：<strong>{parseStatusLabel(job.status)}</strong>
                      {job.status === "preparing" && "（正在准备私有快照并计算哈希）"}
                      {job.status === "submitting" && "（正在向服务商登记批次任务）"}
                      {job.status === "uploading" && "（正在安全传输 PDF 副本，请勿关闭程序）"}
                      {job.status === "processing" && "（服务商排队与大模型解析中）"}
                      {job.status === "downloading" && "（正在安全下载结构化产物 ZIP）"}
                      {job.status === "normalizing" && "（正在归一化版面、公式与图片资产）"}
                      {job.status === "importing" && "（正在将产物事务写入本地工作区）"}
                    </div>
                  )}

                  {job.status === "submission_unknown" && (
                    <div className="parse-warning-box parse-job-warning">
                      暂时无法确认服务商是否受理本次任务。系统已保留远端状态，不会重复提交收费任务；请稍后重试查询。
                    </div>
                  )}

                  {/* 错误展示区（仅有错误时展示） */}
                  {hasError && (
                    <div className="parse-job-error-block">
                      <div className="parse-error-header-row">
                        <span className="parse-error-stage-tag">
                          当前状态: {parseStatusLabel(job.status)}
                        </span>
                        {job.error_code && (
                          <span className="parse-error-code-tag">
                            错误码: {job.error_code}
                          </span>
                        )}
                      </div>
                      <div className="parse-error-text">
                        {job.error_message || "任务处理中断"}
                      </div>
                    </div>
                  )}

                  {/* 诊断入口：所有任务均可查看与复制诊断 */}
                  <div className="parse-diag-toggle-row">
                    <button
                      type="button"
                      className="parse-link-action-btn"
                      onClick={() => toggleExpandDiag(job.job_id)}
                    >
                      {isDiagExpanded ? "收起详细诊断" : "展开详细诊断"}
                    </button>
                    <button
                      type="button"
                      className="parse-link-action-btn"
                      onClick={() => void copyJobDiagnostics(job)}
                    >
                      {copiedJobId === job.job_id ? "已复制诊断" : "复制诊断信息"}
                    </button>
                  </div>
                  {isDiagExpanded && (
                    <pre className="parse-diag-code-box">
                      {generateJobDiagnosticReport(job, serviceHealth, now)}
                    </pre>
                  )}

                  {job.status === "cancelled" && (
                    <div className="parse-job-stage-note">
                      已在本地停止跟踪本次任务，不代表服务商已终止处理或已退回额度。
                    </div>
                  )}

                  <div className="parse-job-actions">
                    {job.status === "succeeded" && (
                      <>
                        <button
                          type="button"
                          className="settings-btn settings-btn-secondary parse-btn-small"
                          onClick={() => onViewResult(job)}
                          disabled={busy}
                        >
                          查看任务结果
                        </button>
                        {canOpenResult && (
                          <button
                            type="button"
                            className="settings-btn settings-btn-primary parse-btn-small"
                            onClick={() => onOpenResultDocument(job)}
                            disabled={busy}
                          >
                            打开流式重排
                          </button>
                        )}
                      </>
                    )}

                    {job.can_resume && (
                      <button
                        type="button"
                        className="settings-btn settings-btn-primary parse-btn-small"
                        onClick={() => onResume(job)}
                        disabled={busy}
                      >
                        {busy ? "处理中…" : "继续任务"}
                      </button>
                    )}

                    {job.can_cancel && (
                      <button
                        type="button"
                        className="settings-btn settings-btn-secondary parse-btn-small"
                        onClick={() => onCancel(job)}
                        disabled={busy}
                        title="仅停止本地跟踪，不代表服务商已终止处理"
                      >
                        {busy ? "处理中…" : "停止"}
                      </button>
                    )}

                    {(job.status === "failed" ||
                      job.status === "cancelled" ||
                      job.status === "submission_unknown") && (
                      <button
                        type="button"
                        className="settings-btn settings-btn-secondary parse-btn-small"
                        onClick={() => onRetry(job)}
                        disabled={busy}
                        title="以同一个文件和服务商重新提交一个新任务"
                      >
                        {busy ? "处理中…" : "重新解析"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {nextCursor && (
            <div className="parse-load-more-row">
              <button
                type="button"
                className="settings-btn settings-btn-secondary parse-btn-small"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "加载中…" : "加载更多"}
              </button>
            </div>
          )}
        </div>

        <div className="parse-modal-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={onRefresh}
            disabled={loading}
          >
            刷新
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
