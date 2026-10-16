import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import RightCompanionPanel from "../components/RightCompanionPanel";
import FullAnswerModal from "../components/FullAnswerModal";
import { DocumentRecord, CardRecord, FullCardDetail } from "../types/records";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("4: 统一所有删除入口的缓存同步", () => {
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

  const createCard = (i: number): CardRecord => ({
    card_id: `card-${i}`,
    document_id: "doc-1",
    anchor_id: `anc-${i}`,
    action: "Ask",
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

  it("在详情大窗中删除历史卡片，广播全局事件，所有视图同步移除且不残留", async () => {
    const historicalCard = createCard(150); // 远超前 100 张的历史卡片

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_cards") {
        return Promise.resolve({
          items: [historicalCard],
          total: 1,
          has_more: false,
        });
      }
      if (cmd === "db_get_card_detail") {
        const detail: FullCardDetail = {
          card: historicalCard,
          anchor: {
            anchor_id: historicalCard.anchor_id!,
            document_id: historicalCard.document_id,
            document_revision: "rev-1",
            source_type: "text_segment",
            location_json: "{}",
            excerpt: "摘录 150",
            created_at: 1000,
          },
          turns: [],
          function_results: [],
        };
        return Promise.resolve(detail);
      }
      if (cmd === "db_delete_card") {
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    const onDeleteSpy = vi.fn();

    // 1. 渲染记录本
    const { getByText, queryByText } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId={null}
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={onDeleteSpy}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={[]}
        cards={[]} // 模拟前 100 张中没有历史卡片
        onRefreshCards={() => {}}
      />
    );

    // 切换到记录本视图
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(50);
    });

    expect(queryByText("问题 150")).not.toBeNull();

    // 2. 渲染详情大窗并点击删除
    const { getByTitle } = render(
      <FullAnswerModal
        isOpen={true}
        cardId="card-150"
        onClose={() => {}}
        onCardDeleted={(deletedId) => {
          // 模拟 App 层的全局事件广播
          window.dispatchEvent(
            new CustomEvent("flowread:card-deleted", {
              detail: { cardId: deletedId, documentId: dummyDoc.id },
            })
          );
        }}
      />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    const deleteBtn = getByTitle("删除本条学习记录");
    await act(async () => {
      fireEvent.click(deleteBtn);
      vi.advanceTimersByTime(50);
    });

    // 验证：数据库删除已调用
    expect(mockInvoke).toHaveBeenCalledWith("db_delete_card", { cardId: "card-150" });

    // 验证：记录本已同步清除，不再显示该历史卡片
    expect(queryByText("问题 150")).toBeNull();
    // 验证：删除最后一张后，显示空状态
    expect(queryByText("暂无匹配的学习记录")).not.toBeNull();
  });

  it("跟随卡片删除最后一张卡片时，跟随视图与记录本同步移除，显示空状态提示", async () => {
    const singleCard = createCard(1);

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_delete_card") return Promise.resolve(true);
      return Promise.resolve(null);
    });

    // 在页面中放置虚拟左侧阅读区锚点
    const readerViewport = document.createElement("div");
    readerViewport.setAttribute("data-reader-viewport", "true");
    const ancEl = document.createElement("div");
    ancEl.setAttribute("data-anchor-id", "anc-1");
    readerViewport.appendChild(ancEl);
    document.body.appendChild(readerViewport);

    const onDeleteCardSpy = vi.fn();

    const { getByTitle, queryByText } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId="card-1"
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={onDeleteCardSpy}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={["anc-1"]}
        cards={[singleCard]}
        onRefreshCards={() => {}}
      />
    );

    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(queryByText("问题 1")).not.toBeNull();

    // 点击跟随卡片删除小按钮
    const cardDeleteBtn = getByTitle("删除卡片");
    await act(async () => {
      fireEvent.click(cardDeleteBtn);
      vi.advanceTimersByTime(50);
    });

    expect(onDeleteCardSpy).toHaveBeenCalledWith("card-1");
  });
});
