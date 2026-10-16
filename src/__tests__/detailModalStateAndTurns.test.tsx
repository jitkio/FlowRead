import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import FullAnswerModal from "../components/FullAnswerModal";
import { CardRecord, FullCardDetail } from "../types/records";
import { invoke } from "@tauri-apps/api/core";
import { aiDispatcher } from "../utils/aiDispatcher";
import {
  resolveTargetLanguage,
  buildTranslationSystemPrompt,
  buildFunctionConfigSignature,
} from "../utils/translationManager";
import { loadPromptConfig } from "../utils/promptConfig";
import { saveModelProfiles, saveActiveProfileId } from "../utils/aiConfig";

const mockInvoke = vi.mocked(invoke);

describe("5: 完成详情页状态清理", () => {
  const sampleCard: CardRecord = {
    card_id: "card-detail-1",
    document_id: "doc-1",
    anchor_id: "anc-1",
    action: "Ask",
    depth: "quick",
    status: "completed",
    user_prompt: "核心问题",
    ai_response: "核心回答内容",
    preview: "核心回答内容",
    error_message: null,
    model_name: "deepseek-chat",
    created_at: 10000,
    updated_at: 10000,
    turns_count: 0,
    anchor_excerpt: "测试摘录",
    anchor_source_type: "text_segment",
    anchor_location_json: "{}",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("解释请求中切到缓存翻译页，应立即显示缓存，且 loading 立即结束", async () => {
    saveModelProfiles([
      {
        id: "profile_test",
        profileName: "测试配置",
        baseUrl: "https://api.deepseek.com/chat/completions",
        apiKey: "test-api-key",
        modelName: "deepseek-chat",
      },
    ]);
    saveActiveProfileId("profile_test");

    const promptConfig = loadPromptConfig();
    const resolved = resolveTargetLanguage("测试摘录", "zh");
    const transPrompt = buildTranslationSystemPrompt(resolved, promptConfig);
    const validTransSignature = buildFunctionConfigSignature({
      sourceText: "测试摘录",
      sourceRevision: "rev-1",
      mode: "translate",
      targetLang: "zh",
      prompt: transPrompt,
      modelName: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/chat/completions",
      depth: "quick",
    });

    const detailWithTranslation: FullCardDetail = {
      card: sampleCard,
      anchor: {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: "{}",
        excerpt: "测试摘录",
        created_at: 1000,
      },
      turns: [],
      function_results: [
        {
          result_id: "fn-trans-1",
          card_id: "card-detail-1",
          mode: "translate:zh",
          result_content: "这是已经缓存好的优质翻译结果。",
          config_signature: validTransSignature,
          created_at: 1000,
        },
      ],
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(detailWithTranslation);
      }
      if (cmd === "db_allocate_function_version") {
        return Promise.resolve(1);
      }
      return Promise.resolve(null);
    });

    const { getByText, queryByText } = render(
      <FullAnswerModal
        isOpen={true}
        cardId="card-detail-1"
        onClose={() => {}}
        globalTranslateLanguage="zh"
      />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 默认在主体回答页
    expect(queryByText("核心回答内容")).not.toBeNull();

    // 1. 切换到“深入解释”页 (无缓存，触发 AI 请求并进入 loading)
    const explainTabBtn = getByText("✧ 深度解释");
    await act(async () => {
      fireEvent.click(explainTabBtn);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(20);
    });

    // 验证深入解释处于 loading 状态
    expect(queryByText("正在生成 explain 分析...")).not.toBeNull();

    // 2. 在解释尚未完成时，紧急切到已有缓存的“全篇翻译”页
    const translateTabBtn = getByText("对照翻译");
    await act(async () => {
      fireEvent.click(translateTabBtn);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(20);
    });

    // 验证：旧解释请求被失效，loading 立即结束，缓存内容立即呈现！
    expect(queryByText("正在生成 explain 分析...")).toBeNull();
    expect(queryByText("正在翻译...")).toBeNull();
    expect(queryByText("这是已经缓存好的优质翻译结果。")).not.toBeNull();
  });

  it("追问问题使用提交时固定的文本，不从已清空输入框读取；终态历史加载后同一轮只显示一次", async () => {
    const detail: FullCardDetail = {
      card: sampleCard,
      anchor: null,
      turns: [],
      function_results: [],
    };

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(detail);
      }
      if (cmd === "db_create_card_turn") {
        return Promise.resolve("turn-test-1");
      }
      return Promise.resolve(null);
    });

    const enqueueSpy = vi.spyOn(aiDispatcher, "enqueue");

    const { getByPlaceholderText, getByText, getAllByText } = render(
      <FullAnswerModal isOpen={true} cardId="card-detail-1" onClose={() => {}} />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 1. 输入追问内容
    const input = getByPlaceholderText("在此输入追问，保留上下文继续探讨...");
    fireEvent.change(input, { target: { value: "请详细解释第二点" } });

    // 提交追问
    const form = input.closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 验证输入框已被清空
    expect((input as HTMLInputElement).value).toBe("");

    // 获取提交生成的真实 turnId
    expect(enqueueSpy).toHaveBeenCalled();
    const lastJob = enqueueSpy.mock.calls[enqueueSpy.mock.calls.length - 1][0];
    const generatedTurnId = lastJob.turnId!;
    expect(generatedTurnId).toBeDefined();

    // 模拟 AI 调度器正在流式吐字该追问轮次
    act(() => {
      aiDispatcher["notify"]({
        cardId: "card-detail-1",
        turnId: generatedTurnId,
        accumulatedText: "这是第二点的详细解释：第一...",
        status: "generating",
      });
    });

    // 验证追问问题仍完整显示为提交时的固定文本，没有因为输入框清空而变成空
    expect(getByText("问：请详细解释第二点")).not.toBeNull();
    expect(getByText("这是第二点的详细解释：第一...")).not.toBeNull();

    // 2. 模拟终态保存完成，更新 DB 详情并重新加载，包含已持久化的轮次
    detail.turns = [
      {
        turn_id: generatedTurnId,
        card_id: "card-detail-1",
        user_prompt: "请详细解释第二点",
        ai_response: "这是第二点的最终完整解释：已落库。",
        status: "completed",
        created_at: 20000,
      },
    ];

    // 触发详情重新读取或更新
    act(() => {
      aiDispatcher["notify"]({
        cardId: "card-detail-1",
        turnId: generatedTurnId,
        accumulatedText: "这是第二点的最终完整解释：已落库。",
        status: "completed",
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 验证同一轮次只显示一次，杜绝流式块与历史块重复渲染
    const questionMatches = getAllByText("问：请详细解释第二点");
    expect(questionMatches.length).toBe(1);
  });
});
