import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import RightCompanionPanel from "../components/RightCompanionPanel";
import FullAnswerModal from "../components/FullAnswerModal";
import ConnectionLinesOverlay from "../components/ConnectionLinesOverlay";
import PDFReaderArea from "../components/PDFReaderArea";
import { findVisibleAnchorElement } from "../utils/sourceAnchorUtils";
import { DocumentRecord, CardRecord, FullCardDetail, SourceAnchorRecord } from "../types/records";
import { invoke } from "@tauri-apps/api/core";
import { aiDispatcher } from "../utils/aiDispatcher";

const mockInvoke = vi.mocked(invoke);

describe("FlowRead 4处遗漏交互回归验证", () => {
  const dummyDoc: DocumentRecord = {
    id: "doc-regression-1",
    file_path: "/test/doc.pdf",
    display_name: "测试回归文档",
    file_size: 2048,
    revision: "rev-1",
    last_read_position: null,
    created_at: 1000,
    updated_at: 1000,
  };

  const createCard = (i: number): CardRecord => ({
    card_id: `card-${i}`,
    document_id: "doc-regression-1",
    anchor_id: `anc-${i}`,
    action: "Ask",
    depth: "quick",
    status: "completed",
    user_prompt: `测试问题 ${i}`,
    ai_response: `测试回答 ${i}`,
    preview: `测试预览 ${i}`,
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

  // ==========================================
  // 1. 删除计数只结算一次
  // ==========================================
  it("1. 删除计数只结算一次：3张删除1张后列表和总数都为2，重复广播事件不能再次扣数", async () => {
    const card1 = createCard(1);
    const card2 = createCard(2);
    const card3 = createCard(3);

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_cards") {
        return Promise.resolve({
          items: [card1, card2, card3],
          total: 3,
          has_more: false,
        });
      }
      if (cmd === "db_get_highlights") {
        return Promise.resolve([]);
      }
      if (cmd === "db_delete_card") {
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    // 真实连接面板删除回调与 App 全局广播路径
    const onDeleteCardWithAppBroadcast = (cardId: string) => {
      // 模拟 App.tsx 删除落库并广播 flowread:card-deleted
      window.dispatchEvent(
        new CustomEvent("flowread:card-deleted", {
          detail: { cardId, documentId: dummyDoc.id },
        })
      );
    };

    const { getByText, queryByText, container } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId={null}
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={onDeleteCardWithAppBroadcast}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={[]}
        cards={[card1, card2, card3]}
        onRefreshCards={() => {}}
      />
    );

    // 切换到记录本视图并等待第一页加载完毕
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(50);
    });

    // 初始状态：3 张卡片全在，总数为 3
    expect(queryByText("测试问题 1")).not.toBeNull();
    expect(queryByText("测试问题 2")).not.toBeNull();
    expect(queryByText("测试问题 3")).not.toBeNull();
    expect(queryByText("全部 (3)")).not.toBeNull();
    expect(queryByText("共 3 条")).not.toBeNull();

    // 找到 card-1 对应的删除按钮并点击
    const card1Article = container.querySelector('[data-index="0"]');
    expect(card1Article).not.toBeNull();
    const deleteBtn1 = card1Article!.querySelector('button[title="删除卡片"]') as HTMLButtonElement;
    expect(deleteBtn1).not.toBeNull();

    await act(async () => {
      fireEvent.click(deleteBtn1);
      vi.advanceTimersByTime(50);
    });

    // 断言：删除 card-1 后，列表仅剩 2 张，总数准确为 2
    expect(queryByText("测试问题 1")).toBeNull();
    expect(queryByText("测试问题 2")).not.toBeNull();
    expect(queryByText("测试问题 3")).not.toBeNull();
    expect(queryByText("全部 (2)")).not.toBeNull();
    expect(queryByText("共 2 条")).not.toBeNull();

    // 核心回归点：模拟外部或重复收到的 flowread:card-deleted 广播事件
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("flowread:card-deleted", {
          detail: { cardId: "card-1", documentId: dummyDoc.id },
        })
      );
      vi.advanceTimersByTime(50);
    });

    // 验证：重复事件绝对幂等，计数绝不再扣，仍为 2！
    expect(queryByText("全部 (2)")).not.toBeNull();
    expect(queryByText("共 2 条")).not.toBeNull();
  });

  // ==========================================
  // 2. PDF异步渲染后重新检测可见锚点
  // ==========================================
  it("2. PDF异步渲染后重新检测可见锚点：首次检测早于锚点挂载，挂载后无需滚动主动检测", async () => {
    const anchorRecord: SourceAnchorRecord = {
      anchor_id: "anc-pdf-async-1",
      document_id: "doc-regression-1",
      document_revision: "rev-1",
      source_type: "pdf_text",
      excerpt: "PDF 异步挂载文字",
      location_json: JSON.stringify({
        type: "pdf_text",
        segments: [{ pageNumber: 1, rects: [[100, 200, 300, 220]] }],
      }),
      created_at: 1000,
    };

    const visibleIdsReceived: string[][] = [];
    const onVisibleAnchorsChangeSpy = vi.fn((ids: string[]) => {
      visibleIdsReceived.push(ids);
    });

    const { container } = render(
      <PDFReaderArea
        filePath="/test/doc.pdf"
        scale={1.0}
        onVisibleAnchorsChange={onVisibleAnchorsChangeSpy}
        anchors={[anchorRecord]}
      />
    );

    // 此时初始状态下，PDF 页面尚未异步渲染完毕，DOM 中尚无 [data-anchor-id]
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // 首次检测因为 DOM 尚未挂载，未检测到该锚点
    expect(onVisibleAnchorsChangeSpy).not.toHaveBeenCalledWith(["anc-pdf-async-1"]);

    // 模拟 PDF 异步渲染完成，页面和锚点元素挂载进 DOM
    const viewportEl = container.querySelector(".pdf-scroll-viewport") as HTMLElement;
    expect(viewportEl).not.toBeNull();

    const anchorEl = document.createElement("div");
    anchorEl.setAttribute("data-anchor-id", "anc-pdf-async-1");
    // 模拟其在视口可视范围内
    Object.defineProperty(anchorEl, "getBoundingClientRect", {
      value: () => ({
        top: 200,
        bottom: 240,
        left: 50,
        right: 350,
        width: 300,
        height: 40,
      }),
      configurable: true,
    });
    viewportEl.appendChild(anchorEl);

    // 触发 handlePageRendered 发出的 flowread:source-layout-updated（用户未发生任何滚动操作）
    await act(async () => {
      window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));
      vi.advanceTimersByTime(50);
    });

    // 验证：挂载完成后不滚动，订阅 source-layout-updated 主动重新检测，锚点成功上报！
    expect(onVisibleAnchorsChangeSpy).toHaveBeenLastCalledWith(["anc-pdf-async-1"]);

    // 验证去重：再次触发相同布局通知，不会重新引发循环更新
    const callCount = onVisibleAnchorsChangeSpy.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));
      vi.advanceTimersByTime(50);
    });
    expect(onVisibleAnchorsChangeSpy.mock.calls.length).toBe(callCount);
  });

  // ==========================================
  // 3. 活跃追问按 turnId 合并显示
  // ==========================================
  it("3. 活跃追问按 turnId 合并显示：生成中重开大窗或功能页刷新，新片段持续可见且同一轮只显示一次", async () => {
    const card = createCard(1);
    const detail: FullCardDetail = {
      card,
      anchor: null,
      turns: [
        {
          turn_id: "turn-live-1",
          card_id: card.card_id,
          user_prompt: "请解释核心论据",
          ai_response: "数据库已有初版快照",
          status: "generating",
          created_at: 1000,
        },
      ],
      function_results: [],
    };

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_card_detail") {
        return Promise.resolve(detail);
      }
      return Promise.resolve(null);
    });

    // 1. 渲染详情窗口
    const { getByText, queryByText, getAllByText } = render(
      <FullAnswerModal isOpen={true} cardId={card.card_id} onClose={() => {}} />
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 模拟此时正在接收实时流式更新
    act(() => {
      aiDispatcher["notify"]({
        cardId: card.card_id,
        turnId: "turn-live-1",
        accumulatedText: "数据库已有初版快照 + 【最新实时流式片段】",
        status: "generating",
      });
    });

    // 验证：最新流式文本与固定问题合并呈现，新片段持续可见
    expect(queryByText("问：请解释核心论据")).not.toBeNull();
    expect(queryByText(/最新实时流式片段/)).not.toBeNull();

    // 2. 模拟功能页切页完成刷新详情 (调用 loadDetail)，turn-live-1 仍在生成中
    await act(async () => {
      // 触发详情重新读取
      mockInvoke.mockImplementationOnce((cmd: string) => {
        if (cmd === "db_get_card_detail") return Promise.resolve(detail);
        return Promise.resolve(null);
      });
      // 模拟功能页切页完成引发的 loadDetail
      detail.function_results.push({
        result_id: "fn-1",
        card_id: card.card_id,
        mode: "formula",
        result_content: "公式结果",
        created_at: 2000,
      });
      // 发送下一个流式块
      aiDispatcher["notify"]({
        cardId: card.card_id,
        turnId: "turn-live-1",
        accumulatedText: "数据库已有初版快照 + 【最新实时流式片段】 + 【第二段实时内容】",
        status: "generating",
      });
      vi.advanceTimersByTime(50);
    });

    // 验证：问题文本不丢失，流式块没有被提前清除或清空
    expect(queryByText("问：请解释核心论据")).not.toBeNull();
    expect(queryByText(/第二段实时内容/)).not.toBeNull();

    // 3. 最终 AI 调度器通知完成
    detail.turns[0].ai_response = "数据库已有初版快照 + 【最新实时流式片段】 + 【第二段实时内容】（最终完成版）";
    detail.turns[0].status = "completed";

    act(() => {
      aiDispatcher["notify"]({
        cardId: card.card_id,
        turnId: "turn-live-1",
        accumulatedText: "数据库已有初版快照 + 【最新实时流式片段】 + 【第二段实时内容】（最终完成版）",
        status: "completed",
      });
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
    });

    // 核心断言：最终同一轮只显示一次，杜绝重复渲染！
    const questionMatches = getAllByText("问：请解释核心论据");
    expect(questionMatches.length).toBe(1);
    expect(getByText(/最终完成版/)).not.toBeNull();
  });

  // ==========================================
  // 4. 来源定位选择当前可见片段
  // ==========================================
  it("4. 来源定位选择当前可见片段：第一片段离屏、后续片段可见时，卡片对齐可见片段且连线不消失", () => {
    const workspaceEl = document.createElement("div");
    document.body.appendChild(workspaceEl);
    Object.defineProperty(workspaceEl, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        bottom: 800,
        left: 0,
        right: 1000,
        width: 1000,
        height: 800,
      }),
      configurable: true,
    });

    // 构造左侧阅读容器（置于 workspaceEl 内部）
    const leftReaderEl = document.createElement("div");
    leftReaderEl.className = "reader-scroll-viewport";
    leftReaderEl.setAttribute("data-reader-viewport", "true");
    workspaceEl.appendChild(leftReaderEl);

    // 视口范围 0 ~ 800
    Object.defineProperty(leftReaderEl, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        bottom: 800,
        left: 0,
        right: 600,
        width: 600,
        height: 800,
      }),
      configurable: true,
    });

    // 片段 1：已滚出视口上方 (-300 ~ -50)
    const seg1 = document.createElement("span");
    seg1.setAttribute("data-anchor-id", "anc-cross-page-1");
    Object.defineProperty(seg1, "getBoundingClientRect", {
      value: () => ({
        top: -300,
        bottom: -50,
        left: 10,
        right: 400,
        width: 390,
        height: 250,
      }),
      configurable: true,
    });
    leftReaderEl.appendChild(seg1);

    // 片段 2：当前在视口内 (200 ~ 280)
    const seg2 = document.createElement("span");
    seg2.setAttribute("data-anchor-id", "anc-cross-page-1");
    Object.defineProperty(seg2, "getBoundingClientRect", {
      value: () => ({
        top: 200,
        bottom: 280,
        left: 10,
        right: 400,
        width: 390,
        height: 80,
      }),
      configurable: true,
    });
    leftReaderEl.appendChild(seg2);

    // 1. 验证共享定位逻辑 findVisibleAnchorElement 正确选择可见片段 seg2
    const selectedAnchorEl = findVisibleAnchorElement(leftReaderEl, "anc-cross-page-1");
    expect(selectedAnchorEl).toBe(seg2);
    expect(selectedAnchorEl).not.toBe(seg1);

    // 2. 验证 ConnectionLinesOverlay 在片段 1 离屏时，连线仍然生成，对齐到可见的 seg2
    const cardEl = document.createElement("div");
    cardEl.setAttribute("data-card-id", "card-cross-1");
    cardEl.setAttribute("data-anchor-id", "anc-cross-page-1");
    Object.defineProperty(cardEl, "getBoundingClientRect", {
      value: () => ({
        top: 220,
        bottom: 400,
        left: 700,
        right: 980,
        width: 280,
        height: 180,
      }),
      configurable: true,
    });
    workspaceEl.appendChild(cardEl);

    const wsRef = { current: workspaceEl };
    const crossCard = createCard(10);
    crossCard.card_id = "card-cross-1";
    crossCard.anchor_id = "anc-cross-page-1";

    const { container: linesContainer } = render(
      <ConnectionLinesOverlay
        workspaceRef={wsRef}
        activeCardId="card-cross-1"
        cards={[crossCard]}
      />
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("flowread:card-layout-updated"));
      vi.advanceTimersByTime(50);
    });

    // 验证：连线 path 成功生成（没有因为片段 1 离屏而消失）
    const pathEl = linesContainer.querySelector("path");
    expect(pathEl).not.toBeNull();
    // 连线起点 y 坐标对应 seg2 (200 + 40 = 240)
    expect(pathEl?.getAttribute("d")).toContain("M 400 240");
  });

  // ==========================================
  // 5. 删除后缓存防重新注入与计数幂等回归验证
  // ==========================================
  it("5. 删除后缓存防重新注入：同一锚点两张卡片（一张生成中），删除后传入包含interrupted旧props及重复广播，记录本与跟随缓存仅剩另一张，计数只减一", async () => {
    const cardA = createCard(1);
    cardA.card_id = "card-A";
    cardA.anchor_id = "anc-shared-1";
    cardA.status = "completed";
    cardA.user_prompt = "已完成卡片A的问题";
    cardA.ai_response = "已完成卡片A的回答";

    const cardB = createCard(2);
    cardB.card_id = "card-B";
    cardB.anchor_id = "anc-shared-1";
    cardB.status = "generating";
    cardB.user_prompt = "正在生成卡片B的问题";
    cardB.ai_response = "正在生成卡片B的内容...";

    // 构造左侧阅读区与锚点 DOM
    const readerEl = document.createElement("div");
    readerEl.className = "reader-scroll-viewport";
    readerEl.setAttribute("data-reader-viewport", "true");
    document.body.appendChild(readerEl);
    Object.defineProperty(readerEl, "getBoundingClientRect", {
      value: () => ({ top: 0, bottom: 800, left: 0, right: 600, width: 600, height: 800 }),
      configurable: true,
    });
    const anchorEl = document.createElement("span");
    anchorEl.setAttribute("data-anchor-id", "anc-shared-1");
    Object.defineProperty(anchorEl, "getBoundingClientRect", {
      value: () => ({ top: 100, bottom: 150, left: 10, right: 300, width: 290, height: 50 }),
      configurable: true,
    });
    readerEl.appendChild(anchorEl);

    // Mock API
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_get_cards") {
        return Promise.resolve({
          items: [cardB, cardA],
          total: 2,
          has_more: false,
        });
      }
      if (cmd === "db_get_cards_by_anchor_ids") {
        return Promise.resolve([cardB, cardA]);
      }
      if (cmd === "db_get_highlights") {
        return Promise.resolve([]);
      }
      if (cmd === "db_delete_card") {
        return Promise.resolve(true);
      }
      return Promise.resolve(null);
    });

    let deleteCallbackCardId = "";
    const onDeleteCard = (cardId: string) => {
      deleteCallbackCardId = cardId;
    };

    const { rerender, getByText, queryByText, container } = render(
      <RightCompanionPanel
        document={dummyDoc}
        activeCardId={null}
        onSelectCard={() => {}}
        onOpenFullModal={() => {}}
        onJumpToSource={() => {}}
        onDeleteCard={onDeleteCard}
        onSendFollowUp={() => {}}
        onBottomAsk={() => {}}
        hasSelection={false}
        visibleAnchorIds={["anc-shared-1"]}
        cards={[cardB, cardA]}
        onRefreshCards={() => {}}
      />
    );

    // 等待跟随视图与卡片排布计算完成
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // 验证初始状态：跟随视图中存在同一锚点 2 条记录指示
    expect(queryByText(/同一来源 \(2 条记录\)/)).not.toBeNull();

    // 切换到记录本视图，确认初始记录本加载 2 条，总数共 2 条
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(100);
    });
    expect(queryByText("全部 (2)")).not.toBeNull();
    expect(queryByText("共 2 条")).not.toBeNull();
    expect(queryByText("正在生成卡片B的问题")).not.toBeNull();
    expect(queryByText("已完成卡片A的问题")).not.toBeNull();

    // 1. 先删除 cardB（正在生成的卡片）
    const cardBArticle =
      container.querySelector('[data-card-id="card-B"]') ||
      container.querySelector('[data-index="0"]');
    const deleteBtn = cardBArticle?.querySelector('button[title="删除卡片"]') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(deleteBtn);
      vi.advanceTimersByTime(50);
    });

    expect(deleteCallbackCardId).toBe("card-B");

    // 2. 模拟父层传入包含 cardB interrupted 状态的旧 props
    const oldPropsCards = [
      cardA,
      { ...cardB, status: "interrupted" as const },
    ];
    await act(async () => {
      rerender(
        <RightCompanionPanel
          document={dummyDoc}
          activeCardId={null}
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={onDeleteCard}
          onSendFollowUp={() => {}}
          onBottomAsk={() => {}}
          hasSelection={false}
          visibleAnchorIds={["anc-shared-1"]}
          cards={oldPropsCards}
          onRefreshCards={() => {}}
        />
      );
      vi.advanceTimersByTime(50);
    });

    // 3. 最后收到删除成功全局广播 flowread:card-deleted
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("flowread:card-deleted", {
          detail: { cardId: "card-B", documentId: dummyDoc.id },
        })
      );
      vi.advanceTimersByTime(50);
    });

    // 4. 断言：记录本只剩另一张卡片（cardA），总数只减一（为 1）
    expect(queryByText("正在生成卡片B的问题")).toBeNull();
    expect(queryByText("已完成卡片A的问题")).not.toBeNull();
    expect(queryByText("全部 (1)")).not.toBeNull();
    expect(queryByText("共 1 条")).not.toBeNull();

    // 切回跟随视图，断言跟随缓存也只剩 cardA（不再有多卡片指示栏，且只显示 cardA）
    await act(async () => {
      fireEvent.click(getByText("跟随视图"));
      vi.advanceTimersByTime(100);
    });
    expect(queryByText(/同一来源/)).toBeNull();
    expect(queryByText("已完成卡片A的回答") || queryByText("已完成卡片A的问题")).not.toBeNull();

    // 5. 断言：重复广播不改变正确结果，计数不被再次扣减
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("flowread:card-deleted", {
          detail: { cardId: "card-B", documentId: dummyDoc.id },
        })
      );
      vi.advanceTimersByTime(50);
    });

    // 切回记录本查看计数与列表
    await act(async () => {
      fireEvent.click(getByText("记录本"));
      vi.advanceTimersByTime(100);
    });
    expect(queryByText("全部 (1)")).not.toBeNull();
    expect(queryByText("共 1 条")).not.toBeNull();
    expect(queryByText("正在生成卡片B的问题")).toBeNull();
    expect(queryByText("已完成卡片A的问题")).not.toBeNull();
  });
});
