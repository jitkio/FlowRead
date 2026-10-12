import React, { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { open } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createTauriPDFTransport, TauriPDFDataRangeTransport } from "../utils/pdfTransport";
import PDFPage from "./PDFPage";
import { SelectionData, SelectionAction } from "./AIPanel";
import "./PDFReaderArea.css";

// 注册官方 PDF.js Worker 资源路径
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface PDFDocumentStats {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  totalPages: number;
  loadDurationMs: number;
}

export interface PDFReaderAreaProps {
  /** 外部传入的文件绝对路径（可选） */
  filePath?: string | null;
  /** 受控缩放比例（可选） */
  scale?: number;
  /** 缩放变更回调（可选） */
  onScaleChange?: (scale: number | ((prev: number) => number)) => void;
  /** 文档加载统计变更回调（可选） */
  onStatsChange?: (stats: PDFDocumentStats | null) => void;
  /** 加载状态变更回调（可选） */
  onLoadingChange?: (loading: boolean, message: string) => void;
  /** 异常信息回调（可选） */
  onErrorChange?: (error: string | null) => void;
  /** 关闭或切换阅读模式的回调 */
  onClose?: () => void;
  /** 划词并选择指令后的回调函数，向上传递选中的纯文本与指令 */
  onSelect?: (data: SelectionData) => void;
}

