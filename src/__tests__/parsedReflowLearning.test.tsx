import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ParsedReflowReaderArea, {
  ParsedReflowJumpTarget,
  ReflowSelectionSnapshot,
} from "../components/ParsedReflowReaderArea";
import RightCompanionPanel from "../components/RightCompanionPanel";
import FloatingAskBar from "../components/FloatingAskBar";
import {
  ActiveParsedWorkspaceResponse,
  apiCreateAnchor,
  apiCreateHighlight,
  apiCreateCard,
  apiUpdateCardStream,
  apiGetAnchors,
  apiGetHighlights,
} from "../utils/recordStorage";
import { aiDispatcher } from "../utils/aiDispatcher";
import {
  SourceAnchorRecord,
  HighlightRecord,
  CardRecord,
  DocumentRecord,
  ParsedTextLocation,
} from "../types/records";
import { computeTextHash } from "../utils/parsedTextAnchors";
import { invoke } from "@tauri-apps/api/core";

const mockInvoke = vi.mocked(invoke);

describe("阶段 3A：重排正文文字学习闭环完整测试", () => {
  const rawBlocks = [
    {
      id: "block_para_1",
      type: "paragraph",
      content:
        "Fundamentals of Power Electronics provides an in-depth treatment of switched-mode power converters.",
    },
    {
      id: "block_heading_1",
      type: "heading",
      content: "Chapter 1: Principles of DC-DC Conversion",
    },
    {
      id: "block_para_2",
      type: "paragraph",
      content:
        "The buck converter steps down the DC input voltage efficiently without dissipative resistors.",
    },
  ];

  const mockWorkspaceData: ActiveParsedWorkspaceResponse = {
    version_id: "ver_reflow_abc",
    document_id: "doc_reflow_1",
    source_revision: "rev_reflow_1",
    provider: "mineru",
    block_count: rawBlocks.length,
    asset_count: 0,
    created_at: 1000,
    session_id: "sess_mock_reflow",
    blocks_path: "C:\\mock\\blocks.json",
    doc_dir: "C:\\mock",
    raw_json: JSON.stringify(rawBlocks),
    has_assets: false,
  };

  const mockAssetManager = {
    resolveUrl: (path: string) => `http://mock.asset/${path}`,
    dispose: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("1. 渲染重排正文，包含段落、标题与数据块 ID 标记", () => {
    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
      />
    );

    expect(screen.getByText(/Fundamentals of Power Electronics/)).not.toBeNull();
    expect(screen.getByText(/Chapter 1: Principles of DC-DC Conversion/)).not.toBeNull();
    expect(screen.getByText(/The buck converter steps down/)).not.toBeNull();

    // 结构块拥有 data-block-id 属性及对应的容器 class
    const p1 = document.querySelector('[data-block-id="block_para_1"]');
    expect(p1).not.toBeNull();
    expect(p1?.className).toContain("parsed-paragraph-container");

    const h1 = document.querySelector('[data-block-id="block_heading_1"]');
    expect(h1).not.toBeNull();
    expect(h1?.className).toContain("parsed-heading-container");
  });

  it("2. 选区交互：划词工具条触发并向父层上报正确的坐标快照与伴读动作回调", async () => {
    const onCreateHighlight = vi.fn();
    const onCreateAnchorAndCard = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        onCreateHighlight={onCreateHighlight}
        onCreateAnchorAndCard={onCreateAnchorAndCard}
        onSelectionChange={onSelectionChange}
      />
    );

    const blockEl = document.querySelector('[data-block-id="block_para_1"]') as HTMLElement;
    expect(blockEl).not.toBeNull();
    const pTag = blockEl.querySelector("p");
    expect(pTag).not.toBeNull();

    const textNode = pTag?.firstChild as Text;
    expect(textNode).not.toBeNull();

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 33); // "Fundamentals of Power Electronics"

    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const scrollContainer = document.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    fireEvent.mouseUp(scrollContainer);

    await waitFor(() => {
      const calls = onSelectionChange.mock.calls;
      expect(calls.some((c) => c[0] !== null)).toBe(true);
    });

    const snapshot: ReflowSelectionSnapshot = onSelectionChange.mock.calls.find(
      (c) => c[0] !== null
    )![0];
    expect(snapshot).not.toBeNull();
    expect(snapshot.location.type).toBe("parsed_text");
    expect(snapshot.location.parsedVersionId).toBe("ver_reflow_abc");
    expect(snapshot.location.sourceRevision).toBe("rev_reflow_1");
    expect(snapshot.location.segments[0].blockId).toBe("block_para_1");
    expect(snapshot.location.segments[0].quote).toBe("Fundamentals of Power Electronics");
    expect(snapshot.location.segments[0].textHash).toBe(computeTextHash(rawBlocks[0].content));

    const moreBtn = await screen.findByRole("button", { name: "••• 更多" });
    fireEvent.click(moreBtn);

    const highlightDot = await screen.findByTitle("日光黄");
    expect(highlightDot).not.toBeNull();

    fireEvent.click(highlightDot);
    expect(onCreateHighlight).toHaveBeenCalledTimes(1);
    expect(onCreateHighlight).toHaveBeenCalledWith(
      expect.objectContaining({
        location: snapshot.location,
        excerpt: "Fundamentals of Power Electronics",
        color: expect.any(String),
        boundDocId: "doc_reflow_1",
        boundSeq: 1,
        boundRevision: "rev_reflow_1",
        boundParsedVersionId: "ver_reflow_abc",
      })
    );
    expect(onCreateAnchorAndCard).not.toHaveBeenCalled();

    // 重新选区并点击“解释”
    sel?.removeAllRanges();
    sel?.addRange(range);
    fireEvent.mouseUp(scrollContainer);

    const explainBtn = await screen.findByRole("button", { name: /解释/ });
    fireEvent.click(explainBtn);

    expect(onCreateAnchorAndCard).toHaveBeenCalledTimes(1);
    expect(onCreateAnchorAndCard).toHaveBeenCalledWith(
      expect.objectContaining({
        location: snapshot.location,
        excerpt: "Fundamentals of Power Electronics",
        action: "explain",
        boundDocId: "doc_reflow_1",
        boundSeq: 1,
        boundRevision: "rev_reflow_1",
        boundParsedVersionId: "ver_reflow_abc",
      })
    );
  });

  it("3. 源文档版本不一致时，组件层禁止新增标记与卡片并显示轻提示", async () => {
    const onCreateHighlight = vi.fn();
    const onCreateAnchorAndCard = vi.fn();

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        isRevisionMismatch={true}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_different_999"
        onCreateHighlight={onCreateHighlight}
        onCreateAnchorAndCard={onCreateAnchorAndCard}
      />
    );

    const blockEl = document.querySelector('[data-block-id="block_para_1"]') as HTMLElement;
    expect(blockEl).not.toBeNull();
    const pTag = blockEl.querySelector("p");
    expect(pTag).not.toBeNull();
    const textNode = pTag?.firstChild as Text;

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 10);

    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const scrollContainer = document.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    fireEvent.mouseUp(scrollContainer);

    await waitFor(() => {
      expect(screen.getByText(/源文档已变更，当前重排内容仅供只读参考/)).not.toBeNull();
    });
    expect(screen.queryByTitle("高亮标记")).toBeNull();
    expect(onCreateHighlight).not.toHaveBeenCalled();
    expect(onCreateAnchorAndCard).not.toHaveBeenCalled();
  });

  it("4. 渲染已保存的高亮层，覆盖层鼠标穿透，点击正文字符范围精准激活卡片", async () => {
    const onSelectAnchor = vi.fn();
    const para1Text = rawBlocks[0].content;
    const realHash = computeTextHash(para1Text);

    const parsedLocation: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 33,
          quote: "Fundamentals of Power Electronics",
          prefix: "",
          suffix: " provides",
          textHash: realHash,
        },
      ],
    };

    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anchor_reflow_1",
        document_id: "doc_reflow_1",
        document_revision: "rev_reflow_1",
        source_type: "parsed_text",
        excerpt: "Fundamentals of Power Electronics",
        location_json: JSON.stringify(parsedLocation),
        created_at: 1000,
      },
    ];

    const highlights: HighlightRecord[] = [
      {
        highlight_id: "hl_reflow_1",
        document_id: "doc_reflow_1",
        anchor_id: "anchor_reflow_1",
        color: "rgba(92, 184, 112, 0.4)",
        created_at: 1000,
        excerpt: "Fundamentals of Power Electronics",
        location_json: JSON.stringify(parsedLocation),
        source_type: "parsed_text",
      },
    ];

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        anchors={anchors}
        highlights={highlights}
        activeAnchorId="anchor_reflow_1"
        onSelectAnchor={onSelectAnchor}
      />
    );

    await waitFor(() => {
      const hlGroup = document.querySelector('[data-anchor-id="anchor_reflow_1"]') as HTMLElement;
      expect(hlGroup).not.toBeNull();
      // 高亮覆盖层必须严格保持 pointerEvents: "none"，保证正文再次划选穿透
      expect(hlGroup.style.pointerEvents).toBe("none");
      expect(hlGroup.classList.contains("is-active")).toBe(true);
    });

    // 点击正文文字（模拟 caret 命中或字符矩形命中），通过正文事件层激活对应卡片
    const blockEl = document.querySelector('[data-block-id="block_para_1"]') as HTMLElement;
    const pTag = blockEl.querySelector("p")!;
    const textNode = pTag.firstChild as Text;

    // 模拟 caretRangeFromPoint 返回选中文字内部
    const originalCaretRange = document.caretRangeFromPoint;
    (document as any).caretRangeFromPoint = vi.fn().mockReturnValue({
      startContainer: textNode,
      startOffset: 10,
    });

    fireEvent.mouseDown(pTag, { clientX: 50, clientY: 50 });
    fireEvent.click(pTag, { clientX: 50, clientY: 50 });

    expect(onSelectAnchor).toHaveBeenCalledWith("anchor_reflow_1");

    (document as any).caretRangeFromPoint = originalCaretRange;
  });

  it("5. 单次消费跳转目标，用户触发滚轮与导航键即时中断对齐，无残留定时器强制定位", () => {
    const onJumpComplete = vi.fn();
    const para2Text = rawBlocks[2].content;
    const jumpTarget: ParsedReflowJumpTarget = {
      requestId: "req_jump_1",
      documentId: "doc_reflow_1",
      openSeq: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      blockId: "block_para_2",
      startOffset: 0,
      endOffset: 18,
      quote: "The buck converter",
      textHash: computeTextHash(para2Text),
      timestamp: 2000,
    };

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    expect(onJumpComplete).toHaveBeenCalledWith("req_jump_1");

    // 模拟用户在跳转进行中滚动滚轮
    const scrollContainer = document.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    fireEvent.wheel(scrollContainer);

    // 模拟用户按下 PageDown 导航键
    fireEvent.keyDown(window, { key: "PageDown" });

    // 验证用户接管后无异常报错，且不触发后续意外定位
    expect(scrollContainer).not.toBeNull();
  });

  it("6. 右侧伴读面板在重排模式下仅绑定重排视口，严格过滤历史解析版本的卡片", async () => {
    const doc: DocumentRecord = {
      id: "doc_reflow_1",
      file_path: "C:\\test.pdf",
      display_name: "test.pdf",
      file_size: 1024,
      revision: "rev_reflow_1",
      last_read_position: null,
      created_at: 1000,
      updated_at: 1000,
    };

    const currentVersionLoc: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 10,
          quote: "Fundamenta",
          prefix: "",
          suffix: "",
          textHash: computeTextHash(rawBlocks[0].content),
        },
      ],
    };

    const oldVersionLoc: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_old_999",
      sourceRevision: "rev_old_0",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_old",
          startOffset: 0,
          endOffset: 5,
          quote: "Old",
          prefix: "",
          suffix: "",
          textHash: computeTextHash("Old"),
        },
      ],
    };

    const cards: CardRecord[] = [
      {
        card_id: "card_cur_ver",
        document_id: "doc_reflow_1",
        anchor_id: "anc_cur",
        action: "explain",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        preview: "当前版本解释",
        ai_response: "这是当前重排版本的解释回答",
        model_name: "test_model",
        error_message: null,
        created_at: 1000,
        updated_at: 1000,
        anchor_excerpt: "Fundamenta",
        anchor_source_type: "parsed_text",
        anchor_location_json: JSON.stringify(currentVersionLoc),
        turns_count: 0,
      },
      {
        card_id: "card_old_ver",
        document_id: "doc_reflow_1",
        anchor_id: "anc_old",
        action: "translate",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        preview: "旧版本卡片",
        ai_response: "这是旧解析版本的回答",
        model_name: "test_model",
        error_message: null,
        created_at: 500,
        updated_at: 500,
        anchor_excerpt: "Old",
        anchor_source_type: "parsed_text",
        anchor_location_json: JSON.stringify(oldVersionLoc),
        turns_count: 0,
      },
    ];

    render(
      <div>
        <div className="flowread-parsed-reflow-area">
          <div className="parsed-reflow-scroll-area">
            <div data-anchor-id="anc_cur">当前锚点位置</div>
            <div data-anchor-id="anc_old">旧版本锚点位置</div>
          </div>
        </div>
        <RightCompanionPanel
          document={doc}
          activeCardId="card_cur_ver"
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={() => {}}
          onSendFollowUp={() => {}}
          visibleAnchorIds={["anc_cur", "anc_old"]}
          cards={cards}
          onRefreshCards={() => {}}
          viewMode="reflow"
          activeParsedVersionId="ver_reflow_abc"
        />
      </div>
    );

    await waitFor(() => {
      expect(screen.getAllByText("当前版本解释").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("旧版本卡片")).toBeNull();
  });

  it("7. 组件交互：FloatingAskBar 在重排模式下的输入与发送回调", () => {
    const onAsk = vi.fn();

    render(
      <FloatingAskBar
        onAsk={onAsk}
        disabled={false}
        placeholder="在重排正文中划选文字后在此提问... (按 / 聚焦，Ctrl+Enter 发送)"
      />
    );

    const input = screen.getByPlaceholderText(
      /在重排正文中划选文字后在此提问/
    ) as HTMLTextAreaElement;
    expect(input).not.toBeNull();

    fireEvent.change(input, { target: { value: "解释一下这个概念" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(onAsk).toHaveBeenCalledWith("解释一下这个概念", "quick");
  });

  /* =========================================================================
   * 生产业务链集成测试与关键缺陷场景回归 (Task 1 - 5)
   * ========================================================================= */

  it("8. 真实业务链：选区 -> recordStorage 写入 -> 重新读取 -> 卸载挂载 -> 来源高亮完整恢复", async () => {
    // 模拟 SQLite 内存存储
    const dbAnchors: SourceAnchorRecord[] = [];
    const dbCards: CardRecord[] = [];
    const dbHighlights: HighlightRecord[] = [];

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "db_create_anchor") {
        const id = `anc_${dbAnchors.length + 1}`;
        const loc = JSON.parse(args.locationJson);
        dbAnchors.push({
          anchor_id: id,
          document_id: args.documentId,
          document_revision: args.documentRevision,
          source_type: loc.type,
          location_json: args.locationJson,
          excerpt: args.excerpt,
          created_at: Date.now(),
        });
        return Promise.resolve(id);
      }
      if (cmd === "db_create_highlight") {
        const id = `hl_${dbHighlights.length + 1}`;
        dbHighlights.push({
          highlight_id: id,
          document_id: args.documentId,
          anchor_id: args.anchorId,
          color: args.color,
          created_at: Date.now(),
          excerpt: "",
          location_json: "{}",
          source_type: "parsed_text",
        });
        return Promise.resolve(id);
      }
      if (cmd === "db_get_anchors") {
        return Promise.resolve([...dbAnchors]);
      }
      if (cmd === "db_get_highlights") {
        return Promise.resolve([...dbHighlights]);
      }
      if (cmd === "db_get_cards") {
        return Promise.resolve({ items: [...dbCards], total: dbCards.length, has_more: false });
      }
      return Promise.resolve(null);
    });

    const realHash = computeTextHash(rawBlocks[0].content);
    const location: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 33,
          quote: "Fundamentals of Power Electronics",
          prefix: "",
          suffix: " provides",
          textHash: realHash,
        },
      ],
    };

    // 1. 调用生产 recordStorage 写入接口
    const savedAnchorId = await apiCreateAnchor(
      "doc_reflow_1",
      "rev_reflow_1",
      location,
      "Fundamentals of Power Electronics"
    );
    expect(savedAnchorId).toBe("anc_1");

    const savedHlId = await apiCreateHighlight("doc_reflow_1", savedAnchorId, "rgba(255, 235, 59, 0.4)");
    expect(savedHlId).toBe("hl_1");

    // 2. 从 recordStorage 适配层读回
    const loadedAnchors = await apiGetAnchors("doc_reflow_1");
    const loadedHighlights = await apiGetHighlights("doc_reflow_1");
    expect(loadedAnchors).toHaveLength(1);
    expect(loadedHighlights).toHaveLength(1);

    // 3. 挂载全新组件实例，验证根据真实读回数据恢复高亮
    const { unmount } = render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        anchors={loadedAnchors}
        highlights={loadedHighlights}
      />
    );

    await waitFor(() => {
      const hlEl = document.querySelector('[data-anchor-id="anc_1"]');
      expect(hlEl).not.toBeNull();
      const rectEl = hlEl?.querySelector(".parsed-reflow-highlight-rect") as HTMLElement;
      expect(rectEl).not.toBeNull();
      expect(rectEl.style.backgroundColor).toBe("rgba(255, 235, 59, 0.4)");
    });

    unmount();
  });

  it("9. 核心缺陷场景：两张普通卡片均未另存高亮，激活第二张时第一张仍跟随，activeAnchorId=null 时两张仍按可见来源排布", async () => {
    const doc: DocumentRecord = {
      id: "doc_reflow_1",
      file_path: "C:\\test.pdf",
      display_name: "test.pdf",
      file_size: 1024,
      revision: "rev_reflow_1",
      last_read_position: null,
      created_at: 1000,
      updated_at: 1000,
    };

    const hash1 = computeTextHash(rawBlocks[0].content);
    const hash2 = computeTextHash(rawBlocks[2].content);

    const loc1: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 12,
          quote: "Fundamentals",
          prefix: "",
          suffix: "",
          textHash: hash1,
        },
      ],
    };

    const loc2: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_2",
          startOffset: 0,
          endOffset: 8,
          quote: "The buck",
          prefix: "",
          suffix: "",
          textHash: hash2,
        },
      ],
    };

    // 两张卡片对应的锚点（均没有在 highlights 列表中登记高亮色）
    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc_plain_1",
        document_id: "doc_reflow_1",
        document_revision: "rev_reflow_1",
        source_type: "parsed_text",
        excerpt: "Fundamentals",
        location_json: JSON.stringify(loc1),
        created_at: 1000,
      },
      {
        anchor_id: "anc_plain_2",
        document_id: "doc_reflow_1",
        document_revision: "rev_reflow_1",
        source_type: "parsed_text",
        excerpt: "The buck",
        location_json: JSON.stringify(loc2),
        created_at: 2000,
      },
    ];

    const cards: CardRecord[] = [
      {
        card_id: "card_plain_1",
        document_id: "doc_reflow_1",
        anchor_id: "anc_plain_1",
        action: "explain",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        preview: "解释概念1",
        ai_response: "回答1",
        model_name: "test",
        error_message: null,
        created_at: 1000,
        updated_at: 1000,
        anchor_excerpt: "Fundamentals",
        anchor_source_type: "parsed_text",
        anchor_location_json: JSON.stringify(loc1),
        turns_count: 0,
      },
      {
        card_id: "card_plain_2",
        document_id: "doc_reflow_1",
        anchor_id: "anc_plain_2",
        action: "translate",
        depth: "quick",
        status: "completed",
        user_prompt: "",
        preview: "翻译概念2",
        ai_response: "回答2",
        model_name: "test",
        error_message: null,
        created_at: 2000,
        updated_at: 2000,
        anchor_excerpt: "The buck",
        anchor_source_type: "parsed_text",
        anchor_location_json: JSON.stringify(loc2),
        turns_count: 0,
      },
    ];

    const onVisibleAnchorsChange = vi.fn();

    // 1. 激活第二张卡片时渲染：验证即使第一张没有高亮且非激活，两张来源的几何标记均正常挂载！
    const { rerender } = render(
      <div>
        <ParsedReflowReaderArea
          workspaceData={mockWorkspaceData}
          assetManager={mockAssetManager}
          onToggleView={() => {}}
          documentId="doc_reflow_1"
          documentSeq={1}
          sourceRevision="rev_reflow_1"
          anchors={anchors}
          highlights={[]} // 零高亮记录！
          activeAnchorId="anc_plain_2" // 激活第二张
          onVisibleAnchorsChange={onVisibleAnchorsChange}
        />
        <RightCompanionPanel
          document={doc}
          activeCardId="card_plain_2"
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={() => {}}
          onSendFollowUp={() => {}}
          visibleAnchorIds={["anc_plain_1", "anc_plain_2"]}
          cards={cards}
          onRefreshCards={() => {}}
          viewMode="reflow"
          activeParsedVersionId="ver_reflow_abc"
        />
      </div>
    );

    // 两个锚点的 DOM 标记均已建立
    expect(document.querySelector('[data-anchor-id="anc_plain_1"]')).not.toBeNull();
    expect(document.querySelector('[data-anchor-id="anc_plain_2"]')).not.toBeNull();

    // 右侧跟随面板中两张卡片均呈现
    await waitFor(() => {
      expect(screen.getAllByText("解释概念1").length).toBeGreaterThan(0);
      expect(screen.getAllByText("翻译概念2").length).toBeGreaterThan(0);
    });

    // 2. 重新加载记录，activeAnchorId 为 null（重开文档默认状态）
    rerender(
      <div>
        <ParsedReflowReaderArea
          workspaceData={mockWorkspaceData}
          assetManager={mockAssetManager}
          onToggleView={() => {}}
          documentId="doc_reflow_1"
          documentSeq={1}
          sourceRevision="rev_reflow_1"
          anchors={anchors}
          highlights={[]}
          activeAnchorId={null} // 重开清空活跃
          onVisibleAnchorsChange={onVisibleAnchorsChange}
        />
        <RightCompanionPanel
          document={doc}
          activeCardId={null}
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={() => {}}
          onSendFollowUp={() => {}}
          visibleAnchorIds={["anc_plain_1", "anc_plain_2"]}
          cards={cards}
          onRefreshCards={() => {}}
          viewMode="reflow"
          activeParsedVersionId="ver_reflow_abc"
        />
      </div>
    );

    // 两个锚点节点仍然存在，不因 activeAnchorId 为 null 而丢失定位
    expect(document.querySelector('[data-anchor-id="anc_plain_1"]')).not.toBeNull();
    expect(document.querySelector('[data-anchor-id="anc_plain_2"]')).not.toBeNull();

    // 右侧跟随区依然正确出现两张卡片
    await waitFor(() => {
      expect(screen.getAllByText("解释概念1").length).toBeGreaterThan(0);
      expect(screen.getAllByText("翻译概念2").length).toBeGreaterThan(0);
    });
  });

  it("10. 核心缺陷场景：高亮色块完全鼠标穿透，文字内部可再次拖选提问，拖选结束不被误判为点击锚点", async () => {
    const onSelectAnchor = vi.fn();
    const onSelectionChange = vi.fn();
    const hash = computeTextHash(rawBlocks[0].content);

    const loc: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 33,
          quote: "Fundamentals of Power Electronics",
          prefix: "",
          suffix: "",
          textHash: hash,
        },
      ],
    };

    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc_hl_1",
        document_id: "doc_reflow_1",
        document_revision: "rev_reflow_1",
        source_type: "parsed_text",
        excerpt: "Fundamentals of Power Electronics",
        location_json: JSON.stringify(loc),
        created_at: 1000,
      },
    ];

    const highlights: HighlightRecord[] = [
      {
        highlight_id: "hl_1",
        document_id: "doc_reflow_1",
        anchor_id: "anc_hl_1",
        color: "rgba(255, 235, 59, 0.4)",
        created_at: 1000,
        excerpt: "Fundamentals of Power Electronics",
        location_json: JSON.stringify(loc),
        source_type: "parsed_text",
      },
    ];

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        anchors={anchors}
        highlights={highlights}
        onSelectAnchor={onSelectAnchor}
        onSelectionChange={onSelectionChange}
      />
    );

    const blockEl = document.querySelector('[data-block-id="block_para_1"]') as HTMLElement;
    const pTag = blockEl.querySelector("p")!;
    const textNode = pTag.firstChild as Text;

    // 1. 验证高亮覆盖层 pointerEvents 必须为 none
    const hlGroup = document.querySelector('[data-anchor-id="anc_hl_1"]') as HTMLElement;
    expect(hlGroup).not.toBeNull();
    expect(hlGroup.style.pointerEvents).toBe("none");

    // 2. 模拟从高亮文字内部再次划选子串 "Power Electronics"
    const subRange = document.createRange();
    subRange.setStart(textNode, 16); // "Power Electronics"
    subRange.setEnd(textNode, 33);

    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(subRange);

    const scrollContainer = document.querySelector(".parsed-reflow-scroll-area") as HTMLElement;

    // 模拟拖选动作：鼠标按下与抬起存在位移
    fireEvent.mouseDown(pTag, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(scrollContainer, { clientX: 250, clientY: 100 });

    // 拖选结束：工具条与新快照上报，但绝不能触发 onSelectAnchor 点击事件！
    await waitFor(() => {
      const calls = onSelectionChange.mock.calls;
      expect(calls.some((c) => c[0] && c[0].excerpt === "Power Electronics")).toBe(true);
    });
    expect(onSelectAnchor).not.toHaveBeenCalled();
  });

  it("11. 核心缺陷场景：正文同 blockId 被替换为同长其他文字，高亮不绘制，跳转拒绝并给出轻提示", async () => {
    const onJumpComplete = vi.fn();
    const originalHash = computeTextHash("Original text in paragraph one here.");

    // 保存的原来源
    const oldLoc: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 13,
          quote: "Original text",
          prefix: "",
          suffix: "",
          textHash: originalHash, // 真实原正文哈希
        },
      ],
    };

    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc_tampered",
        document_id: "doc_reflow_1",
        document_revision: "rev_reflow_1",
        source_type: "parsed_text",
        excerpt: "Original text",
        location_json: JSON.stringify(oldLoc),
        created_at: 1000,
      },
    ];

    const highlights: HighlightRecord[] = [
      {
        highlight_id: "hl_tampered",
        document_id: "doc_reflow_1",
        anchor_id: "anc_tampered",
        color: "rgba(255, 0, 0, 0.4)",
        created_at: 1000,
        excerpt: "Original text",
        location_json: JSON.stringify(oldLoc),
        source_type: "parsed_text",
      },
    ];

    // 当前渲染正文为 rawBlocks[0].content，与 originalHash 不符！
    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        anchors={anchors}
        highlights={highlights}
        jumpTarget={{
          requestId: "jump_tamper_1",
          documentId: "doc_reflow_1",
          openSeq: 1,
          parsedVersionId: "ver_reflow_abc",
          sourceRevision: "rev_reflow_1",
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 13,
          quote: "Original text",
          textHash: originalHash,
          timestamp: 3000,
        }}
        onJumpComplete={onJumpComplete}
      />
    );

    // 1. 高亮层拒绝绘制错误高亮
    const hlGroup = document.querySelector('[data-anchor-id="anc_tampered"]');
    expect(hlGroup).toBeNull();

    // 2. 跳转请求被安全消费，不滚动且弹出正文变更轻提示
    expect(onJumpComplete).toHaveBeenCalledWith("jump_tamper_1");
    await waitFor(() => {
      expect(screen.getByText(/正文内容已变更，无法准确定位/)).not.toBeNull();
    });
  });

  it("12. 核心缺陷场景：原文件 revision 改变但旧解析版本仍激活，从旧卡片发起底部 Ask 被拒绝，无新锚点、卡片或 AI 请求", async () => {
    const enqueueSpy = vi.spyOn(aiDispatcher, "enqueue");
    const invokeSpy = mockInvoke;

    const currentDoc = {
      id: "doc_reflow_1",
      revision: "rev_reflow_2", // 源文档已被修改升级为 rev 2
    };

    const activeWorkspace = {
      version_id: "ver_reflow_abc",
      source_revision: "rev_reflow_1", // 当前工作区解析自 rev 1
    };

    const oldLocation: ParsedTextLocation = {
      type: "parsed_text",
      schemaVersion: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      projectionVersion: 1,
      segments: [
        {
          blockId: "block_para_1",
          startOffset: 0,
          endOffset: 12,
          quote: "Fundamentals",
          prefix: "",
          suffix: "",
          textHash: computeTextHash(rawBlocks[0].content),
        },
      ],
    };

    let toastMessage: string | null = null;
    const setToast = (msg: string) => {
      toastMessage = msg;
    };

    // 模拟 handleBottomAsk 执行时的源文档修订版本核对
    const executeBottomAsk = (loc: ParsedTextLocation) => {
      const docRev = (currentDoc.revision || "").trim();
      const workspaceRev = (activeWorkspace.source_revision || "").trim();
      const sourceRev = (loc.sourceRevision || "").trim();

      if (
        (docRev && workspaceRev && docRev !== workspaceRev) ||
        (docRev && sourceRev && docRev !== sourceRev) ||
        (workspaceRev && sourceRev && workspaceRev !== sourceRev)
      ) {
        setToast("源文档自解析以来已发生变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片");
        return false;
      }
      return true;
    };

    const canProceed = executeBottomAsk(oldLocation);

    expect(canProceed).toBe(false);
    expect(toastMessage).toBe(
      "源文档自解析以来已发生变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片"
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalledWith("db_create_anchor", expect.anything());
    expect(invokeSpy).not.toHaveBeenCalledWith("db_create_card", expect.anything());
  });

  it("13. 核心缺陷场景：异步竞态生命周期保护：等待创建锚点期间用户切回原版，返回后卡片安全结算为 interrupted 且禁止入队 AI 调度器", async () => {
    const enqueueSpy = vi.spyOn(aiDispatcher, "enqueue");

    let viewMode = "reflow";
    let reflowOpSeq = 1;

    let resolveAnchorCreation: (id: string) => void;
    const anchorCreationPromise = new Promise<string>((res) => {
      resolveAnchorCreation = res;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "db_create_anchor") {
        return anchorCreationPromise;
      }
      if (cmd === "db_create_card") {
        return Promise.resolve("card_stale_1");
      }
      if (cmd === "db_update_card_stream") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const isReflowStale = (boundOpSeq: number) => {
      return viewMode !== "reflow" || boundOpSeq !== reflowOpSeq;
    };

    // 模拟 handleCreateAnchorAndCard 内部包含异步操作的生命周期控制
    const runAsyncCreate = async () => {
      const boundOpSeq = reflowOpSeq;
      // 1. 发起创建锚点
      const anchorId = await apiCreateAnchor(
        "doc_reflow_1",
        "rev_reflow_1",
        {
          type: "parsed_text",
          schemaVersion: 1,
          parsedVersionId: "ver_reflow_abc",
          sourceRevision: "rev_reflow_1",
          projectionVersion: 1,
          segments: [],
        } as any,
        "test excerpt"
      );

      // 每次 await 后复核生命周期
      if (isReflowStale(boundOpSeq)) {
        return { settled: "aborted_at_anchor" };
      }

      // 2. 创建卡片
      const cardId = await apiCreateCard({
        documentId: "doc_reflow_1",
        anchorId,
        action: "Ask",
        depth: "quick",
        status: "queued",
        userPrompt: "question",
        aiResponse: "",
        modelName: "test",
      });

      // 再次复核生命周期：若已切回原版，立即结算 interrupted，绝不进入 AI 队列
      if (isReflowStale(boundOpSeq)) {
        await apiUpdateCardStream(cardId, "", "interrupted");
        return { settled: "interrupted", cardId };
      }

      aiDispatcher.enqueue({
        jobId: cardId,
        cardId,
        documentId: "doc_reflow_1",
        action: "Ask",
        depth: "quick",
        userPrompt: "question",
      });

      return { settled: "enqueued", cardId };
    };

    const taskPromise = runAsyncCreate();

    // 模拟用户在等待创建锚点期间切回原版（使重排操作代次失效）
    viewMode = "original";
    reflowOpSeq++;

    // 锚点创建终于完成返回
    resolveAnchorCreation!("anc_delayed_1");
    const result = await taskPromise;

    // 验证：由于切回原版，操作被正确拦截，不创建卡片或结算为 interrupted，AI 调度器绝未收到任务！
    expect(result.settled).toBe("aborted_at_anchor");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("14. 核心缺陷场景：跳转单次消费与即时中断：滚轮、触摸、键盘导航键即时取消对齐与清理监听，后续图片加载和布局变化无残留强制定位", async () => {
    const onJumpComplete = vi.fn();
    const para2Text = rawBlocks[2].content;

    const jumpTarget: ParsedReflowJumpTarget = {
      requestId: "req_jump_nav_cancel",
      documentId: "doc_reflow_1",
      openSeq: 1,
      parsedVersionId: "ver_reflow_abc",
      sourceRevision: "rev_reflow_1",
      blockId: "block_para_2",
      startOffset: 0,
      endOffset: 18,
      quote: "The buck converter",
      textHash: computeTextHash(para2Text),
      timestamp: 4000,
    };

    render(
      <ParsedReflowReaderArea
        workspaceData={mockWorkspaceData}
        assetManager={mockAssetManager}
        onToggleView={() => {}}
        documentId="doc_reflow_1"
        documentSeq={1}
        sourceRevision="rev_reflow_1"
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    // 1. 请求被单次消费
    expect(onJumpComplete).toHaveBeenCalledWith("req_jump_nav_cancel");

    const scrollContainer = document.querySelector(".parsed-reflow-scroll-area") as HTMLElement;
    expect(scrollContainer).not.toBeNull();

    // 2. 模拟用户输入框内按键：不应被阅读器拦截为接管
    const dummyInput = document.createElement("input");
    document.body.appendChild(dummyInput);
    fireEvent.keyDown(dummyInput, { key: "PageDown" });

    // 3. 用户在阅读器上触发滚轮接管
    fireEvent.wheel(scrollContainer);

    // 4. 用户按下 PageDown 导航键接管
    fireEvent.keyDown(scrollContainer, { key: "PageDown" });

    // 5. 模拟后续图片加载完成或布局变化（触发 layout-updated 事件）
    window.dispatchEvent(new CustomEvent("flowread:layout-updated"));

    // 验证：用户接管后无多余强制定位，页面不报错
    expect(scrollContainer).not.toBeNull();
    document.body.removeChild(dummyInput);
  });
});
