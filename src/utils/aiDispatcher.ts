/**
 * FlowRead - 异步 AI 调度引擎 (AI Request Dispatcher)
 * 与 React 组件挂载彻底解耦，支持卡片级独立取消/重试、并发控制 (最大2并发)、流式平滑渲染与 500ms 批处理持久化
 */

import { getActiveModelProfile } from "./aiConfig";
import { loadPromptConfig } from "./promptConfig";
import { CardAction, CardDepth, CardStatus } from "../types/records";
import {
  apiUpdateCardStream,
  apiUpdateCardTurnStream,
} from "./recordStorage";
import { resolveTargetLanguage, buildTranslationSystemPrompt } from "./translationManager";

export interface AIJob {
  jobId: string; // cardId or `${cardId}_turn_${turnId}`
  cardId: string;
  documentId: string;
  turnId?: string;
  action: CardAction;
  depth: CardDepth;
  userPrompt: string;
  contextExcerpt?: string;
  imageBase64?: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

export type StreamUpdateCallback = (data: {
  cardId: string;
  turnId?: string;
  accumulatedText: string;
  status: CardStatus;
  errorMessage?: string | null;
}) => void;

interface ActiveExecution {
  generationId: string;
  controller: AbortController;
  documentId: string;
  cardId: string;
  turnId?: string;
  accumulatedText: string;
  lastDbSavedText: string;
  dbSaveTimer: number | null;
}

class AIDispatcherManager {
  private maxConcurrency = 2;
  private queue: AIJob[] = [];
  private activeJobs = new Map<string, ActiveExecution>();
  private listeners = new Set<StreamUpdateCallback>();

  /**
   * 注册全局流式监听器 (React Hook / 组件订阅)
   */
  public subscribe(cb: StreamUpdateCallback): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(data: {
    cardId: string;
    turnId?: string;
    accumulatedText: string;
    status: CardStatus;
    errorMessage?: string | null;
  }): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  /**
   * 检查指定卡片或其追问是否正在队列中或执行中
   */
  public isCardActive(cardId: string): boolean {
    return this.isCardInitialActive(cardId) || this.isCardFollowUpActive(cardId);
  }

  /**
   * 检查指定卡片初答是否正在队列中或执行中
   */
  public isCardInitialActive(cardId: string): boolean {
    const inQueue = this.queue.some((j) => j.cardId === cardId && !j.turnId);
    if (inQueue) return true;
    for (const exec of this.activeJobs.values()) {
      if (exec.cardId === cardId && !exec.turnId) return true;
    }
    return false;
  }

  /**
   * 检查指定卡片追问是否正在队列中或执行中
   */
  public isCardFollowUpActive(cardId: string): boolean {
    const inQueue = this.queue.some((j) => j.cardId === cardId && Boolean(j.turnId));
    if (inQueue) return true;
    for (const exec of this.activeJobs.values()) {
      if (exec.cardId === cardId && Boolean(exec.turnId)) return true;
    }
    return false;
  }

  /**
   * 检查指定追问轮次是否正在执行或排队
   */
  public isTurnActive(turnId: string): boolean {
    const inQueue = this.queue.some((j) => j.turnId === turnId);
    if (inQueue) return true;
    for (const exec of this.activeJobs.values()) {
      if (exec.turnId === turnId) return true;
    }
    return false;
  }

  /**
   * 分发新请求任务
   */
  public enqueue(job: AIJob): void {
    // 检查是否已有相同任务在运行，有则先取消
    this.cancel(job.jobId);

    // 初始通知：排队中
    this.notify({
      cardId: job.cardId,
      turnId: job.turnId,
      accumulatedText: "",
      status: "queued",
    });

    this.queue.push(job);
    this.processQueue();
  }

