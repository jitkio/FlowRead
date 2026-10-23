/**
 * FlowRead - PDF 云端解析服务前端访问层
 *
 * 约束：
 * 1. 所有解析相关 IPC 只集中在本文件，组件与 App 不得直接 invoke；
 * 2. 前端不直接请求 MinerU / Datalab 的 HTTP 接口，网络访问全部由 Rust 后端完成；
 * 3. 采用应用级单一轮询管理器（ParseJobTracker），不在各组件内各开一套轮询。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  ParseJobDto,
  ParseJobListRequest,
  ParseJobListResponse,
  ParseJobResult,
  ParseProvider,
  ParseProviderStatus,
  ParseProviderTokenRequest,
  ParseSettings,
  ParseSettingsSaveRequest,
  ParseServiceHealthDto,
  StartParseJobRequest,
  isTerminalParseStatus,
} from "../types/parserService";

/* ------------------------------------------------------------------ */
/* 设置与凭据                                                          */
/* ------------------------------------------------------------------ */

export async function apiParseSettingsGet(): Promise<ParseSettings> {
  return await invoke<ParseSettings>("parse_settings_get");
}

export async function apiParseSettingsSave(
  defaultProvider: ParseProvider
): Promise<ParseSettings> {
  const request: ParseSettingsSaveRequest = { default_provider: defaultProvider };
  return await invoke<ParseSettings>("parse_settings_save", { request });
}

/** 保存/替换某家服务商的 Token；空 Token 由界面拦截，不会传到这里 */
export async function apiParseProviderSetToken(
  provider: ParseProvider,
  token: string
): Promise<ParseProviderStatus> {
  const request: ParseProviderTokenRequest = { provider, token };
  return await invoke<ParseProviderStatus>("parse_provider_set_token", { request });
}

export async function apiParseProviderClearToken(
  provider: ParseProvider
): Promise<ParseProviderStatus> {
  return await invoke<ParseProviderStatus>("parse_provider_clear_token", {
    request: { provider },
  });
}

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

export async function apiParseJobStart(
  sourcePath: string,
  provider: ParseProvider,
  forceNew = false
): Promise<ParseJobDto> {
  const request: StartParseJobRequest = {
    source_path: sourcePath,
    provider,
    force_new: forceNew,
  };
  return await invoke<ParseJobDto>("parse_job_start", { request });
}

export async function apiParseJobGet(jobId: string): Promise<ParseJobDto> {
  return await invoke<ParseJobDto>("parse_job_get", { jobId });
}

export async function apiParseJobCancel(jobId: string): Promise<ParseJobDto> {
  return await invoke<ParseJobDto>("parse_job_cancel", { jobId });
}

export async function apiParseJobResume(jobId: string): Promise<ParseJobDto> {
  return await invoke<ParseJobDto>("parse_job_resume", { jobId });
}

export async function apiParseJobList(
  request: ParseJobListRequest
): Promise<ParseJobListResponse> {
  return await invoke<ParseJobListResponse>("parse_job_list", { request });
}

export async function apiParseJobResult(jobId: string): Promise<ParseJobResult> {
  return await invoke<ParseJobResult>("parse_job_result", { jobId });
}

export async function apiParseServiceHealth(): Promise<ParseServiceHealthDto> {
  return await invoke<ParseServiceHealthDto>("parse_service_health");
}

/** 首次加载任务列表（面板打开、应用启动时使用） */
export async function apiParseJobListFirstPage(
  limit = 50
): Promise<ParseJobListResponse> {
  return await apiParseJobList({
    document_id: null,
    active_only: false,
    limit,
    cursor: null,
  });
}

/* ------------------------------------------------------------------ */
/* 应用级单一轮询管理器                                                */
/* ------------------------------------------------------------------ */

export interface ParseJobTrackerOptions {
  intervalMs?: number;
  listLimit?: number;
  /** 便于测试注入，默认使用真实 IPC */
  listJobs?: () => Promise<ParseJobListResponse>;
  getJob?: (jobId: string) => Promise<ParseJobDto>;
  getHealth?: () => Promise<ParseServiceHealthDto>;
}

type JobsListener = (jobs: ParseJobDto[]) => void;
type ErrorListener = (message: string | null) => void;
type HealthListener = (health: ParseServiceHealthDto | null) => void;

/**
 * 应用级任务跟踪器：
 * - 约 2 秒轮询一次，防请求重叠；
 * - 把「本会话启动过的任务」记录为 tracked，列表里查不到时单独 parse_job_get，
 *   避免任务完成瞬间从活动列表消失导致完成状态丢失；
 * - 按 update_seq 忽略乱序/重复响应；
 * - 定期查询后台调度健康状态；
 * - 面板关闭后仍继续跟踪（实例由 App 持有）。
 */
