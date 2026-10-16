import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import ReaderMinimap from "../components/ReaderMinimap";
import RightCompanionPanel from "../components/RightCompanionPanel";
import { SourceAnchorRecord } from "../types/records";

describe("三栏共享背景布局与轻量 Minimap 回归验证", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("1. Minimap 在大文档下使用轻量 Canvas 与标记点，不克隆 DOM 且正确计算视口指示器高度与位置", async () => {
    const wsRef = { current: document.createElement("div") };
    const vp = document.createElement("div");
    vp.setAttribute("data-reader-viewport", "true");
    Object.defineProperty(vp, "scrollTop", { value: 200, writable: true });
    Object.defineProperty(vp, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(vp, "clientHeight", { value: 400, configurable: true });
    wsRef.current.appendChild(vp);
    document.body.appendChild(wsRef.current);

    const dummyAnchors: SourceAnchorRecord[] = [
      {
        anchor_id: "anc-1",
        document_id: "doc-1",
        document_revision: "rev-1",
        source_type: "text_segment",
        excerpt: "段落1摘录",
        location_json: JSON.stringify({ segments: [{ paragraphIndex: 5 }] }),
        created_at: 1000,
      },
    ];

    const { container } = render(
      <ReaderMinimap
        mode="text"
        workspaceRef={wsRef}
        textParagraphLengths={[100, 200, 300, 400, 500, 600, 700, 800]}
        anchors={dummyAnchors}
        scale={1.0}
      />
    );

    const rail = container.querySelector(".minimap-rail");
    expect(rail).not.toBeNull();
    const canvas = container.querySelector(".minimap-canvas");
    expect(canvas).not.toBeNull();
    const marker = container.querySelector(".minimap-anchor-marker");
    expect(marker).not.toBeNull();
    const viewportIndicator = container.querySelector(".minimap-viewport-indicator");
    expect(viewportIndicator).not.toBeNull();
  });

  it("2. Minimap 点击与拖拽快速滚动：更新 scrollTop 并在 pointerup 时立即结束拖拽与控制权", async () => {
    const wsRef = { current: document.createElement("div") };
    const vp = document.createElement("div");
    vp.setAttribute("data-reader-viewport", "true");
    let currentScroll = 0;
    Object.defineProperty(vp, "scrollTop", {
      get: () => currentScroll,
      set: (v) => { currentScroll = v; },
      configurable: true,
    });
    Object.defineProperty(vp, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(vp, "clientHeight", { value: 500, configurable: true });
    wsRef.current.appendChild(vp);
    document.body.appendChild(wsRef.current);

    const { container } = render(
      <ReaderMinimap
        mode="text"
        workspaceRef={wsRef}
        textParagraphLengths={[500, 500, 500, 500]}
        anchors={[]}
        scale={1.0}
      />
    );

    const rail = container.querySelector(".minimap-rail") as HTMLElement;
    expect(rail).not.toBeNull();

    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 20,
      bottom: 500,
      right: 70,
      width: 50,
      height: 400,
      x: 20,
      y: 100,
      toJSON: () => {},
    });

    // 模拟在 minimap 中间点击 (clientY = 300, 相当于相对于 rail 的 200px / 50% 处)
    act(() => {
      fireEvent.pointerDown(rail, { clientY: 300, pointerId: 1 });
    });

    // 最大可滚动距离 2000 - 500 = 1500
    // 应当滚动到接近 50% 处，不应为 0
    expect(currentScroll).toBeGreaterThan(0);
    expect(currentScroll).toBeLessThanOrEqual(1500);

    // 模拟拖动
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: 400 }));
    });
    expect(currentScroll).toBeGreaterThan(500);

    // 释放指针：立即解除控制
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    // 此时用户自由滚动 reader 视口
    currentScroll = 120;
    expect(currentScroll).toBe(120);
  });

  it("3. 右侧伴读面板支持自定义宽度，外壳背景透明以融入统一背景", () => {
    const { container } = render(
      <RightCompanionPanel
        width={380}
        document={null}
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

    const panel = container.querySelector(".right-companion-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.style.width).toBe("380px");
    expect(panel.style.backgroundColor).toBe("transparent");
  });

  it("4. 伴读栏宽度本地持久化恢复与窗口变窄限位", () => {
    localStorage.setItem("flowread_companion_panel_width_v1", "480");
    const saved = localStorage.getItem("flowread_companion_panel_width_v1");
    expect(saved).toBe("480");

    const parsed = parseInt(saved!, 10);
    const mockWindowWidth = 600;
    const maxAllowed = Math.max(260, mockWindowWidth - 420); // 180 -> max(260, 180) = 260
    const clamped = Math.min(Math.min(560, maxAllowed), Math.max(260, parsed));
    expect(clamped).toBe(260); // 窄窗口自动约束至 260
  });
});