  /**
   * 取消指定任务 (cardId 或 jobId) 的请求
   */
  public cancel(id: string): void {
    // 1. 从等待队列中移除匹配任务，结算为 interrupted 并通知界面
    const removedFromQueue: AIJob[] = [];
    this.queue = this.queue.filter((j) => {
      if (j.jobId === id || j.cardId === id) {
        removedFromQueue.push(j);
        return false;
      }
      return true;
    });

    for (const job of removedFromQueue) {
      if (job.turnId) {
        void apiUpdateCardTurnStream(job.turnId, "", "interrupted");
      } else {
        void apiUpdateCardStream(job.cardId, "", "interrupted");
      }
      this.notify({
        cardId: job.cardId,
        turnId: job.turnId,
        accumulatedText: "",
        status: "interrupted",
      });
    }

    // 2. 如果正在执行，中止并结算
    for (const [jobId, exec] of Array.from(this.activeJobs.entries())) {
      if (jobId === id || exec.cardId === id) {
        exec.controller.abort();
        if (exec.dbSaveTimer) {
          window.clearTimeout(exec.dbSaveTimer);
          exec.dbSaveTimer = null;
        }
        // 区分初答与追问轮次，严禁追问覆盖 cards.ai_response
        if (exec.turnId) {
          void apiUpdateCardTurnStream(exec.turnId, exec.accumulatedText, "interrupted");
        } else {
          void apiUpdateCardStream(exec.cardId, exec.accumulatedText, "interrupted");
        }
        this.notify({
          cardId: exec.cardId,
          turnId: exec.turnId,
          accumulatedText: exec.accumulatedText,
          status: "interrupted",
        });
        this.activeJobs.delete(jobId);
      }
    }

    this.processQueue();
  }

  /**
   * 切换文档时安全取消该文档的所有旧请求并标记中断
   */
  public cancelAllForDocument(documentId: string): void {
    // 1. 从等待队列中移除该文档任务，结算为 interrupted 并通知界面
    const removedFromQueue: AIJob[] = [];
    this.queue = this.queue.filter((j) => {
      if (j.documentId === documentId) {
        removedFromQueue.push(j);
        return false;
      }
      return true;
    });

    for (const job of removedFromQueue) {
      if (job.turnId) {
        void apiUpdateCardTurnStream(job.turnId, "", "interrupted");
      } else {
        void apiUpdateCardStream(job.cardId, "", "interrupted");
      }
      this.notify({
        cardId: job.cardId,
        turnId: job.turnId,
        accumulatedText: "",
        status: "interrupted",
      });
    }

    // 2. 中止并结算正在执行的任务
    for (const [jobId, exec] of Array.from(this.activeJobs.entries())) {
      if (exec.documentId === documentId) {
        exec.controller.abort();
        if (exec.dbSaveTimer) {
          window.clearTimeout(exec.dbSaveTimer);
          exec.dbSaveTimer = null;
        }
        if (exec.turnId) {
          void apiUpdateCardTurnStream(exec.turnId, exec.accumulatedText, "interrupted");
        } else {
          void apiUpdateCardStream(exec.cardId, exec.accumulatedText, "interrupted");
        }
        this.notify({
          cardId: exec.cardId,
          turnId: exec.turnId,
          accumulatedText: exec.accumulatedText,
          status: "interrupted",
        });
        this.activeJobs.delete(jobId);
      }
    }

    this.processQueue();
  }

  /**
   * 轮询调度队列
   */
  private processQueue(): void {
    while (this.activeJobs.size < this.maxConcurrency && this.queue.length > 0) {
      const nextJob = this.queue.shift();
      if (nextJob) {
        this.runJob(nextJob);
      }
    }
  }

