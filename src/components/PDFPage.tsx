import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { SelectionData } from "./AIPanel";

export interface PDFPageProps {
  /** PDF.js 文档代理对象 */
  pdf: PDFDocumentProxy;
  /** 页码（1-based） */
  pageNumber: number;
  /** 缩放比例 */
  scale: number;
  /** 页面渲染完成并获取精准宽高后的回调 */
  onPageRendered?: (pageNumber: number, width: number, height: number) => void;
  /** 框选图片或指令选择后的回调通知 */
  onSelect?: (data: SelectionData) => void;
}

/**
 * PDFPage: 单页“三明治架构”渲染与多模态区域框选组件
 *
 * 架构层次：
 * 1. 底层视觉 (Canvas)：page.render() 绘制高清位图与矢量视觉层
 * 2. 中层交互 (TextLayer)：DOM 文本层，绝对对齐 Canvas，字体透明、支持原生精准划词
 * 3. 顶层框选遮罩：按住 Alt 拖拽生成虚线选区框，精准裁切底层 Canvas 像素生成 Base64 发往视觉大模型
 * 4. 严格的内存生命周期：页面 unmount 时主动取消正在运行的任务并调用 page.cleanup()
 */
export default function PDFPage({
  pdf,
  pageNumber,
  scale,
  onPageRendered,
  onSelect,
}: PDFPageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const sandwichRef = useRef<HTMLDivElement | null>(null);

  // 记录实际页面尺寸（像素）
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [isRendering, setIsRendering] = useState<boolean>(true);

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
  const [pendingImageBase64, setPendingImageBase64] = useState<string | null>(null);
  const [customImagePrompt, setCustomImagePrompt] = useState<string>("");
  const [isAltPressed, setIsAltPressed] = useState<boolean>(false);

  // 估算标准 A4 宽高（72 DPI 下默认 595 x 842 磅），未就绪时作为骨架占位
  const estimatedWidth = Math.floor(595 * scale);
  const estimatedHeight = Math.floor(842 * scale);

  // 监听全局 Alt 键状态，用于光标样式与交互提示
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Alt") {
        setIsAltPressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent): void => {
      if (e.key === "Alt") {
        setIsAltPressed(false);
      }
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
        // 1. 获取目标页 Proxy
        const page = await pdf.getPage(pageNumber);
        if (isCancelled) {
          page.cleanup();
          return;
        }
        activePage = page;

        // 2. 计算视口尺寸与高分屏倍率
        const viewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
        const widthPx = Math.floor(viewport.width);
        const heightPx = Math.floor(viewport.height);

        setPageSize({ width: widthPx, height: heightPx });

        // 3. 底层 Canvas 视觉渲染
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

        // 4. 中层 TextLayer 交互文本层构建与对齐
        const textLayerContainer = textLayerRef.current;
        if (!textLayerContainer || isCancelled) return;

        // 清空旧文本节点
        textLayerContainer.innerHTML = "";
        textLayerContainer.style.width = `${widthPx}px`;
        textLayerContainer.style.height = `${heightPx}px`;

        // 注入 PDF.js 核心缩放变量以实现严格几何坐标对齐
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
            onPageRendered(pageNumber, widthPx, heightPx);
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

    // 关键生命周期：unmount 时彻底释放内存与不可见位图
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
   * 精准 Canvas 裁剪算法：
   * 将选区 CSS 物理边界映射到底层高清 Canvas 位图像素并生成 Base64 JPEG
   */
  const cropCanvasRegion = (left: number, top: number, width: number, height: number): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const currentWidthPx = pageSize ? pageSize.width : estimatedWidth;
    const currentHeightPx = pageSize ? pageSize.height : estimatedHeight;

    // 像素补偿倍率：底层高清 Canvas 物理像素与显示 CSS 像素之比
    const scaleX = canvas.width / (currentWidthPx || canvas.clientWidth || 1);
    const scaleY = canvas.height / (currentHeightPx || canvas.clientHeight || 1);

    const sx = Math.max(0, Math.min(canvas.width, Math.round(left * scaleX)));
    const sy = Math.max(0, Math.min(canvas.height, Math.round(top * scaleY)));
    const sWidth = Math.max(1, Math.min(canvas.width - sx, Math.round(width * scaleX)));
    const sHeight = Math.max(1, Math.min(canvas.height - sy, Math.round(height * scaleY)));

    if (sWidth <= 0 || sHeight <= 0) return;

    // 创建离屏 Canvas，尺寸直接采用物理高清裁剪尺寸，保证 Vision AI 识别 100% 锐利
    const offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = sWidth;
    offscreenCanvas.height = sHeight;
    const offCtx = offscreenCanvas.getContext("2d");
    if (!offCtx) return;

    // 扣取目标区域
    offCtx.drawImage(
      canvas,
      sx,
      sy,
      sWidth,
      sHeight,
      0,
      0,
      sWidth,
      sHeight
    );

    const imageBase64 = offscreenCanvas.toDataURL("image/jpeg", 0.9);
    setSelectedBox({ left, top, width, height });
    setPendingImageBase64(imageBase64);
  };

  /**
   * PointerDown: 捕获 Alt + 鼠标拖拽框选
   */
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    // 如果已有选区菜单且点击在外部，清空选区
    if (selectedBox && !target.closest(".image-selection-toolbar")) {
      setSelectedBox(null);
      setPendingImageBase64(null);
      setCustomImagePrompt("");
    }

    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();

      // 阻止原生文字划选
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
      }

      const rect = sandwichRef.current?.getBoundingClientRect();
      if (!rect) return;

      const startX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const startY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

      setStartPoint({ x: startX, y: startY });
      setCurrentPoint({ x: startX, y: startY });
      setIsSelecting(true);
      setSelectedBox(null);
      setPendingImageBase64(null);
      setCustomImagePrompt("");

      // 锁定指针捕获，防止光标快速划出边缘时丢失跟踪
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  };

  /**
   * PointerMove: 实时更新框选矩形
   */
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!isSelecting || !startPoint) return;
    e.preventDefault();

    const rect = sandwichRef.current?.getBoundingClientRect();
    if (!rect) return;

    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    setCurrentPoint({ x: curX, y: curY });
  };

  /**
   * PointerUp: 结束拖拽，生成图像切片
   */
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

    // 过滤极小误触 (< 12px)
    if (width < 12 || height < 12) {
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    cropCanvasRegion(left, top, width, height);
    setStartPoint(null);
    setCurrentPoint(null);
  };

  /**
   * PointerCancel: 取消拖拽
   */
  const handlePointerCancel = (): void => {
    setIsSelecting(false);
    setStartPoint(null);
    setCurrentPoint(null);
  };

  /**
   * 悬浮菜单动作触发
   */
  const handleImageAction = (action: string, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();

    if (pendingImageBase64 && onSelect) {
      onSelect({
        type: "image",
        imageBase64: pendingImageBase64,
        action,
      });
    }

    setSelectedBox(null);
    setPendingImageBase64(null);
  };

  /**
   * 手动关闭选区框
   */
  const handleClearBox = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedBox(null);
    setPendingImageBase64(null);
    setCustomImagePrompt("");
  };

  const currentWidth = pageSize ? pageSize.width : estimatedWidth;
  const currentHeight = pageSize ? pageSize.height : estimatedHeight;

  return (
    <article
      className="pdf-page-card"
      style={{
        width: `${currentWidth}px`,
        height: `${currentHeight}px`,
      }}
      data-page-number={pageNumber}
    >
      {/* 悬浮页码标识 */}
      <div className="pdf-page-number-indicator">
        <span>P. {pageNumber}</span>
      </div>

      {/* 三明治架构容器：底层 Canvas + 中层 TextLayer + 顶层框选遮罩 */}
      <div
        ref={sandwichRef}
        className={`pdf-page-sandwich ${isAltPressed || isSelecting ? "alt-mode" : ""}`}
        style={{
          width: `${currentWidth}px`,
          height: `${currentHeight}px`,
          position: "relative",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {/* 底层：Canvas 视觉层 */}
        <div className="canvasWrapper">
          <canvas ref={canvasRef} className="pdf-page-canvas" />
        </div>

        {/* 中层：TextLayer DOM 原生文本层（透明字体 + 几何对齐） */}
        <div ref={textLayerRef} className="textLayer" />

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

        {/* 选定静态选区虚线框 */}
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

        {/* 选区浮动菜单 (Image Selection Toolbar) - 带自定义输入层与极简规范 */}
        {selectedBox && pendingImageBase64 && (
          <div
            className="image-selection-toolbar"
            style={{
              top: `${
                selectedBox.top + selectedBox.height + 44 > currentHeight
                  ? Math.max(8, selectedBox.top - 46)
                  : selectedBox.top + selectedBox.height + 10
              }px`,
              left: `${selectedBox.left + selectedBox.width / 2}px`,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* 正上方 100% 宽度极简自定义指令输入框 */}
            <div className="toolbar-input-wrapper">
              <input
                type="text"
                className="toolbar-custom-input"
                placeholder="输入图像分析指令并回车..."
                value={customImagePrompt}
                onChange={(e) => setCustomImagePrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customImagePrompt.trim()) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (pendingImageBase64 && onSelect) {
                      onSelect({
                        type: "image",
                        imageBase64: pendingImageBase64,
                        action: "custom",
                        customPrompt: customImagePrompt.trim(),
                      });
                    }
                    setCustomImagePrompt("");
                    setSelectedBox(null);
                    setPendingImageBase64(null);
                  }
                }}
                autoFocus
              />
            </div>

            {/* 下方等宽快捷按钮 */}
            <div className="toolbar-buttons-row">
              <button
                type="button"
                className="image-toolbar-btn"
                onClick={(e) => handleImageAction("analyze-chart", e)}
                title="解析图表、电路拓扑与架构"
              >
                <span>解析图表</span>
              </button>
              <button
                type="button"
                className="image-toolbar-btn"
                onClick={(e) => handleImageAction("extract-formula", e)}
                title="精准提取公式为标准 LaTeX"
              >
                <span>提取公式</span>
              </button>
              <button
                type="button"
                className="image-toolbar-close-btn"
                onClick={handleClearBox}
                title="取消选区"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 渲染未完成时的平滑骨架提示 */}
      {isRendering && (
        <div className="pdf-page-skeleton">
          <span className="pdf-skeleton-pulse" />
        </div>
      )}
    </article>
  );
}
