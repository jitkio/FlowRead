import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { aiDispatcher, AIJob } from "../utils/aiDispatcher";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

// Mock global fetch for AI API streaming
const originalFetch = globalThis.fetch;

describe("6: 阻断最终保存后的旧通知与取消验证", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default model config
    localStorage.setItem(
      "FLOWREAD_MODEL_PROFILES",
      JSON.stringify([
        {
          id: "profile_1",
          profileName: "测试配置",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test-key",
          modelName: "deepseek-chat",
        },
      ])
    );
    localStorage.setItem("FLOWREAD_ACTIVE_PROFILE_ID", "profile_1");
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("在完成结果的最终保存延迟期间取消任务，阻断旧 completed 通知，不覆盖取消状态", async () => {
    // 模拟一个流式响应，吐出一段文本然后 [DONE]
    const streamContent = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"部分有效回答"}}]}\n\n'
          )
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamContent,
    } as any);

    let resolveDbSave: () => void;
    const dbSavePromise = new Promise<void>((resolve) => {
      resolveDbSave = resolve;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_update_card_stream") {
        // 模拟数据库最终持久化耗时 (等待外部 resolve)
        return dbSavePromise;
      }
      return Promise.resolve(null);
    });

    const receivedStatuses: string[] = [];
    const unsubscribe = aiDispatcher.subscribe((update) => {
      if (update.cardId === "card-cancel-test") {
        receivedStatuses.push(update.status);
      }
    });

    const job: AIJob = {
      jobId: "card-cancel-test",
      cardId: "card-cancel-test",
      documentId: "doc-1",
      action: "Ask",
      depth: "quick",
      userPrompt: "测试取消",
    };

    // 1. 发起任务并等待流处理完毕到达最终 DB await 处
    aiDispatcher.enqueue(job);

    await vi.waitFor(() => {
      expect(receivedStatuses).toContain("generating");
    });

    // 2. 模拟在最终 DB save await 挂起期间，用户点击了取消
    aiDispatcher.cancel("card-cancel-test");

    // 验证此时已收到 interrupted 结算通知
    expect(receivedStatuses).toContain("interrupted");
    const countBeforeDbResolve = receivedStatuses.length;

    // 3. 此时迟缓的数据库保存终于返回
    resolveDbSave!();
    await Promise.resolve();
    await Promise.resolve();

    // 4. 核心断言：await 返回后，检测到 controller 已 abort，严禁发送 completed 通知！
    expect(receivedStatuses.slice(countBeforeDbResolve)).not.toContain("completed");
    expect(receivedStatuses[receivedStatuses.length - 1]).toBe("interrupted");

    unsubscribe();
  });

  it("在失败处理的数据库保存延迟期间取消任务，阻断旧 failed 通知", async () => {
    // 模拟 fetch 抛出异常
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("网络断开"));

    let resolveDbSave: () => void;
    const dbSavePromise = new Promise<void>((resolve) => {
      resolveDbSave = resolve;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_update_card_stream") {
        return dbSavePromise;
      }
      return Promise.resolve(null);
    });

    const receivedStatuses: string[] = [];
    const unsubscribe = aiDispatcher.subscribe((update) => {
      if (update.cardId === "card-fail-cancel-test") {
        receivedStatuses.push(update.status);
      }
    });

    const job: AIJob = {
      jobId: "card-fail-cancel-test",
      cardId: "card-fail-cancel-test",
      documentId: "doc-1",
      action: "Ask",
      depth: "quick",
      userPrompt: "测试失败取消",
    };

    aiDispatcher.enqueue(job);

    await Promise.resolve();
    await Promise.resolve();

    // 在失败存库期间取消任务
    aiDispatcher.cancel("card-fail-cancel-test");
    expect(receivedStatuses).toContain("interrupted");

    const countBeforeDbResolve = receivedStatuses.length;

    // 数据库存库返回
    resolveDbSave!();
    await Promise.resolve();
    await Promise.resolve();

    // 核心断言：await 返回后，检测到 controller 已 abort，严禁发送 failed 通知
    expect(receivedStatuses.slice(countBeforeDbResolve)).not.toContain("failed");
    expect(receivedStatuses[receivedStatuses.length - 1]).toBe("interrupted");

    unsubscribe();
  });

  it("排队中的任务取消时正确结算为 interrupted，且初答与追问轮次严格隔离", async () => {
    // 占满最大并发 (2)
    const longRunningJob1: AIJob = {
      jobId: "card-busy-1",
      cardId: "card-busy-1",
      documentId: "doc-1",
      action: "Ask",
      depth: "quick",
      userPrompt: "busy 1",
    };
    const longRunningJob2: AIJob = {
      jobId: "card-busy-2",
      cardId: "card-busy-2",
      documentId: "doc-1",
      action: "Ask",
      depth: "quick",
      userPrompt: "busy 2",
    };

    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // 永不完成
    mockInvoke.mockImplementation(() => Promise.resolve(null));

    aiDispatcher.enqueue(longRunningJob1);
    aiDispatcher.enqueue(longRunningJob2);

    // 第三个任务进入队列排队 (追问轮次)
    const queuedTurnJob: AIJob = {
      jobId: "card-target_turn_trn-1",
      cardId: "card-target",
      turnId: "trn-1",
      documentId: "doc-1",
      action: "Ask",
      depth: "quick",
      userPrompt: "排队追问",
    };

    const updates: { cardId: string; turnId?: string; status: string }[] = [];
    const unsubscribe = aiDispatcher.subscribe((u) => {
      updates.push({ cardId: u.cardId, turnId: u.turnId, status: u.status });
    });

    aiDispatcher.enqueue(queuedTurnJob);

    // 验证排队状态
    expect(updates.some((u) => u.turnId === "trn-1" && u.status === "queued")).toBe(true);

    // 取消排队的追问轮次
    aiDispatcher.cancel("card-target_turn_trn-1");

    // 验证追问轮次在排队中被取消结算为 interrupted，且标记了 turnId
    const turnInterrupted = updates.find(
      (u) => u.turnId === "trn-1" && u.status === "interrupted"
    );
    expect(turnInterrupted).toBeDefined();

    // 清理
    aiDispatcher.cancel("card-busy-1");
    aiDispatcher.cancel("card-busy-2");
    unsubscribe();
  });
});