  /**
   * 执行单次 AI 流式请求
   */
  private async runJob(job: AIJob): Promise<void> {
    const generationId = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const controller = new AbortController();
    const activeExec: ActiveExecution = {
      generationId,
      controller,
      documentId: job.documentId,
      cardId: job.cardId,
      turnId: job.turnId,
      accumulatedText: "",
      lastDbSavedText: "",
      dbSaveTimer: null,
    };

    this.activeJobs.set(job.jobId, activeExec);

    this.notify({
      cardId: job.cardId,
      turnId: job.turnId,
      accumulatedText: "",
      status: "generating",
    });

    const activeProfile = getActiveModelProfile();
    const promptConfig = loadPromptConfig();
    const apiKey = activeProfile.apiKey.trim();
    const baseUrl = activeProfile.baseUrl.trim() || "https://api.deepseek.com/chat/completions";
    const modelName = activeProfile.modelName.trim() || "deepseek-chat";

    if (!apiKey) {
      this.activeJobs.delete(job.jobId);
      const errMsg = "请先前往 [工具 -> 模型配置] 完善您的 API 密钥";
      if (job.turnId) {
        void apiUpdateCardTurnStream(job.turnId, "", "failed");
      } else {
        void apiUpdateCardStream(job.cardId, "", "failed", errMsg);
      }
      this.notify({
        cardId: job.cardId,
        turnId: job.turnId,
        accumulatedText: "",
        status: "failed",
        errorMessage: errMsg,
      });
      this.processQueue();
      return;
    }

    // 构建 System Prompt 与 User Message
    const depthInstruction =
      job.depth === "quick"
        ? "\n【回答深度要求】：请用极简凝练、直击要点的语言作答，严控字数，突出核心结论。"
        : "\n【回答深度要求】：请提供极尽严谨详尽的学术论证与机理解析，包含核心步骤、推导论据与边界条件。";

    let systemPrompt = "";
    if (job.action === "translate") {
      const sourceText = job.contextExcerpt || job.userPrompt || "";
      const target = resolveTargetLanguage(sourceText);
      systemPrompt = `${buildTranslationSystemPrompt(target, promptConfig)}${depthInstruction}`;
    } else {
      let actionPrompt = "";
      if (job.action === "explain") actionPrompt = promptConfig.explain;
      else if (job.action === "extract-formula") actionPrompt = promptConfig.extractFormula;
      else if (job.action === "analyze-chart") actionPrompt = promptConfig.analyzeChart;
      else if (job.action === "extract-text") actionPrompt = promptConfig.extractText;
      else if (job.action === "simplify") actionPrompt = promptConfig.simplify;
      else if (job.action === "summarize") actionPrompt = promptConfig.summarize;
      else actionPrompt = promptConfig.ask;

      systemPrompt = `${promptConfig.globalPrompt.trim()}\n\n${actionPrompt}${depthInstruction}`;
    }

    // 构建消息历史
    const messages: { role: string; content: unknown }[] = [
      { role: "system", content: systemPrompt },
    ];

    if (job.history && job.history.length > 0) {
      for (const h of job.history) {
        messages.push({ role: h.role, content: h.content });
      }
    }

    // 当前用户输入
    let currentUserContent: unknown = "";
    if (job.imageBase64) {
      currentUserContent = [
        {
          type: "text",
          text: job.userPrompt
            ? `【指令】：${job.userPrompt}`
            : job.action === "extract-text"
            ? "请精准提取转录框选图像中的所有文字与段落排版。"
            : job.action === "extract-formula"
            ? "请精准提取框选图像中的所有数学、物理公式，严格使用标准 LaTeX 排版。"
            : "请对框选的图像内容进行深度剖析。",
        },
        {
          type: "image_url",
          image_url: {
            url: job.imageBase64,
          },
        },
      ];
    } else {
      if (job.action === "Ask" || job.turnId) {
        currentUserContent = job.contextExcerpt
          ? `【用户问题】：${job.userPrompt}\n\n【选中文本】：\n「${job.contextExcerpt}」`
          : `【用户问题】：${job.userPrompt}`;
      } else {
        currentUserContent = job.contextExcerpt
          ? `【指令】：${job.userPrompt || job.action}\n\n【选中文本】：\n「${job.contextExcerpt}」`
          : `【指令】：${job.userPrompt || job.action}`;
      }
    }

    messages.push({ role: "user", content: currentUserContent });

    // 节流写入 DB 函数 (~500ms 批处理)
    const scheduleDbSave = () => {
      if (activeExec.dbSaveTimer) return;
      activeExec.dbSaveTimer = window.setTimeout(() => {
        activeExec.dbSaveTimer = null;
        // 校验 generationId 保证是当前请求
        const currentExec = this.activeJobs.get(job.jobId);
        if (!currentExec || currentExec.generationId !== generationId) return;

        if (activeExec.accumulatedText !== activeExec.lastDbSavedText) {
          activeExec.lastDbSavedText = activeExec.accumulatedText;
          if (job.turnId) {
            void apiUpdateCardTurnStream(job.turnId, activeExec.accumulatedText, "generating");
          } else {
            void apiUpdateCardStream(job.cardId, activeExec.accumulatedText, "generating");
          }
        }
      }, 500);
    };

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          stream: true,
          messages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 响应异常 [${response.status}]: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("无法读取响应流 (body 为空)");
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let isStreamDone = false;

      while (true) {
        if (controller.signal.aborted || isStreamDone) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataPayload = trimmed.replace(/^data:\s*/, "");
          if (dataPayload === "[DONE]") {
            isStreamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(dataPayload);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              const currentExec = this.activeJobs.get(job.jobId);
              if (!currentExec || currentExec.generationId !== generationId) return;

              activeExec.accumulatedText += delta;
              // 立即通知 UI 触发打字机更新
              this.notify({
                cardId: job.cardId,
                turnId: job.turnId,
                accumulatedText: activeExec.accumulatedText,
                status: "generating",
              });
              // 500ms 批量更新数据库
              scheduleDbSave();
            }
          } catch {
            // 忽略流中偶发的碎片非 JSON 块
          }
        }