export class ParseJobTracker {
  private readonly intervalMs: number;
  private readonly listLimit: number;
  private readonly listJobs: () => Promise<ParseJobListResponse>;
  private readonly getJob: (jobId: string) => Promise<ParseJobDto>;
  private readonly getHealth: () => Promise<ParseServiceHealthDto>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = true;

  private readonly jobs = new Map<string, ParseJobDto>();
  private readonly appliedSeq = new Map<string, number>();
  private readonly trackedIds = new Set<string>();
  private currentHealth: ParseServiceHealthDto | null = null;

  private readonly jobListeners = new Set<JobsListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly healthListeners = new Set<HealthListener>();
  private lastEmittedSignature = "";

  constructor(options: ParseJobTrackerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 2000;
    this.listLimit = options.listLimit ?? 50;
    this.listJobs = options.listJobs ?? (() => apiParseJobListFirstPage(this.listLimit));
    this.getJob = options.getJob ?? ((jobId) => apiParseJobGet(jobId));
    this.getHealth = options.getHealth ?? (() => apiParseServiceHealth());
  }

  public subscribeJobs(listener: JobsListener): () => void {
    this.jobListeners.add(listener);
    return () => this.jobListeners.delete(listener);
  }

  public subscribeError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  public subscribeHealth(listener: HealthListener): () => void {
    this.healthListeners.add(listener);
    // 立即向新订阅者推送当前已有健康缓存
    listener(this.currentHealth);
    return () => this.healthListeners.delete(listener);
  }

  public getHealthStatus(): ParseServiceHealthDto | null {
    return this.currentHealth;
  }

  public getJobs(): ParseJobDto[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.created_at - a.created_at);
  }

  public getJobById(jobId: string): ParseJobDto | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** 标记为需要持续跟踪的任务（本会话启动/继续的任务） */
  public track(job: ParseJobDto): void {
    this.trackedIds.add(job.job_id);
    this.applyJob(job);
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 启动时立即查询一次后端的持久任务
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单次刷新：先取列表，再对「已跟踪但不在列表中 / 仍非终态」的任务单独查询。
   * 导出以便测试直接驱动，不需要依赖真实定时器。
   */
  public async pollOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const list = await this.listJobs();
      const seen = new Set<string>();
      for (const job of list.items || []) {
        seen.add(job.job_id);
        this.applyJob(job);
      }

      // 已跟踪但列表未覆盖的任务（分页之外，或刚完成被活动列表过滤）单独查询
      const needDetail = Array.from(this.trackedIds).filter((jobId) => {
        if (seen.has(jobId)) return false;
        const current = this.jobs.get(jobId);
        return !current || !isTerminalParseStatus(current.status);
      });
      for (const jobId of needDetail) {
        try {
          const job = await this.getJob(jobId);
          this.applyJob(job);
        } catch {
          // 单个任务查询失败不影响其余任务；错误由列表层统一上报
        }
      }

      // 查询后台调度健康状态
      try {
        const health = await this.getHealth();
        this.currentHealth = health;
        this.emitHealth(health);
      } catch {
        // 健康状态查询异常不阻断任务列表刷新
      }

      this.emitJobs();
      this.emitError(null);
    } catch (err: any) {
      this.emitError(err?.message ? String(err.message) : "解析任务列表刷新失败");
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * 应用一条任务数据：update_seq 不大于已应用值时视为乱序/重复响应丢弃。
   * 返回是否真正更新。
   */
  public applyJob(job: ParseJobDto): boolean {
    if (!job || !job.job_id) return false;
    const previousSeq = this.appliedSeq.get(job.job_id);
    if (typeof job.update_seq === "number") {
      if (previousSeq !== undefined && job.update_seq <= previousSeq) {
        return false;
      }
      this.appliedSeq.set(job.job_id, job.update_seq);
    }
    this.jobs.set(job.job_id, job);
    this.emitJobs();
    return true;
  }

  private emitJobs(): void {
    const snapshot = this.getJobs();
    // 内容没有变化时不重复通知，避免每 2 秒无意义地重渲染整棵界面
    const signature = snapshot.map((job) => `${job.job_id}#${job.update_seq}`).join("|");
    if (signature === this.lastEmittedSignature) return;
    this.lastEmittedSignature = signature;
    for (const listener of this.jobListeners) listener(snapshot);
  }

  private emitError(message: string | null): void {
    for (const listener of this.errorListeners) listener(message);
  }

  private emitHealth(health: ParseServiceHealthDto | null): void {
    for (const listener of this.healthListeners) listener(health);
  }
}
