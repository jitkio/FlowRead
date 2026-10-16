import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import RightCompanionPanel from "../components/RightCompanionPanel";
import { DocumentRecord, CardRecord } from "../types/records";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("3: 记录本加载生命周期和触底分页", () => {
  const dummyDoc: DocumentRecord = {
    id: "doc-1",
    file_path: "/test/doc.txt",
    display_name: "测试文档",
    file_size: 1024,
    revision: "rev-1",
    last_read_position: null,
    created_at: 1000,
    updated_at: 1000,
  };

  const createCard = (i: number, action: "Ask" | "explain" = "Ask"): CardRecord => ({
    card_id: `card-${i}`,
    document_id: "doc-1",
    anchor_id: `anc-${i}`,
    action,
    depth: "quick",
    status: "completed",
    user_prompt: `问题 ${i}`,
    ai_response: `回答 ${i}`,
    preview: `预览 ${i}`,
    error_message: null,
    model_name: "deepseek-chat",
    created_at: 1000000 - i * 1000,
    updated_at: 1000000 - i * 1000,
    turns_count: 0,
    anchor_excerpt: `摘录 ${i}`,
    anchor_source_type: "text_segment",
    anchor_location_json: "{}",
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("记录本切 all / qa / actions / highlights，正确重置生命周期并呈现新筛选结果", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_cards") {
        const filterType = args?.filterType;
        if (filterType === "Ask") {
          return Promise.resolve({
            items: [createCard(1, "Ask"), createCard(2, "Ask")],
            total: 2,
            has_more: false,
          });
        }
        if (filterType === "actions") {
          return Promise.resolve({
            items: [createCard(3, "explain"), createCard(4, "explain")],
            total: 2,
            has_more: false,
          });
        }
        return Promise.resolve({
          items: [createCard(1, "Ask"), createCard(3, "explain")],
          total: 2,
          has_more: false,
        });
      }
      if (cmd === "db_get_highlights") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    const { getByText, queryByText } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId={null}
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={() => {}}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={[]}
        cards={[]}
        onRefreshCards={() => {}}
      />
    );

    // 1. 切换至记录本视图
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(50);
    });

    // 默认 "全部"
    expect(queryByText("问题 1")).not.toBeNull();
    expect(queryByText("问题 3")).not.toBeNull();

    // 2. 切筛选至 "问答 (QA)"
    const qaFilterBtn = getByText("提问 (Q&A)");
    await act(async () => {
      fireEvent.click(qaFilterBtn);
      vi.advanceTimersByTime(50);
    });

    // 验证 QA 结果呈现，且 actions 记录不再显示
    expect(queryByText("问题 1")).not.toBeNull();
    expect(queryByText("问题 2")).not.toBeNull();
    expect(queryByText("问题 3")).toBeNull();

    // 3. 切筛选至 "动作 (Actions)"
    const actionsFilterBtn = getByText("指令卡片");
    await act(async () => {
      fireEvent.click(actionsFilterBtn);
      vi.advanceTimersByTime(50);
    });

    // 验证 Actions 结果呈现
    expect(queryByText("问题 3")).not.toBeNull();
    expect(queryByText("问题 4")).not.toBeNull();
    expect(queryByText("问题 1")).toBeNull();
  });

  it("静态历史超过50张时，纯滚动也能继续分页加载下一页", async () => {
    // 构造第 1 页 (50 张) 与第 2 页 (10 张)，共 60 张
    const page1Cards = Array.from({ length: 50 }, (_, i) => createCard(i + 1));
    const page2Cards = Array.from({ length: 10 }, (_, i) => createCard(50 + i + 1));

    let page2Requested = false;

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_get_cards") {
        if (args?.cursorCardId) {
          page2Requested = true;
          return Promise.resolve({
            items: page2Cards,
            total: 60,
            has_more: false,
          });
        }
        return Promise.resolve({
          items: page1Cards,
          total: 60,
          has_more: true,
        });
      }
      if (cmd === "db_get_highlights") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    const { getByText, container } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId={null}
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={() => {}}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={[]}
        cards={[]}
        onRefreshCards={() => {}}
      />
    );

    // 切换至记录本视图加载第 1 页
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(100);
    });

    expect(page2Requested).toBe(false);

    // 获取记录本独立滚动容器
    const scrollContainer = container.querySelector(
      ".companion-records-scroll-viewport"
    ) as HTMLElement;

    expect(scrollContainer).not.toBeNull();

    // 模拟纯滚动到底部 (距离底部仅 50px)
    if (scrollContainer) {
      Object.defineProperty(scrollContainer, "scrollTop", { value: 7000, configurable: true });
      Object.defineProperty(scrollContainer, "scrollHeight", { value: 7600, configurable: true });
      Object.defineProperty(scrollContainer, "clientHeight", { value: 550, configurable: true });

      await act(async () => {
        fireEvent.scroll(scrollContainer);
        vi.advanceTimersByTime(100);
      });
    }

    // 验证：即使没有 AI 流式事件，纯滚动也成功触发了复合游标的分页请求
    expect(page2Requested).toBe(true);
  });
});