        if (isStreamDone) break;
      }

      // 结束流式传输，清除节流定时器并提交最终结果
      if (activeExec.dbSaveTimer) {
        window.clearTimeout(activeExec.dbSaveTimer);
        activeExec.dbSaveTimer = null;
      }

      if (!controller.signal.aborted) {
        const currentExec = this.activeJobs.get(job.jobId);
        if (currentExec && currentExec.generationId === generationId) {
          if (job.turnId) {
            await apiUpdateCardTurnStream(job.turnId, activeExec.accumulatedText, "completed");
          } else {
            await apiUpdateCardStream(job.cardId, activeExec.accumulatedText, "completed");
          }

          // 关键：在完成结果的数据库 await 返回后，再次检查 AbortController 与 generationId
          if (controller.signal.aborted) {
            return;
          }
          const postSaveExec = this.activeJobs.get(job.jobId);
          if (
            !postSaveExec ||
            postSaveExec.generationId !== generationId ||
            postSaveExec.controller.signal.aborted
          ) {
            return;
          }

          this.notify({
            cardId: job.cardId,
            turnId: job.turnId,
            accumulatedText: activeExec.accumulatedText,
            status: "completed",
          });
        }
      }
    } catch (err: unknown) {
      if (activeExec.dbSaveTimer) {
        window.clearTimeout(activeExec.dbSaveTimer);
        activeExec.dbSaveTimer = null;
      }

      if (controller.signal.aborted) {
        return;
      }

      const currentExec = this.activeJobs.get(job.jobId);
      if (currentExec && currentExec.generationId === generationId) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[AIDispatcher] 请求异常:", err);

        if (job.turnId) {
          await apiUpdateCardTurnStream(job.turnId, activeExec.accumulatedText, "failed");
        } else {
          await apiUpdateCardStream(job.cardId, activeExec.accumulatedText, "failed", errMsg);
        }

        // 关键：在失败结果的数据库 await 返回后，再次检查 AbortController 与 generationId
        if (controller.signal.aborted) {
          return;
        }
        const postSaveExec = this.activeJobs.get(job.jobId);
        if (
          !postSaveExec ||
          postSaveExec.generationId !== generationId ||
          postSaveExec.controller.signal.aborted
        ) {
          return;
        }

        this.notify({
          cardId: job.cardId,
          turnId: job.turnId,
          accumulatedText: activeExec.accumulatedText,
          status: "failed",
          errorMessage: errMsg,
        });
      }
    } finally {
      const currentExec = this.activeJobs.get(job.jobId);
      if (currentExec && currentExec.generationId === generationId) {
        this.activeJobs.delete(job.jobId);
      }
      this.processQueue();
    }
  }
}

export const aiDispatcher = new AIDispatcherManager();