export default function PDFReaderArea({
  filePath: propFilePath,
  scale: propScale,
  onScaleChange: _onScaleChange,
  onStatsChange,
  onLoadingChange,
  onErrorChange,
  onClose: _onClose,
  onSelect,
}: PDFReaderAreaProps): React.JSX.Element {
  // 当前文档与加载状态
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [stats, setStats] = useState<PDFDocumentStats | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("请选择本地 PDF 文件进行极简流式阅读");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 缩放比例状态（若外部传入则受控，默认 1.35x 高清视角）
  const scale = propScale !== undefined ? propScale : 1.35;

  useEffect(() => {
    onStatsChange?.(stats);
  }, [stats, onStatsChange]);

  useEffect(() => {
    onLoadingChange?.(isLoading, statusMessage);
  }, [isLoading, statusMessage, onLoadingChange]);

  useEffect(() => {
    onErrorChange?.(errorMessage);
  }, [errorMessage, onErrorChange]);

  // 划词悬浮菜单坐标与当前暂存文本
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [currentSelectedText, setCurrentSelectedText] = useState<string>("");
  const [customPrompt, setCustomPrompt] = useState<string>("");

  // 滑块拖拽状态
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // 滚动容器与物理引擎 Ref
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  // 动力学平滑滚动的核心状态变量 (Kinetic Lerp Engine)
  const targetYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const isLerpRunningRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  // 文档级资源引用
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const transportRef = useRef<TauriPDFDataRangeTransport | null>(null);
  const loadSequenceIdRef = useRef<number>(0);

  // 单页测量高度缓存 (1-based pageNumber -> total height in px)
  const pageHeightsRef = useRef<Map<number, number>>(new Map());

  /**
   * 彻底清理上一个 PDF 文档的所有异步任务与资源
   */
  const cleanupCurrentDocument = useCallback(async (): Promise<void> => {
    // 1. 销毁自定义数据流 Transport
    if (transportRef.current) {
      transportRef.current.destroy();
      transportRef.current = null;
    }

    // 2. 销毁当前 LoadingTask 与底层 Worker 通道
    if (loadingTaskRef.current) {
      try {
        await loadingTaskRef.current.destroy();
      } catch (err) {
        console.warn("[PDFReaderArea] 销毁 loadingTask 异常:", err);
      }
      loadingTaskRef.current = null;
    }

    setPdfDoc(null);
    setStats(null);
    pageHeightsRef.current.clear();
  }, []);

  /**
   * 虚拟滚动高度预估：根据 scale 动态估算标准比例页面高度
   */
  const estimateSize = useCallback(
    (index: number): number => {
      const pageNum = index + 1;
      const cached = pageHeightsRef.current.get(pageNum);
      if (cached) return cached;
      // 预估标准 A4 页面高度 (842 * scale) 加上 32px 的下边距
      return Math.floor(842 * scale) + 32;
    },
    [scale]
  );

  /**
   * 初始化页面级虚拟滚动 virtualizer
   */
  const virtualizer = useVirtualizer({
    count: stats?.totalPages || 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: 2, // 视口外缓冲 2 页，保证秒开与低内存预算的黄金平衡
  });

  const totalContentSize = virtualizer.getTotalSize();

  /**
   * 子组件单页真实尺寸就绪后的回调，通知虚拟滚动动态修正
   */
  const handlePageRendered = useCallback(
    (pageNumber: number, _width: number, height: number): void => {
      const itemHeight = height + 32;
      const prev = pageHeightsRef.current.get(pageNumber);
      if (prev !== itemHeight) {
        pageHeightsRef.current.set(pageNumber, itemHeight);
        virtualizer.measure();
      }
    },
    [virtualizer]
  );

  /**
   * 更新自定义滚动条滑块位置与高度
   */
  const updateThumbPosition = useCallback((): void => {
    const thumb = thumbRef.current;
    const container = scrollContainerRef.current;
    if (!thumb || !container) return;

    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);

    if (maxScroll <= 0) {
      thumb.style.display = "none";
      return;
    }

    thumb.style.display = "block";
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);
    const progress = currentYRef.current / maxScroll;
    const thumbTop = Math.max(0, Math.min(trackTravel, progress * trackTravel));

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, [totalContentSize]);

  /**
   * 动力学平滑滚动 (Kinetic Lerp Scrolling) 核心循环
   * 线性插值公式：currentY += (targetY - currentY) * 0.12
   */
  const startLerpLoop = useCallback((): void => {
    if (isLerpRunningRef.current) return;
    isLerpRunningRef.current = true;

    const tick = (): void => {
      const diff = targetYRef.current - currentYRef.current;

      if (Math.abs(diff) < 0.5) {
        currentYRef.current = targetYRef.current;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = currentYRef.current;
        }
        updateThumbPosition();
        isLerpRunningRef.current = false;
        rafIdRef.current = null;
        return;
      }

      currentYRef.current += diff * 0.12;

      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = currentYRef.current;
      }

      updateThumbPosition();
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, [updateThumbPosition]);

  // 组件卸载时释放 rAF
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // 尺寸变动时校验位移并重新映射
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const maxScroll = Math.max(0, totalContentSize - container.clientHeight);
    targetYRef.current = Math.min(targetYRef.current, maxScroll);
    currentYRef.current = Math.min(currentYRef.current, maxScroll);
    updateThumbPosition();
  }, [totalContentSize, updateThumbPosition]);

  /**
   * 拦截原生鼠标滚轮事件 (wheel)，累加进 targetYRef 驱动动力学平滑滚动
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const cHeight = container.clientHeight;
      const maxScroll = Math.max(0, totalContentSize - cHeight);

      targetYRef.current = Math.max(
        0,
        Math.min(maxScroll, targetYRef.current + e.deltaY)
      );

      startLerpLoop();
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, [totalContentSize, startLerpLoop]);

  /**
   * 自定义滑块拖拽事件处理
   */
  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();

    const container = scrollContainerRef.current;
    if (!container) return;

    const startClientY = e.clientY;
    const startTarget = targetYRef.current;
    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);

    setIsDragging(true);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const deltaY = moveEvent.clientY - startClientY;
      const scrollDelta = (deltaY / trackTravel) * maxScroll;

      targetYRef.current = Math.max(
        0,
        Math.min(maxScroll, startTarget + scrollDelta)
      );

      startLerpLoop();
    };

    const onPointerUp = (): void => {
      setIsDragging(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  /**
   * 点击滚动槽空白区域：平滑快进至点击位置
   */
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    const container = scrollContainerRef.current;
    if (!track || !container) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);

    const targetPercent = Math.max(
      0,
      Math.min(1, (clickY - thumbHeight / 2) / trackTravel)
    );
    targetYRef.current = targetPercent * maxScroll;
    startLerpLoop();
  };

  /**
   * 加载指定路径的 PDF 文件
   */
  const loadPdfDocument = useCallback(
    async (targetPath: string): Promise<void> => {
      const sequenceId = ++loadSequenceIdRef.current;
      setIsLoading(true);
      setErrorMessage(null);
      setStatusMessage("正在建立 Tauri Range Request 分块流通信...");

      const startTime = performance.now();

      await cleanupCurrentDocument();

      if (sequenceId !== loadSequenceIdRef.current) {
        return;
      }

      try {
        // 1. 初始化自定义 Range Transport
        const transport = await createTauriPDFTransport(targetPath);
        transportRef.current = transport;

        if (sequenceId !== loadSequenceIdRef.current) {
          transport.destroy();
          return;
        }

        // 2. 调用原生 getDocument，按需拉取
        const loadingTask = pdfjsLib.getDocument({
          range: transport,
          disableAutoFetch: true,
          disableStream: true,
          cMapPacked: true,
        });
        loadingTaskRef.current = loadingTask;

        const doc = await loadingTask.promise;

        if (sequenceId !== loadSequenceIdRef.current) {
          await loadingTask.destroy();
          return;
        }

        setPdfDoc(doc);
        const endTime = performance.now();
        const duration = Math.round(endTime - startTime);

        const fileName = targetPath.split(/[/\\]/).pop() || "未知文件.pdf";
        setStats({
          filePath: targetPath,
          fileName,
          fileSizeBytes: transport.length,
          totalPages: doc.numPages,
          loadDurationMs: duration,
        });

        // 重置滚动位置
        targetYRef.current = 0;
        currentYRef.current = 0;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }

        setIsLoading(false);
        setStatusMessage(
          `首屏加载就绪！耗时: ${duration}ms，共 ${doc.numPages} 页，文件大小: ${(
            transport.length /
            (1024 * 1024)
          ).toFixed(2)} MB`
        );
      } catch (error) {
        if (sequenceId === loadSequenceIdRef.current) {
          console.error("[PDFReaderArea] PDF 加载失败:", error);
          setIsLoading(false);
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setStatusMessage("加载 PDF 文档失败");
        }
      }
    },
    [cleanupCurrentDocument]
  );

  // 当外部传入的 filePath 变化时触发加载
  useEffect(() => {
    if (propFilePath) {
      void loadPdfDocument(propFilePath);
    }
  }, [propFilePath, loadPdfDocument]);

  // 组件卸载时释放所有资源
  useEffect(() => {
    return () => {
      loadSequenceIdRef.current++;
      void cleanupCurrentDocument();
    };
  }, [cleanupCurrentDocument]);

  /**
   * 划选鼠标松开事件处理：
   * 捕获选区范围物理坐标，弹出悬浮指令菜单
   */
  const handleMouseUp = (): void => {
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setMenuPosition(null);
        return;
      }

      const text = selection.toString().trim();
      if (text.length === 0) {
        setMenuPosition(null);
        return;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          setCurrentSelectedText(text);
          setCustomPrompt("");

          // 坐标计算：悬浮在选区正上方（如果太接近顶部则降至选区下方展示）
          const showBelow = rect.top < 70;
          const top = showBelow ? rect.bottom + 12 : rect.top - 12;
          const left = rect.left + rect.width / 2;

          setMenuPosition({
            top,
            left,
          });
        }
      } catch (err) {
        console.error("[PDFReaderArea] 捕获选区边界异常:", err);
      }
    }, 10);
  };

  /**
   * 监听全局点击：点击非菜单区域自动隐藏悬浮菜单
   */
  const handleContainerMouseDown = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (!target.closest(".selection-toolbar")) {
      setMenuPosition(null);
    }
  };

  /**
   * 悬浮菜单按钮动作点击
   */
  const handleActionClick = (action: SelectionAction, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (currentSelectedText && onSelect) {
      onSelect({
        type: "text",
        text: currentSelectedText,
        action,
      });
    }
    setMenuPosition(null);
  };

  /**
   * 打开系统文件选择框选择本地 PDF 文件
   */
  const handleSelectLocalPdf = async (): Promise<void> => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF 文档 (*.pdf)", extensions: ["pdf"] }],
      });

      if (typeof selected === "string" && selected.length > 0) {
        await loadPdfDocument(selected);
      }
    } catch (err) {
      console.error("[PDFReaderArea] 调起文件选择器异常:", err);
    }
  };

  return (
    <main
      className="pdf-reader-container"
      onMouseUp={handleMouseUp}
      onMouseDown={handleContainerMouseDown}
    >
      {/* 动力学平滑滚动的虚拟滚动视口 */}
      <div className="pdf-scroll-viewport" ref={scrollContainerRef}>
        {stats && pdfDoc ? (
          <div
            className="pdf-virtual-stage"
            style={{
              height: `${totalContentSize}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const pageNum = virtualRow.index + 1;
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="pdf-virtual-row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    display: "flex",
                    justifyContent: "center",
                    paddingBottom: "32px",
                  }}
                >
                  <PDFPage
                    pdf={pdfDoc}
                    pageNumber={pageNum}
                    scale={scale}
                    onPageRendered={handlePageRendered}
                    onSelect={onSelect}
                  />
                </div>
              );
            })}
          </div>
        ) : !isLoading && !errorMessage ? (
          <div className="pdf-empty-placeholder">
            <div className="empty-card">
              <h2 className="empty-title">FlowRead PDF 多模态视觉流式引擎</h2>
              <p className="empty-desc">
                已进入【阶段三】：多模态区域框选 (Alt + 拖拽) + 视觉大模型 (Vision AI) + 页面级虚拟滚动 + 原生高保真划词。
                <br />
                支持 1000+ 页文档秒开与 60fps 动力学平滑滚动，随时 Alt+拖拽截取电路图、拓扑结构与公式交由 AI 解析。
              </p>
              <button
                type="button"
                className="pdf-btn pdf-btn-primary empty-action-btn"
                onClick={handleSelectLocalPdf}
              >
                立即打开 PDF 文件
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 自定义动力学平滑滚动条 */}
      <div
        className="custom-scrollbar-track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
      >
        <div
          ref={thumbRef}
          className={`custom-scrollbar-thumb ${isDragging ? "is-dragging" : ""}`}
          onPointerDown={handleThumbPointerDown}
        />
      </div>

      {/* 划词悬浮指令菜单 (Selection Toolbar) - 带自定义输入层 */}
      {menuPosition && (
        <div
          className="selection-toolbar"
          style={{
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 正上方 100% 宽度极简自定义指令输入框 */}
          <div className="toolbar-input-wrapper">
            <input
              type="text"
              className="toolbar-custom-input"
              placeholder="输入自定义指令并回车..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customPrompt.trim()) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (currentSelectedText && onSelect) {
                    onSelect({
                      type: "text",
                      text: currentSelectedText,
                      action: "custom",
                      customPrompt: customPrompt.trim(),
                    });
                  }
                  setCustomPrompt("");
                  setMenuPosition(null);
                }
              }}
              autoFocus
            />
          </div>

          {/* 下方等宽排列快捷按钮 */}
          <div className="toolbar-buttons-row">
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("translate", e)}
              title="翻译为流畅中文"
            >
              <span>翻译</span>
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("explain", e)}
              title="专业清晰解释核心机理"
            >
              <span>解释</span>
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleActionClick("extract-formula", e)}
              title="严格提取 LaTeX 数学公式"
            >
              <span>提取公式</span>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
