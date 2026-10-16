import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import * as pdfjsLib from "pdfjs-dist";
import ReaderArea, { TextJumpTarget } from "../components/ReaderArea";
import PDFReaderArea, { PDFJumpTarget } from "../components/PDFReaderArea";
import App from "../App";
import { invoke } from "@tauri-apps/api/core";
import { SourceAnchorRecord, CardRecord } from "../types/records";

const mockInvoke = vi.mocked(invoke);

function setupMockPdf(numPages = 3) {
  const mockPage = {
    getViewport: ({ scale = 1.0 }: { scale?: number } = {}) => ({
      width: Math.floor(595 * scale),
      height: Math.floor(842 * scale),
      scale,
      convertToPdfPoint: (x: number, y: number) => [x, y],
      convertToViewportPoint: (x: number, y: number) => [x, y],
    }),
    render: () => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
    getTextContent: () =>
      Promise.resolve({
        items: [
          {
            str: "第 1 页测试内容",
            dir: "ltr",
            width: 120,
            height: 16,
            transform: [1, 0, 0, 1, 0, 0],
          },
        ],
      }),
    cleanup: vi.fn(),
  };

  const mockDoc = {
    numPages,
    getPage: vi.fn().mockResolvedValue(mockPage),
    cleanup: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(pdfjsLib.getDocument).mockImplementation(() => {
    return {
      promise: Promise.resolve(mockDoc),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as any;
  });

  return { mockDoc, mockPage };
}

describe("回到原文定位稳定性与滚动接管回归测试", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setupMockPdf();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 1024 * 1024, mtime: 1000, revision: "v1" });
      }
      if (cmd === "read_file_chunk") {
        return Promise.resolve(new Uint8Array(65536));
      }
      if (cmd === "read_local_file") {
        return Promise.resolve("第一段文字内容。\n\n第二段文字关键论点所在。\n\n第三段补充内容。\n\n第四段结尾总结。");
      }
      if (cmd === "db_get_reading_preferences") return Promise.resolve(null);
      if (cmd === "db_save_reading_position") return Promise.resolve(true);
      if (cmd === "db_get_cards") return Promise.resolve({ items: [], total: 0, has_more: false });
      if (cmd === "db_get_highlights") return Promise.resolve([]);
      if (cmd === "db_get_anchors") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  // ============================================================
  // 1. 文本路径：定位完成立即释放控制权，用户自由滚动不被回拉
  // ============================================================
  it("1. 文本路径：定位完成后立即调用 onJumpComplete，用户连续滚动数秒无回拉", async () => {
    const onJumpComplete = vi.fn();

    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc-text-1",
        document_id: "doc-text-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        location_json: JSON.stringify({
          segments: [{ paragraphIndex: 1, startOffset: 0, endOffset: 8 }],
        }),
        excerpt: "第二段文字关键论点",
        created_at: 1000,
      },
    ];

    const jumpTarget: TextJumpTarget = {
      requestId: "jump-1-1-1000",
      paragraphIndex: 1,
      charOffset: 0,
      anchorId: "anc-text-1",
      timestamp: 1000,
      targetDocId: "doc-text-1",
      openSeq: 1,
    };

    const { container, rerender } = render(
      <ReaderArea
        filePath="/docs/text1.txt"
        documentId="doc-text-1"
        documentSeq={1}
        anchors={anchors}
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    const viewport = container.querySelector(".reader-scroll-viewport") as HTMLDivElement;
    expect(viewport).not.toBeNull();

    // 等待定位流程执行并完成释放
    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-1-1-1000");
    });

    // 定位完成后，模拟用户自由连续手动滚动
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);

    // 再次向上滚动到 250
    viewport.scrollTop = 250;
    fireEvent.scroll(viewport);

    // 等待一段时间（模拟多帧与异步调度）
    await new Promise((r) => setTimeout(r, 60));

    // 验证视口依然保持在用户自由滚动到的 250，没有被旧定位逻辑或定时器拉回
    expect(viewport.scrollTop).toBe(250);

    // App 在 onJumpComplete 后将 jumpTarget 置为 null，重新渲染组件不触发回拉
    rerender(
      <ReaderArea
        filePath="/docs/text1.txt"
        documentId="doc-text-1"
        documentSeq={1}
        anchors={anchors}
        jumpTarget={null}
        onJumpComplete={onJumpComplete}
      />
    );

    expect(viewport.scrollTop).toBe(250);
  });

  // ============================================================
  // 2. 文本路径：定位刚开始用户手动介入，延迟校正立即作废
  // ============================================================
  it("2. 文本路径：定位启动期间用户立即滚动或按键，立即中断定位并不再执行校正", async () => {
    const onJumpComplete = vi.fn();

    // 先正常挂载已打开的文档
    const { container, rerender } = render(
      <ReaderArea
        filePath="/docs/text-int.txt"
        documentId="doc-text-int"
        documentSeq={1}
        jumpTarget={null}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    const viewport = container.querySelector(".reader-scroll-viewport") as HTMLDivElement;
    expect(viewport).not.toBeNull();

    const jumpTarget: TextJumpTarget = {
      requestId: "jump-interrupt-text",
      paragraphIndex: 2,
      charOffset: 0,
      anchorId: "anc-text-interrupt-nonexistent",
      timestamp: 2000,
      targetDocId: "doc-text-int",
      openSeq: 1,
    };

    // 触发跳转
    rerender(
      <ReaderArea
        filePath="/docs/text-int.txt"
        documentId="doc-text-int"
        documentSeq={1}
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    // 用户在定位进行期间立即触发键盘向下导航或滚轮
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onJumpComplete).toHaveBeenCalledWith("jump-interrupt-text");

    // 用户手动滚到特定位置
    viewport.scrollTop = 550;
    fireEvent.scroll(viewport);

    // 等待足够长的时间确保任何排队的 rAF 或 timeout 都失效
    await new Promise((r) => setTimeout(r, 80));

    // 位置保持在用户滚到的 550，没有被校正拉回
    expect(viewport.scrollTop).toBe(550);
  });

  // ============================================================
  // 3. PDF 路径：文字与图像锚点定位结束释放，连续滚动无回拉
  // ============================================================
  it("3. PDF 路径：支持文字与截图切片定位，完成即释放控制权，用户自由滚动无回拉", async () => {
    const onJumpComplete = vi.fn();

    const anchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc-pdf-p2",
        document_id: "doc-pdf-1",
        document_revision: "v1",
        source_type: "pdf_text",
        location_json: JSON.stringify({
          segments: [{ pageNumber: 2, rects: [[100, 100, 200, 120]] }],
        }),
        excerpt: "PDF第二页文字",
        created_at: 1000,
      },
      {
        anchor_id: "anc-pdf-img-p2",
        document_id: "doc-pdf-1",
        document_revision: "v1",
        source_type: "pdf_image",
        location_json: JSON.stringify({
          location: { pageNumber: 2, rect: [50, 50, 150, 150], assetId: "" },
        }),
        excerpt: "P.2 图像切片",
        created_at: 1000,
      },
    ];

    const jumpTarget: PDFJumpTarget = {
      requestId: "jump-pdf-1",
      pageNumber: 2,
      anchorId: "anc-pdf-p2",
      timestamp: 3000,
      targetDocId: "doc-pdf-1",
      openSeq: 1,
    };

    const { container, rerender } = render(
      <PDFReaderArea
        filePath="/docs/test.pdf"
        documentId="doc-pdf-1"
        documentSeq={1}
        anchors={anchors}
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    const viewport = container.querySelector(".pdf-scroll-viewport") as HTMLDivElement;
    expect(viewport).not.toBeNull();

    // 等待定位完成并调用 onJumpComplete
    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-pdf-1");
    });

    // 用户自由向下滚动到 1200
    viewport.scrollTop = 1200;
    fireEvent.scroll(viewport);

    await new Promise((r) => setTimeout(r, 80));

    // 用户滚动不被旧的 180ms 延迟或 effect 循环拉回
    expect(viewport.scrollTop).toBe(1200);

    // 图像截图锚点跳转验证：同理能够单次正确定位并释放
    const imgJumpTarget: PDFJumpTarget = {
      requestId: "jump-pdf-img",
      pageNumber: 2,
      anchorId: "anc-pdf-img-p2",
      timestamp: 3500,
      targetDocId: "doc-pdf-1",
      openSeq: 1,
    };

    rerender(
      <PDFReaderArea
        filePath="/docs/test.pdf"
        documentId="doc-pdf-1"
        documentSeq={1}
        anchors={anchors}
        jumpTarget={imgJumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-pdf-img");
    });

    // 再次手动滚动
    viewport.scrollTop = 1400;
    fireEvent.scroll(viewport);
    await new Promise((r) => setTimeout(r, 60));
    expect(viewport.scrollTop).toBe(1400);
  });

  // ============================================================
  // 4. PDF 路径：定位中用户手动介入，立即中止微调
  // ============================================================
  it("4. PDF 路径：定位进行期间用户通过滚轮或指针交互介入，定位任务立即释放不抢回", async () => {
    const onJumpComplete = vi.fn();

    // 先挂载 PDFReaderArea，等待页面加载完成
    const { container, rerender } = render(
      <PDFReaderArea
        filePath="/docs/int.pdf"
        documentId="doc-pdf-int"
        documentSeq={1}
        jumpTarget={null}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".pdf-page-card")).not.toBeNull();
    });

    const viewport = container.querySelector(".pdf-scroll-viewport") as HTMLDivElement;
    expect(viewport).not.toBeNull();

    const jumpTarget: PDFJumpTarget = {
      requestId: "jump-pdf-int",
      pageNumber: 3,
      anchorId: "anc-pdf-p3-nonexistent",
      timestamp: 4000,
      targetDocId: "doc-pdf-int",
      openSeq: 1,
    };

    // 传入 jumpTarget 启动定位微调轮询
    rerender(
      <PDFReaderArea
        filePath="/docs/int.pdf"
        documentId="doc-pdf-int"
        documentSeq={1}
        jumpTarget={jumpTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    // 用户在定位中途立即通过鼠标滚轮或指针按下介入
    fireEvent.pointerDown(viewport);
    expect(onJumpComplete).toHaveBeenCalledWith("jump-pdf-int");

    // 用户置于新的滚动位置 400
    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);

    await new Promise((r) => setTimeout(r, 80));
    expect(viewport.scrollTop).toBe(400);
  });

  // ============================================================
  // 5. 快速点击 A -> B -> C：最新请求优先，旧异步不覆盖新请求
  // ============================================================
  it("5. 快速点击 A -> B -> C：旧异步查询迟到不会覆盖新请求，仅最新有效请求执行定位", async () => {
    const cards: CardRecord[] = [
      {
        card_id: "card-A",
        document_id: "doc-abc",
        anchor_id: "anc-A",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "A",
        ai_response: "A",
        preview: "A",
        error_message: null,
        model_name: "m",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "A",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      {
        card_id: "card-B",
        document_id: "doc-abc",
        anchor_id: "anc-B",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "B",
        ai_response: "B",
        preview: "B",
        error_message: null,
        model_name: "m",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "B",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
      {
        card_id: "card-C",
        document_id: "doc-abc",
        anchor_id: "anc-C",
        action: "Ask",
        depth: "quick",
        status: "completed",
        user_prompt: "C",
        ai_response: "C",
        preview: "C",
        error_message: null,
        model_name: "m",
        created_at: 1000,
        updated_at: 1000,
        turns_count: 0,
        anchor_excerpt: "C",
        anchor_source_type: "text_segment",
        anchor_location_json: "{}",
      },
    ];

    const anchorA: SourceAnchorRecord = {
      anchor_id: "anc-A",
      document_id: "doc-abc",
      document_revision: "v1",
      source_type: "text_segment",
      location_json: JSON.stringify({ segments: [{ paragraphIndex: 0, startOffset: 0, endOffset: 3 }] }),
      excerpt: "A",
      created_at: 1000,
    };
    const anchorB: SourceAnchorRecord = {
      anchor_id: "anc-B",
      document_id: "doc-abc",
      document_revision: "v1",
      source_type: "text_segment",
      location_json: JSON.stringify({ segments: [{ paragraphIndex: 0, startOffset: 4, endOffset: 7 }] }),
      excerpt: "B",
      created_at: 1000,
    };
    const anchorC: SourceAnchorRecord = {
      anchor_id: "anc-C",
      document_id: "doc-abc",
      document_revision: "v1",
      source_type: "text_segment",
      location_json: JSON.stringify({ segments: [{ paragraphIndex: 0, startOffset: 8, endOffset: 11 }] }),
      excerpt: "C",
      created_at: 1000,
    };

    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "get_file_metadata") {
        return Promise.resolve({ size: 1024, mtime: 1000, revision: "v1" });
      }
      if (cmd === "db_get_or_create_document") {
        return Promise.resolve({
          id: "doc-abc",
          path: "/docs/abc.txt",
          title: "abc.txt",
          file_size: 1024,
          created_at: 1000,
          updated_at: 1000,
        });
      }
      if (cmd === "read_local_file") {
        return Promise.resolve("段落A段落B段落C内容。");
      }
      if (cmd === "db_get_cards") {
        return Promise.resolve({ items: cards, total: 3, has_more: false });
      }
      if (cmd === "db_get_card_detail") {
        // 模拟卡片 A 的异步查询严重滞后 (60ms)，而卡片 C 立即返回
        if (args?.cardId === "card-A") {
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  card: cards[0],
                  anchor: anchorA,
                  turns: [],
                  function_results: [],
                }),
              60
            )
          );
        }
        const card = cards.find((c) => c.card_id === args?.cardId) || cards[2];
        return Promise.resolve({
          card,
          anchor: card.card_id === "card-B" ? anchorB : anchorC,
          turns: [],
          function_results: [],
        });
      }
      if (cmd === "db_get_anchors") {
        return Promise.resolve([anchorA, anchorB, anchorC]);
      }
      if (cmd === "db_get_reading_preferences") return Promise.resolve(null);
      if (cmd === "db_save_reading_position") return Promise.resolve(true);
      if (cmd === "db_get_highlights") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const { open } = await import("@tauri-apps/plugin-dialog");
    const mockOpen = vi.mocked(open);
    mockOpen.mockResolvedValueOnce("/docs/abc.txt");

    const { container } = render(<App />);

    // 通过快捷键打开文档
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    // 切换到“记录本”视图显示全部卡片
    await waitFor(() => {
      const recordsTab = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("记录本")
      );
      expect(recordsTab).toBeDefined();
      fireEvent.click(recordsTab!);
    });

    // 等待记录本卡片列表完全渲染
    await waitFor(() => {
      expect(container.querySelectorAll(".companion-card").length).toBe(3);
    });

    const cardElements = container.querySelectorAll(".companion-card");
    const jumpBtns = Array.from(cardElements).map(
      (el) => el.querySelector<HTMLButtonElement>("button[title='回到原文位置']")!
    );
    expect(jumpBtns[0]).toBeDefined();
    expect(jumpBtns[1]).toBeDefined();
    expect(jumpBtns[2]).toBeDefined();

    // 快速连续触发 A -> B -> C
    fireEvent.click(jumpBtns[0]); // A 触发慢异步 (60ms)
    fireEvent.click(jumpBtns[1]);
    fireEvent.click(jumpBtns[2]); // C 最晚发起

    // 等待所有异步完全返回（包含 A 的 60ms 迟到请求）
    await new Promise((r) => setTimeout(r, 100));

    // 验证当前选中的仍然是 C，A 的迟到结果被严格废弃，不能覆盖 C
    await waitFor(() => {
      const activeCard = container.querySelector(".companion-card.is-active");
      expect(activeCard?.textContent).toContain("C");
    });
  });

  // ============================================================
  // 6. 再次点击同一张卡发起全新定位请求
  // ============================================================
  it("6. 再次点击同一张卡片：生成新请求ID并重新执行定位", async () => {
    const onJumpComplete = vi.fn();

    const { rerender } = render(
      <ReaderArea
        filePath="/docs/same.txt"
        documentId="doc-same"
        documentSeq={1}
        jumpTarget={{
          requestId: "jump-same-1",
          paragraphIndex: 1,
          charOffset: 0,
          anchorId: "anc-1",
          timestamp: 5000,
          targetDocId: "doc-same",
          openSeq: 1,
        }}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-same-1");
    });

    // 再次点击同一张卡，传入新的 requestId 与时间戳
    rerender(
      <ReaderArea
        filePath="/docs/same.txt"
        documentId="doc-same"
        documentSeq={1}
        jumpTarget={{
          requestId: "jump-same-2",
          paragraphIndex: 1,
          charOffset: 0,
          anchorId: "anc-1",
          timestamp: 5001,
          targetDocId: "doc-same",
          openSeq: 1,
        }}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-same-2");
    });
  });

  // ============================================================
  // 7. 定位中切换文档：新文档不执行旧文档的定位请求
  // ============================================================
  it("7. 定位中切换文档：新文档严格校验文档身份与打开序号，旧目标不执行定位", async () => {
    const onJumpComplete = vi.fn();

    // 旧定位属于 doc-old (seq 1)
    const oldTarget: TextJumpTarget = {
      requestId: "jump-doc-old",
      paragraphIndex: 1,
      charOffset: 0,
      anchorId: "anc-old",
      timestamp: 6000,
      targetDocId: "doc-old",
      openSeq: 1,
    };

    const { container, rerender } = render(
      <ReaderArea
        filePath="/docs/old.txt"
        documentId="doc-old"
        documentSeq={1}
        jumpTarget={oldTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-doc-old");
    });

    // 切换到新文档 doc-new (seq 2)，等待新文档就绪
    rerender(
      <ReaderArea
        filePath="/docs/new.txt"
        documentId="doc-new"
        documentSeq={2}
        jumpTarget={null}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(container.querySelector(".virtual-paragraph-item")).not.toBeNull();
    });

    // 此时新文档已就绪，旧目标不应定位
    rerender(
      <ReaderArea
        filePath="/docs/new.txt"
        documentId="doc-new"
        documentSeq={2}
        jumpTarget={oldTarget} // 目标依然属于 doc-old
        onJumpComplete={onJumpComplete}
      />
    );

    await new Promise((r) => setTimeout(r, 60));

    // 旧目标的定位被严格拒绝，onJumpComplete 不会被旧目标再次调用
    expect(onJumpComplete).toHaveBeenCalledTimes(1);

    // 传入属于新文档的定位目标
    const newTarget: TextJumpTarget = {
      requestId: "jump-doc-new",
      paragraphIndex: 1,
      charOffset: 0,
      anchorId: "anc-new",
      timestamp: 6500,
      targetDocId: "doc-new",
      openSeq: 2,
    };

    rerender(
      <ReaderArea
        filePath="/docs/new.txt"
        documentId="doc-new"
        documentSeq={2}
        jumpTarget={newTarget}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledWith("jump-doc-new");
    });
    expect(onJumpComplete).toHaveBeenCalledTimes(2);
  });

  // ============================================================
  // 8. 缩放、重渲染不复活已完成的旧定位
  // ============================================================
  it("8. 缩放与重渲染：已完成的定位不会因 scale 变化或容器 resize 再次触发定位", async () => {
    const onJumpComplete = vi.fn();

    const target: TextJumpTarget = {
      requestId: "jump-scale-test",
      paragraphIndex: 1,
      charOffset: 0,
      timestamp: 7000,
      targetDocId: "doc-scale",
      openSeq: 1,
    };

    const { rerender } = render(
      <ReaderArea
        filePath="/docs/scale.txt"
        documentId="doc-scale"
        documentSeq={1}
        scale={1.0}
        jumpTarget={target}
        onJumpComplete={onJumpComplete}
      />
    );

    await waitFor(() => {
      expect(onJumpComplete).toHaveBeenCalledTimes(1);
    });

    // 改变缩放比例为 1.5，传入相同已经消费过的 target
    rerender(
      <ReaderArea
        filePath="/docs/scale.txt"
        documentId="doc-scale"
        documentSeq={1}
        scale={1.5}
        jumpTarget={target}
        onJumpComplete={onJumpComplete}
      />
    );

    // 模拟窗口尺寸变化
    fireEvent(window, new Event("resize"));
    await new Promise((r) => setTimeout(r, 60));

    // 验证 onJumpComplete 依然只被调用过一次，未重复消费或复活旧定位
    expect(onJumpComplete).toHaveBeenCalledTimes(1);
  });
});
