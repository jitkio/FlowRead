import React, { useState, useEffect, useRef } from "react";
import { CardRecord } from "../types/records";
import { findVisibleAnchorElement } from "../utils/sourceAnchorUtils";

export interface ConnectionLinesOverlayProps {
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  activeCardId: string | null;
  cards: CardRecord[];
}

interface RenderedLine {
  id: string;
  d: string;
  isActive: boolean;
}

export default function ConnectionLinesOverlay({
  workspaceRef,
  activeCardId,
  cards,
}: ConnectionLinesOverlayProps): React.JSX.Element {
  const [lines, setLines] = useState<RenderedLine[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // 保持实时状态引用，确保滚动、视口缩放与布局回调时刻读取最新卡片与选中态
  const cardsRef = useRef<CardRecord[]>(cards);
  cardsRef.current = cards;
  const activeCardIdRef = useRef<string | null>(activeCardId);
  activeCardIdRef.current = activeCardId;

  const calculateLines = () => {
    const ws = workspaceRef.current;
    if (!ws) return;

    const wsRect = ws.getBoundingClientRect();
    const newLines: RenderedLine[] = [];
    const currentCards = cardsRef.current;
    const currentActiveCardId = activeCardIdRef.current;

    // 所有来源查找严格限定在左侧阅读区域，避免误命中右侧伴读卡片同名 data-anchor-id
    const leftReaderEl =
      ws.querySelector<HTMLElement>('[data-reader-viewport="true"]') ||
      ws.querySelector<HTMLElement>(".reader-scroll-viewport") ||
      ws.querySelector<HTMLElement>(".pdf-scroll-viewport") ||
      ws.querySelector<HTMLElement>(".reader-container") ||
      ws.querySelector<HTMLElement>(".pdf-reader-container");
    if (!leftReaderEl) return;

    // 连线使用实际显示的可见卡片，包括历史卡片与重叠锚点轮切选中的卡片
    const followingContainer = ws.querySelector(".companion-following-stage");
    const targetCardItems: { cardId: string; anchorId: string; cardEl: HTMLElement }[] = [];

    if (followingContainer) {
      const domCardNodes = followingContainer.querySelectorAll<HTMLElement>(
        "[data-card-id][data-anchor-id]"
      );
      domCardNodes.forEach((cardEl) => {
        const cId = cardEl.dataset.cardId;
        const aId = cardEl.dataset.anchorId;
        if (cId && aId) {
          targetCardItems.push({ cardId: cId, anchorId: aId, cardEl });
        }
      });
    }

    // 若跟随舞台无卡片（如初次渲染或记录本切页），回退到当前卡片列表
    if (targetCardItems.length === 0) {
      for (const card of currentCards) {
        if (!card.anchor_id) continue;
        const cardEl = ws.querySelector<HTMLElement>(`[data-card-id="${card.card_id}"]`);
        if (cardEl) {
          targetCardItems.push({ cardId: card.card_id, anchorId: card.anchor_id, cardEl });
        }
      }
    }

    for (const item of targetCardItems) {
      const cardEl = item.cardEl;
      // 共享定位逻辑：选择当前阅读视口内相交的锚点片段
      const anchorEl = findVisibleAnchorElement(leftReaderEl, item.anchorId);

      if (!cardEl || !anchorEl) continue;

      const cardRect = cardEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();

      // 判断是否在视口范围内可见
      const isCardVisible =
        cardRect.bottom > wsRect.top && cardRect.top < wsRect.bottom;
      const isAnchorVisible =
        anchorRect.bottom > wsRect.top && anchorRect.top < wsRect.bottom;

      if (!isCardVisible || !isAnchorVisible) continue;

      // 查找锚点所在段落容器或内容容器的右边界，使连线从正文右侧自然引出，避免横穿段落文字
      const parentParaEl = anchorEl.closest<HTMLElement>(
        ".virtual-paragraph-item, p, .pdf-page-container, [data-paragraph-index]"
      ) || anchorEl;
      const paraRect = parentParaEl ? parentParaEl.getBoundingClientRect() : anchorRect;
      const startX = Math.max(anchorRect.right, paraRect.right);
      const x1 = Math.min(startX, cardRect.left - 20) - wsRect.left;
      const y1 = anchorRect.top + anchorRect.height / 2 - wsRect.top;
      const x2 = cardRect.left - wsRect.left;
      const y2 = cardRect.top + 18 - wsRect.top; // 对齐卡片顶部标题行

      // 避免反向倒勾
      if (x2 <= x1 + 12) continue;

      const dx = (x2 - x1) * 0.45;
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      const isActive = item.cardId === currentActiveCardId;

      newLines.push({
        id: item.cardId,
        d,
        isActive,
      });

      if (newLines.length >= 6 && !isActive) {
        break;
      }
    }

    setLines(newLines);
  };

  const scheduleUpdate = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      calculateLines();
      rafIdRef.current = null;
    });
  };

  useEffect(() => {
    scheduleUpdate();
  }, [cards, activeCardId]);

  // 监听正文滚动、卡片重新布局完成事件与窗口调整
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!ws) return;

    const handleScrollOrResize = () => {
      scheduleUpdate();
    };

    window.addEventListener("scroll", handleScrollOrResize, { passive: true, capture: true });
    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("flowread:layout-updated", handleScrollOrResize);
    window.addEventListener("flowread:card-layout-updated", handleScrollOrResize);
    window.addEventListener("flowread:source-layout-updated", handleScrollOrResize);

    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("flowread:layout-updated", handleScrollOrResize);
      window.removeEventListener("flowread:card-layout-updated", handleScrollOrResize);
      window.removeEventListener("flowread:source-layout-updated", handleScrollOrResize);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [workspaceRef]);

  return (
    <svg
      className="connection-lines-overlay"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 15,
        overflow: "visible",
      }}
    >
      {lines.map((l) => (
        <path
          key={l.id}
          d={l.d}
          fill="none"
          stroke={l.isActive ? "var(--pen, #e8664a)" : "var(--ln, #262523)"}
          strokeWidth={l.isActive ? 1.5 : 1}
          strokeDasharray={l.isActive ? "none" : "3 3"}
          opacity={l.isActive ? 0.92 : 0.35}
          style={{ transition: "stroke 0.15s ease, stroke-width 0.15s ease, opacity 0.15s ease" }}
        />
      ))}
    </svg>
  );
}
