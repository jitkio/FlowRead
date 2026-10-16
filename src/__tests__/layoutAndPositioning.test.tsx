import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import RightCompanionPanel from "../components/RightCompanionPanel";
import ConnectionLinesOverlay from "../components/ConnectionLinesOverlay";
import { DocumentRecord, CardRecord } from "../types/records";

describe("1 & 2: 阅读区定位与消除布局反馈循环", () => {
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

  const sampleCard: CardRecord = {
    card_id: "c-1",
    document_id: "doc-1",
    anchor_id: "anc-1",
    action: "Ask",
    depth: "quick",
    status: "completed",
    user_prompt: "问题1",
    ai_response: "回答1",
    preview: "回答1",
    error_message: null,
    model_name: "test-model",
    created_at: 1000,
    updated_at: 1000,
    turns_count: 0,
    anchor_excerpt: "测试段落",
    anchor_source_type: "text_segment",
    anchor_location_json: "{}",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("文本容器 .reader-scroll-viewport 和 PDF 容器 .pdf-scroll-viewport 均能被定位且连线层正常工作", async () => {
    const workspaceRef: { current: HTMLDivElement | null } = { current: null };

    const { container, rerender } = render(
      <div
        className="app-workspace"
        ref={(el) => {
          workspaceRef.current = el;
          if (el) {
            vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
              top: 0,
              left: 0,
              right: 1000,
              bottom: 800,
              width: 1000,
              height: 800,
              x: 0,
              y: 0,
              toJSON: () => {},
            });
          }
        }}
      >
        <div
          className="reader-scroll-viewport"
          data-reader-viewport="true"
          ref={(el) => {
            if (el) {
              vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                top: 0,
                left: 0,
                right: 500,
                bottom: 800,
                width: 500,
                height: 800,
                x: 0,
                y: 0,
                toJSON: () => {},
              });
            }
          }}
        >
          <mark
            data-anchor-id="anc-1"
            ref={(el) => {
              if (el) {
                vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                  top: 100,
                  left: 50,
                  right: 250,
                  bottom: 120,
                  width: 200,
                  height: 20,
                  x: 50,
                  y: 100,
                  toJSON: () => {},
                });
              }
            }}
          >
            原文内容
          </mark>
        </div>

        <ConnectionLinesOverlay
          workspaceRef={workspaceRef}
          activeCardId={"c-1"}
          cards={[sampleCard]}
        />
        <RightCompanionPanel
          document={dummyDoc}
          activeCardId={"c-1"}
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={() => {}}
          onSendFollowUp={() => {}}
          onBottomAsk={() => {}}
          hasSelection={true}
          visibleAnchorIds={["anc-1"]}
          cards={[sampleCard]}
          onRefreshCards={() => {}}
        />
      </div>
    );

    // 推进 timers 使跟随测量完成
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // 验证：右侧伴读卡片出现
    const cardEl = container.querySelector('[data-card-id="c-1"]');
    expect(cardEl).not.toBeNull();

    // 验证：PDF 容器场景切换，类名为 .pdf-scroll-viewport
    rerender(
      <div className="app-workspace" ref={(el) => { workspaceRef.current = el; }}>
        <div
          className="pdf-scroll-viewport"
          data-reader-viewport="true"
          ref={(el) => {
            if (el) {
              vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                top: 0, left: 0, right: 500, bottom: 800, width: 500, height: 800, x: 0, y: 0, toJSON: () => {},
              });
            }
          }}
        >
          <div
            data-anchor-id="anc-1"
            ref={(el) => {
              if (el) {
                vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                  top: 100, left: 50, right: 250, bottom: 120, width: 200, height: 20, x: 50, y: 100, toJSON: () => {},
                });
              }
            }}
          />
        </div>
        <ConnectionLinesOverlay
          workspaceRef={workspaceRef}
          activeCardId={"c-1"}
          cards={[sampleCard]}
        />
        <RightCompanionPanel
          document={dummyDoc}
          activeCardId={"c-1"}
          onSelectCard={() => {}}
          onOpenFullModal={() => {}}
          onJumpToSource={() => {}}
          onDeleteCard={() => {}}
          onSendFollowUp={() => {}}
          onBottomAsk={() => {}}
          hasSelection={true}
          visibleAnchorIds={["anc-1"]}
          cards={[sampleCard]}
          onRefreshCards={() => {}}
        />
      </div>
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));
      vi.advanceTimersByTime(100);
    });

    const pdfCardEl = container.querySelector('[data-card-id="c-1"]');
    expect(pdfCardEl).not.toBeNull();
  });

  it("来源查找严格限定在左侧，支持重叠锚点 data-all-anchor-ids，禁止误命中右侧卡片自身的同名属性", async () => {
    const overlapCard: CardRecord = {
      ...sampleCard,
      card_id: "c-overlap",
      anchor_id: "anc-overlap-2",
    };

    const { container } = render(
      <div className="app-workspace">
        <div
          className="reader-scroll-viewport"
          data-reader-viewport="true"
          ref={(el) => {
            if (el) {
              vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                top: 0, left: 0, right: 500, bottom: 800, width: 500, height: 800, x: 0, y: 0, toJSON: () => {},
              });
            }
          }}
        >
          <mark
            data-all-anchor-ids="anc-overlap-1,anc-overlap-2"
            ref={(el) => {
              if (el) {
                vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
                  top: 150, left: 50, right: 250, bottom: 170, width: 200, height: 20, x: 50, y: 150, toJSON: () => {},
                });
              }
            }}
          >
            重叠切片
          </mark>
        </div>

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
          visibleAnchorIds={["anc-overlap-2"]}
          cards={[overlapCard]}
          onRefreshCards={() => {}}
        />
      </div>
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const renderedCard = container.querySelector('[data-card-id="c-overlap"]');
    expect(renderedCard).not.toBeNull();
    expect(renderedCard?.getAttribute("data-anchor-id")).toBe("anc-overlap-2");
  });

  it("空首屏静置后刷新停止，无持续布局反馈循环", async () => {
    let layoutUpdateCount = 0;
    const handleLayoutUpdate = () => {
      layoutUpdateCount++;
    };
    window.addEventListener("flowread:card-layout-updated", handleLayoutUpdate);
    window.addEventListener("flowread:layout-updated", handleLayoutUpdate);

    render(
      <div className="app-workspace">
        <div className="reader-scroll-viewport" data-reader-viewport="true" />
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
      </div>
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const countAfterMount = layoutUpdateCount;

    // 空首屏静置 2 秒，验证没有循环触发
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(layoutUpdateCount).toBe(countAfterMount);

    window.removeEventListener("flowread:card-layout-updated", handleLayoutUpdate);
    window.removeEventListener("flowread:layout-updated", handleLayoutUpdate);
  });
});
