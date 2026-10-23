import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import { ActiveParsedWorkspaceResponse } from "../utils/recordStorage";
import { validateParsedBlocks, ParsedAssetManager } from "../utils/parsedDocumentLoader";
import ParsedBlockView from "./ParsedBlock";
import SelectionToolbar from "./SelectionToolbar";
import {
  CardAction,
  CardDepth,
  HighlightRecord,
  ParsedTextLocation,
  SourceAnchorRecord,
  SourceLocationData,
} from "../types/records";
import {
  indexAnchorsByBlock,
  ParsedBlockAnchorEntry,
  validateAndMapDOMSelection,
  createDOMRangeFromProjection,
  getBlockTextProjection,
  resolveDOMBoundaryPoint,
} from "../utils/parsedTextAnchors";
import "./ParsedDocumentPreview.css";

export interface ReflowSelectionSnapshot {
  location: ParsedTextLocation;
  excerpt: string;
  boundDocId?: string;
  boundSeq?: number;
  boundRevision?: string;
  boundParsedVersionId?: string;
}

export interface ParsedReflowJumpTarget {
  requestId: string;
  documentId: string;
  openSeq: number;
  parsedVersionId: string;
  sourceRevision?: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote?: string;
  textHash?: string;
  location?: ParsedTextLocation;
  anchorId?: string;
  timestamp: number;
}

interface ParsedReflowReaderAreaProps {
  workspaceData: ActiveParsedWorkspaceResponse;
  assetManager: ParsedAssetManager;
  isRevisionMismatch?: boolean;
  onToggleView: () => void;
  currentDocTitle?: string;
  initialScrollTop?: number;
  onScrollPositionChange?: (scrollTop: number) => void;
  // 阶段 3A 学习闭环所需接口
  documentId?: string;
  documentSeq?: number;
  sourceRevision?: string;
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
    boundParsedVersionId?: string;
  }) => void;
  onCreateHighlight?: (params: {
    location: SourceLocationData;
    excerpt: string;
    color: string;
    boundDocId?: string;
    boundSeq?: number;
    boundRevision?: string;
    boundParsedVersionId?: string;
  }) => void;
  jumpTarget?: ParsedReflowJumpTarget | null;
  onJumpComplete?: (requestId: string) => void;
  onSelectionChange?: (snapshot: ReflowSelectionSnapshot | null) => void;
}

/** 阅读导航键：位置恢复或跳转期间按下即视为用户接管滚动 */
const READER_NAV_KEYS = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  " ",
]);

function isEditableElement(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof (el as any).tagName !== "string") return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return (el as HTMLElement).isContentEditable === true;
}

function isInsideReaderScope(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (!target || !container) return false;
  if (target === window || target === document) return true;
  const node = target as Node;
  if (typeof (node as any).nodeType !== "number") return false;
  if (node === document.body || node === document.documentElement) return true;
  return container.contains(node);
}

/**
 * 块级高亮覆盖渲染层
 * 纯范围色块覆盖，严禁通过 innerHTML 或 surroundContents 破坏 React / KaTeX DOM
 */
