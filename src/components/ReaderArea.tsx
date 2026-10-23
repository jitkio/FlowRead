import React, { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import SelectionToolbar from "./SelectionToolbar";
import {
  SourceAnchorRecord,
  HighlightRecord,
  SourceLocationData,
  TextParagraphSegment,
  CardAction,
  CardDepth,
} from "../types/records";
import {
  parseAndStructureText,
  StructuredDocument,
  DisplayChunk,
} from "../utils/textDocumentManager";
import {
  buildParagraphAnchorIndex,
  ParagraphAnchorIndex,
} from "../utils/textAnchorIndexer";

export interface TextJumpTarget {
  requestId?: string;
  paragraphIndex: number;
  charOffset?: number;
  anchorId?: string;
  timestamp: number;
  targetDocId?: string;
  openSeq?: number;
}

export interface ReaderAreaProps {
  onLoadLocalBook?: (content: string) => void;
  onOpenPdf?: (filePath?: string) => void;
  onDocInfoChange?: (info: { title: string; paragraphs: number; paragraphLengths?: number[] }) => void;
  filePath?: string | null;
  scale?: number;
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
  jumpTarget?: TextJumpTarget | null;
  onJumpComplete?: (requestId: string) => void;
}

const DEFAULT_BOOK_CONTENT = `阅读不仅是一种获取信息的机械过程，更是一场思想与灵魂的幽邃漫游。在如今信息激流奔涌的屏幕世代，我们习惯了被碎片化的推文、跳跃的超链接和刺目的冷光所裹挟，原本属于文字的那份温润与静谧，似乎正一点一滴地流失。

真正具有启发性的阅读，往往需要读者进入一种“心流”（Flow）状态。在此状态下，时间感逐渐消融，思维随着铅字排列的韵律徐徐展开。正如卡尔·诺顿在《深度工作》中所言，深度沉浸不仅能锻造更为深刻的认知结构，也是抵御认知过载与精神焦虑的坚固盾牌。

“书籍是人类用来将思维跨越时空阻隔而传递的至简之器。静默地面对一页纸，便是与世界上最深邃的心智展开最私密的对谈。”

传统的纸质书页之所以让人沉醉，不仅在于油墨的芬芳，更在于其纯粹无扰的环境。它不会在阅读到最动人之处弹出一则推送，也不会用复杂的菜单栏割裂你的凝视。为了在现代应用中重塑这种体验，我们引入了类似“Gloss”风格的极简排版——用温暖柔和的暖纸底色消解眼睛的疲惫，用节制有度的字距行高还给文字应有的呼吸空间。

与此同时，数字阅读也不应仅仅是对纸张的生硬模仿。它真正的魅力在于“延伸”与“赋能”。当你偶遇一个生僻的概念、一段晦涩的隐喻，或者一段跨语言的典故时，你不必离开当前的阅读语境，去四处搜索繁琐的字典词条。

这就是“划词伴读”诞生的意义。只需要用鼠标轻轻划选你感兴趣或疑惑的语句，右侧的 AI 助手便会即刻捕获这一段落。它不是冷冰冰的外部搜索引擎，而是一位随时坐定身旁的知心书童，帮助你拆解长难句、阐释文化背景、提炼核心论点，甚至与你探讨作者未尽的弦外之音。

这种即时、平滑、无缝的交互，让阅读从被动的“接受”变成了主动的“对话”。在这个人机共读的新维度里，复杂的哲学文本不再显得高不可攀，冗长的学术专著也变得层层透彻。

我们每天被成千上万的信息片段轰炸，但信息绝不等于知识，更不等于智慧。唯有经过慢速咀嚼、深度沉思与结构化梳理的文字，才能真正融入你的心智模型，成为支撑你洞察世界的基石。

关掉浮躁的弹窗，让视线沉落在温润的字里行间。在流动的文字中漫步，让思考重新找回它本有的深度与宁静。`;

function ReaderAreaComponent({
  onLoadLocalBook,
  onOpenPdf: _onOpenPdf,
  onDocInfoChange,
  filePath,
  scale = 1,
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
}: ReaderAreaProps): React.JSX.Element {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const headerWrapperRef = useRef<HTMLDivElement>(null);
  const updateThumbPositionRef = useRef<() => void>(() => {});

  const targetYRef = useRef<number>(0);
  const currentYRef = useRef<number>(0);
  const isLerpRunningRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);
  const loadSequenceIdRef = useRef<number>(0);
  const lastVisibleIdsRef = useRef<string[]>([]);
  const lastConsumedJumpTimestampRef = useRef<number>(0);
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
  const [isLoadingDocument, setIsLoadingDocument] = useState<boolean>(false);

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [headerHeight, setHeaderHeight] = useState<number>(0);

  // 划词工具栏状态与稳定选区快照
  const [toolbarPosition, setToolbarPosition] = useState<{ top: number; left: number } | null>(null);
  const [selectedText, setSelectedText] = useState<string>("");
  const selectionSnapshotRef = useRef<{
    location: SourceLocationData;
    excerpt: string;
    boundPath: string | null;
    boundRevision: string | null;
    boundSeq: number;
    boundDocId: string | null;
  } | null>(null);

  const [bookContent, setBookContent] = useState<string>(DEFAULT_BOOK_CONTENT);
  const [currentBookTitle, setCurrentBookTitle] = useState<string>(
    "在流动中沉思：重新发现数字时代的深度阅读之美"
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // 1. 结构化文档与超长段落安全切片 (O(N) 仅在文本变化时计算)
  const structuredDoc = useMemo<StructuredDocument>(() => {
    return parseAndStructureText(bookContent, 1500);
  }, [bookContent]);

  // 2. 预构建逻辑段落锚点与高亮索引 (O(A) 仅在锚点数据或版本变化时计算，AI 流式生成时绝不重跑)
  const paragraphAnchorIndex = useMemo<ParagraphAnchorIndex>(() => {
    return buildParagraphAnchorIndex(anchors, highlights, documentRevision);
  }, [anchors, highlights, documentRevision]);

  // 同步文档元信息（段落数按逻辑段落统计）
  useEffect(() => {
    onDocInfoChange?.({
      title: currentBookTitle,
      paragraphs: structuredDoc.logicalParagraphs.length,
      paragraphLengths: structuredDoc.logicalParagraphs.map((p) => p.length),
    });
  }, [currentBookTitle, structuredDoc.logicalParagraphs, onDocInfoChange]);

  const latestPropsRef = useRef({
    filePath,
    documentRevision,
    documentId,
    documentSeq,
    onLoadLocalBook,
  });
  latestPropsRef.current = {
    filePath,
    documentRevision,
    documentId,
    documentSeq,
    onLoadLocalBook,
  };

  // 1. 同步数据库身份与修订（不触发重新读取物理文件，身份先到或正文先到均能正确绑定）
  useEffect(() => {
    const curPath = loadedDocIdentityRef.current.path;
    if (curPath && curPath === filePath) {
      if (documentSeq === undefined || loadedDocIdentityRef.current.seq === documentSeq) {
        if (documentId) loadedDocIdentityRef.current.docId = documentId;
        if (documentRevision) loadedDocIdentityRef.current.revision = documentRevision;
        if (documentSeq !== undefined) loadedDocIdentityRef.current.seq = documentSeq;
      }
    }
    // 同步未结算的有效选区快照
    if (
      selectionSnapshotRef.current &&
      selectionSnapshotRef.current.boundPath === filePath &&
      (documentSeq === undefined || selectionSnapshotRef.current.boundSeq === documentSeq)
    ) {
      if (documentId) selectionSnapshotRef.current.boundDocId = documentId;
      if (documentRevision) selectionSnapshotRef.current.boundRevision = documentRevision;
    }
  }, [documentId, documentRevision, documentSeq, filePath]);

  // 2. 加载本地文本/EPUB文件（明确区分进行中的请求、完成的数据和已失效的请求）
  const activeLoadTaskRef = useRef<{
    path: string;
    seq?: number;
    revision?: string;
    generation: number;
    promise: Promise<void>;
  } | null>(null);

  const completedDataRef = useRef<{
    path: string;
    seq?: number;
    revision?: string;
    content: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (!filePath) {
      activeLoadTaskRef.current = null;
      completedDataRef.current = null;
      loadedDocIdentityRef.current = {
        path: null,
        revision: documentRevision || null,
        seq: documentSeq || 0,
        docId: documentId || null,
      };
      setIsLoadingDocument(false);
      return;
    }

    // 虚拟文档 flowread:// 绝不调用 read_local_file
    if (filePath.startsWith("flowread://")) {
      activeLoadTaskRef.current = null;
      completedDataRef.current = {
        path: filePath,
        seq: documentSeq,
        revision: documentRevision || "v1",
        content: DEFAULT_BOOK_CONTENT,
        title: "在流动中沉思：重新发现数字时代的深度阅读之美",
      };
      setBookContent(DEFAULT_BOOK_CONTENT);
      setCurrentBookTitle("在流动中沉思：重新发现数字时代的深度阅读之美");
      setLoadError(null);
      setIsLoadingDocument(false);
      loadedDocIdentityRef.current = {
        path: filePath,
        revision: documentRevision || "v1",
        seq: documentSeq ?? 1,
        docId: documentId || null,
      };
      onLoadLocalBook?.(DEFAULT_BOOK_CONTENT);
      return;
    }

    // 判断是否属于同一次打开请求
    const isSameRequest = (taskPath: string, taskSeq?: number, taskRev?: string): boolean => {
      if (taskPath !== filePath) return false;
      if (documentSeq !== undefined && taskSeq !== undefined && taskSeq !== documentSeq) return false;
      if (documentRevision && taskRev && taskRev !== documentRevision) return false;
      return true;
    };

    // A. 已经完成且数据匹配：直接复用，不发起重复读取
    if (
      completedDataRef.current &&
      isSameRequest(
        completedDataRef.current.path,
        completedDataRef.current.seq,
        completedDataRef.current.revision
      )
    ) {
      if (documentRevision && !completedDataRef.current.revision) {
        completedDataRef.current.revision = documentRevision;
      }
      if (bookContent !== completedDataRef.current.content) {
        setBookContent(completedDataRef.current.content);
        setCurrentBookTitle(completedDataRef.current.title);
      }
      setIsLoadingDocument(false);
      loadedDocIdentityRef.current = {
        path: filePath,
        revision: documentRevision || completedDataRef.current.revision || null,
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
      return;
    }

    // C. 真正的新打开请求：递增请求代际
    const generation = ++loadSequenceIdRef.current;
    setIsLoadingDocument(true);
    cancelActiveJump("doc_switch");
    lastConsumedJumpRequestIdRef.current = null;
    lastConsumedJumpTimestampRef.current = 0;
    setToolbarPosition(null);
    selectionSnapshotRef.current = null;
    setLoadError(null);

    const loadPromise = (async (): Promise<void> => {
      try {
        const content = await invoke<string>("read_local_file", { filePath });
        if (generation !== loadSequenceIdRef.current) return;

        const curProps = latestPropsRef.current;
        if (
          curProps.filePath !== filePath ||
          (documentSeq !== undefined && curProps.documentSeq !== undefined && curProps.documentSeq !== documentSeq)
        ) {
          return;
        }

        const fileName = filePath.split(/[/\\]/).pop() || "未命名文档";
        completedDataRef.current = {
          path: filePath,
          seq: documentSeq,
          revision: curProps.documentRevision || documentRevision,
          content,
          title: fileName,
        };
        activeLoadTaskRef.current = null;

        setBookContent(content);
        setCurrentBookTitle(fileName);
        curProps.onLoadLocalBook?.(content);

        // 正文就绪时绑定最新身份，避免旧 render 捕获的 stale props
        loadedDocIdentityRef.current = {
          path: filePath,
          revision: curProps.documentRevision || documentRevision || null,
          seq: curProps.documentSeq ?? documentSeq ?? generation,
          docId: curProps.documentId || documentId || null,
        };

        setIsLoadingDocument(false);
        targetYRef.current = 0;
        currentYRef.current = 0;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
        setToolbarPosition(null);
        updateThumbPositionRef.current();
      } catch (error) {
        if (generation !== loadSequenceIdRef.current) return;
        activeLoadTaskRef.current = null;
        const errorMsg = error instanceof Error ? error.message : String(error);
        setLoadError(errorMsg);
        setBookContent("");
        const fileName = filePath.split(/[/\\]/).pop() || "未知文件";
        setCurrentBookTitle(`读取失败: ${fileName}`);
        loadedDocIdentityRef.current = {
          path: null,
          revision: null,
          seq: 0,
          docId: null,
        };
        setIsLoadingDocument(false);
        targetYRef.current = 0;
        currentYRef.current = 0;
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = 0;
        }
      }
    })();

    activeLoadTaskRef.current = {
      path: filePath,
      seq: documentSeq,
      revision: documentRevision,
      generation,
      promise: loadPromise,
    };
  }, [filePath, documentSeq, documentRevision, onLoadLocalBook]);

  const containerWidthRef = useRef<number>(644);

  useEffect(() => {
    if (!scrollContainerRef.current) return;
    const updateContainerWidth = (): void => {
      if (scrollContainerRef.current) {
        const rawWidth = scrollContainerRef.current.clientWidth - 80;
        containerWidthRef.current = Math.min(Math.max(280, rawWidth), 644);
      }
    };
    updateContainerWidth();
    const resizeObserver = new ResizeObserver(updateContainerWidth);
    resizeObserver.observe(scrollContainerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!headerWrapperRef.current) return;
    const updateHeaderHeight = (): void => {
      if (headerWrapperRef.current) {
        setHeaderHeight(headerWrapperRef.current.offsetHeight);
      }
    };
    updateHeaderHeight();
    const resizeObserver = new ResizeObserver(updateHeaderHeight);
    resizeObserver.observe(headerWrapperRef.current);
    return () => resizeObserver.disconnect();
  }, [currentBookTitle, structuredDoc.displayChunks.length]);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const prevScaleRef = useRef(scale);

  const onResizeRectRef = useRef<((rect: { width: number; height: number }) => void) | null>(null);
  const onScrollOffsetRef = useRef<((offset: number, isScrolling: boolean) => void) | null>(null);

  // 观察视口尺寸在缩放下的换算
  const observeElementRect = useCallback(
    (instance: any, cb: (rect: { width: number; height: number }) => void) => {
      const element = instance.scrollElement;
      if (!element) return () => {};
      const targetWindow = instance.targetWindow;
      if (!targetWindow) return () => {};

      onResizeRectRef.current = cb;

      const handler = (rect: { width: number; height: number }) => {
        cb({
          width: Math.round(rect.width / scaleRef.current),
          height: Math.round(rect.height / scaleRef.current),
        });
      };
      handler({ width: element.offsetWidth, height: element.offsetHeight });

      const observer = new targetWindow.ResizeObserver((entries: ResizeObserverEntry[]) => {
        const entry = entries[0];
        if (entry?.borderBoxSize?.[0]) {
          const box = entry.borderBoxSize[0];
          handler({ width: box.inlineSize, height: box.blockSize });
        } else {
          handler({ width: element.offsetWidth, height: element.offsetHeight });
        }
      });
      observer.observe(element, { box: "border-box" });
      return () => {
        observer.disconnect();
        if (onResizeRectRef.current === cb) {
          onResizeRectRef.current = null;
        }
      };
    },
    []
  );

  // 观察滚动位移在缩放下的换算
  const observeElementOffset = useCallback(
    (instance: any, cb: (offset: number, isScrolling: boolean) => void) => {
      const element = instance.scrollElement;
      if (!element) return () => {};

      onScrollOffsetRef.current = cb;

      const readOffset = () => element.scrollTop / scaleRef.current;
      let timer: any = null;
      const createHandler = (isScrolling: boolean) => () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => cb(readOffset(), false), 150);
        cb(readOffset(), isScrolling);
      };
      const handler = createHandler(true);
      element.addEventListener("scroll", handler, { passive: true });
      return () => {
        element.removeEventListener("scroll", handler);
        if (timer) clearTimeout(timer);
        if (onScrollOffsetRef.current === cb) {
          onScrollOffsetRef.current = null;
        }
      };
    },
    []
  );

  // 写入滚动位移：必须将 unzoomed 虚拟坐标加上 adjustments 乘以当前 scale 写入实际 DOM scrollTop
  const scrollToFn = useCallback(
    (
      offset: number,
      options: unknown,
      instance: { scrollElement: HTMLElement | null }
    ): void => {
      const element = instance.scrollElement;
      if (!element) return;
      const adjustments =
        typeof options === "object" &&
        options !== null &&
        "adjustments" in options &&
        typeof (options as any).adjustments === "number"
          ? (options as any).adjustments
          : 0;
      const logicalOffset = offset + adjustments;
      const scaledOffset = Math.round(logicalOffset * scaleRef.current);
      targetYRef.current = scaledOffset;
      currentYRef.current = scaledOffset;
      element.scrollTop = scaledOffset;
      updateThumbPositionRef.current();
    },
    []
  );

  // 虚拟化列表：按显示切片渲染，控制预加载量 (overscan 25)
  const virtualizer = useVirtualizer({
    count: structuredDoc.displayChunks.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index: number) => {
      const chunk = structuredDoc.displayChunks[index];
      const text = chunk ? chunk.text : "";
      if (text.length === 0) return 34;
      const charsPerLine = Math.max(1, Math.floor(containerWidthRef.current / 18));
      const lines = Math.ceil(text.length / charsPerLine);
      return Math.max(34, lines * 30 + 24);
    },
    overscan: 25,
    scrollMargin: 40 + headerHeight,
    observeElementRect,
    observeElementOffset,
    scrollToFn,
  });

  const totalContentSize = virtualizer.getTotalSize();

  // 依赖库内部滚动上限转换为 unzoomed 逻辑坐标，确保 50% / 100% / 150% / 200% 跳转均不被截断为 0
  (virtualizer as any).getMaxScrollOffset = () => {
    const el = scrollContainerRef.current;
    if (!el) return 0;
    const currentScale = scaleRef.current || 1;
    const domMax = (el.scrollHeight - el.clientHeight) / currentScale;
    const calcTotal = headerHeight + totalContentSize + 160;
    const calcMax = calcTotal - (el.clientHeight / currentScale);
    return Math.max(0, Math.max(domMax, calcMax));
  };

  useEffect(() => {
    if (scrollContainerRef.current) {
      (scrollContainerRef.current as any).__virtualizer = virtualizer;
    }
  }, [virtualizer]);

  // 精准计算滚动边界与首尾可达性（统一实际视口滚动距离、虚拟列表测高、标题、160px正文留白和 zoom 的坐标关系）
  const getScrollBounds = useCallback((): { maxScroll: number; cHeight: number } => {
    const container = scrollContainerRef.current;
    if (!container) return { maxScroll: 0, cHeight: 0 };
    const cHeight = container.clientHeight;
    const calculatedTotal = (headerHeight + totalContentSize + 160) * scale;
    const totalHeight = Math.max(calculatedTotal, container.scrollHeight);
    const maxScroll = Math.max(0, totalHeight - cHeight);
    return { maxScroll, cHeight };
  }, [headerHeight, totalContentSize, scale]);

  const updateThumbPosition = useCallback((): void => {
    const thumb = thumbRef.current;
    const container = scrollContainerRef.current;
    if (!thumb || !container) return;

    const { maxScroll, cHeight } = getScrollBounds();
    if (maxScroll <= 0) {
      thumb.style.display = "none";
      return;
    }

    thumb.style.display = "block";
    const totalHeight = (headerHeight + totalContentSize + 160) * scale;
    const thumbHeight = Math.max(40, (cHeight / Math.max(cHeight, totalHeight)) * cHeight);
    const trackTravel = Math.max(1, cHeight - thumbHeight);
    const progress = Math.max(0, Math.min(1, currentYRef.current / maxScroll));
    const thumbTop = Math.max(0, Math.min(trackTravel, progress * trackTravel));

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, [getScrollBounds, headerHeight, totalContentSize, scale]);

  updateThumbPositionRef.current = updateThumbPosition;

  // 缩放、测高或视口边界变化时同步滚动坐标：
  // 缩小时先用旧阅读位置和旧比例计算新位置，再按新边界限位，绝不能先截断再换算！
  useEffect(() => {
    const prevScale = prevScaleRef.current;
    const { maxScroll } = getScrollBounds();

    if (prevScale !== scale) {
      // 1. 缩放比例发生改变：先用旧阅读位置和旧比例换算新目标位置，然后再按新边界限位！
      const unzoomedY = currentYRef.current / prevScale;
      const newY = Math.round(unzoomedY * scale);
      prevScaleRef.current = scale;

      const clampedY = Math.max(0, Math.min(maxScroll, newY));
      targetYRef.current = clampedY;
      currentYRef.current = clampedY;
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = clampedY;
      }
      updateThumbPosition();

      // 立即向虚拟列表推送最新尺寸与位移，并重新测量
      if (onResizeRectRef.current && scrollContainerRef.current) {
        onResizeRectRef.current({
          width: Math.round(scrollContainerRef.current.offsetWidth / scale),
          height: Math.round(scrollContainerRef.current.offsetHeight / scale),
        });
      }
      if (onScrollOffsetRef.current && scrollContainerRef.current) {
        onScrollOffsetRef.current(clampedY / scale, false);
      }
      virtualizer.measure();
      return;
    }

    // 2. 普通测高或窗口大小变化（缩放未变）：直接按最新有效边界限位
    if (targetYRef.current > maxScroll) {
      targetYRef.current = maxScroll;
    }
    if (currentYRef.current > maxScroll) {
      currentYRef.current = maxScroll;
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = maxScroll;
      }
    }
    updateThumbPosition();
  }, [scale, getScrollBounds, updateThumbPosition, virtualizer]);

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

  // 划选鼠标松开：按显示切片映射还原为逻辑段落索引与绝对字符偏移（带加载期隔离校验）
  const handleMouseUp = (): void => {
    setTimeout(() => {
      if (isLoadingDocument) return;
      if (
        documentId &&
        loadedDocIdentityRef.current.docId &&
        loadedDocIdentityRef.current.docId !== documentId
      ) {
        return;
      }
      if (
        documentSeq !== undefined &&
        loadedDocIdentityRef.current.seq &&
        loadedDocIdentityRef.current.seq !== documentSeq
      ) {
        return;
      }
      if (
        documentRevision &&
        loadedDocIdentityRef.current.revision &&
        loadedDocIdentityRef.current.revision !== documentRevision
      ) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
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
        if (rect.width <= 0 || rect.height <= 0) return;

        const container = scrollContainerRef.current;
        if (!container) return;

        // 查找所有相交的切片容器
        const chunkElements = Array.from(
          container.querySelectorAll<HTMLElement>(".virtual-paragraph-item")
        );

        const segmentMap = new Map<
          number,
          { startOffset: number; endOffset: number; prefix: string; suffix: string }
        >();

        for (const pEl of chunkElements) {
          if (range.intersectsNode(pEl)) {
            const logicalIdx = parseInt(pEl.dataset.paragraphIndex || "0", 10);
            const chunkCharStart = parseInt(pEl.dataset.charStart || "0", 10);
            const chunkText = pEl.innerText || pEl.textContent || "";

            let localStart = 0;
            let localEnd = chunkText.length;

            if (pEl.contains(range.startContainer)) {
              const preRange = document.createRange();
              preRange.selectNodeContents(pEl);
              preRange.setEnd(range.startContainer, range.startOffset);
              localStart = preRange.toString().length;
            }

            if (pEl.contains(range.endContainer)) {
              const preEndRange = document.createRange();
              preEndRange.selectNodeContents(pEl);
              preEndRange.setEnd(range.endContainer, range.endOffset);
              localEnd = preEndRange.toString().length;
            }

            localStart = Math.max(0, Math.min(chunkText.length, localStart));
            localEnd = Math.max(localStart, Math.min(chunkText.length, localEnd));

            const absStart = chunkCharStart + localStart;
            const absEnd = chunkCharStart + localEnd;

            if (absEnd > absStart) {
              const existing = segmentMap.get(logicalIdx);
              if (existing) {
                existing.startOffset = Math.min(existing.startOffset, absStart);
                existing.endOffset = Math.max(existing.endOffset, absEnd);
              } else {
                const fullParaText = structuredDoc.logicalParagraphs[logicalIdx] || "";
                segmentMap.set(logicalIdx, {
                  startOffset: absStart,
                  endOffset: absEnd,
                  prefix: fullParaText.slice(Math.max(0, absStart - 15), absStart),
                  suffix: fullParaText.slice(absEnd, Math.min(fullParaText.length, absEnd + 15)),
                });
              }
            }
          }
        }

        const segments: TextParagraphSegment[] = Array.from(segmentMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([paragraphIndex, data]) => ({
            paragraphIndex,
            startOffset: data.startOffset,
            endOffset: data.endOffset,
            prefix: data.prefix,
            suffix: data.suffix,
          }));

        if (segments.length === 0) {
          segments.push({
            paragraphIndex: 0,
            startOffset: 0,
            endOffset: text.length,
          });
        }

        const currentIdentity = loadedDocIdentityRef.current;
        if (!currentIdentity.path || currentIdentity.path !== filePath) return;
        if (documentSeq !== undefined && currentIdentity.seq !== documentSeq) return;

        selectionSnapshotRef.current = {
          location: { type: "text_segment", segments },
          excerpt: text,
          boundPath: currentIdentity.path,
          boundRevision: currentIdentity.revision,
          boundSeq: currentIdentity.seq,
          boundDocId: currentIdentity.docId,
        };

        setSelectedText(text);
        const showBelow = rect.top < 60;
        const top = showBelow ? rect.bottom + 10 : rect.top - 10;
        const left = rect.left + rect.width / 2;
        setToolbarPosition({ top, left });
      } catch (err) {
        console.error("[ReaderArea] 捕获选区边界异常:", err);
      }
    }, 20);
  };

  const handleContainerMouseDown = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    if (!target.closest(".floating-selection-toolbar")) {
      setToolbarPosition(null);
    }
  };

  const handleToolbarAction = (action: CardAction, customPrompt?: string, depth?: CardDepth) => {
    if (!selectionSnapshotRef.current) return;
    const snap = selectionSnapshotRef.current;
    // B 正文先到、身份尚未就绪时，不能登记到 A，也不能在身份未定前登记
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
        boundDocId: snap.boundDocId,
        boundSeq: snap.boundSeq,
        boundRevision: snap.boundRevision || undefined,
      });
    }
    setToolbarPosition(null);
  };

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

  // 跨段落跳转 (JumpTarget) 调度：单次请求严格消费一次，按逻辑段落和字符偏移定位所属切片，带唯一ID与取消机制
  useEffect(() => {
    if (!jumpTarget || isLoadingDocument) return;
    const reqId = jumpTarget.requestId || String(jumpTarget.timestamp);
    if (reqId === lastConsumedJumpRequestIdRef.current) {
      return;
    }
    if (jumpTarget.timestamp === lastConsumedJumpTimestampRef.current) {
      return;
    }
    if (jumpTarget.targetDocId && documentId && jumpTarget.targetDocId !== documentId) return;
    if (jumpTarget.openSeq !== undefined && documentSeq !== undefined && jumpTarget.openSeq !== documentSeq) return;

    const pIdx = jumpTarget.paragraphIndex;
    if (pIdx < 0 || pIdx >= structuredDoc.logicalParagraphs.length) return;

    // 记录消费的时间戳与请求ID，防止重复跳转
    lastConsumedJumpTimestampRef.current = jumpTarget.timestamp;
    lastConsumedJumpRequestIdRef.current = reqId;
    cancelActiveJump("superseded");
    activeJumpRequestIdRef.current = reqId;

    // 映射逻辑段落及字符偏移到所属显示切片
    const displayIndices = structuredDoc.logicalToDisplayIndices[pIdx];
    let targetDisplayIndex =
      displayIndices && displayIndices.length > 0 ? displayIndices[0] : pIdx;

    if (displayIndices && displayIndices.length > 1 && typeof jumpTarget.charOffset === "number") {
      const targetChar = jumpTarget.charOffset;
      const matched = displayIndices.find((dIdx) => {
        const chunk = structuredDoc.displayChunks[dIdx];
        return chunk && targetChar >= chunk.charStart && targetChar < chunk.charEnd;
      });
      if (matched !== undefined) {
        targetDisplayIndex = matched;
      } else if (
        targetChar >=
        (structuredDoc.displayChunks[displayIndices[displayIndices.length - 1]]?.charEnd ?? 0)
      ) {
        targetDisplayIndex = displayIndices[displayIndices.length - 1];
      }
    }

    const unzoomedOffset = Math.max(
      0,
      virtualizer.getOffsetForIndex(targetDisplayIndex, "start")?.[0] ?? (40 + headerHeight)
    );
    const { maxScroll } = getScrollBounds();
    const targetScroll = Math.max(0, Math.min(maxScroll, Math.round(unzoomedOffset * scale)));
    targetYRef.current = targetScroll;
    currentYRef.current = targetScroll;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = targetScroll;
    }
    updateThumbPosition();

    // 寻找目标元素并进行必要的有限定位微调
    const anchorIdToHighlight = jumpTarget.anchorId;
    let attempts = 0;
    const maxAttempts = 25;

    const tryAlignAndHighlight = () => {
      if (activeJumpRequestIdRef.current !== reqId) return;
      const container = scrollContainerRef.current;
      if (!container) {
        cancelActiveJump("container_missing");
        return;
      }
      attempts++;

      let targetEl: HTMLElement | null = null;
      if (anchorIdToHighlight) {
        targetEl = (container.querySelector(
          `[data-anchor-id="${anchorIdToHighlight}"]`
        ) ||
          Array.from(container.querySelectorAll<HTMLElement>("[data-all-anchor-ids]")).find(
            (el) => el.dataset.allAnchorIds?.split(",").includes(anchorIdToHighlight)
          )) as HTMLElement | null;
      }
      if (!targetEl) {
        targetEl = container.querySelector<HTMLElement>(
          `[data-display-index="${targetDisplayIndex}"]`
        );
      }

      if (targetEl) {
        const elRect = targetEl.getBoundingClientRect();
        const contRect = container.getBoundingClientRect();
        const desiredTop = contRect.top + 50;
        const delta = elRect.top - desiredTop;

        if (Math.abs(delta) > 8) {
          const { maxScroll: curMax } = getScrollBounds();
          const correctedY = Math.max(0, Math.min(curMax, currentYRef.current + delta));
          targetYRef.current = correctedY;
          currentYRef.current = correctedY;
          container.scrollTop = correctedY;
          updateThumbPosition();
        }

        if (anchorIdToHighlight) {
          const anchorEl = (container.querySelector(
            `[data-anchor-id="${anchorIdToHighlight}"]`
          ) ||
            Array.from(container.querySelectorAll<HTMLElement>("[data-all-anchor-ids]")).find(
              (el) => el.dataset.allAnchorIds?.split(",").includes(anchorIdToHighlight)
            )) as HTMLElement | null;
          if (anchorEl) {
            if (activeHighlightedElRef.current && activeHighlightedElRef.current !== anchorEl) {
              activeHighlightedElRef.current.style.outline = "none";
            }
            anchorEl.style.outline = "2px solid var(--pen, #e8664a)";
            activeHighlightedElRef.current = anchorEl;
            jumpPendingTimeoutRef.current = setTimeout(() => {
              anchorEl.style.outline = "none";
              if (activeHighlightedElRef.current === anchorEl) {
                activeHighlightedElRef.current = null;
              }
            }, 1600);
          }
        }

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
    isLoadingDocument,
    structuredDoc,
    virtualizer,
    scale,
    headerHeight,
    getScrollBounds,
    updateThumbPosition,
    cancelActiveJump,
    onJumpComplete,
    documentId,
    documentSeq,
  ]);

  // 检测视口内可见锚点通知跟随面板
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !onVisibleAnchorsChange) return;

    let rafId: number | null = null;
    const checkVisible = () => {
      const cRect = container.getBoundingClientRect();
      if (cRect.width === 0 && cRect.height === 0) return;
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

    scheduleCheck();
    window.dispatchEvent(new CustomEvent("flowread:source-layout-updated"));

    container.addEventListener("scroll", scheduleCheck, { passive: true });
    window.addEventListener("resize", scheduleCheck);

    return () => {
      container.removeEventListener("scroll", scheduleCheck);
      window.removeEventListener("resize", scheduleCheck);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [onVisibleAnchorsChange, anchors, scale, bookContent]);

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    cancelActiveJump("scrollbar_drag");
    const container = scrollContainerRef.current;
    if (!container) return;

    const { maxScroll, cHeight } = getScrollBounds();
    if (maxScroll <= 0) return;

    const startClientY = e.clientY;
    const startTarget = targetYRef.current;
    const totalHeight = (headerHeight + totalContentSize + 160) * scale;
    const thumbHeight = Math.max(40, (cHeight / Math.max(cHeight, totalHeight)) * cHeight);
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

    const { maxScroll, cHeight } = getScrollBounds();
    if (maxScroll <= 0) return;

    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const totalHeight = (headerHeight + totalContentSize + 160) * scale;
    const thumbHeight = Math.max(40, (cHeight / Math.max(cHeight, totalHeight)) * cHeight);
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
      const { maxScroll } = getScrollBounds();
      targetYRef.current = Math.max(0, Math.min(maxScroll, targetYRef.current + e.deltaY));
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
  }, [getScrollBounds, startLerpLoop, updateThumbPosition, cancelActiveJump]);

  /**
   * 渲染切片内容：直接通过 O(1) 索引获取命中本段的锚点，零 JSON.parse，避免全篇扫描
   */
  const renderChunkContent = (chunk: DisplayChunk) => {
    const matchingSpans = paragraphAnchorIndex.getByParagraph(chunk.logicalParagraphIndex);
    if (!matchingSpans || matchingSpans.length === 0) {
      return chunk.text;
    }

    // 过滤命中当前切片字符区间的有效片段
    const overlappingSpans = matchingSpans
      .filter(
        (s) =>
          Math.max(s.startOffset, chunk.charStart) < Math.min(s.endOffset, chunk.charEnd)
      )
      .map((s) => ({
        anchor_id: s.anchor_id,
        startOffset: Math.max(0, s.startOffset - chunk.charStart),
        endOffset: Math.min(chunk.text.length, s.endOffset - chunk.charStart),
        color: s.color,
        isActive: s.anchor_id === activeAnchorId,
      }));

    if (overlappingSpans.length === 0) {
      return chunk.text;
    }

    // 收集所有分割边界点，保证重叠选区切片切分后完整保留所有关联锚点
    const boundaries = new Set<number>([0, chunk.text.length]);
    for (const m of overlappingSpans) {
      boundaries.add(m.startOffset);
      boundaries.add(m.endOffset);
    }
    const sortedPoints = Array.from(boundaries).sort((a, b) => a - b);

    const nodes: React.ReactNode[] = [];

    for (let i = 0; i < sortedPoints.length - 1; i++) {
      const sliceStart = sortedPoints[i];
      const sliceEnd = sortedPoints[i + 1];
      const textSlice = chunk.text.slice(sliceStart, sliceEnd);
      if (!textSlice) continue;

      const covering = overlappingSpans.filter(
        (m) => m.startOffset <= sliceStart && m.endOffset >= sliceEnd
      );

      if (covering.length === 0) {
        nodes.push(textSlice);
      } else {
        const hasActive = covering.some((c) => c.isActive);
        const primaryAnchor = covering.find((c) => c.isActive) || covering[covering.length - 1];
        const allIds = covering.map((c) => c.anchor_id).join(",");

        nodes.push(
          <mark
            key={`mark_${chunk.displayIndex}_${sliceStart}_${sliceEnd}`}
            data-anchor-id={primaryAnchor.anchor_id}
            data-all-anchor-ids={allIds}
            className={`reader-text-highlight ${hasActive ? "is-active" : ""}`}
            onClick={(e) => {
              const sel = window.getSelection();
              if (!sel || sel.isCollapsed) {
                e.stopPropagation();
                const activeIdx = covering.findIndex((c) => c.anchor_id === activeAnchorId);
                const nextIdx = activeIdx >= 0 ? (activeIdx + 1) % covering.length : 0;
                onSelectAnchor?.(covering[nextIdx].anchor_id);
              }
            }}
            style={{
              backgroundColor: primaryAnchor.color,
              color: "inherit",
              borderRadius: "2px",
              cursor: "pointer",
              borderBottom: hasActive ? "2px solid var(--pen, #e8664a)" : "none",
            }}
          >
            {textSlice}
          </mark>
        );
      }
    }

    return nodes;
  };

  return (
    <main
      className="reader-container"
      onMouseUp={handleMouseUp}
      onMouseDown={handleContainerMouseDown}
    >
      <div className="reader-scroll-viewport" ref={scrollContainerRef} data-reader-viewport="true">
        <article className="reader-content" style={{ zoom: scale }}>
          <div ref={headerWrapperRef}>
            <header className="article-header">
              <h1 className="article-title">{currentBookTitle}</h1>
              <div className="article-meta">
                <span>FlowRead 本地书库</span>
                <span>·</span>
                <span>总段落：{structuredDoc.logicalParagraphs.length} 段</span>
                <span>·</span>
                <span>划选文字即享 AI 深度伴读</span>
              </div>
            </header>
          </div>

          {loadError ? (
            <div
              className="reader-error-banner"
              style={{
                margin: "40px auto",
                maxWidth: "600px",
                padding: "24px 28px",
                background: "rgba(244, 63, 94, 0.08)",
                border: "1px solid rgba(244, 63, 94, 0.3)",
                borderRadius: "8px",
                color: "#f43f5e",
                textAlign: "left",
              }}
            >
              <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: 600 }}>文件读取失败</h3>
              <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6, opacity: 0.9 }}>{loadError}</p>
            </div>
          ) : (
            <div
              className="virtual-article-body"
              style={{
                height: `${totalContentSize}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const chunk = structuredDoc.displayChunks[virtualRow.index];
                if (!chunk) return null;
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    data-display-index={chunk.displayIndex}
                    data-paragraph-index={chunk.logicalParagraphIndex}
                    data-char-start={chunk.charStart}
                    ref={virtualizer.measureElement}
                    className="virtual-paragraph-item"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start - (40 + headerHeight)}px)`,
                    }}
                  >
                    <p
                      style={{
                        margin: "0 0 16px 0",
                        fontSize: "var(--reader-fs, 18px)",
                        lineHeight: "var(--reader-lh, 1.7)",
                      }}
                    >
                      {renderChunkContent(chunk)}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </article>
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

      {toolbarPosition && (
        <SelectionToolbar
          position={toolbarPosition}
          selectionType="text"
          selectedText={selectedText}
          onAction={handleToolbarAction}
          onHighlight={handleToolbarHighlight}
          onClose={() => setToolbarPosition(null)}
        />
      )}
    </main>
  );
}

const ReaderArea = React.memo(ReaderAreaComponent);
export default ReaderArea;
