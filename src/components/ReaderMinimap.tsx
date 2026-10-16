import React, { useState, useEffect, useRef, useCallback } from "react";
import { SourceAnchorRecord } from "../types/records";

export interface ReaderMinimapProps {
  mode: "text" | "pdf";
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  textParagraphLengths?: number[];
  pdfTotalPages?: number;
  anchors?: SourceAnchorRecord[];
  scale?: number;
}

export default function ReaderMinimap({
  mode,
  workspaceRef,
  textParagraphLengths = [],
  pdfTotalPages = 0,
  anchors = [],
  scale = 1.0,
}: ReaderMinimapProps): React.JSX.Element {
  const [scrollProgress, setScrollProgress] = useState<{ top: number; height: number }>({
    top: 0,
    height: 30,
  });
  const [railHeight, setRailHeight] = useState<number>(400);

  const railRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDraggingRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  // 获取主阅读器滚动容器
  const getViewport = useCallback((): HTMLElement | null => {
    const ws = workspaceRef.current;
    if (!ws) return null;
    return (
      ws.querySelector<HTMLElement>('[data-reader-viewport="true"]') ||
      ws.querySelector<HTMLElement>(".reader-scroll-viewport") ||
      ws.querySelector<HTMLElement>(".pdf-scroll-viewport")
    );
  }, [workspaceRef]);

  // 同步正文当前视口位置到 minimap 指示框
  const updateScrollIndicator = useCallback(() => {
    const vp = getViewport();
    const rail = railRef.current;
    if (!vp || !rail) return;

    const sTop = vp.scrollTop;
    const sHeight = vp.scrollHeight;
    const cHeight = vp.clientHeight;
    const rHeight = rail.clientHeight;

    if (sHeight <= 0 || cHeight <= 0 || rHeight <= 0) return;

    const visibleRatio = Math.min(1, Math.max(0.04, cHeight / sHeight));
    const indicatorHeight = Math.max(20, Math.min(rHeight, visibleRatio * rHeight));
    const maxScroll = Math.max(1, sHeight - cHeight);
    const scrollRatio = Math.max(0, Math.min(1, sTop / maxScroll));
    const travelDistance = Math.max(0, rHeight - indicatorHeight);
    const indicatorTop = scrollRatio * travelDistance;

    setScrollProgress({
      top: indicatorTop,
      height: indicatorHeight,
    });
  }, [getViewport]);

  // 监听正文滚动与视口尺寸变化
  useEffect(() => {
    const scheduleUpdate = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        updateScrollIndicator();
      });
    };

    updateScrollIndicator();

    const ws = workspaceRef.current;
    if (!ws) return;

    const vp = getViewport();
    if (vp) {
      vp.addEventListener("scroll", scheduleUpdate, { passive: true });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (railRef.current) {
        setRailHeight(railRef.current.clientHeight);
      }
      scheduleUpdate();
    });

    if (vp) resizeObserver.observe(vp);
    if (railRef.current) resizeObserver.observe(railRef.current);

    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("flowread:layout-updated", scheduleUpdate);

    return () => {
      if (vp) {
        vp.removeEventListener("scroll", scheduleUpdate);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("flowread:layout-updated", scheduleUpdate);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [workspaceRef, getViewport, updateScrollIndicator, scale]);

  // 在 Canvas 上绘制轻量级内容结构轮廓（非克隆 DOM，大文档高帧率）
  useEffect(() => {
    const canvas = canvasRef.current;
    const rail = railRef.current;
    if (!canvas || !rail) return;

    const width = rail.clientWidth || 54;
    const height = rail.clientHeight || 400;

    // 高清 DPR 采样
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx || typeof ctx.scale !== "function" || typeof ctx.clearRect !== "function") return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // 提取当前主题前景色（微透明）
    const isDark = document.documentElement.getAttribute("data-theme") === "night" ||
                   document.documentElement.getAttribute("data-theme") === "ink";
    const barColor = isDark ? "rgba(232, 229, 222, 0.22)" : "rgba(30, 41, 59, 0.20)";
    const headingColor = isDark ? "rgba(232, 229, 222, 0.45)" : "rgba(30, 41, 59, 0.40)";
    const pdfPageBg = isDark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.03)";
    const pdfPageBorder = isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)";

    if (mode === "text") {
      const pLengths = textParagraphLengths.length > 0 ? textParagraphLengths : [100, 200, 150, 80];
      const count = pLengths.length;
      if (count > 0) {
        const totalChars = pLengths.reduce((a, b) => a + Math.max(20, b), 0);
        let currentY = 8;
        const availableH = Math.max(30, height - 16);

        // 使用轻量、细密的段落轮廓替代粗方块 (1.2px 精致横条)
        for (let i = 0; i < count; i++) {
          const len = pLengths[i];
          const sliceH = Math.max(2.2, Math.min(8, (Math.max(20, len) / totalChars) * availableH * 1.6));
          const isHeading = len < 35 && i > 0 && i % 4 === 0;

          ctx.fillStyle = isHeading ? headingColor : barColor;
          const lineWidth = isHeading
            ? width * 0.45
            : Math.max(width * 0.35, Math.min(width * 0.82, (len / 300) * width * 0.82));

          const lineX = (width - lineWidth) / 2;
          ctx.fillRect(lineX, currentY, lineWidth, 1.2);

          currentY += sliceH;
          if (currentY > height - 8) break;
        }
      }
    } else {
      // PDF 模式：绘制各页缩略外框比例模型
      const pages = Math.max(1, pdfTotalPages);
      const padding = 6;
      const availableH = height - padding * 2;
      const pageH = Math.max(16, Math.min(44, (availableH - (pages - 1) * 3) / pages));
      const pageW = Math.min(width - 12, pageH / 1.414);
      const pageX = (width - pageW) / 2;

      for (let p = 0; p < pages; p++) {
        const pageY = padding + p * (pageH + 3);
        if (pageY > height - 6) break;

        ctx.fillStyle = pdfPageBg;
        ctx.strokeStyle = pdfPageBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(pageX, pageY, pageW, pageH, 2);
        } else {
          ctx.rect(pageX, pageY, pageW, pageH);
        }
        ctx.fill();
        ctx.stroke();

        // 页码指示
        if (pageH >= 20) {
          ctx.fillStyle = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
          ctx.font = "8px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(String(p + 1), width / 2, pageY + pageH / 2 + 3);
        }
      }
    }
  }, [mode, textParagraphLengths, pdfTotalPages, railHeight]);

  // 点击与拖拽快速滚动处理（居中指示器并释放控制权）
  const scrollToClientY = useCallback((clientY: number) => {
    const rail = railRef.current;
    const vp = getViewport();
    if (!rail || !vp) return;

    // Minimap 交互表明用户意图，中断任何在途的旧定位拉回任务
    try {
      vp.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    } catch {}

    const rect = rail.getBoundingClientRect();
    const clickY = clientY - rect.top;
    const rHeight = rect.height;
    const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
    if (maxScroll <= 0 || rHeight <= 0) return;

    const visibleRatio = Math.min(1, Math.max(0.04, vp.clientHeight / Math.max(1, vp.scrollHeight)));
    const indicatorHeight = Math.max(20, Math.min(rHeight, visibleRatio * rHeight));
    const travelDistance = Math.max(1, rHeight - indicatorHeight);
    const adjustedY = clickY - indicatorHeight / 2;
    const ratio = Math.max(0, Math.min(1, adjustedY / travelDistance));
    const targetScroll = Math.round(ratio * maxScroll);
    vp.scrollTop = targetScroll;
  }, [getViewport]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rail = railRef.current;
    if (!rail) return;

    isDraggingRef.current = true;
    try {
      rail.setPointerCapture(e.pointerId);
    } catch {}

    scrollToClientY(e.clientY);

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDraggingRef.current) return;
      scrollToClientY(moveEvent.clientY);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      isDraggingRef.current = false;
      try {
        rail.releasePointerCapture(upEvent.pointerId);
      } catch {}
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  // 收集当前文档在 Minimap 上的锚点分布标记
  const anchorMarkers = React.useMemo(() => {
    if (!anchors || anchors.length === 0) return [];
    const markers: { id: string; topPercent: number }[] = [];

    if (mode === "text") {
      const totalP = Math.max(1, textParagraphLengths.length || 1);
      anchors.forEach((a) => {
        try {
          const loc = JSON.parse(a.location_json);
          const pIdx = loc.segments?.[0]?.paragraphIndex ?? 0;
          const pct = Math.min(0.96, Math.max(0.04, pIdx / totalP));
          markers.push({ id: a.anchor_id, topPercent: pct });
        } catch {}
      });
    } else {
      const totalP = Math.max(1, pdfTotalPages || 1);
      anchors.forEach((a) => {
        try {
          const loc = JSON.parse(a.location_json);
          const pNum = loc.segments?.[0]?.pageNumber || loc.location?.pageNumber || 1;
          const pct = Math.min(0.96, Math.max(0.04, (pNum - 0.5) / totalP));
          markers.push({ id: a.anchor_id, topPercent: pct });
        } catch {}
      });
    }

    return markers;
  }, [anchors, mode, textParagraphLengths.length, pdfTotalPages]);

  // 计算内容自适应的 Minimap 轨道高度 (短文紧凑，大文档控制上限，不再拉成长条空轨道)
  const computedRailHeight = React.useMemo(() => {
    if (mode === "text") {
      const pCount = Math.max(1, textParagraphLengths.length || 1);
      return Math.min(420, Math.max(84, Math.round(pCount * 5.5 + 24)));
    } else {
      const pages = Math.max(1, pdfTotalPages || 1);
      return Math.min(420, Math.max(84, Math.round(pages * 36 + 20)));
    }
  }, [mode, textParagraphLengths.length, pdfTotalPages]);

  return (
    <aside
      className="workspace-minimap-column"
      aria-label="内容全局小地图导航"
      title="小地图全景导航 · 点击或拖动快速跳转视口"
    >
      <div
        ref={railRef}
        className="minimap-rail"
        style={{
          height: `${computedRailHeight}px`,
        }}
        onPointerDown={handlePointerDown}
      >
        <canvas ref={canvasRef} className="minimap-canvas" />

        {/* 锚点/伴读标记点 (Coral Red Dot) */}
        {anchorMarkers.map((m) => (
          <div
            key={m.id}
            className="minimap-anchor-marker"
            style={{
              top: `${m.topPercent * 100}%`,
            }}
          />
        ))}

        {/* 动态视口滑块指示器 */}
        <div
          className="minimap-viewport-indicator"
          style={{
            top: `${scrollProgress.top}px`,
            height: `${scrollProgress.height}px`,
          }}
        />
      </div>
    </aside>
  );
}
