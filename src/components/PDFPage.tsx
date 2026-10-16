import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  SourceAnchorRecord,
  HighlightRecord,
  PDFTextSegment,
  PDFImageLocation,
} from "../types/records";

export interface PDFPageProps {
  /** PDF.js 文档代理对象 */
  pdf: PDFDocumentProxy;
  /** 页码（1-based） */
  pageNumber: number;
  /** 缩放比例 */
  scale: number;
  /** 页面渲染完成并获取精准宽高与 Viewport 后的回调 */
  onPageRendered?: (
    pageNumber: number,
    width: number,
    height: number,
    viewport: PageViewport
  ) => void;
  /** 框选图片裁剪完成回调 */
  onCropCompleted?: (cropData: {
    imageBase64: string;
    pageNumber: number;
    pdfRect: [number, number, number, number];
    cssRect: { left: number; top: number; width: number; height: number };
  }) => void;
  /** 外部传入的历史锚点集合 */
  anchors?: SourceAnchorRecord[];
  /** 外部传入的高亮记录 */
  highlights?: HighlightRecord[];
  /** 当前激活的高亮锚点 ID */
  activeAnchorId?: string | null;
  /** 点击高亮锚点的回调 */
  onSelectAnchor?: (anchorId: string) => void;
  /** 当前文档版本标识，版本变化时不绘制旧锚点 */
  documentRevision?: string;
}