function ParsedBlockHighlightLayer({
  blockId,
  entries,
  activeAnchorId,
  scrollContainerRef,
  resizeVer,
}: {
  blockId: string;
  entries?: ParsedBlockAnchorEntry[];
  activeAnchorId?: string | null;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  resizeVer: number;
}) {
  const [rectGroups, setRectGroups] = useState<
    Array<{
      anchorId: string;
      color: string;
      hasHighlight: boolean;
      rects: Array<{ top: number; left: number; width: number; height: number }>;
    }>
  >([]);

  useLayoutEffect(() => {
    if (!entries || entries.length === 0) {
      setRectGroups([]);
      return;
    }
    const container = scrollContainerRef.current;
    const blockEl = (container || document).querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    if (!blockEl) return;

    const blockRect = blockEl.getBoundingClientRect();
    const proj = getBlockTextProjection(blockEl);
    const newGroups: Array<{
      anchorId: string;
      color: string;
      hasHighlight: boolean;
      rects: Array<{ top: number; left: number; width: number; height: number }>;
    }> = [];

    for (const entry of entries) {
      // 严格校验正文内容一致性：若同 blockId 正文已被替换或修改，绝不绘制错误高亮与注册错误几何
      if (proj.textHash !== entry.textHash) continue;
      if (entry.endOffset > proj.text.length) continue;
      if (proj.text.slice(entry.startOffset, entry.endOffset) !== entry.quote) continue;

      const range = createDOMRangeFromProjection(blockEl, entry.startOffset, entry.endOffset);
      if (!range) continue;

      const clientRects = Array.from(range.getClientRects());
      const rects = clientRects.map((cr) => ({
        top: cr.top - blockRect.top,
        left: cr.left - blockRect.left,
        width: cr.width,
        height: cr.height,
      }));

      if (rects.length > 0) {
        newGroups.push({
          anchorId: entry.anchorId,
          color: entry.color,
          hasHighlight: entry.hasHighlight,
          rects,
        });
      }
    }

    setRectGroups(newGroups);
  }, [entries, activeAnchorId, blockId, scrollContainerRef, resizeVer]);

  if (rectGroups.length === 0) return null;

  return (
    <div
      className="parsed-block-highlights-layer"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      {rectGroups.map((g) => {
        const minTop = Math.min(...g.rects.map((r) => r.top));
        const minLeft = Math.min(...g.rects.map((r) => r.left));
        const maxBottom = Math.max(...g.rects.map((r) => r.top + r.height));
        const maxRight = Math.max(...g.rects.map((r) => r.left + r.width));
        const isActive = activeAnchorId === g.anchorId;

        return (
          <div
            key={g.anchorId}
            className={`parsed-reflow-highlight-group ${isActive ? "is-active" : ""}`}
            data-anchor-id={g.anchorId}
            style={{
              position: "absolute",
              top: `${minTop}px`,
              left: `${minLeft}px`,
              width: `${Math.max(0, maxRight - minLeft)}px`,
              height: `${Math.max(0, maxBottom - minTop)}px`,
              pointerEvents: "none",
            }}
          >
            {(g.hasHighlight || isActive) &&
              g.rects.map((r, i) => (
                <div
                  key={i}
                  className="parsed-reflow-highlight-rect"
                  style={{
                    position: "absolute",
                    top: `${r.top - minTop}px`,
                    left: `${r.left - minLeft}px`,
                    width: `${r.width}px`,
                    height: `${r.height}px`,
                    backgroundColor: g.hasHighlight
                      ? g.color
                      : "rgba(59, 130, 246, 0.15)",
                    boxShadow: isActive ? "0 0 0 1.5px rgba(59, 130, 246, 0.7)" : undefined,
                    borderRadius: "2px",
                    pointerEvents: "none",
                  }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

export default function ParsedReflowReaderArea({
  workspaceData,
  assetManager,
  isRevisionMismatch = false,
  onToggleView,
  currentDocTitle,
  initialScrollTop,
  onScrollPositionChange,
  documentId,
  documentSeq,
  sourceRevision,
  anchors = [],
  highlights = [],
  activeAnchorId,
  onSelectAnchor,
  onVisibleAnchorsChange,
  onCreateAnchorAndCard,
  onCreateHighlight,
  jumpTarget,
  onJumpComplete,
  onSelectionChange,
}: ParsedReflowReaderAreaProps): React.JSX.Element {
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const isRestoringRef = useRef(false);
  const userInteractedRef = useRef(false);

  // 工具条与选区快照
  const [toolbarPosition, setToolbarPosition] = useState<{ top: number; left: number } | null>(
    null
  );
  const [selectedText, setSelectedText] = useState<string>("");
  const selectionSnapshotRef = useRef<ReflowSelectionSnapshot | null>(null);

  // 提示信息 (Toast)
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2800);
  }, []);

  // 跳转闪烁目标
  const [flashTarget, setFlashTarget] = useState<{
    blockId: string;
    rects: Array<{ top: number; left: number; width: number; height: number }>;
  } | null>(null);

  // 窗口 Resize 版本号，通知高亮重新计算物理坐标
  const [resizeVer, setResizeVer] = useState(0);
  useEffect(() => {
    const handleResize = () => setResizeVer((v) => v + 1);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 版本变更时复位状态
  useEffect(() => {
    setLightboxImage(null);
    setToolbarPosition(null);
    selectionSnapshotRef.current = null;
    onSelectionChange?.(null);
  }, [workspaceData.version_id, onSelectionChange]);

  // 按 blockId 高效索引属于当前版本及修订的有效锚点
  const blockAnchorsMap = useMemo(() => {
    return indexAnchorsByBlock(
      anchors,
      highlights,
      workspaceData.version_id,
      sourceRevision || workspaceData.source_revision
    );
  }, [anchors, highlights, workspaceData.version_id, sourceRevision, workspaceData.source_revision]);

  // 首次阅读位置恢复
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      isRestoringRef.current = false;
      return;
    }

    const hasRecord = typeof initialScrollTop === "number" && initialScrollTop > 0;
    const targetTop = hasRecord ? (initialScrollTop as number) : 0;

    isRestoringRef.current = hasRecord;
    userInteractedRef.current = false;

    container.scrollTop = targetTop;
    if (!hasRecord) return;

    if (Math.abs(container.scrollTop - targetTop) <= 2) {
      isRestoringRef.current = false;
      return;
    }

    let ro: ResizeObserver | null = null;
    let timer: any = null;

    function stopRestoration() {
      isRestoringRef.current = false;
      if (ro) {
        ro.disconnect();
        ro = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("keydown", handleKeyDown, true);
    }

    function handleUserInteraction() {
      userInteractedRef.current = true;
      stopRestoration();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!isRestoringRef.current || userInteractedRef.current) return;
      if (!READER_NAV_KEYS.has(event.key)) return;
      if (isEditableElement(event.target)) return;
      if (!isInsideReaderScope(container, event.target)) return;
      handleUserInteraction();
    }

    container.addEventListener("wheel", handleUserInteraction, { passive: true });
    container.addEventListener("touchmove", handleUserInteraction, { passive: true });
    container.addEventListener("pointerdown", handleUserInteraction, { passive: true });
    window.addEventListener("keydown", handleKeyDown, true);

    const contentEl = container.querySelector(".parsed-preview-content-column");
    if (contentEl && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (!isRestoringRef.current || userInteractedRef.current) {
          stopRestoration();
          return;
        }
        container.scrollTop = targetTop;
        if (Math.abs(container.scrollTop - targetTop) <= 2) {
          stopRestoration();
        }
      });
      ro.observe(contentEl);
    }

    timer = setTimeout(() => {
      if (isRestoringRef.current && !userInteractedRef.current && container) {
        container.scrollTop = targetTop;
      }
      stopRestoration();
    }, 1000);

    return () => {
      container.removeEventListener("wheel", handleUserInteraction);
      container.removeEventListener("touchmove", handleUserInteraction);
      container.removeEventListener("pointerdown", handleUserInteraction);
      stopRestoration();
    };
  }, [workspaceData.version_id, initialScrollTop]);

  // 单次跳转目标 (JumpTarget) 调度与生命周期控制
  const lastConsumedJumpRequestIdRef = useRef<string | null>(null);
  const lastConsumedJumpTimestampRef = useRef<number | null>(null);
  const flashTimerRef = useRef<any>(null);
  const jumpCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!jumpTarget) return;
    const reqId = jumpTarget.requestId || String(jumpTarget.timestamp);
    if (reqId === lastConsumedJumpRequestIdRef.current) return;
    if (jumpTarget.timestamp === lastConsumedJumpTimestampRef.current) return;

    if (jumpTarget.documentId && documentId && jumpTarget.documentId !== documentId) return;
    if (jumpTarget.openSeq !== undefined && documentSeq !== undefined && jumpTarget.openSeq !== documentSeq) return;

    lastConsumedJumpRequestIdRef.current = reqId;
    lastConsumedJumpTimestampRef.current = jumpTarget.timestamp;

    // 清理之前的跳转接管监听与闪烁计时器
    if (jumpCleanupRef.current) {
      jumpCleanupRef.current();
      jumpCleanupRef.current = null;
    }
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }

    // 显式跳转开始，终止正在进行的自动阅读位置恢复，避免被拉回
    isRestoringRef.current = false;

    const container = scrollRef.current;
    if (!container) {
      onJumpComplete?.(reqId);
      return;
    }

    // 统一来源版本校验
    const currentRev = sourceRevision || workspaceData.source_revision;
    if (
      jumpTarget.parsedVersionId &&
      workspaceData.version_id &&
      jumpTarget.parsedVersionId !== workspaceData.version_id
    ) {
      showToast(`来源属于历史解析版本 (${jumpTarget.parsedVersionId})，与当前激活版本不符`);
      onJumpComplete?.(reqId);
      return;
    }

    if (jumpTarget.sourceRevision && currentRev && jumpTarget.sourceRevision !== currentRev) {
      showToast(`来源修订版本 (${jumpTarget.sourceRevision}) 与当前文档修订 (${currentRev}) 不符`);
      onJumpComplete?.(reqId);
      return;
    }

    const blockEl = container.querySelector<HTMLElement>(`[data-block-id="${jumpTarget.blockId}"]`);
    if (!blockEl) {
      showToast(`目标结构块 #${jumpTarget.blockId} 不存在`);
      onJumpComplete?.(reqId);
      return;
    }

    const proj = getBlockTextProjection(blockEl);

    // 校验文本哈希（若携带）
    if (jumpTarget.textHash && proj.textHash !== jumpTarget.textHash) {
      showToast("正文内容已变更，无法准确定位");
      onJumpComplete?.(reqId);
      return;
    }

    // 校验偏移合法性
    if (
      jumpTarget.startOffset < 0 ||
      jumpTarget.endOffset > proj.text.length ||
      jumpTarget.startOffset >= jumpTarget.endOffset
    ) {
      showToast("字符偏移超出有效范围");
      onJumpComplete?.(reqId);
      return;
    }

    // 校验引用正文（若携带）
    if (jumpTarget.quote) {
      const actualQuote = proj.text.slice(jumpTarget.startOffset, jumpTarget.endOffset);
      if (actualQuote !== jumpTarget.quote) {
        showToast("引用正文不匹配");
        onJumpComplete?.(reqId);
        return;
      }
    }

    let targetY = blockEl.offsetTop;
    const range = createDOMRangeFromProjection(blockEl, jumpTarget.startOffset, jumpTarget.endOffset);
    let flashRects: Array<{ top: number; left: number; width: number; height: number }> = [];

    if (range) {
      const rangeRect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      targetY = container.scrollTop + (rangeRect.top - containerRect.top) - 100;

      const blockRect = blockEl.getBoundingClientRect();
      flashRects = Array.from(range.getClientRects()).map((cr) => ({
        top: cr.top - blockRect.top,
        left: cr.left - blockRect.left,
        width: cr.width,
        height: cr.height,
      }));
    }

    // 注册跳转期间的用户交互接管：滚轮、触摸、拖拽和导航按键均打断平滑对齐
    let isJumpActive = true;
    function handleUserTakeover(e: Event) {
      if (!isJumpActive) return;
      if (e.type === "keydown") {
        const ke = e as KeyboardEvent;
        if (!READER_NAV_KEYS.has(ke.key)) return;
        if (isEditableElement(ke.target)) return;
        if (!isInsideReaderScope(container, ke.target)) return;
      }
      isJumpActive = false;
      cleanupJump();
    }

    function cleanupJump() {
      isJumpActive = false;
      container?.removeEventListener("wheel", handleUserTakeover);
      container?.removeEventListener("touchmove", handleUserTakeover);
      container?.removeEventListener("pointerdown", handleUserTakeover);
      window.removeEventListener("keydown", handleUserTakeover, true);
    }

    jumpCleanupRef.current = cleanupJump;

    container.addEventListener("wheel", handleUserTakeover, { passive: true });
    container.addEventListener("touchmove", handleUserTakeover, { passive: true });
    container.addEventListener("pointerdown", handleUserTakeover, { passive: true });
    window.addEventListener("keydown", handleUserTakeover, true);

    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: Math.max(0, targetY),
        behavior: "smooth",
      });
    } else {
      container.scrollTop = Math.max(0, targetY);
    }

    if (flashRects.length > 0) {
      setFlashTarget({ blockId: jumpTarget.blockId, rects: flashRects });
      flashTimerRef.current = setTimeout(() => {
        setFlashTarget(null);
        flashTimerRef.current = null;
      }, 2000);
    }

    onJumpComplete?.(reqId);
  }, [
    jumpTarget,
    documentId,
    documentSeq,
    sourceRevision,
    workspaceData.version_id,
    workspaceData.source_revision,
    onJumpComplete,
    showToast,
  ]);

  // 组件卸载时清理跳转接管监听与计时器
  useEffect(() => {
    return () => {
      if (jumpCleanupRef.current) {
        jumpCleanupRef.current();
        jumpCleanupRef.current = null;
      }
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  // 可见锚点检测
  const checkVisibleAnchors = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !onVisibleAnchorsChange) return;
    const containerRect = container.getBoundingClientRect();
    const visibleIds: string[] = [];

    for (const entries of blockAnchorsMap.values()) {
      for (const entry of entries) {
        const el = container.querySelector<HTMLElement>(`[data-anchor-id="${entry.anchorId}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.bottom > containerRect.top && r.top < containerRect.bottom) {
            visibleIds.push(entry.anchorId);
          }
        }
      }
    }

    onVisibleAnchorsChange(visibleIds);
  }, [blockAnchorsMap, onVisibleAnchorsChange]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      if (isRestoringRef.current) return;
      const target = e.currentTarget;
      if (onScrollPositionChange) {
        onScrollPositionChange(target.scrollTop);
      }
      checkVisibleAnchors();
    },
    [onScrollPositionChange, checkVisibleAnchors]
  );

  useEffect(() => {
    checkVisibleAnchors();
  }, [checkVisibleAnchors]);

  // 用户划选监听
  const handleMouseUp = useCallback(() => {
    setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        return;
      }

      const res = validateAndMapDOMSelection(sel, container);
      if (!res.valid) {
        if (res.errorReason && sel.toString().trim().length > 0) {
          showToast(res.errorReason);
        }
        setToolbarPosition(null);
        selectionSnapshotRef.current = null;
        onSelectionChange?.(null);
        return;
      }

      if (isRevisionMismatch) {
        showToast("源文档已变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片");
        setToolbarPosition(null);
        selectionSnapshotRef.current = null;
        onSelectionChange?.(null);
        return;
      }

      const location: ParsedTextLocation = {
        type: "parsed_text",
        schemaVersion: 1,
        parsedVersionId: workspaceData.version_id,
        sourceRevision: workspaceData.source_revision,
        projectionVersion: 1,
        segments: [
          {
            blockId: res.blockId!,
            startOffset: res.startOffset!,
            endOffset: res.endOffset!,
            quote: res.quote!,
            prefix: res.prefix!,
            suffix: res.suffix!,
            textHash: res.textHash!,
          },
        ],
      };

      const snap: ReflowSelectionSnapshot = {
        location,
        excerpt: res.quote!,
        boundDocId: documentId,
        boundSeq: documentSeq,
        boundRevision: sourceRevision || workspaceData.source_revision,
        boundParsedVersionId: workspaceData.version_id,
      };

      selectionSnapshotRef.current = snap;
      onSelectionChange?.(snap);
      setSelectedText(res.quote!);

      const r = res.rangeRect;
      if (r) {
        const showBelow = r.top < 60;
        const top = showBelow ? r.bottom + 10 : r.top - 10;
        const left = r.left + r.width / 2;
        setToolbarPosition({ top, left });
      }
    }, 20);
  }, [
    documentId,
    documentSeq,
    isRevisionMismatch,
    workspaceData.source_revision,
    workspaceData.version_id,
    onSelectionChange,
    showToast,
  ]);

  const mouseDownInfoRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownInfoRef.current = { clientX: e.clientX, clientY: e.clientY };
    const target = e.target as HTMLElement;
    if (target.closest(".floating-selection-toolbar")) {
      return;
    }
    setToolbarPosition(null);
  }, []);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      // 若当前正在划词或有有效选中文本，绝不误触锚点点击
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
        return;
      }

      const down = mouseDownInfoRef.current;
      if (down) {
        const dist = Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY);
        if (dist > 5) return; // 拖选而非纯点击
      }

      const target = e.target as HTMLElement;
      if (
        target.closest(".floating-selection-toolbar") ||
        target.closest("button") ||
        target.closest("a")
      ) {
        return;
      }

      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      if (!blockEl) return;
      const blockId = blockEl.getAttribute("data-block-id");
      if (!blockId) return;

      const entries = blockAnchorsMap.get(blockId);
      if (!entries || entries.length === 0) return;

      // 1. 优先根据 caret 映射的纯净字符偏移命中
      let hitAnchorId: string | null = null;
      let clickProjOffset: number | null = null;

      if (typeof (document as any).caretPositionFromPoint === "function") {
        const pos = (document as any).caretPositionFromPoint(e.clientX, e.clientY);
        if (pos && pos.offsetNode) {
          const proj = getBlockTextProjection(blockEl);
          clickProjOffset = resolveDOMBoundaryPoint(proj, pos.offsetNode, pos.offset, true);
        }
      } else if (typeof document.caretRangeFromPoint === "function") {
        const cr = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (cr) {
          const proj = getBlockTextProjection(blockEl);
          clickProjOffset = resolveDOMBoundaryPoint(proj, cr.startContainer, cr.startOffset, true);
        }
      }

      if (clickProjOffset !== null) {
        for (const entry of entries) {
          if (entry.startOffset <= clickProjOffset && clickProjOffset < entry.endOffset) {
            hitAnchorId = entry.anchorId;
            break;
          }
        }
      }

      // 2. 回退到实际字符行 clientRects 命中（严格排除多行包围矩形空隙）
      if (!hitAnchorId) {
        for (const entry of entries) {
          const range = createDOMRangeFromProjection(blockEl, entry.startOffset, entry.endOffset);
          if (!range) continue;
          const rects = Array.from(range.getClientRects());
          for (const r of rects) {
            if (
              e.clientX >= r.left - 2 &&
              e.clientX <= r.right + 2 &&
              e.clientY >= r.top - 2 &&
              e.clientY <= r.bottom + 2
            ) {
              hitAnchorId = entry.anchorId;
              break;
            }
          }
          if (hitAnchorId) break;
        }
      }

      if (hitAnchorId && onSelectAnchor) {
        onSelectAnchor(hitAnchorId);
      }
    },
    [blockAnchorsMap, onSelectAnchor]
  );

  // 工具条交互
  const handleToolbarAction = (
    action: CardAction,
    customPrompt?: string,
    depth?: CardDepth
  ) => {
    const snap = selectionSnapshotRef.current;
    if (!snap) return;
    if (snap.boundDocId !== documentId || snap.boundSeq !== documentSeq) return;
    if (snap.boundParsedVersionId !== workspaceData.version_id) return;

    if (onCreateAnchorAndCard) {
      onCreateAnchorAndCard({
        location: snap.location,
        excerpt: snap.excerpt,
        action,
        customPrompt,
        depth: depth || "quick",
        boundDocId: snap.boundDocId,
        boundSeq: snap.boundSeq,
        boundRevision: snap.boundRevision,
        boundParsedVersionId: snap.boundParsedVersionId,
      });
    }

    setToolbarPosition(null);
    selectionSnapshotRef.current = null;
    onSelectionChange?.(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleToolbarHighlight = (color: string) => {
    const snap = selectionSnapshotRef.current;
    if (!snap) return;
    if (snap.boundDocId !== documentId || snap.boundSeq !== documentSeq) return;
    if (snap.boundParsedVersionId !== workspaceData.version_id) return;

    if (onCreateHighlight) {
      onCreateHighlight({
        location: snap.location,
        excerpt: snap.excerpt,
        color,
        boundDocId: snap.boundDocId,
        boundSeq: snap.boundSeq,
        boundRevision: snap.boundRevision,
        boundParsedVersionId: snap.boundParsedVersionId,
      });
    }

    setToolbarPosition(null);
    selectionSnapshotRef.current = null;
    onSelectionChange?.(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleCopy = () => {
    if (selectedText) {
      navigator.clipboard.writeText(selectedText);
    }
    setToolbarPosition(null);
  };

  // 校验并渲染文章
  const validation = useMemo(() => {
    try {
      const parsed = JSON.parse(workspaceData.raw_json);
      return validateParsedBlocks(
        parsed,
        workspaceData.blocks_path,
        workspaceData.session_id,
        workspaceData.doc_dir,
        workspaceData.has_assets
      );
    } catch (err: any) {
      return {
        valid: false,
        document: null,
        errors: [`JSON 语法解析失败: ${err?.message || err}`],
        warnings: [],
        stats: {
          totalBlocks: 0,
          renderableBlocks: 0,
          paragraphCount: 0,
          headingCount: 0,
          formulaCount: 0,
          imageCount: 0,
          tableCount: 0,
          captionCount: 0,
          pageHeaderFooterCount: 0,
          unknownCount: 0,
        },
      };
    }
  }, [
    workspaceData.raw_json,
    workspaceData.blocks_path,
    workspaceData.session_id,
    workspaceData.doc_dir,
    workspaceData.has_assets,
  ]);

  const handleEsc = useCallback(() => {
    if (lightboxImage) {
      setLightboxImage(null);
    }
  }, [lightboxImage]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && lightboxImage) {
        e.preventDefault();
        handleEsc();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleEsc, lightboxImage]);

  const doc = validation.document;

  return (
    <div
      className="flowread-parsed-reflow-area"
      role="region"
      aria-label="FlowRead 流式重排阅读区"
      onMouseDown={handleContainerMouseDown}
      onClick={handleContainerClick}
    >
      {/* 顶部控制条 */}
      <div className="parsed-reflow-toolbar">
        <div className="parsed-reflow-toolbar-left">
          <span className="parsed-preview-badge">流式重排</span>
          <span className="parsed-reflow-title" title={workspaceData.blocks_path}>
            {currentDocTitle || "结构化重排文档"}
          </span>
          <span className="parsed-reflow-provider-tag">{workspaceData.provider}</span>
        </div>

        <div className="parsed-reflow-toolbar-right">
          <button
            type="button"
            className="parsed-preview-btn"
            onClick={onToggleView}
            title="返回原版 PDF / 文本版式查看"
          >
            切换至原版视图
          </button>
        </div>
      </div>

      {/* 原文件已更新时的温和提示横幅 */}
      {isRevisionMismatch && (
        <div
          className="parsed-preview-banner is-warning parsed-reflow-revision-warning"
          style={{ margin: "12px 24px 0" }}
        >
          <div>
            <strong>版本提示：</strong>
            <span>
              源文档自解析以来已发生变更（原版本: {workspaceData.source_revision}
              ），重排内容可能与当前物理文件不一致，已禁止新增重排标记
            </span>
          </div>
        </div>
      )}

      {/* 校验错误提示 */}
      {!validation.valid && validation.errors.length > 0 && (
        <div className="parsed-preview-banner is-error" style={{ margin: "16px 24px 0" }}>
          <div>
            <strong>解析数据异常：</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* 浮动提示通知 (Toast) */}
      {toastMessage && (
        <div className="parsed-reflow-toast" role="alert">
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 连续主阅读滚动区 */}
      <main
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        className="parsed-reflow-scroll-area"
        data-reader-viewport="true"
      >
        <div className="parsed-preview-content-column">
          {doc && doc.blocks && (
            <article className="parsed-preview-article">
              {doc.blocks.map((block) => {
                const entries = blockAnchorsMap.get(block.id);
                return (
                  <div key={block.id} className="parsed-reflow-block-wrapper">
                    <ParsedBlockView
                      block={block}
                      assetManager={assetManager}
                      onViewImage={(src, alt) => setLightboxImage({ src, alt })}
                    />
                    <ParsedBlockHighlightLayer
                      blockId={block.id}
                      entries={entries}
                      activeAnchorId={activeAnchorId}
                      scrollContainerRef={scrollRef}
                      resizeVer={resizeVer}
                    />
                    {flashTarget && flashTarget.blockId === block.id && (
                      <div className="parsed-reflow-flash-layer">
                        {flashTarget.rects.map((r, i) => (
                          <div
                            key={i}
                            className="parsed-reflow-flash-rect"
                            style={{
                              top: `${r.top}px`,
                              left: `${r.left}px`,
                              width: `${r.width}px`,
                              height: `${r.height}px`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </article>
          )}
        </div>
      </main>

      {/* 浮动选区工具条 */}
      {toolbarPosition && (
        <SelectionToolbar
          position={toolbarPosition}
          selectionType="text"
          selectedText={selectedText}
          onAction={handleToolbarAction}
          onHighlight={handleToolbarHighlight}
          onCopy={handleCopy}
          onClose={() => setToolbarPosition(null)}
        />
      )}

      {/* 全屏 Lightbox 图片查看 */}
      {lightboxImage && (
        <div
          className="parsed-lightbox-overlay"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="parsed-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="parsed-lightbox-close"
              onClick={() => setLightboxImage(null)}
              title="关闭大图 (Esc)"
            >
              ×
            </button>
            <img src={lightboxImage.src} alt={lightboxImage.alt} className="parsed-lightbox-img" />
            {lightboxImage.alt && (
              <div className="parsed-lightbox-caption">{lightboxImage.alt}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
