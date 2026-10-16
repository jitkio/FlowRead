import React, { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createTauriPDFTransport, TauriPDFDataRangeTransport } from "../utils/pdfTransport";
import PDFPage from "./PDFPage";
import SelectionToolbar from "./SelectionToolbar";
import {
  SourceAnchorRecord,
  HighlightRecord,
  SourceLocationData,
  PDFTextSegment,
  CardAction,
  CardDepth,
} from "../types/records";
import "./PDFReaderArea.css";

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
  filePath?: string | null;
  scale?: number;
  onScaleChange?: (scale: number | ((prev: number) => number)) => void;
  onStatsChange?: (stats: PDFDocumentStats | null) => void;
  onLoadingChange?: (loading: boolean, message: string) => void;
  onErrorChange?: (error: string | null) => void;
  onClose?: () => void;
  anchors?: SourceAnchorRecord[];
  highlights?: HighlightRecord[];
  activeAnchorId?: string | null;
  onSelectAnchor?: (anchorId: string) => void;
  onVisibleAnchorsChange?: (anchorIds: string[]) => void;
  onCreateAnchorAndCard?: (params: {
    location: SourceLocationData;
    excerpt: string;
    action: CardAction;
    customPrompt?: string;
    depth?: CardDepth;
    imageBase64?: string;
    boundDocId?: string;
    boundSeq?: number;
    boundRevision?: string;
  }) => void;
  onCreateHighlight?: (params: {
    location: SourceLocationData;
    excerpt: string;
    color: string;
    boundDocId?: string;
    boundSeq?: number;
    boundRevision?: string;
  }) => void;
  documentRevision?: string;
  documentId?: string;
  documentSeq?: number;
  jumpTarget?: PDFJumpTarget | null;
  onJumpComplete?: (requestId: string) => void;
}

export interface PDFJumpTarget {
  requestId?: string;
  pageNumber: number;
  anchorId?: string;
  timestamp: number;
  targetDocId?: string;
  openSeq?: number;
}