export default function PDFPage({
  pdf,
  pageNumber,
  scale,
  onPageRendered,
  onCropCompleted,
  anchors,
  highlights,
  activeAnchorId,
  onSelectAnchor,
  documentRevision,
}: PDFPageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const sandwichRef = useRef<HTMLDivElement | null>(null);

  // 记录实际页面尺寸（像素）
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [isRendering, setIsRendering] = useState<boolean>(true);
  const currentViewportRef = useRef<PageViewport | null>(null);

  // 区域框选 (Region Selection) 状态
  const [isSelecting, setIsSelecting] = useState<boolean>(false);
  const [startPoint, setStartPoint] = useState<{ x: number; y: number } | null>(null);
  const [currentPoint, setCurrentPoint] = useState<{ x: number; y: number } | null>(null);
  const [selectedBox, setSelectedBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [isAltPressed, setIsAltPressed] = useState<boolean>(false);

  // 估算标准 A4 宽高（72 DPI 下默认 595 x 842 磅），未就绪时作为骨架占位
  const estimatedWidth = Math.floor(595 * scale);
  const estimatedHeight = Math.floor(842 * scale);

  // 监听全局 Alt 键状态，用于光标样式与交互提示
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Alt") setIsAltPressed(true);
    };
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === "Alt") setIsAltPressed(false);
    };
    const handleWindowBlur = (): void => {
      setIsAltPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // 页面生命周期：Canvas 视觉渲染 + TextLayer 构建
  useEffect(() => {
    let isCancelled = false;
    let activePage: PDFPageProxy | null = null;
    let activeRenderTask: RenderTask | null = null;
    let activeTextLayer: InstanceType<typeof pdfjsLib.TextLayer> | null = null;

    setIsRendering(true);

    async function renderPageSandwich(): Promise<void> {
      try {
        const page = await pdf.getPage(pageNumber);
        if (isCancelled) {
          page.cleanup();
          return;
        }
        activePage = page;

        const viewport = page.getViewport({ scale });
        currentViewportRef.current = viewport;
        const pixelRatio = window.devicePixelRatio || 1;
        const widthPx = Math.floor(viewport.width);
        const heightPx = Math.floor(viewport.height);

        setPageSize({ width: widthPx, height: heightPx });

        const canvas = canvasRef.current;
        if (!canvas || isCancelled) return;

        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${widthPx}px`;
        canvas.style.height = `${heightPx}px`;

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx || isCancelled) return;

        const transform = pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined;

        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform,
        });
        activeRenderTask = renderTask;

        await renderTask.promise;
        if (isCancelled) return;

        // 中层 TextLayer
        const textLayerContainer = textLayerRef.current;
        if (!textLayerContainer || isCancelled) return;

        textLayerContainer.innerHTML = "";
        textLayerContainer.style.width = `${widthPx}px`;
        textLayerContainer.style.height = `${heightPx}px`;
        textLayerContainer.style.setProperty("--scale-factor", `${viewport.scale}`);
        textLayerContainer.style.setProperty("--total-scale-factor", `${viewport.scale}`);
        textLayerContainer.style.setProperty("--scale-round-x", "1px");
        textLayerContainer.style.setProperty("--scale-round-y", "1px");

        const textContent = await page.getTextContent();
        if (isCancelled) return;

        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        activeTextLayer = textLayer;

        await textLayer.render();

        if (!isCancelled) {
          setIsRendering(false);
          if (onPageRendered) {
            onPageRendered(pageNumber, widthPx, heightPx, viewport);
          }
        }
      } catch (err: unknown) {
        if (isCancelled) return;
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err.name === "RenderingCancelledException" || err.name === "AbortException")
        ) {
          return;
        }
        console.warn(`[PDFPage] 第 ${pageNumber} 页渲染失败:`, err);
      }
    }

    void renderPageSandwich();

    return () => {
      isCancelled = true;
      if (activeRenderTask) {
        try {
          activeRenderTask.cancel();
        } catch {
          // ignore
        }
      }
      if (activeTextLayer) {
        try {
          activeTextLayer.cancel();
        } catch {
          // ignore
        }
      }
      if (activePage) {
        try {
          activePage.cleanup();
        } catch {
          // ignore
        }
      }
    };
  }, [pdf, pageNumber, scale, onPageRendered]);

  /**
   * 精准 Canvas 裁剪与 PDF 原始坐标转换
   */
  const cropCanvasRegion = (left: number, top: number, width: number, height: number): void => {
    const canvas = canvasRef.current;
    const viewport = currentViewportRef.current;
    if (!canvas || !viewport) return;

    const currentWidthPx = pageSize ? pageSize.width : estimatedWidth;
    const currentHeightPx = pageSize ? pageSize.height : estimatedHeight;

    const scaleX = canvas.width / (currentWidthPx || canvas.clientWidth || 1);
    const scaleY = canvas.height / (currentHeightPx || canvas.clientHeight || 1);

    const sx = Math.max(0, Math.min(canvas.width, Math.round(left * scaleX)));
    const sy = Math.max(0, Math.min(canvas.height, Math.round(top * scaleY)));
    const sWidth = Math.max(1, Math.min(canvas.width - sx, Math.round(width * scaleX)));
    const sHeight = Math.max(1, Math.min(canvas.height - sy, Math.round(height * scaleY)));

    if (sWidth <= 0 || sHeight <= 0) return;

    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = sWidth;
    offscreenCanvas.height = sHeight;
    const offCtx = offscreenCanvas.getContext("2d");
    if (!offCtx) return;

    offCtx.drawImage(canvas, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);
    const imageBase64 = offscreenCanvas.toDataURL("image/jpeg", 0.9);

    // 将选区 CSS 物理边界映射为 72 DPI PDF 原始几何坐标
    const [pX1, pY1] = viewport.convertToPdfPoint(left, top);
    const [pX2, pY2] = viewport.convertToPdfPoint(left + width, top + height);
    const pdfRect: [number, number, number, number] = [
      Math.min(pX1, pX2),
      Math.min(pY1, pY2),
      Math.max(pX1, pX2),
      Math.max(pY1, pY2),
    ];

    setSelectedBox({ left, top, width, height });

    if (onCropCompleted) {
      onCropCompleted({
        imageBase64,
        pageNumber,
        pdfRect,
        cssRect: { left, top, width, height },
      });
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (selectedBox) {
      setSelectedBox(null);
    }

    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();

      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();

      const rect = sandwichRef.current?.getBoundingClientRect();
      if (!rect) return;

      const startX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const startY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

      setStartPoint({ x: startX, y: startY });
      setCurrentPoint({ x: startX, y: startY });
      setIsSelecting(true);
      setSelectedBox(null);

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isSelecting || !startPoint) return;
    e.preventDefault();

    const rect = sandwichRef.current?.getBoundingClientRect();
    if (!rect) return;

    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    setCurrentPoint({ x: curX, y: curY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isSelecting || !startPoint || !currentPoint) {
      setIsSelecting(false);
      return;
    }

    setIsSelecting(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const left = Math.min(startPoint.x, currentPoint.x);
    const top = Math.min(startPoint.y, currentPoint.y);
    const width = Math.abs(currentPoint.x - startPoint.x);
    const height = Math.abs(currentPoint.y - startPoint.y);

    if (width < 12 || height < 12) {
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    cropCanvasRegion(left, top, width, height);
    setStartPoint(null);
    setCurrentPoint(null);
  };

  const handlePointerCancel = (): void => {
    setIsSelecting(false);
    setStartPoint(null);
    setCurrentPoint(null);
  };

  const currentWidth = pageSize ? pageSize.width : estimatedWidth;
  const currentHeight = pageSize ? pageSize.height : estimatedHeight;
  const viewport = currentViewportRef.current;

  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 若当前正在划词或已选中文字，绝不触发锚点点击，确保原生文字选择完整丝滑
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      return;
    }
    if (isSelecting) return;

    const sandwich = sandwichRef.current;
    const viewport = currentViewportRef.current;
    if (!sandwich || !viewport) return;

    const rect = sandwich.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // 命中检测：收集点击坐标命中的所有当前有效版本锚点，支持重叠来源循环切换激活
    const hitAnchorIds: string[] = [];
    for (const anc of anchors || []) {
      if (documentRevision && anc.document_revision && anc.document_revision !== documentRevision) {
        continue;
      }
      if (anc.source_type === "pdf_text") {
        try {
          const loc = JSON.parse(anc.location_json);
          const seg = (loc.segments || []).find((s: PDFTextSegment) => s.pageNumber === pageNumber);
          if (seg) {
            for (const r of seg.rects) {
              const [vx1, vy1] = viewport.convertToViewportPoint(r[0], r[1]);
              const [vx2, vy2] = viewport.convertToViewportPoint(r[2], r[3]);
              const minX = Math.min(vx1, vx2);
              const maxX = Math.max(vx1, vx2);
              const minY = Math.min(vy1, vy2);
              const maxY = Math.max(vy1, vy2);
              if (clickX >= minX && clickX <= maxX && clickY >= minY && clickY <= maxY) {
                if (!hitAnchorIds.includes(anc.anchor_id)) {
                  hitAnchorIds.push(anc.anchor_id);
                }
                break;
              }
            }
          }
        } catch {}
      } else if (anc.source_type === "pdf_image") {
        try {
          const loc = JSON.parse(anc.location_json);
          const imgLoc = loc.location || loc;
          if (imgLoc.pageNumber === pageNumber) {
            const [vx1, vy1] = viewport.convertToViewportPoint(imgLoc.rect[0], imgLoc.rect[1]);
            const [vx2, vy2] = viewport.convertToViewportPoint(imgLoc.rect[2], imgLoc.rect[3]);
            const minX = Math.min(vx1, vx2);
            const maxX = Math.max(vx1, vx2);
            const minY = Math.min(vy1, vy2);
            const maxY = Math.max(vy1, vy2);
            if (clickX >= minX && clickX <= maxX && clickY >= minY && clickY <= maxY) {
              if (!hitAnchorIds.includes(anc.anchor_id)) {
                hitAnchorIds.push(anc.anchor_id);
              }
            }
          }
        } catch {}
      }
    }

    if (hitAnchorIds.length > 0) {
      const activeIdx = hitAnchorIds.indexOf(activeAnchorId || "");
      const nextIdx = activeIdx >= 0 ? (activeIdx + 1) % hitAnchorIds.length : 0;
      onSelectAnchor?.(hitAnchorIds[nextIdx]);
    }
  };

  return (
    <article
      className="pdf-page-card"
      style={{
        width: `${currentWidth}px`,
        height: `${currentHeight}px`,
      }}
      data-page-number={pageNumber}
    >
      <div className="pdf-page-number-indicator">
        <span>P. {pageNumber}</span>
      </div>

      <div
        ref={sandwichRef}
        className={`pdf-page-sandwich ${isAltPressed || isSelecting ? "alt-mode" : ""}`}
        style={{
          width: `${currentWidth}px`,
          height: `${currentHeight}px`,
          position: "relative",
        }}
        onClick={handlePageClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {/* 底层：Canvas 视觉层 */}
        <div className="canvasWrapper">
          <canvas ref={canvasRef} className="pdf-page-canvas" />
        </div>

        {/* 中层：TextLayer DOM 原生文本层 */}
        <div ref={textLayerRef} className="textLayer" />

        {/* 持久化高亮与来源区域渲染层 (非拦截覆盖层 pointer-events: none) */}
        {viewport && (
          <div
            className="pdf-page-highlights-overlay"
            style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}
          >
            {anchors?.map((anc) => {
              // 版本不一致时不绘制旧锚点
              if (documentRevision && anc.document_revision && anc.document_revision !== documentRevision) {
                return null;
              }

              if (anc.source_type === "pdf_text") {
                try {
                  const loc = JSON.parse(anc.location_json);
                  const segments: PDFTextSegment[] = loc.segments || [];
                  const pageSeg = segments.find((s) => s.pageNumber === pageNumber);
                  if (!pageSeg) return null;

                  return pageSeg.rects.map((r, rIdx) => {
                    const [vx1, vy1] = viewport.convertToViewportPoint(r[0], r[1]);
                    const [vx2, vy2] = viewport.convertToViewportPoint(r[2], r[3]);
                    const hlLeft = Math.min(vx1, vx2);
                    const hlTop = Math.min(vy1, vy2);
                    const hlW = Math.abs(vx1 - vx2);
                    const hlH = Math.abs(vy1 - vy2);
                    const isActive = anc.anchor_id === activeAnchorId;
                    const matchingHl = highlights?.find((h) => h.anchor_id === anc.anchor_id);
                    const color = matchingHl?.color || "rgba(230, 200, 70, 0.35)";

                    return (
                      <div
                        key={`${anc.anchor_id}_${rIdx}`}
                        data-anchor-id={anc.anchor_id}
                        className={`pdf-text-highlight-rect ${isActive ? "is-active" : ""}`}
                        style={{
                          position: "absolute",
                          left: `${hlLeft}px`,
                          top: `${hlTop}px`,
                          width: `${hlW}px`,
                          height: `${hlH}px`,
                          backgroundColor: color,
                          pointerEvents: "none",
                          borderRadius: "2px",
                          borderBottom: isActive ? "2px solid var(--pen, #e8664a)" : "none",
                        }}
                      />
                    );
                  });
                } catch {
                  return null;
                }
              } else if (anc.source_type === "pdf_image") {
                try {
                  const loc = JSON.parse(anc.location_json);
                  const imgLoc: PDFImageLocation = loc.location || loc;
                  if (imgLoc.pageNumber !== pageNumber) return null;

                  const [vx1, vy1] = viewport.convertToViewportPoint(imgLoc.rect[0], imgLoc.rect[1]);
                  const [vx2, vy2] = viewport.convertToViewportPoint(imgLoc.rect[2], imgLoc.rect[3]);
                  const bLeft = Math.min(vx1, vx2);
                  const bTop = Math.min(vy1, vy2);
                  const bW = Math.abs(vx1 - vx2);
                  const bH = Math.abs(vy1 - vy2);
                  const isActive = anc.anchor_id === activeAnchorId;

                  return (
                    <div
                      key={anc.anchor_id}
                      data-anchor-id={anc.anchor_id}
                      className={`pdf-image-anchor-box ${isActive ? "is-active" : ""}`}
                      style={{
                        position: "absolute",
                        left: `${bLeft}px`,
                        top: `${bTop}px`,
                        width: `${bW}px`,
                        height: `${bH}px`,
                        border: `2px dashed ${isActive ? "var(--pen, #e8664a)" : "rgba(232, 102, 74, 0.5)"}`,
                        backgroundColor: isActive
                          ? "rgba(232, 102, 74, 0.12)"
                          : "rgba(232, 102, 74, 0.05)",
                        pointerEvents: "none",
                        borderRadius: "4px",
                      }}
                    />
                  );
                } catch {
                  return null;
                }
              }
              return null;
            })}
          </div>
        )}

        {/* 顶层：实时拖拽选区虚线框 */}
        {isSelecting && startPoint && currentPoint && (() => {
          const liveLeft = Math.min(startPoint.x, currentPoint.x);
          const liveTop = Math.min(startPoint.y, currentPoint.y);
          const liveWidth = Math.abs(currentPoint.x - startPoint.x);
          const liveHeight = Math.abs(currentPoint.y - startPoint.y);

          return (
            <div
              className="selection-box"
              style={{
                left: `${liveLeft}px`,
                top: `${liveTop}px`,
                width: `${liveWidth}px`,
                height: `${liveHeight}px`,
              }}
            >
              <span className="selection-box-dim">{`${Math.round(liveWidth)} × ${Math.round(liveHeight)}`}</span>
            </div>
          );
        })()}

        {/* 选定静态框选区域 */}
        {selectedBox && !isSelecting && (
          <div
            className="selection-box"
            style={{
              left: `${selectedBox.left}px`,
              top: `${selectedBox.top}px`,
              width: `${selectedBox.width}px`,
              height: `${selectedBox.height}px`,
            }}
          >
            <span className="selection-box-dim">{`${Math.round(selectedBox.width)} × ${Math.round(selectedBox.height)}`}</span>
          </div>
        )}
      </div>

      {isRendering && (
        <div className="pdf-page-skeleton">
          <span className="pdf-skeleton-pulse" />
        </div>
      )}
    </article>
  );
}