export default function PDFReaderArea({
  filePath: propFilePath,
  scale: propScale,
  onScaleChange: _onScaleChange,
  onStatsChange,
  onLoadingChange,
  onErrorChange,
  onClose: _onClose,
  anchors = [],
  highlights = [],
  activeAnchorId = null,
  onSelectAnchor,
  onVisibleAnchorsChange,
  onCreateAnchorAndCard,
  onCreateHighlight,
  jumpTarget,
  onJumpComplete,
  documentRevision,
  documentId,
  documentSeq,
}: PDFReaderAreaProps): React.JSX.Element {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [stats, setStats] = useState<PDFDocumentStats | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("请选择本地 PDF 文件进行极简流式阅读");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  // 工具栏与选区快照
  const [toolbarPosition, setToolbarPosition] = useState<{ top: number; left: number } | null>(null);
  const [toolbarSelectionType, setToolbarSelectionType] = useState<"text" | "image">("text");
  const [selectedText, setSelectedText] = useState<string>("");
  const selectionSnapshotRef = useRef<{
    location: SourceLocationData;
    excerpt: string;
    imageBase64?: string;
    boundPath: string | null;
    boundRevision: string | null;
    boundSeq: number;
    boundDocId: string | null;
  } | null>(null);

  const loadedDocIdentityRef = useRef<{
    path: string | null;
    revision: string | null;
    seq: number;
    docId: string | null;
  }>({
    path: null,
    revision: null,
    seq: 0,
    docId: null,
  });

  const activeLoadTaskRef = useRef<{
    path: string;
    seq?: number;
    revision?: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);

  const completedDocRef = useRef<{
    path: string;
    seq?: number;
    revision?: string;
    doc: PDFDocumentProxy;
    stats: PDFDocumentStats;
  } | null>(null);

  // 滑块拖拽状态
  const [isDragging, setIsDragging] = useState<boolean>(false);

  // 滚动容器与物理引擎 Ref
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const targetYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const isLerpRunningRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);

  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const transportRef = useRef<TauriPDFDataRangeTransport | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const loadSequenceIdRef = useRef<number>(0);

  const pageHeightsRef = useRef<Map<number, number>>(new Map());
  const viewportsMapRef = useRef<Map<number, PageViewport>>(new Map());
  const lastVisibleIdsRef = useRef<string[]>([]);
  const lastConsumedJumpRequestIdRef = useRef<string | null>(null);
  const activeJumpRequestIdRef = useRef<string | null>(null);
  const jumpPendingRafRef = useRef<number | null>(null);
  const jumpPendingTimeoutRef = useRef<any>(null);
  const activeHighlightedElRef = useRef<HTMLElement | null>(null);

  const cancelActiveJump = useCallback((_reason?: string) => {
    if (jumpPendingRafRef.current !== null) {
      cancelAnimationFrame(jumpPendingRafRef.current);
      jumpPendingRafRef.current = null;
    }
    if (jumpPendingTimeoutRef.current !== null) {
      clearTimeout(jumpPendingTimeoutRef.current);
      jumpPendingTimeoutRef.current = null;
    }
    if (activeHighlightedElRef.current) {
      activeHighlightedElRef.current.style.outline = "none";
      activeHighlightedElRef.current = null;
    }
    const currentReq = activeJumpRequestIdRef.current;
    if (currentReq) {
      activeJumpRequestIdRef.current = null;
      onJumpComplete?.(currentReq);
    }
  }, [onJumpComplete]);

  // 物理资源包定义
  interface DisposablePdfResources {
    transport: TauriPDFDataRangeTransport | null;
    loadingTask: PDFDocumentLoadingTask | null;
    doc: PDFDocumentProxy | null;
  }

  // 释放独立的物理资源包（纯异步执行，绝对不碰任何共享 ref 或 UI 状态）
  const disposePdfResources = async (resources: DisposablePdfResources): Promise<void> => {
    // 立即释放页面渲染缓存与 DOM 引用
    if (resources.doc) {
      try {
        resources.doc.cleanup();
      } catch {}
    }

    if (resources.transport) {
      try {
        resources.transport.destroy();
      } catch (err) {
        console.warn("[PDFReaderArea] 销毁 transport 异常:", err);
      }
    }

    if (resources.loadingTask) {
      try {
        await resources.loadingTask.destroy();
      } catch (err) {
        console.warn("[PDFReaderArea] 销毁 loadingTask 异常:", err);
      }
    }

    if (resources.doc) {
      try {
        await (resources.doc as any).destroy?.();
      } catch (err) {
        console.warn("[PDFReaderArea] 销毁 doc 异常:", err);
      }
    }
  };

  // 同步摘除当前所有物理资源并返回独立快照（立即清空所有共享 ref，使后续任何操作无法触及旧资源）
  const detachCurrentResources = (): DisposablePdfResources => {
    const transport = transportRef.current;
    transportRef.current = null;

    const loadingTask = loadingTaskRef.current;
    loadingTaskRef.current = null;

    const doc = completedDocRef.current?.doc || pdfDocRef.current || null;
    completedDocRef.current = null;
    activeLoadTaskRef.current = null;
    pdfDocRef.current = null;

    return { transport, loadingTask, doc };
  };

  const estimateSize = useCallback(
    (index: number): number => {
      const pageNum = index + 1;
      const cached = pageHeightsRef.current.get(pageNum);
      if (cached) return cached;
      return Math.floor(842 * scale) + 32;
    },
    [scale]
  );

  const virtualizer = useVirtualizer({
    count: stats?.totalPages || 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: 2,
  });

  const totalContentSize = virtualizer.getTotalSize();

  const handlePageRendered = useCallback(
    (pageNumber: number, _width: number, height: number, viewport: PageViewport): void => {
      viewportsMapRef.current.set(pageNumber, viewport);
      const itemHeight = height + 32;
      const prev = pageHeightsRef.current.get(pageNumber);
      if (prev !== itemHeight) {
        pageHeightsRef.current.set(pageNumber, itemHeight);
        virtualizer.measure();
      }
      window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));
      window.dispatchEvent(new CustomEvent("flowread:layout-updated"));
    },
    [virtualizer]
  );

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

  useEffect(() => {
    return () => {
      cancelActiveJump("unmount");
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [cancelActiveJump]);

  // 跨页跨行文字选区转换
  const handleMouseUp = (): void => {
    setTimeout(() => {
      if (isLoading) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        // 如果点击在工具栏内不清除
        return;
      }

      const text = selection.toString().trim();
      if (text.length === 0) {
        setToolbarPosition(null);
        return;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        if (rect.width > 0 && rect.height > 0) {
          const container = scrollContainerRef.current;
          if (!container) return;

          // 计算 PDF 原始几何坐标切片 (按页拆分四边形)
          const clientRects = Array.from(range.getClientRects());
          const segmentsMap = new Map<number, [number, number, number, number][]>();

          const pageCards = container.querySelectorAll<HTMLElement>(".pdf-page-card");
          pageCards.forEach((pageCard) => {
            const pageNum = parseInt(pageCard.dataset.pageNumber || "0", 10);
            const viewport = viewportsMapRef.current.get(pageNum);
            if (!viewport || !pageNum) return;
            const pageCardRect = pageCard.getBoundingClientRect();

            const pageRects: [number, number, number, number][] = [];
            for (const cr of clientRects) {
              const ix1 = Math.max(cr.left, pageCardRect.left);
              const iy1 = Math.max(cr.top, pageCardRect.top);
              const ix2 = Math.min(cr.right, pageCardRect.right);
              const iy2 = Math.min(cr.bottom, pageCardRect.bottom);
              if (ix2 - ix1 > 2 && iy2 - iy1 > 2) {
                const vx1 = ix1 - pageCardRect.left;
                const vy1 = iy1 - pageCardRect.top;
                const vx2 = ix2 - pageCardRect.left;
                const vy2 = iy2 - pageCardRect.top;
                const [px1, py1] = viewport.convertToPdfPoint(vx1, vy1);
                const [px2, py2] = viewport.convertToPdfPoint(vx2, vy2);
                pageRects.push([
                  Math.min(px1, px2),
                  Math.min(py1, py2),
                  Math.max(px1, px2),
                  Math.max(py1, py2),
                ]);
              }
            }
            if (pageRects.length > 0) {
              segmentsMap.set(pageNum, pageRects);
            }
          });

          const segments: PDFTextSegment[] = [];
          segmentsMap.forEach((rects, pNum) => {
            segments.push({ pageNumber: pNum, rects });
          });

          const currentIdentity = loadedDocIdentityRef.current;
          if (!currentIdentity.path || currentIdentity.path !== propFilePath) return;
          if (documentSeq !== undefined && currentIdentity.seq !== documentSeq) return;
          if (documentRevision && currentIdentity.revision && currentIdentity.revision !== documentRevision) return;

          // 在 Ask 输入框聚焦前立即锁定稳定选区快照
          selectionSnapshotRef.current = {
            location: { type: "pdf_text", segments },
            excerpt: text,
            boundPath: currentIdentity.path,
            boundRevision: currentIdentity.revision,
            boundSeq: currentIdentity.seq,
            boundDocId: currentIdentity.docId,
          };

          setSelectedText(text);
          setToolbarSelectionType("text");
          const top = rect.top < 70 ? rect.bottom + 12 : rect.top - 12;
          const left = rect.left + rect.width / 2;
          setToolbarPosition({ top, left });
        }
      } catch (err) {
        console.error("[PDFReaderArea] 捕获选区边界异常:", err);
      }
    }, 20);
  };

  // 图像裁剪完成
  const handleCropCompleted = (cropData: {
    imageBase64: string;
    pageNumber: number;
    pdfRect: [number, number, number, number];
    cssRect: { left: number; top: number; width: number; height: number };
  }) => {
    const currentIdentity = loadedDocIdentityRef.current;
    if (!currentIdentity.path || currentIdentity.path !== propFilePath) return;
    if (documentSeq !== undefined && currentIdentity.seq !== documentSeq) return;
    if (documentRevision && currentIdentity.revision && currentIdentity.revision !== documentRevision) return;

    selectionSnapshotRef.current = {
      location: {
        type: "pdf_image",
        location: {
          pageNumber: cropData.pageNumber,
          rect: cropData.pdfRect,
          assetId: "",
        },
      },
      excerpt: `P.${cropData.pageNumber} 图像切片`,
      imageBase64: cropData.imageBase64,
      boundPath: currentIdentity.path,
      boundRevision: currentIdentity.revision,
      boundSeq: currentIdentity.seq,
      boundDocId: currentIdentity.docId,
    };

    setSelectedText(`P.${cropData.pageNumber} 图像选区`);
    setToolbarSelectionType("image");

    const container = scrollContainerRef.current;
    if (container) {
      const pageEl = container.querySelector(`[data-page-number="${cropData.pageNumber}"]`);
      if (pageEl) {
        const pageRect = pageEl.getBoundingClientRect();
        const screenTop = pageRect.top + cropData.cssRect.top;
        const screenLeft = pageRect.left + cropData.cssRect.left + cropData.cssRect.width / 2;
        setToolbarPosition({ top: screenTop - 12, left: screenLeft });
        return;
      }
    }
    setToolbarPosition({ top: window.innerHeight / 2, left: window.innerWidth / 2 });
  };

  // 点击外部收起工具栏
  const handleContainerMouseDown = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (!target.closest(".floating-selection-toolbar") && !target.closest(".selection-box")) {
      setToolbarPosition(null);
    }
  };

  // 触发卡片动作
  const handleToolbarAction = (action: CardAction, customPrompt?: string, depth?: CardDepth) => {
    if (!selectionSnapshotRef.current) return;
    const snap = selectionSnapshotRef.current;
    if (!snap.boundDocId || snap.boundDocId !== documentId) return;
    if (snap.boundSeq === undefined || snap.boundSeq !== documentSeq) return;
    if (snap.boundRevision && documentRevision && snap.boundRevision !== documentRevision) return;

    if (onCreateAnchorAndCard) {
      onCreateAnchorAndCard({
        location: snap.location,
        excerpt: snap.excerpt,
        action,
        customPrompt,
        depth: depth || "quick",
        imageBase64: snap.imageBase64,
        boundDocId: snap.boundDocId,
        boundSeq: snap.boundSeq,
        boundRevision: snap.boundRevision || undefined,
      });
    }
    setToolbarPosition(null);
  };

  // 触发高亮动作
  const handleToolbarHighlight = (color: string) => {
    if (!selectionSnapshotRef.current) return;
    const snap = selectionSnapshotRef.current;
    if (!snap.boundDocId || snap.boundDocId !== documentId) return;
    if (snap.boundSeq === undefined || snap.boundSeq !== documentSeq) return;
    if (snap.boundRevision && documentRevision && snap.boundRevision !== documentRevision) return;

    if (onCreateHighlight) {
      onCreateHighlight({
        location: snap.location,
        excerpt: snap.excerpt,
        color,
        boundDocId: snap.boundDocId,
        boundSeq: snap.boundSeq,
        boundRevision: snap.boundRevision || undefined,
      });
    }
    setToolbarPosition(null);
  };

  // 跨页定位 (JumpTarget) 调度处理：单次消费、可取消、最新优先、有限校正后释放控制权
  useEffect(() => {
    if (!jumpTarget) return;
    const reqId = jumpTarget.requestId || String(jumpTarget.timestamp);
    if (reqId === lastConsumedJumpRequestIdRef.current) return;
    if (jumpTarget.targetDocId && documentId && jumpTarget.targetDocId !== documentId) return;
    if (jumpTarget.openSeq !== undefined && documentSeq !== undefined && jumpTarget.openSeq !== documentSeq) return;

    if (!stats || jumpTarget.pageNumber < 1 || jumpTarget.pageNumber > stats.totalPages) return;

    // 立即消费该请求，取消之前的进行中定位任务
    lastConsumedJumpRequestIdRef.current = reqId;
    cancelActiveJump("superseded");
    activeJumpRequestIdRef.current = reqId;

    // 预估目标高度
    let accY = 0;
    for (let p = 1; p < jumpTarget.pageNumber; p++) {
      accY += pageHeightsRef.current.get(p) || Math.floor(842 * scale) + 32;
    }

    const cHeight = scrollContainerRef.current?.clientHeight || 0;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const clampedY = Math.max(0, Math.min(maxScroll, accY));

    targetYRef.current = clampedY;
    currentYRef.current = clampedY;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = clampedY;
    }
    updateThumbPosition();

    // 如果没有 anchorId，仅跳到页顶即可结束
    if (!jumpTarget.anchorId) {
      activeJumpRequestIdRef.current = null;
      onJumpComplete?.(reqId);
      return;
    }

    // 待目标挂载后微调定位与高亮闪烁（有限重试）
    const anchorIdToHighlight = jumpTarget.anchorId;
    let attempts = 0;
    const maxAttempts = 35;

    const tryAlignAndHighlight = () => {
      if (activeJumpRequestIdRef.current !== reqId) return;
      const container = scrollContainerRef.current;
      if (!container) {
        cancelActiveJump("container_missing");
        return;
      }
      attempts++;

      const targetAnchorEl = (container.querySelector(
        `[data-anchor-id="${anchorIdToHighlight}"]`
      ) ||
        Array.from(container.querySelectorAll<HTMLElement>("[data-all-anchor-ids]")).find(
          (el) => el.dataset.allAnchorIds?.split(",").includes(anchorIdToHighlight)
        )) as HTMLElement | null;

      if (targetAnchorEl) {
        const ancRect = targetAnchorEl.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        const delta = ancRect.top - contRect.top - contRect.height / 3;
        if (Math.abs(delta) > 5) {
          const maxScrollNow = Math.max(0, totalContentSize - container.clientHeight);
          const corrected = Math.max(0, Math.min(maxScrollNow, currentYRef.current + delta));
          targetYRef.current = corrected;
          currentYRef.current = corrected;
          container.scrollTop = corrected;
          updateThumbPosition();
        }

        if (activeHighlightedElRef.current && activeHighlightedElRef.current !== targetAnchorEl) {
          activeHighlightedElRef.current.style.outline = "none";
        }
        targetAnchorEl.style.outline = "2px solid var(--pen, #e8664a)";
        activeHighlightedElRef.current = targetAnchorEl;
        jumpPendingTimeoutRef.current = setTimeout(() => {
          targetAnchorEl.style.outline = "none";
          if (activeHighlightedElRef.current === targetAnchorEl) {
            activeHighlightedElRef.current = null;
          }
        }, 1600);

        activeJumpRequestIdRef.current = null;
        onJumpComplete?.(reqId);
      } else if (attempts < maxAttempts) {
        jumpPendingRafRef.current = requestAnimationFrame(tryAlignAndHighlight);
      } else {
        activeJumpRequestIdRef.current = null;
        onJumpComplete?.(reqId);
      }
    };

    jumpPendingRafRef.current = requestAnimationFrame(tryAlignAndHighlight);
  }, [
    jumpTarget,
    stats,
    scale,
    totalContentSize,
    updateThumbPosition,
    cancelActiveJump,
    onJumpComplete,
    documentId,
    documentSeq,
  ]);

  // 定期检测视口内可见锚点通知跟随面板（共同识别全部 anchor IDs）
  // 首次显示、锚点新增、PDF页面挂载、缩放及布局变化后主动检测，不依赖额外滚动
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !onVisibleAnchorsChange) return;

    let rafId: number | null = null;
    const checkVisible = () => {
      const cRect = container.getBoundingClientRect();
      const anchorEls = container.querySelectorAll<HTMLElement>("[data-anchor-id]");
      const visibleIds: string[] = [];

      anchorEls.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom > cRect.top && r.top < cRect.bottom) {
          const allIds = (
            el.dataset.allAnchorIds
              ? el.dataset.allAnchorIds.split(",")
              : [el.dataset.anchorId]
          ).filter(Boolean) as string[];

          for (const aid of allIds) {
            if (!visibleIds.includes(aid)) {
              visibleIds.push(aid);
            }
          }
        }
      });

      const isUnchanged =
        visibleIds.length === lastVisibleIdsRef.current.length &&
        visibleIds.every((id, idx) => id === lastVisibleIdsRef.current[idx]);

      if (!isUnchanged) {
        lastVisibleIdsRef.current = visibleIds;
        onVisibleAnchorsChange(visibleIds);
      }
    };

    const scheduleCheck = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(checkVisible);
    };

    // 首次挂载、缩放或锚点新增后主动检测并通知来源布局更新
    scheduleCheck();
    window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));

    container.addEventListener("scroll", scheduleCheck, { passive: true });
    window.addEventListener("resize", scheduleCheck);
    window.addEventListener("flowread:source-layout-updated", scheduleCheck);

    return () => {
      container.removeEventListener("scroll", scheduleCheck);
      window.removeEventListener("resize", scheduleCheck);
      window.removeEventListener("flowread:source-layout-updated", scheduleCheck);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [onVisibleAnchorsChange, anchors, scale, stats]);

  const latestPropsRef = useRef({
    filePath: propFilePath,
    documentRevision,
    documentId,
    documentSeq,
  });
  latestPropsRef.current = {
    filePath: propFilePath,
    documentRevision,
    documentId,
    documentSeq,
  };

  // 同步数据库身份与修订（不触发重新读取，身份先到或正文先到均能正确绑定）
  useEffect(() => {
    const curPath = loadedDocIdentityRef.current.path;
    if (curPath && curPath === propFilePath) {
      const curSeq = loadedDocIdentityRef.current.seq;
      const curRev = loadedDocIdentityRef.current.revision;
      if (
        (documentSeq === undefined || curSeq === documentSeq) &&
        (!documentRevision || !curRev || curRev === documentRevision)
      ) {
        if (documentId) loadedDocIdentityRef.current.docId = documentId;
        if (documentRevision) loadedDocIdentityRef.current.revision = documentRevision;
        if (documentSeq !== undefined) loadedDocIdentityRef.current.seq = documentSeq;
      }
    }
    // 同步当前存在的选区快照（受相同打开请求与修订约束，不把旧选区标为新版本）
    if (
      selectionSnapshotRef.current &&
      selectionSnapshotRef.current.boundPath === propFilePath
    ) {
      const snapSeq = selectionSnapshotRef.current.boundSeq;
      const snapRev = selectionSnapshotRef.current.boundRevision;
      if (
        (documentSeq === undefined || snapSeq === documentSeq) &&
        (!documentRevision || !snapRev || snapRev === documentRevision)
      ) {
        if (documentId) selectionSnapshotRef.current.boundDocId = documentId;
        if (documentRevision) selectionSnapshotRef.current.boundRevision = documentRevision;
      }
    }
  }, [propFilePath, documentId, documentRevision, documentSeq]);

  // 组件卸载时释放所有已分配的物理资源，并令任何在途的异步任务失效
  useEffect(() => {
    return () => {
      loadSequenceIdRef.current++;
      const oldResources = detachCurrentResources();
      void disposePdfResources(oldResources);
    };
  }, []);

  // 加载文档（明确区分进行中的请求、完成的数据和已失效的请求）
  useEffect(() => {
    if (!propFilePath) {
      loadSequenceIdRef.current++;
      const oldResources = detachCurrentResources();
      void disposePdfResources(oldResources);

      selectionSnapshotRef.current = null;
      setToolbarPosition(null);
      pdfDocRef.current = null;
      setPdfDoc(null);
      setStats(null);
      loadedDocIdentityRef.current = {
        path: null,
        revision: null,
        seq: 0,
        docId: null,
      };
      pageHeightsRef.current.clear();
      viewportsMapRef.current.clear();
      setIsLoading(false);
      return;
    }

    // 判断是否属于同一次打开请求
    const isSameRequest = (taskPath: string, taskSeq?: number, taskRev?: string): boolean => {
      if (taskPath !== propFilePath) return false;
      if (documentSeq !== undefined && taskSeq !== undefined && taskSeq !== documentSeq) return false;
      if (documentRevision && taskRev && taskRev !== documentRevision) return false;
      return true;
    };

    // A. 已经完成且数据匹配：直接复用，不发起重复解析
    if (
      completedDocRef.current &&
      isSameRequest(
        completedDocRef.current.path,
        completedDocRef.current.seq,
        completedDocRef.current.revision
      )
    ) {
      if (documentRevision && !completedDocRef.current.revision) {
        completedDocRef.current.revision = documentRevision;
      }
      if (documentSeq !== undefined && completedDocRef.current.seq === undefined) {
        completedDocRef.current.seq = documentSeq;
      }
      if (pdfDoc !== completedDocRef.current.doc) {
        pdfDocRef.current = completedDocRef.current.doc;
        setPdfDoc(completedDocRef.current.doc);
        setStats(completedDocRef.current.stats);
      }
      setIsLoading(false);
      loadedDocIdentityRef.current = {
        path: propFilePath,
        revision: documentRevision || completedDocRef.current.revision || null,
        seq: documentSeq ?? loadSequenceIdRef.current,
        docId: documentId || null,
      };
      return;
    }

    // B. 当前已有进行中的同一请求（StrictMode setup/cleanup 或慢读取中元数据到达）：保持请求继续执行，绝不废弃！
    if (
      activeLoadTaskRef.current &&
      isSameRequest(
        activeLoadTaskRef.current.path,
        activeLoadTaskRef.current.seq,
        activeLoadTaskRef.current.revision
      )
    ) {
      if (documentRevision && !activeLoadTaskRef.current.revision) {
        activeLoadTaskRef.current.revision = documentRevision;
      }
      if (documentSeq !== undefined && activeLoadTaskRef.current.seq === undefined) {
        activeLoadTaskRef.current.seq = documentSeq;
      }
      return;
    }

    // C. 真正的新打开请求（包括切换文件、同路径递增 documentSeq 重新打开、或真实 documentRevision 变化）：
    // 立即递增代际，同步摘除旧资源，异步销毁旧资源，旧选区快照与旧工具栏失效！
    const generation = ++loadSequenceIdRef.current;

    // 1. 同步捕获并摘除旧资源的物理引用，放入独立闭包后台异步销毁，
    // 绝不阻断新一代加载，且无论旧销毁何时结束，绝不可能误伤新一代资源！
    const oldResources = detachCurrentResources();
    void disposePdfResources(oldResources);

    setIsLoading(true);
    cancelActiveJump("doc_switch");
    lastConsumedJumpRequestIdRef.current = null;
    setToolbarPosition(null);
    selectionSnapshotRef.current = null;
    setErrorMessage(null);
    setStatusMessage("正在建立文件数据通道...");

    // 2. 立即清空 UI 旧页面与旧身份，杜绝新内容就绪前旧页面/旧选区冒充新版本
    pdfDocRef.current = null;
    setPdfDoc(null);
    setStats(null);
    loadedDocIdentityRef.current = {
      path: null,
      revision: null,
      seq: 0,
      docId: null,
    };
    pageHeightsRef.current.clear();
    viewportsMapRef.current.clear();

    const taskPromise = (async (): Promise<void> => {
      try {
        const startTime = performance.now();
        const onDataError = (error: Error) => {
          if (generation !== loadSequenceIdRef.current) return;
          console.error("[PDFReaderArea] 范围流式读取错误:", error);
          setErrorMessage(error.message);
        };

        const transport = await createTauriPDFTransport(propFilePath, 65536, onDataError);
        if (generation !== loadSequenceIdRef.current) {
          try { transport.destroy(); } catch {}
          return;
        }
        transportRef.current = transport;

        const loadingTask = pdfjsLib.getDocument({
          range: transport,
          cMapUrl: "https://unpkg.com/pdfjs-dist@6.4.299/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "https://unpkg.com/pdfjs-dist@6.4.299/standard_fonts/",
          disableAutoFetch: true,
          disableStream: true,
        });

        if (generation !== loadSequenceIdRef.current) {
          void loadingTask.destroy();
          return;
        }
        loadingTaskRef.current = loadingTask;

        const doc = await loadingTask.promise;
        if (generation !== loadSequenceIdRef.current) {
          try { doc.cleanup(); } catch {}
          try { void (doc as any).destroy?.(); } catch {}
          return;
        }

        const curProps = latestPropsRef.current;
        if (
          curProps.filePath !== propFilePath ||
          (documentSeq !== undefined && curProps.documentSeq !== undefined && curProps.documentSeq !== documentSeq)
        ) {
          try { doc.cleanup(); } catch {}
          try { void (doc as any).destroy?.(); } catch {}
          return;
        }

        const durationMs = Math.round(performance.now() - startTime);
        const fileName = propFilePath.split(/[/\\]/).pop() || "未命名文档";
        const totalPages = doc.numPages;

        const docStats: PDFDocumentStats = {
          filePath: propFilePath,
          fileName,
          fileSizeBytes: transport.length,
          totalPages,
          loadDurationMs: durationMs,
        };

        completedDocRef.current = {
          path: propFilePath,
          seq: documentSeq,
          revision: curProps.documentRevision || documentRevision,
          doc,
          stats: docStats,
        };
        activeLoadTaskRef.current = null;

        loadedDocIdentityRef.current = {
          path: propFilePath,
          revision: curProps.documentRevision || documentRevision || null,
          seq: curProps.documentSeq !== undefined ? curProps.documentSeq : generation,
          docId: curProps.documentId || null,
        };

        pdfDocRef.current = doc;
        setPdfDoc(doc);
        setStats(docStats);
        setIsLoading(false);
        setStatusMessage(`已就绪 (${totalPages} 页)`);
      } catch (err: unknown) {
        if (generation !== loadSequenceIdRef.current) return;
        activeLoadTaskRef.current = null;
        console.error("[PDFReaderArea] PDF 范围流加载异常:", err);
        const errorDetail = err instanceof Error ? err.message : String(err);
        setErrorMessage(errorDetail);
        setIsLoading(false);
        setStatusMessage("加载失败");
      }
    })();

    activeLoadTaskRef.current = {
      path: propFilePath,
      seq: documentSeq,
      revision: documentRevision,
      generation,
      promise: taskPromise,
    };
  }, [propFilePath, documentSeq, documentRevision]);

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    cancelActiveJump("scrollbar_drag");
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
      targetYRef.current = Math.max(0, Math.min(maxScroll, startTarget + scrollDelta));
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

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    cancelActiveJump("scrollbar_track");
    const track = trackRef.current;
    const container = scrollContainerRef.current;
    if (!track || !container) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const cHeight = container.clientHeight;
    const maxScroll = Math.max(0, totalContentSize - cHeight);
    const thumbHeight = Math.max(40, (cHeight / totalContentSize) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);

    const targetPercent = Math.max(0, Math.min(1, (clickY - thumbHeight / 2) / trackTravel));
    targetYRef.current = targetPercent * maxScroll;
    startLerpLoop();
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) return;
      cancelActiveJump("user_wheel");
      e.preventDefault();
      const cHeight = container.clientHeight;
      const maxScroll = Math.max(0, totalContentSize - cHeight);
      const delta = e.deltaY;
      targetYRef.current = Math.max(0, Math.min(maxScroll, targetYRef.current + delta));
      startLerpLoop();
    };

    const onScroll = (): void => {
      if (!isLerpRunningRef.current && scrollContainerRef.current) {
        const top = scrollContainerRef.current.scrollTop;
        currentYRef.current = top;
        targetYRef.current = top;
        updateThumbPosition();
      }
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const navKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
      if (navKeys.includes(e.key)) {
        cancelActiveJump("keyboard_nav");
      }
    };

    const onPointerDown = (): void => {
      cancelActiveJump("container_pointer");
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [totalContentSize, startLerpLoop, updateThumbPosition, cancelActiveJump]);

  return (
    <main
      className="pdf-reader-container"
      onMouseUp={handleMouseUp}
      onMouseDown={handleContainerMouseDown}
    >
      <div className="pdf-scroll-viewport" ref={scrollContainerRef} data-reader-viewport="true">
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
                    onCropCompleted={handleCropCompleted}
                    anchors={anchors}
                    highlights={highlights}
                    activeAnchorId={activeAnchorId}
                    onSelectAnchor={onSelectAnchor}
                    documentRevision={documentRevision}
                  />
                </div>
              );
            })}
          </div>
        ) : errorMessage ? (
          <div className="pdf-empty-placeholder">
            <div className="empty-card" style={{ borderColor: "rgba(244, 63, 94, 0.4)" }}>
              <h2 className="empty-title" style={{ color: "#f43f5e" }}>PDF 加载遇到问题</h2>
              <p className="empty-desc">{errorMessage}</p>
            </div>
          </div>
        ) : !isLoading ? (
          <div className="pdf-empty-placeholder">
            <div className="empty-card">
              <h2 className="empty-title">FlowRead PDF 多模态视觉流式引擎</h2>
              <p className="empty-desc">
                支持 1000+ 页文档秒开与 60fps 动力学平滑滚动，随时 Alt+拖拽框选图表或划词交由 AI 深度伴读。
              </p>
            </div>
          </div>
        ) : null}
      </div>

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

      {/* 浮动划词指令工具栏 */}
      {toolbarPosition && (
        <SelectionToolbar
          position={toolbarPosition}
          selectionType={toolbarSelectionType}
          selectedText={selectedText}
          onAction={handleToolbarAction}
          onHighlight={handleToolbarHighlight}
          onClose={() => setToolbarPosition(null)}
        />
      )}
    </main>
  );
}
