import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import ReaderArea, { TextJumpTarget } from "./components/ReaderArea";
import PDFReaderArea, { PDFDocumentStats, PDFJumpTarget } from "./components/PDFReaderArea";
import ReaderMinimap from "./components/ReaderMinimap";
import FloatingAskBar from "./components/FloatingAskBar";
import RightCompanionPanel from "./components/RightCompanionPanel";
import FullAnswerModal from "./components/FullAnswerModal";
import ReadingSettingsModal from "./components/ReadingSettingsModal";
import ModelConfigModal from "./components/SettingsModal";
import PromptConfigModal from "./components/PromptConfigModal";
import WorkspaceExplorerModal from "./components/WorkspaceExplorerModal";
import ConnectionLinesOverlay from "./components/ConnectionLinesOverlay";
import ParsedDocumentPreview, { ParsedPreviewTarget } from "./components/ParsedDocumentPreview";
import ParsedReflowReaderArea, {
  ParsedReflowJumpTarget,
  ReflowSelectionSnapshot,
} from "./components/ParsedReflowReaderArea";
import ParserSettingsModal from "./components/ParserSettingsModal";
import PdfParseImportModal from "./components/PdfParseImportModal";
import ParseJobsPanel from "./components/ParseJobsPanel";

import { ModelProfile, loadAIConfig, saveAIConfig, getActiveModelProfile } from "./utils/aiConfig";
import { PromptConfig, loadPromptConfig, savePromptConfig } from "./utils/promptConfig";
import {
  WorkspaceNode,
  loadWorkspaceNodes,
  saveWorkspaceNodes,
  getTopLevelFolders,
} from "./utils/workspaceManager";
import {
  DocumentRecord,
  CardRecord,
  SourceAnchorRecord,
  HighlightRecord,
  SourceLocationData,
  ParsedTextLocation,
  CardAction,
  CardDepth,
  ReadingPreferences,
} from "./types/records";
import { verifyParsedTextLocation } from "./utils/parsedTextAnchors";
import {
  apiGetOrCreateDocument,
  apiGetReadingPreferences,
  apiSaveReadingPreferences,
  apiGetAnchors,
  apiCreateAnchor,
  apiGetCards,
  apiCreateCard,
  apiDeleteCard,
  apiGetHighlights,
  apiCreateHighlight,
  apiSaveBase64Image,
  apiSaveReadingPosition,
  apiCreateCardTurn,
  apiUpdateCardTurnStream,
  apiUpdateCardStream,
  apiGetCardDetail,
  apiGetAssetDataUrl,
  apiParsedWorkspaceImportDir,
  apiParsedWorkspaceGetActive,
  apiParsedPreviewClose,
  ActiveParsedWorkspaceResponse,
} from "./utils/recordStorage";
import { ParsedAssetManager } from "./utils/parsedDocumentLoader";
import {
  ParseJobDto,
  ParseProvider,
  ParseServiceHealthDto,
  ParseSettings,
} from "./types/parserService";
import {
  ParseJobTracker,
  apiParseJobCancel,
  apiParseJobList,
  apiParseJobListFirstPage,
  apiParseJobResume,
  apiParseJobResult,
  apiParseJobStart,
  apiParseSettingsGet,
} from "./utils/parserService";
import {
  createReflowPositionWriter,
  getPreferredViewMode,
  getReflowScrollTop,
  savePreferredViewMode,
} from "./utils/parsedReadingPreferences";
import { applyTheme, loadGlobalPreferences, saveGlobalPreferences } from "./utils/themeManager";
import { aiDispatcher } from "./utils/aiDispatcher";
import "./App.css";

export default function App(): React.JSX.Element {
  // 阅读器模式：支持纯文本/EPUB 模式 与 PDF 极简流式阅读模式
  const [readerMode, setReaderMode] = useState<"text" | "pdf">("text");
  const readerModeRef = useRef<"text" | "pdf">(readerMode);
  readerModeRef.current = readerMode;
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [textFilePath, setTextFilePath] = useState<string | null>(null);

  // 缩放比例状态（默认 1.35x 高保真视角，由 Ctrl+滚轮 与 Ctrl+/- 动态控制）
  const [scale, setScale] = useState<number>(1.35);
  const scaleRef = useRef<number>(scale);
  scaleRef.current = scale;

  // PDF 文档统计
  const [pdfStats, setPdfStats] = useState<PDFDocumentStats | null>(null);

  // 纯文本文档统计
  const [textDocInfo, setTextDocInfo] = useState<{
    title: string;
    paragraphs: number;
    paragraphLengths?: number[];
  }>({
    title: "在流动中沉思：重新发现数字时代的深度阅读之美",
    paragraphs: 0,
  });

  // 当前已激活的持久化文档身份记录与实时引用（保证异步回调准确识别切书）
  const [currentDoc, setCurrentDoc] = useState<DocumentRecord | null>(null);
  const currentDocRef = useRef<DocumentRecord | null>(null);

  useEffect(() => {
    currentDocRef.current = currentDoc;
  }, [currentDoc]);

  // 文档关联的学习记录、锚点与高亮集合
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [anchors, setAnchors] = useState<SourceAnchorRecord[]>([]);
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);

  const cardsRef = useRef<CardRecord[]>(cards);
  cardsRef.current = cards;
  const anchorsRef = useRef<SourceAnchorRecord[]>(anchors);
  anchorsRef.current = anchors;

  // 当前选中的卡片与锚点激活态
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [visibleAnchorIds, setVisibleAnchorIds] = useState<string[]>([]);

  // 相同可见锚点复用原状态数组引用，消除无变化时的渲染波动与连环反馈
  const handleVisibleAnchorsChange = useCallback((ids: string[]) => {
    setVisibleAnchorIds((prev) => {
      if (prev.length === ids.length && prev.every((v, i) => v === ids[i])) {
        return prev;
      }
      return ids;
    });
  }, []);

  // 大窗卡片 ID 状态 (3:4 完整回答窗口)
  const [fullModalCardId, setFullModalCardId] = useState<string | null>(null);

  // 页面/段落/重排双向跳转目标（一次性可取消请求，带唯一请求ID与文档身份）
  const [pdfJumpTarget, setPdfJumpTarget] = useState<PDFJumpTarget | null>(null);
  const [textJumpTarget, setTextJumpTarget] = useState<TextJumpTarget | null>(null);
  const [parsedReflowJumpTarget, setParsedReflowJumpTarget] = useState<ParsedReflowJumpTarget | null>(null);
  const [reflowSelectionSnapshot, setReflowSelectionSnapshot] = useState<ReflowSelectionSnapshot | null>(null);
  const reflowSelectionSnapshotRef = useRef<ReflowSelectionSnapshot | null>(null);
  reflowSelectionSnapshotRef.current = reflowSelectionSnapshot;
  const reflowOpSeqRef = useRef<number>(0);
  const [globalToast, setGlobalToast] = useState<string | null>(null);
  const latestJumpRequestIdRef = useRef<number>(0);

  const handleJumpComplete = useCallback((completedReqId: string) => {
    setTextJumpTarget((prev) => (prev?.requestId === completedReqId ? null : prev));
    setPdfJumpTarget((prev) => (prev?.requestId === completedReqId ? null : prev));
    setParsedReflowJumpTarget((prev) => (prev?.requestId === completedReqId ? null : prev));
  }, []);

  // 菜单与工作区状态
  const [activeMenu, setActiveMenu] = useState<"workspace" | "tools" | "help" | null>(null);
  const menuBarRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // 伴读栏宽度持久化与动态分栏拖动（保证大窗口在 260px~560px，小窗口受屏幕宽度约束）
  const [companionWidth, setCompanionWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("flowread_companion_panel_width_v1");
      if (saved) {
        const val = parseInt(saved, 10);
        if (Number.isFinite(val)) {
          const maxAllowed = typeof window !== "undefined" ? Math.max(260, window.innerWidth - 420) : 560;
          return Math.min(Math.min(560, maxAllowed), Math.max(260, val));
        }
      }
    } catch {}
    return 340;
  });

  const companionWidthRef = useRef<number>(companionWidth);
  companionWidthRef.current = companionWidth;

  // 窗口变窄时自动约束伴读宽度落在有效范围
  useEffect(() => {
    const handleResize = () => {
      setCompanionWidth((prev) => {
        const maxAllowed = Math.max(260, window.innerWidth - 420);
        const clamped = Math.min(Math.min(560, maxAllowed), Math.max(260, prev));
        return clamped;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 拖动分栏手柄调整伴读栏宽度并通知关联连线实时重排
  const handleSplitterPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const targetEl = e.currentTarget;
    try {
      targetEl.setPointerCapture(e.pointerId);
    } catch {}

    const startX = e.clientX;
    const startW = companionWidthRef.current;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // 向左拖动增加伴读栏宽度，向右拖动减小伴读栏宽度
      const nextW = startW - deltaX;
      const maxAllowed = Math.max(260, window.innerWidth - 420);
      const clamped = Math.min(Math.min(560, maxAllowed), Math.max(260, nextW));

      setCompanionWidth(clamped);
      try {
        localStorage.setItem("flowread_companion_panel_width_v1", String(clamped));
      } catch {}
      window.dispatchEvent(new CustomEvent("flowread:layout-updated"));
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      try {
        targetEl.releasePointerCapture(upEvent.pointerId);
      } catch {}
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.dispatchEvent(new CustomEvent("flowread:layout-updated"));
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }, []);

  // 工作区节点持久化管理
  const [workspaceNodes, setWorkspaceNodes] = useState<WorkspaceNode[]>(() => loadWorkspaceNodes());
  const [isWorkspaceExplorerOpen, setIsWorkspaceExplorerOpen] = useState<boolean>(false);
  const [explorerInitialFolderId, setExplorerInitialFolderId] = useState<string | null>(null);

  // 模型配置模态框
  const [aiConfig, setAiConfig] = useState<ModelProfile>(() => loadAIConfig());
  const [isModelConfigOpen, setIsModelConfigOpen] = useState<boolean>(false);

  // 提示词工程模态框
  const [promptConfig, setPromptConfig] = useState<PromptConfig>(() => loadPromptConfig());
  const [isPromptConfigOpen, setIsPromptConfigOpen] = useState<boolean>(false);

  // 阅读外观与排版设置模态框
  const [readingPrefs, setReadingPrefs] = useState<ReadingPreferences>(() => loadGlobalPreferences());
  const readingPrefsRef = useRef<ReadingPreferences>(readingPrefs);
  readingPrefsRef.current = readingPrefs;
  const [isReadingSettingsOpen, setIsReadingSettingsOpen] = useState<boolean>(false);

  // 阶段 2A 解析结果只读预览临时层状态
  const [parsedPreviewTarget, setParsedPreviewTarget] = useState<ParsedPreviewTarget | null>(null);
  const parsedPreviewTargetRef = useRef<ParsedPreviewTarget | null>(null);
  parsedPreviewTargetRef.current = parsedPreviewTarget;

  // 阶段 2B 隐式重排工作区与文档级视图模式 ("original" | "reflow")
  const [viewMode, setViewMode] = useState<"original" | "reflow">("original");
  const viewModeRef = useRef<"original" | "reflow">(viewMode);
  viewModeRef.current = viewMode;
  const [activeParsedWorkspace, setActiveParsedWorkspace] = useState<ActiveParsedWorkspaceResponse | null>(null);
  const parsedWorkspaceAssetManagerRef = useRef<ParsedAssetManager | null>(null);
  const activeParsedWorkspaceRef = useRef<ActiveParsedWorkspaceResponse | null>(null);
  activeParsedWorkspaceRef.current = activeParsedWorkspace;
  const importBusyTokenRef = useRef<symbol | null>(null);
  const parsedOpSeqRef = useRef<number>(0);
  const reflowScrollTopMapRef = useRef<Record<string, number>>({});
  const isAppMountedRef = useRef<boolean>(true);

  // PDF 云端解析：设置、导入面板、任务面板与轻提示
  const [parseSettings, setParseSettings] = useState<ParseSettings | null>(null);
  const [isParserSettingsOpen, setIsParserSettingsOpen] = useState<boolean>(false);
  const [parserSettingsFocus, setParserSettingsFocus] = useState<ParseProvider | null>(null);
  const [isPdfParseImportOpen, setIsPdfParseImportOpen] = useState<boolean>(false);
  const [pdfParseTarget, setPdfParseTarget] = useState<{ filePath: string; fileName: string } | null>(null);
  const [parseSubmitting, setParseSubmitting] = useState<boolean>(false);
  const [parseSubmitError, setParseSubmitError] = useState<string | null>(null);
  const [isParseJobsOpen, setIsParseJobsOpen] = useState<boolean>(false);
  const [parseJobs, setParseJobs] = useState<ParseJobDto[]>([]);
  const [parseJobsNextCursor, setParseJobsNextCursor] = useState<string | null>(null);
  const [parseJobsLoading, setParseJobsLoading] = useState<boolean>(false);
  const [parseJobsLoadingMore, setParseJobsLoadingMore] = useState<boolean>(false);
  const [parseJobsError, setParseJobsError] = useState<string | null>(null);
  const [parseBusyJobIds, setParseBusyJobIds] = useState<string[]>([]);
  const [parseNotice, setParseNotice] = useState<string | null>(null);
  const [parseServiceHealth, setParseServiceHealth] = useState<ParseServiceHealthDto | null>(null);
  /** 当前解析预览是否来自任务结果（该入口禁止“绑定到当前文档”） */
  const [previewFromJob, setPreviewFromJob] = useState<boolean>(false);

  const parseTrackerRef = useRef<ParseJobTracker | null>(null);
  const parseSubmitTokenRef = useRef<symbol | null>(null);
  /** 指向最新的任务终态处理函数，避免订阅回调闭包过期 */
  const handleParseJobTerminalRef = useRef<(job: ParseJobDto) => void>(() => {});
  /** 本会话提交的任务：提交时的自动打开意愿、文档打开代次与视图操作代次 */
  const submittedJobMetaRef = useRef<
    Map<
      string,
      {
        openAfter: boolean;
        docSeq: number;
        docId: string | null;
        revision: string;
        viewModeSeq: number;
        openPromise?: Promise<DocumentRecord | null>;
      }
    >
  >(new Map());
  const handledSuccessKeysRef = useRef<Set<string>>(new Set());
  const handledFailedKeysRef = useRef<Set<string>>(new Set());
  /** 用户每次手动切换视图都递增，用于判断“任务完成后是否还能自动切重排” */
  const viewModeManualSeqRef = useRef<number>(0);
  const reflowPositionWriterRef = useRef(createReflowPositionWriter(400));

  // 挂载与卸载生命周期（兼容 React.StrictMode 重复挂载）
  useEffect(() => {
    isAppMountedRef.current = true;
    return () => {
      isAppMountedRef.current = false;
      // 卸载时把尚未落盘的重排位置写回（快照自带文档身份，不会写到别的书上）
      reflowPositionWriterRef.current.flush();
      if (parsedWorkspaceAssetManagerRef.current) {
        parsedWorkspaceAssetManagerRef.current.dispose();
        parsedWorkspaceAssetManagerRef.current = null;
      }
    };
  }, []);

  // 应用级单一解析任务轮询：面板关闭后仍继续跟踪本会话启动的任务
  useEffect(() => {
    const tracker = new ParseJobTracker();
    parseTrackerRef.current = tracker;

    const unsubscribeJobs = tracker.subscribeJobs((jobs) => {
      setParseJobs(jobs);
      for (const job of jobs) {
        if (!job) continue;
        if (job.status === "succeeded") {
          const key = `${job.job_id}:${job.version_id || "succeeded"}`;
          if (handledSuccessKeysRef.current.has(key)) continue;
          handledSuccessKeysRef.current.add(key);
          handleParseJobTerminalRef.current(job);
        } else if (job.status === "failed") {
          const key = `${job.job_id}:${job.update_seq ?? 0}`;
          if (handledFailedKeysRef.current.has(key)) continue;
          handledFailedKeysRef.current.add(key);
          handleParseJobTerminalRef.current(job);
        }
      }
    });
    const unsubscribeError = tracker.subscribeError((message) => {
      setParseJobsError(message);
    });
    const unsubscribeHealth = tracker.subscribeHealth((health) => {
      setParseServiceHealth(health);
    });

    tracker.start();

    return () => {
      unsubscribeJobs();
      unsubscribeError();
      unsubscribeHealth();
      tracker.stop();
      if (parseTrackerRef.current === tracker) {
        parseTrackerRef.current = null;
      }
    };
  }, []);

  // 检查源文档自解析以来是否已发生版本哈希变更
  const isRevisionMismatch = useMemo(() => {
    if (!currentDoc || !activeParsedWorkspace) return false;
    const docRev = (currentDoc.revision || "").trim();
    const parsedRev = (activeParsedWorkspace.source_revision || "").trim();
    if (!docRev || !parsedRev) return false;
    return docRev !== parsedRev;
  }, [currentDoc, activeParsedWorkspace]);

  // 检查重排视图下是否存在有效来源（当前版本快照或当前版本的活跃重排锚点）
  const hasValidReflowSource = useMemo(() => {
    if (reflowSelectionSnapshot) return true;
    if (!activeAnchorId) return false;
    const anc = anchors.find((a) => a.anchor_id === activeAnchorId);
    if (!anc || anc.source_type !== "parsed_text") return false;
    try {
      const loc = JSON.parse(anc.location_json);
      return loc?.parsedVersionId === activeParsedWorkspace?.version_id;
    } catch {
      return false;
    }
  }, [reflowSelectionSnapshot, activeAnchorId, anchors, activeParsedWorkspace]);

  /**
   * 用户主动切换视图：记录“手动操作”代次（用于阻止旧任务完成时强制切回重排），
   * 并按 document_id 持久化到独立存储，供重启后恢复。
   */
  const handleSetViewMode = useCallback((mode: "original" | "reflow") => {
    viewModeManualSeqRef.current += 1;
    reflowOpSeqRef.current += 1;
    reflowSelectionSnapshotRef.current = null;
    setReflowSelectionSnapshot(null);
    setViewMode(mode);
    const doc = currentDocRef.current;
    if (doc) savePreferredViewMode(doc.id, mode);
  }, []);

  const activeMenuRef = useRef(activeMenu);
  activeMenuRef.current = activeMenu;

  const isAnyModalOpenRef = useRef(false);
  isAnyModalOpenRef.current =
    isWorkspaceExplorerOpen ||
    isModelConfigOpen ||
    isPromptConfigOpen ||
    isReadingSettingsOpen ||
    fullModalCardId !== null ||
    parsedPreviewTarget !== null ||
    isParserSettingsOpen ||
    isPdfParseImportOpen ||
    isParseJobsOpen;

  const handleImportOrOpenFileRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // 初始化应用主题
  useEffect(() => {
    applyTheme(readingPrefs);
  }, [readingPrefs]);

  const openSequenceRef = useRef<number>(0);

  // 辅助函数：判断两个来源锚点是否位于完全一致的几何/字符位置
  const isSameLocation = (loc1: SourceLocationData, loc2Json: string): boolean => {
    try {
      const loc2 = JSON.parse(loc2Json) as SourceLocationData;
      if (loc1.type !== loc2.type) return false;
      if (loc1.type === "pdf_text" && loc2.type === "pdf_text") {
        if (loc1.segments.length !== loc2.segments.length) return false;
        return loc1.segments.every((s1, i) => {
          const s2 = loc2.segments[i];
          return (
            s1.pageNumber === s2.pageNumber &&
            JSON.stringify(s1.rects) === JSON.stringify(s2.rects)
          );
        });
      }
      if (loc1.type === "pdf_image" && loc2.type === "pdf_image") {
        return (
          loc1.location.pageNumber === loc2.location.pageNumber &&
          JSON.stringify(loc1.location.rect) === JSON.stringify(loc2.location.rect)
        );
      }
      if (loc1.type === "text_segment" && loc2.type === "text_segment") {
        if (loc1.segments.length !== loc2.segments.length) return false;
        return loc1.segments.every((s1, i) => {
          const s2 = loc2.segments[i];
          return (
            s1.paragraphIndex === s2.paragraphIndex &&
            s1.startOffset === s2.startOffset &&
            s1.endOffset === s2.endOffset
          );
        });
      }
      if (loc1.type === "parsed_text" && loc2.type === "parsed_text") {
        if (loc1.parsedVersionId !== loc2.parsedVersionId) return false;
        if (loc1.segments.length !== loc2.segments.length) return false;
        return loc1.segments.every((s1, i) => {
          const s2 = loc2.segments[i];
          return (
            s1.blockId === s2.blockId &&
            s1.startOffset === s2.startOffset &&
            s1.endOffset === s2.endOffset
          );
        });
      }
    } catch {
      return false;
    }
    return false;
  };

  // 订阅解耦的 AI 请求调度引擎流式更新
  useEffect(() => {
    const unsubscribe = aiDispatcher.subscribe((update) => {
      // 追问轮次（turnId 存在）绝不覆盖卡片初答 cards.ai_response！
      if (update.turnId) {
        setCards((prev) =>
          prev.map((c) => {
            if (c.card_id === update.cardId) {
              return { ...c, updated_at: Date.now() };
            }
            return c;
          })
        );
        return;
      }

      setCards((prev) =>
        prev.map((c) => {
          if (c.card_id === update.cardId) {
            return {
              ...c,
              ai_response: update.accumulatedText,
              status: update.status,
              error_message: update.errorMessage || null,
              updated_at: Date.now(),
            };
          }
          return c;
        })
      );
    });
    return () => unsubscribe();
  }, []);

  /**
   * 打开文档入口：立即建立目标路径与打开序号，
   * 元数据获取、数据库身份和正文加载结果共同校验该次打开序号，杜绝慢元数据覆盖新文档
   */
  const openDocument = useCallback(
    async (
      filePath: string,
      options?: {
        displayName?: string;
        mode?: "text" | "pdf";
        fileSize?: number;
        revision?: string;
      }
    ): Promise<DocumentRecord | null> => {
      // 1. 立即递增打开序号，建立目标路径与模式
      const seq = ++openSequenceRef.current;
      // 同时在打开操作建立时固定本次初始化流程的解析操作身份：
      // 后续阶段（元数据、偏好、卡片）都可能有延迟，若等到发出 getActive 前才递增，
      // 用户在这段时间内发起导入会被这条迟启动的初始化查询反向淘汰。
      const parsedOpId = ++parsedOpSeqRef.current;
      const ext = filePath.split(".").pop()?.toLowerCase() || "";
      const targetMode: "text" | "pdf" = options?.mode || (ext === "pdf" ? "pdf" : "text");
      const displayName = options?.displayName || filePath.split(/[/\\]/).pop() || "未命名文档";

      // 2. 如果已有旧文档，先结算并取消其正在进行的请求，保存阅读位置
      if (currentDocRef.current) {
        aiDispatcher.cancelAllForDocument(currentDocRef.current.id);
        void apiSaveReadingPosition(
          currentDocRef.current.id,
          JSON.stringify({ scale: scaleRef.current, readerMode: readerModeRef.current })
        );
      }

      // 清理前一个文档的隐式解析工作区资产与重排状态
      // 切书前先把尚未落盘的重排位置写回（快照持有旧文档身份）
      reflowPositionWriterRef.current.flush();
      if (parsedWorkspaceAssetManagerRef.current) {
        parsedWorkspaceAssetManagerRef.current.dispose();
        parsedWorkspaceAssetManagerRef.current = null;
      }
      setActiveParsedWorkspace(null);
      setViewMode("original");

      // 3. 立即重置旧文档身份与关联数据，废弃任何进行中的跳转请求，避免身份未就绪时新书操作登记到旧书
      latestJumpRequestIdRef.current++;
      reflowOpSeqRef.current++;
      setTextJumpTarget(null);
      setPdfJumpTarget(null);
      setParsedReflowJumpTarget(null);
      setReflowSelectionSnapshot(null);
      reflowSelectionSnapshotRef.current = null;
      currentDocRef.current = null;
      setCurrentDoc(null);
      setCards([]);
      setAnchors([]);
      setHighlights([]);
      setActiveCardId(null);
      setActiveAnchorId(null);

      // 4. 同步切换显示路径与阅读模式（携带最新 openSequenceRef.current）
      setReaderMode(targetMode);
      if (targetMode === "pdf") {
        setPdfPath(filePath);
      } else {
        setTextFilePath(filePath);
      }

      // 5. 异步获取文件元数据（校验 seq）
      let sizeBytes = options?.fileSize || 0;
      let revision = options?.revision || "";
      if (!revision && !filePath.startsWith("flowread://")) {
        try {
          const meta = await invoke<{ size: number; mtime: number; revision: string }>(
            "get_file_metadata",
            { path: filePath }
          );
          if (seq !== openSequenceRef.current) return null;
          sizeBytes = meta.size;
          revision = meta.revision;
        } catch (err) {
          if (seq !== openSequenceRef.current) return null;
          console.warn("[FlowRead] 获取文件元数据失败:", err);
        }
      }

      if (seq !== openSequenceRef.current) return null;

      try {
        // 6. 从 SQLite 获取或创建文档身份（校验 seq）
        const doc = await apiGetOrCreateDocument(filePath, displayName, sizeBytes, revision);
        if (seq !== openSequenceRef.current) return null;
        currentDocRef.current = doc;
        setCurrentDoc(doc);

        // 7. 读取该文档的阅读偏好并应用（校验 seq）
        const prefs = await apiGetReadingPreferences(doc.id);
        if (seq !== openSequenceRef.current) return null;
        setReadingPrefs(prefs);
        applyTheme(prefs);

        // 8. 读取锚点、卡片列表、高亮列表（校验 seq）
        const [loadedAnchors, cardListRes, loadedHighlights] = await Promise.all([
          apiGetAnchors(doc.id),
          apiGetCards(doc.id, 100, 0, "all"),
          apiGetHighlights(doc.id),
        ]);
        if (seq !== openSequenceRef.current) return null;

        setAnchors(loadedAnchors);
        setCards(cardListRes.items);
        setHighlights(loadedHighlights);
        setActiveCardId(cardListRes.items[0]?.card_id || null);

        // 9. 查询该文档是否有已激活的隐式重排版本
        // 复用打开操作建立时固定的 parsedOpId：延迟结束后不得重新取得更高优先级的代次，
        // 用户在初始化期间发起的导入会递增代次，使这条旧查询（含尚未发出的查询）整体失效。
        try {
          const activeParsed = await apiParsedWorkspaceGetActive(doc.id);
          const isStale =
            !isAppMountedRef.current ||
            seq !== openSequenceRef.current ||
            currentDocRef.current?.id !== doc.id ||
            parsedOpId !== parsedOpSeqRef.current;

          if (isStale) {
            if (activeParsed?.session_id) {
              void apiParsedPreviewClose(activeParsed.session_id).catch(() => {});
            }
            return doc;
          }

          if (activeParsed) {
            const prevMgr = parsedWorkspaceAssetManagerRef.current as ParsedAssetManager | null;
            if (prevMgr) {
              prevMgr.dispose();
            }
            parsedWorkspaceAssetManagerRef.current = new ParsedAssetManager(activeParsed.session_id);
            reflowOpSeqRef.current++;
            reflowSelectionSnapshotRef.current = null;
            setReflowSelectionSnapshot(null);
            activeParsedWorkspaceRef.current = activeParsed;
            setActiveParsedWorkspace(activeParsed);
            // 重启/重新打开时恢复上次选择的视图模式（仅在重排资源仍然有效时）
            setViewMode(getPreferredViewMode(doc.id) === "reflow" ? "reflow" : "original");
          } else {
            const prevMgr = parsedWorkspaceAssetManagerRef.current as ParsedAssetManager | null;
            if (prevMgr) {
              prevMgr.dispose();
              parsedWorkspaceAssetManagerRef.current = null;
            }
            activeParsedWorkspaceRef.current = null;
            setActiveParsedWorkspace(null);
            setViewMode("original");
            // 上次选择重排但资源已不可用：回到原版并明确提示
            if (getPreferredViewMode(doc.id) === "reflow") {
              savePreferredViewMode(doc.id, "original");
              setParseNotice("上次使用的流式重排版本已不可用，已回到原版视图。");
            }
          }
        } catch (err) {
          const isStale =
            !isAppMountedRef.current ||
            seq !== openSequenceRef.current ||
            currentDocRef.current?.id !== doc.id ||
            parsedOpId !== parsedOpSeqRef.current;
          if (isStale) return doc;
          console.warn("[FlowRead] 检查当前文档隐式解析工作区失败:", err);
          setActiveParsedWorkspace(null);
          setViewMode("original");
        }
        return doc;
      } catch (err) {
        if (seq !== openSequenceRef.current) return null;
        console.error("[FlowRead] 载入文档身份失败:", err);
        return null;
      }
    },
    []
  );

  // 首屏初始化默认书籍文档：仅在首次启动时执行一次，普通缩放、切书和模式切换绝不重新初始化
  const hasInitializedIntroRef = useRef<boolean>(false);
  useEffect(() => {
    if (hasInitializedIntroRef.current) return;
    hasInitializedIntroRef.current = true;
    const defaultVirtualPath = "flowread://default_reading_intro";
    void openDocument(defaultVirtualPath, {
      displayName: "在流动中沉思：重新发现数字时代的深度阅读之美",
      mode: "text",
      revision: "v1",
    });
  }, [openDocument]);

  /**
   * 创建来源锚点并创建卡片，发起真实 AI 请求（严格绑定文档身份与序号，防切书覆盖）
   */
  const handleCreateAnchorAndCard = useCallback(
    async (params: {
      location: SourceLocationData;
      excerpt: string;
      action: CardAction;
      customPrompt?: string;
      depth?: CardDepth;
      imageBase64?: string;
      boundDocId?: string;
      boundSeq?: number;
      boundRevision?: string;
      boundParsedVersionId?: string;
      boundReflowOpSeq?: number;
    }) => {
      const targetDoc = currentDocRef.current;
      if (!targetDoc) return;
      if (!params.boundDocId || params.boundDocId !== targetDoc.id) return;
      const targetDocId = targetDoc.id;
      const seq = params.boundSeq;
      if (seq === undefined || openSequenceRef.current !== seq) return;
      if (params.boundRevision && targetDoc.revision && params.boundRevision !== targetDoc.revision) return;
      if (params.boundParsedVersionId) {
        if (!activeParsedWorkspaceRef.current || activeParsedWorkspaceRef.current.version_id !== params.boundParsedVersionId) {
          return;
        }
      }

      let anchorId: string | null = null;
      let finalLocation = params.location;

      // 统一校验重排来源身份、版本一致性与正文内容哈希
      if (finalLocation.type === "parsed_text") {
        if (viewModeRef.current !== "reflow") return;
        if (params.boundReflowOpSeq !== undefined && params.boundReflowOpSeq !== reflowOpSeqRef.current) return;
        const activeWorkspace = activeParsedWorkspaceRef.current;
        if (!activeWorkspace || activeWorkspace.version_id !== params.boundParsedVersionId) return;

        const docRev = (targetDoc.revision || "").trim();
        const workspaceRev = (activeWorkspace.source_revision || "").trim();
        const locRev = ((finalLocation as ParsedTextLocation).sourceRevision || "").trim();

        if (
          (docRev && workspaceRev && docRev !== workspaceRev) ||
          (docRev && locRev && docRev !== locRev) ||
          (workspaceRev && locRev && workspaceRev !== locRev)
        ) {
          setGlobalToast("源文档自解析以来已发生变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片");
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }

        const verifyRes = verifyParsedTextLocation(
          document.querySelector(".parsed-reflow-scroll-area"),
          activeWorkspace.version_id,
          workspaceRev,
          finalLocation,
          params.excerpt
        );
        if (!verifyRes.valid) {
          setGlobalToast(`来源校验失败: ${verifyRes.failReason || "内容不匹配"}`);
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }
      }

      const isReflowStale = () =>
        finalLocation.type === "parsed_text" &&
        (viewModeRef.current !== "reflow" ||
          (params.boundReflowOpSeq !== undefined && params.boundReflowOpSeq !== reflowOpSeqRef.current) ||
          activeParsedWorkspaceRef.current?.version_id !== params.boundParsedVersionId);

      // 如果为图像裁切，先保存二进制文件至 app data assets
      if (params.imageBase64) {
        try {
          const assetId = await apiSaveBase64Image(targetDocId, "crop.jpg", params.imageBase64);
          if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;
          if (finalLocation.type === "pdf_image") {
            finalLocation = {
              type: "pdf_image",
              location: {
                ...finalLocation.location,
                assetId,
              },
            };
          }
        } catch (err) {
          console.warn("[FlowRead] 保存裁剪图像资产失败:", err);
        }
      }

      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;

      // 检查是否存在同文档、同版本、同类型且同真实位置的锚点，严格复用
      const existingAnchor = anchorsRef.current.find(
        (a) =>
          a.document_id === targetDocId &&
          a.document_revision === targetDoc.revision &&
          a.source_type === finalLocation.type &&
          a.excerpt === params.excerpt &&
          isSameLocation(finalLocation, a.location_json)
      );

      if (existingAnchor) {
        anchorId = existingAnchor.anchor_id;
      } else {
        anchorId = await apiCreateAnchor(
          targetDocId,
          targetDoc.revision,
          finalLocation,
          params.excerpt
        );
        if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;
        const newAnchorRecord: SourceAnchorRecord = {
          anchor_id: anchorId,
          document_id: targetDocId,
          document_revision: targetDoc.revision,
          source_type: finalLocation.type,
          location_json: JSON.stringify(finalLocation),
          excerpt: params.excerpt,
          created_at: Date.now(),
        };
        setAnchors((prev) => [...prev, newAnchorRecord]);
      }

      const activeProfile = getActiveModelProfile();
      const depth = params.depth || readingPrefsRef.current.defaultDepth || "quick";

      // 创建 SQLite 持久卡片记录
      const cardId = await apiCreateCard({
        documentId: targetDocId,
        anchorId,
        action: params.action,
        depth,
        status: "queued",
        userPrompt: params.customPrompt || "",
        aiResponse: "",
        modelName: activeProfile.modelName,
      });

      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) {
        // 创建记录后因切书或切回原版而放弃入队的 queued 记录，同样需要结算，不能留下永远等待的任务
        void apiUpdateCardStream(cardId, "", "interrupted");
        return;
      }

      const newCardRecord: CardRecord = {
        card_id: cardId,
        document_id: targetDocId,
        anchor_id: anchorId,
        action: params.action,
        depth,
        status: "queued",
        user_prompt: params.customPrompt || "",
        ai_response: "",
        preview: "",
        error_message: null,
        model_name: activeProfile.modelName,
        created_at: Date.now(),
        updated_at: Date.now(),
        turns_count: 0,
        anchor_excerpt: params.excerpt,
        anchor_source_type: finalLocation.type,
        anchor_location_json: JSON.stringify(finalLocation),
      };

      setCards((prev) => [newCardRecord, ...prev]);
      setActiveCardId(cardId);
      setActiveAnchorId(anchorId);

      // 发送真实 AI 请求到调度器（若已切书或切回原版，不入队）
      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;

      aiDispatcher.enqueue({
        jobId: cardId,
        cardId,
        documentId: targetDocId,
        action: params.action,
        depth,
        userPrompt: params.customPrompt || "",
        contextExcerpt: params.excerpt,
        imageBase64: params.imageBase64,
      });
    },
    []
  );

  /**
   * 创建划词高亮（纯高亮记录，零 AI 请求，按需增量更新锚点）
   */
  const handleCreateHighlight = useCallback(
    async (params: {
      location: SourceLocationData;
      excerpt: string;
      color: string;
      boundDocId?: string;
      boundSeq?: number;
      boundRevision?: string;
      boundParsedVersionId?: string;
      boundReflowOpSeq?: number;
    }) => {
      const targetDoc = currentDocRef.current;
      if (!targetDoc) return;
      if (!params.boundDocId || params.boundDocId !== targetDoc.id) return;
      const targetDocId = targetDoc.id;
      const seq = params.boundSeq;
      if (seq === undefined || openSequenceRef.current !== seq) return;
      if (params.boundRevision && targetDoc.revision && params.boundRevision !== targetDoc.revision) return;
      if (params.boundParsedVersionId) {
        if (!activeParsedWorkspaceRef.current || activeParsedWorkspaceRef.current.version_id !== params.boundParsedVersionId) {
          return;
        }
      }

      // 统一校验重排来源身份、版本一致性与正文内容哈希
      if (params.location.type === "parsed_text") {
        if (viewModeRef.current !== "reflow") return;
        if (params.boundReflowOpSeq !== undefined && params.boundReflowOpSeq !== reflowOpSeqRef.current) return;
        const activeWorkspace = activeParsedWorkspaceRef.current;
        if (!activeWorkspace || activeWorkspace.version_id !== params.boundParsedVersionId) return;

        const docRev = (targetDoc.revision || "").trim();
        const workspaceRev = (activeWorkspace.source_revision || "").trim();
        const locRev = ((params.location as ParsedTextLocation).sourceRevision || "").trim();

        if (
          (docRev && workspaceRev && docRev !== workspaceRev) ||
          (docRev && locRev && docRev !== locRev) ||
          (workspaceRev && locRev && workspaceRev !== locRev)
        ) {
          setGlobalToast("源文档自解析以来已发生变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片");
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }

        const verifyRes = verifyParsedTextLocation(
          document.querySelector(".parsed-reflow-scroll-area"),
          activeWorkspace.version_id,
          workspaceRev,
          params.location,
          params.excerpt
        );
        if (!verifyRes.valid) {
          setGlobalToast(`来源校验失败: ${verifyRes.failReason || "内容不匹配"}`);
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }
      }

      const isReflowStale = () =>
        params.location.type === "parsed_text" &&
        (viewModeRef.current !== "reflow" ||
          (params.boundReflowOpSeq !== undefined && params.boundReflowOpSeq !== reflowOpSeqRef.current) ||
          activeParsedWorkspaceRef.current?.version_id !== params.boundParsedVersionId);

      let anchorId: string;
      const existing = anchorsRef.current.find(
        (a) =>
          a.document_id === targetDocId &&
          a.document_revision === targetDoc.revision &&
          a.source_type === params.location.type &&
          a.excerpt === params.excerpt &&
          isSameLocation(params.location, a.location_json)
      );

      if (existing) {
        anchorId = existing.anchor_id;
      } else {
        anchorId = await apiCreateAnchor(
          targetDocId,
          targetDoc.revision,
          params.location,
          params.excerpt
        );
        if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;
        const newAnchorRecord: SourceAnchorRecord = {
          anchor_id: anchorId,
          document_id: targetDocId,
          document_revision: targetDoc.revision,
          source_type: params.location.type,
          location_json: JSON.stringify(params.location),
          excerpt: params.excerpt,
          created_at: Date.now(),
        };
        setAnchors((prev) => [...prev, newAnchorRecord]);
      }

      const hlId = await apiCreateHighlight(targetDocId, anchorId, params.color);
      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId || isReflowStale()) return;
      const newHlRecord: HighlightRecord = {
        highlight_id: hlId,
        document_id: targetDocId,
        anchor_id: anchorId,
        color: params.color,
        created_at: Date.now(),
        excerpt: params.excerpt,
        location_json: JSON.stringify(params.location),
        source_type: params.location.type,
      };
      setHighlights((prev) => [newHlRecord, ...prev]);
    },
    []
  );

  /**
   * 右侧面板底部提问 (Ask)
   */
  const handleBottomAsk = async (prompt: string, depth: CardDepth) => {
    // 严格在读取图片前固定 documentId、来源锚点和打开序号
    const targetDoc = currentDocRef.current;
    if (!targetDoc) return;
    const targetDocId = targetDoc.id;
    const seq = openSequenceRef.current;

    // 流式重排视图下的提问：必须基于重排选区或已有重排锚点，绝不伪造第 0 段
    if (viewModeRef.current === "reflow") {
      const snapshot = reflowSelectionSnapshotRef.current;
      const targetAnchor = anchors.find(
        (a) => a.anchor_id === activeAnchorId && a.source_type === "parsed_text"
      );

      if (!snapshot && !targetAnchor) {
        setGlobalToast("请先在重排正文中选择一段文字，然后再发起提问");
        setTimeout(() => setGlobalToast(null), 3000);
        return;
      }

      const activeWorkspace = activeParsedWorkspaceRef.current;
      if (!activeWorkspace) {
        setGlobalToast("当前重排工作区不可用");
        setTimeout(() => setGlobalToast(null), 3000);
        return;
      }

      let locationToUse: ParsedTextLocation;
      let excerptToUse: string;

      if (snapshot) {
        locationToUse = snapshot.location;
        excerptToUse = snapshot.excerpt;
      } else {
        try {
          locationToUse = JSON.parse(targetAnchor!.location_json) as ParsedTextLocation;
          excerptToUse = targetAnchor!.excerpt;
        } catch {
          setGlobalToast("解析活跃锚点来源数据失败");
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }
      }

      // 校验解析版本
      if (locationToUse.parsedVersionId !== activeWorkspace.version_id) {
        setGlobalToast("所选内容属于历史解析版本，当前视图禁止基于历史版本新增卡片");
        setTimeout(() => setGlobalToast(null), 3000);
        return;
      }

      // 统一源文档修订版本校验：无论快照还是已有锚点，均核对真实源修订
      const docRev = (targetDoc.revision || "").trim();
      const workspaceRev = (activeWorkspace.source_revision || "").trim();
      const sourceRev = (locationToUse.sourceRevision || "").trim();

      if (
        (docRev && workspaceRev && docRev !== workspaceRev) ||
        (docRev && sourceRev && docRev !== sourceRev) ||
        (workspaceRev && sourceRev && workspaceRev !== sourceRev)
      ) {
        setGlobalToast("源文档自解析以来已发生变更，当前重排内容仅供只读参考，已禁止新增重排标记与卡片");
        setTimeout(() => setGlobalToast(null), 3000);
        return;
      }

      // 统一内容校验
      const verifyRes = verifyParsedTextLocation(
        document.querySelector(".parsed-reflow-scroll-area"),
        activeWorkspace.version_id,
        workspaceRev,
        locationToUse,
        excerptToUse
      );
      if (!verifyRes.valid) {
        setGlobalToast(`来源校验失败: ${verifyRes.failReason || "内容不匹配"}`);
        setTimeout(() => setGlobalToast(null), 3000);
        return;
      }

      void handleCreateAnchorAndCard({
        location: locationToUse,
        excerpt: excerptToUse,
        action: "Ask",
        customPrompt: prompt,
        depth,
        boundDocId: targetDocId,
        boundSeq: seq,
        boundRevision: sourceRev || workspaceRev,
        boundParsedVersionId: locationToUse.parsedVersionId,
        boundReflowOpSeq: reflowOpSeqRef.current,
      });
      return;
    }

    // 原版阅读器模式
    const targetAnchor = anchors.find((a) => a.anchor_id === activeAnchorId);

    const location: SourceLocationData = targetAnchor
      ? JSON.parse(targetAnchor.location_json)
      : {
          type: "text_segment",
          segments: [{ paragraphIndex: 0, startOffset: 0, endOffset: 0 }],
        };
    const excerpt = targetAnchor?.excerpt || "当前页面/阅读段落";

    let imageBase64: string | undefined = undefined;
    if (targetAnchor?.source_type === "pdf_image") {
      try {
        const loc = JSON.parse(targetAnchor.location_json);
        const imgLoc = loc.location || loc;
        if (imgLoc.assetId) {
          imageBase64 = await apiGetAssetDataUrl(imgLoc.assetId);
        }
      } catch (err) {
        console.warn("[FlowRead] 底部提问加载关联图片失败:", err);
      }
    }

    // 每次 await 后校验：切书后立即终止，禁止调用重新捕获当前文档的创建逻辑，杜绝把 A 图片登记到 B
    if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) {
      return;
    }

    void handleCreateAnchorAndCard({
      location,
      excerpt,
      action: "Ask",
      customPrompt: prompt,
      depth,
      imageBase64,
      boundDocId: targetDocId,
      boundSeq: seq,
    });
  };

  /**
   * 从卡片定位回到原文（不依赖首 100 张限制，支持旧卡片与数据库直查）
   */
  const handleJumpToSource = async (cardId: string, anchorId?: string) => {
    const targetDoc = currentDocRef.current;
    if (!targetDoc) return;
    const targetDocId = targetDoc.id;
    const seq = openSequenceRef.current;
    const reqId = ++latestJumpRequestIdRef.current;
    const reqString = `jump-${seq}-${reqId}-${Date.now()}`;

    let targetAnchorId = anchorId;
    if (!targetAnchorId) {
      const card = cards.find((c) => c.card_id === cardId);
      targetAnchorId = card?.anchor_id || undefined;
      if (!targetAnchorId) {
        try {
          const detail = await apiGetCardDetail(cardId);
          if (
            reqId !== latestJumpRequestIdRef.current ||
            openSequenceRef.current !== seq ||
            currentDocRef.current?.id !== targetDocId
          ) {
            return;
          }
          if (detail?.card.document_id === targetDocId) {
            targetAnchorId = detail?.card.anchor_id || undefined;
          }
        } catch {}
      }
    }
    if (!targetAnchorId) return;
    if (
      reqId !== latestJumpRequestIdRef.current ||
      openSequenceRef.current !== seq ||
      currentDocRef.current?.id !== targetDocId
    ) {
      return;
    }

    let anchor = anchors.find((a) => a.anchor_id === targetAnchorId);
    if (!anchor && currentDocRef.current) {
      try {
        const allAnchors = await apiGetAnchors(targetDocId);
        if (
          reqId !== latestJumpRequestIdRef.current ||
          openSequenceRef.current !== seq ||
          currentDocRef.current?.id !== targetDocId
        ) {
          return;
        }
        setAnchors(allAnchors);
        anchor = allAnchors.find((a) => a.anchor_id === targetAnchorId);
      } catch {}
    }
    if (
      reqId !== latestJumpRequestIdRef.current ||
      openSequenceRef.current !== seq ||
      currentDocRef.current?.id !== targetDocId
    ) {
      return;
    }
    if (!anchor) return;

    // 选中、高亮、连线状态与定位请求解耦：更新选中态但不锁定正文滚动
    setActiveCardId(cardId);
    setActiveAnchorId(anchor.anchor_id);

    try {
      const loc = JSON.parse(anchor.location_json);
      const now = Date.now();

      if (anchor.source_type === "parsed_text") {
        const parsedLoc = loc as ParsedTextLocation;
        if (activeParsedWorkspaceRef.current?.version_id !== parsedLoc.parsedVersionId) {
          setGlobalToast("该卡片属于其他解析版本，当前视图无法直接定位");
          setTimeout(() => setGlobalToast(null), 3000);
          return;
        }

        // 确保留在或切换到流式重排视图
        if (viewModeRef.current !== "reflow") {
          handleSetViewMode("reflow");
        }

        const seg = parsedLoc.segments?.[0];
        if (seg) {
          setParsedReflowJumpTarget({
            requestId: reqString,
            documentId: targetDocId,
            openSeq: seq,
            parsedVersionId: parsedLoc.parsedVersionId,
            sourceRevision: parsedLoc.sourceRevision,
            blockId: seg.blockId,
            startOffset: seg.startOffset,
            endOffset: seg.endOffset,
            quote: seg.quote,
            textHash: seg.textHash,
            location: parsedLoc,
            anchorId: anchor.anchor_id,
            timestamp: now,
          });
        }
        return;
      }

      // 非流式重排来源（原版 PDF/文本）：若当前处于流式重排视图，点击卡片回到原文自动切换回原版视图
      if (viewModeRef.current !== "original") {
        handleSetViewMode("original");
      }

      if (anchor.source_type === "pdf_text") {
        const seg = loc.segments?.[0];
        if (seg) {
          setPdfJumpTarget({
            requestId: reqString,
            pageNumber: seg.pageNumber,
            anchorId: anchor.anchor_id,
            timestamp: now,
            targetDocId,
            openSeq: seq,
          });
        }
      } else if (anchor.source_type === "pdf_image") {
        const imgLoc = loc.location || loc;
        setPdfJumpTarget({
          requestId: reqString,
          pageNumber: imgLoc.pageNumber,
          anchorId: anchor.anchor_id,
          timestamp: now,
          targetDocId,
          openSeq: seq,
        });
      } else if (anchor.source_type === "text_segment") {
        const seg = loc.segments?.[0];
        if (seg) {
          setTextJumpTarget({
            requestId: reqString,
            paragraphIndex: seg.paragraphIndex,
            charOffset: seg.startOffset,
            anchorId: anchor.anchor_id,
            timestamp: now,
            targetDocId,
            openSeq: seq,
          });
        }
      }
    } catch (err) {
      console.warn("[FlowRead] 解析锚点位置跳转异常:", err);
    }
  };

  // 点击原文标记时反向激活对应卡片
  const handleSelectAnchor = useCallback((anchorId: string) => {
    setActiveAnchorId(anchorId);
    const matchedCard = cardsRef.current.find((c) => c.anchor_id === anchorId);
    if (matchedCard) {
      setActiveCardId(matchedCard.card_id);
    }
  }, []);

  // 删除卡片（统一同步数据库、父层状态、广播全局删除事件，维护选中态与孤立锚点）
  const handleDeleteCard = async (cardId: string) => {
    const targetDocId = currentDocRef.current?.id;
    const seq = openSequenceRef.current;
    aiDispatcher.cancel(cardId);
    try {
      await apiDeleteCard(cardId);
    } catch (err) {
      console.warn("[App] 删除卡片异常:", err);
    }
    if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;

    // 1. 同步父层卡片数组
    setCards((prev) => prev.filter((c) => c.card_id !== cardId));

    // 2. 清理当前选中的卡片激活态
    if (activeCardId === cardId) {
      setActiveCardId(null);
    }

    // 3. 广播全局卡片删除事件，通知右侧面板（全量记录本缓存、跟随缓存、计数等）
    window.dispatchEvent(
      new CustomEvent("flowread:card-deleted", {
        detail: { cardId, documentId: targetDocId },
      })
    );

    // 4. 检查是否有孤立锚点需要清理
    if (targetDocId) {
      try {
        const remainingAnchors = await apiGetAnchors(targetDocId);
        if (openSequenceRef.current === seq && currentDocRef.current?.id === targetDocId) {
          setAnchors(remainingAnchors);
          if (activeAnchorId && !remainingAnchors.some((a) => a.anchor_id === activeAnchorId)) {
            setActiveAnchorId(null);
          }
        }
      } catch {}
    }
  };

  // 发送追问（按 cardId 读取数据库完整详情，携带真实图片 base64 与历史）
  const handleSendFollowUp = async (cardId: string, prompt: string, depth: CardDepth) => {
    const targetDoc = currentDocRef.current;
    if (!targetDoc) return;
    const targetDocId = targetDoc.id;
    const seq = openSequenceRef.current;

    // 不依赖 cards 首 100 条数组，按 cardId 完整读取详情
    const detail = await apiGetCardDetail(cardId);
    if (
      openSequenceRef.current !== seq ||
      currentDocRef.current?.id !== targetDocId ||
      !detail ||
      detail.card.document_id !== targetDocId
    ) {
      return;
    }

    const card = detail.card;
    let imageBase64: string | undefined = undefined;

    // 图像卡片从资产读取真实 base64 数据
    if (card.anchor_source_type === "pdf_image" && card.anchor_location_json) {
      try {
        const loc = JSON.parse(card.anchor_location_json);
        const imgLoc = loc.location || loc;
        if (imgLoc.assetId) {
          imageBase64 = await apiGetAssetDataUrl(imgLoc.assetId);
        }
      } catch (err) {
        console.warn("[FlowRead] 追问加载图片资产失败:", err);
      }
    }

    if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;

    const turnId = `trn_${Date.now()}`;
    await apiCreateCardTurn(cardId, prompt, turnId, "queued");
    if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) {
      // 创建记录后因切书而放弃入队的 queued 追问，同样需要结算为 interrupted
      void apiUpdateCardTurnStream(turnId, "", "interrupted");
      return;
    }

    const priorTurns = detail.turns || [];
    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: card.user_prompt || card.anchor_excerpt || "请解析上述内容" },
      { role: "assistant", content: card.ai_response || "" },
    ];
    for (const t of priorTurns) {
      if (t.turn_id !== turnId && t.user_prompt && t.ai_response) {
        history.push({ role: "user", content: t.user_prompt });
        history.push({ role: "assistant", content: t.ai_response });
      }
    }

    aiDispatcher.enqueue({
      jobId: `${cardId}_turn_${turnId}`,
      cardId,
      documentId: targetDocId,
      turnId,
      action: "Ask",
      depth,
      userPrompt: prompt,
      contextExcerpt: card.anchor_excerpt || undefined,
      imageBase64,
      history,
    });
  };

  // 顶层文件夹列表（最多展示 3 个）
  const topFolders = useMemo(() => {
    return getTopLevelFolders(workspaceNodes).slice(0, 3);
  }, [workspaceNodes]);

  // 全局外部点击以收起主菜单
  useEffect(() => {
    const handleGlobalPointerDown = (e: MouseEvent): void => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener("mousedown", handleGlobalPointerDown);
    return () => window.removeEventListener("mousedown", handleGlobalPointerDown);
  }, []);

  // 纯净缩放交互：Ctrl + 鼠标滚轮
  useEffect(() => {
    const handleWheel = (e: WheelEvent): void => {
      // 若处于独立解析预览层或流式重排视图，缩放操作完全静默，避免修改底层文档 scale
      if (parsedPreviewTargetRef.current || viewModeRef.current === "reflow") return;

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY;
        setScale((prev) => {
          const step = 0.1;
          const next = delta < 0 ? prev + step : prev - step;
          return Math.min(3.0, Math.max(0.5, +next.toFixed(2)));
        });
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  // 全局快捷键监听
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // 若处于独立解析预览层，主界面的快捷键全面静默，由预览层自身管理
      if (parsedPreviewTargetRef.current) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "o") {
          e.preventDefault();
          void handleImportOrOpenFileRef.current();
        } else if (e.key === ",") {
          e.preventDefault();
          setIsModelConfigOpen(true);
        } else if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          if (viewModeRef.current === "reflow") return;
          setScale((s) => Math.min(3.0, +(s + 0.1).toFixed(2)));
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          if (viewModeRef.current === "reflow") return;
          setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)));
        } else if (e.key === "0") {
          e.preventDefault();
          if (viewModeRef.current === "reflow") return;
          setScale(1.35);
        }
      } else if (e.key === "Escape") {
        if (isAnyModalOpenRef.current) return;
        if (activeMenuRef.current) {
          setActiveMenu(null);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 切换至 PDF 阅读器
  const handleOpenPdf = useCallback(
    async (filePath?: string): Promise<void> => {
      if (filePath) {
        void openDocument(filePath, { mode: "pdf" });
      } else {
        alert("未指定有效的 PDF 文件路径。");
      }
    },
    [openDocument]
  );

  // 阶段 2A：打开解析结果预览选择器（支持显式路径，支持重复选择同一路径刷新，取消选择保持原状态）
  const handleOpenParsedPreview = useCallback(async (explicitPath?: string) => {
    setActiveMenu(null);
    let targetPath = explicitPath;
    if (!targetPath) {
      try {
        const selected = await open({
          multiple: false,
          directory: false,
          filters: [
            {
              name: "解析结果结构文件 (blocks.json)",
              extensions: ["json"],
            },
          ],
        });

        if (typeof selected === "string" && selected.trim()) {
          targetPath = selected.trim();
        } else if (Array.isArray(selected) && selected[0]?.trim()) {
          targetPath = selected[0].trim();
        }
      } catch (err) {
        console.error("[App] 打开解析结果文件选择器失败:", err);
        return;
      }
    }

    if (targetPath) {
      setPreviewFromJob(false);
      setParsedPreviewTarget((prev) => ({
        filePath: targetPath!,
        loadKey: (prev ? prev.loadKey : 0) + 1,
      }));
    }
  }, []);

  // 阶段 2B：导入/绑定解析结果目录到当前文档隐式工作区
  const handleImportParsedToCurrentDoc = useCallback(
    async (explicitBlocksPath?: string) => {
      setActiveMenu(null);
      const targetDoc = currentDocRef.current;
      if (!targetDoc) {
        alert("请先打开一个文档，再为其绑定解析结果。");
        return;
      }
      const targetDocId = targetDoc.id;
      const targetRevision = targetDoc.revision || "";
      const docSeq = openSequenceRef.current;

      // 忙碌保护：在调起文件选择器前即加锁，防止连续重复点击触发多个选择器
      if (importBusyTokenRef.current !== null) {
        return;
      }
      const currentToken = Symbol("import_busy");
      importBusyTokenRef.current = currentToken;

      let sourcePath = explicitBlocksPath;
      if (!sourcePath) {
        try {
          const selected = await open({
            multiple: false,
            directory: false,
            filters: [
              {
                name: "解析结果结构文件 (blocks.json)",
                extensions: ["json"],
              },
            ],
          });

          // 取消选择保持原界面不变，释放当前锁并退出
          if (!selected) {
            if (importBusyTokenRef.current === currentToken) {
              importBusyTokenRef.current = null;
            }
            return;
          }

          if (typeof selected === "string" && selected.trim()) {
            sourcePath = selected.trim();
          } else if (Array.isArray(selected) && selected[0]?.trim()) {
            sourcePath = selected[0].trim();
          }
        } catch (err) {
          if (importBusyTokenRef.current === currentToken) {
            importBusyTokenRef.current = null;
          }
          console.error("[App] 打开解析结果文件选择器失败:", err);
          return;
        }
      }

      if (!sourcePath) {
        if (importBusyTokenRef.current === currentToken) {
          importBusyTokenRef.current = null;
        }
        return;
      }

      // 文件选择器返回后比对生命周期、打开序号与文档 ID，若已切换或卸载则丢弃
      if (
        !isAppMountedRef.current ||
        openSequenceRef.current !== docSeq ||
        currentDocRef.current?.id !== targetDocId
      ) {
        if (importBusyTokenRef.current === currentToken) {
          importBusyTokenRef.current = null;
        }
        return;
      }

      const parsedOpId = ++parsedOpSeqRef.current;

      try {
        const activeResp = await apiParsedWorkspaceImportDir(
          targetDocId,
          targetRevision,
          sourcePath,
          "manual_import"
        );

        // 异步操作返回后再次严格校验生命周期、代次序号与文档身份
        const isStale =
          !isAppMountedRef.current ||
          parsedOpId !== parsedOpSeqRef.current ||
          openSequenceRef.current !== docSeq ||
          currentDocRef.current?.id !== targetDocId;

        if (isStale) {
          if (activeResp?.session_id) {
            void apiParsedPreviewClose(activeResp.session_id).catch(() => {});
          }
          return;
        }

        const prevMgr = parsedWorkspaceAssetManagerRef.current as ParsedAssetManager | null;
        if (prevMgr) {
          prevMgr.dispose();
        }
        parsedWorkspaceAssetManagerRef.current = new ParsedAssetManager(activeResp.session_id);
        activeParsedWorkspaceRef.current = activeResp;
        setActiveParsedWorkspace(activeResp);
        handleSetViewMode("reflow");

        // 若当前正处于独立预览层，关闭预览层以便直接在主工作区查看流式重排
        setParsedPreviewTarget(null);
        setPreviewFromJob(false);
      } catch (err: any) {
        const isStale =
          !isAppMountedRef.current ||
          parsedOpId !== parsedOpSeqRef.current ||
          openSequenceRef.current !== docSeq ||
          currentDocRef.current?.id !== targetDocId;

        if (isStale) {
          return;
        }
        console.error("[App] 导入解析结果到隐式工作区失败:", err);
        alert(`导入解析结果失败: ${err?.message || err}`);
      } finally {
        // 旧操作的 finally 绝不能解锁另一个新操作的锁
        if (importBusyTokenRef.current === currentToken) {
          importBusyTokenRef.current = null;
        }
      }
    },
    [handleSetViewMode]
  );

  // 保存工作区节点
  const handleSaveWorkspaceNodes = (
    updater: WorkspaceNode[] | ((prev: WorkspaceNode[]) => WorkspaceNode[])
  ): void => {
    setWorkspaceNodes((prev) => {
      const nextNodes = typeof updater === "function" ? updater(prev) : updater;
      saveWorkspaceNodes(nextNodes);
      return nextNodes;
    });
  };

  // 从工作区管理器中打开文件
  const handleOpenFileFromExplorer = async (
    filePath?: string,
    extension?: string,
    name?: string
  ): Promise<void> => {
    let resolvedPath = filePath;
    // 识别内置虚拟文档条目
    if (!resolvedPath && name && name.includes("在流动中沉思")) {
      resolvedPath = "flowread://default_reading_intro";
    }

    if (resolvedPath) {
      const ext = (extension || resolvedPath.split(".").pop() || "").toLowerCase();
      const mode: "text" | "pdf" = ext === "pdf" ? "pdf" : "text";
      void openDocument(resolvedPath, {
        mode,
        displayName: name,
        revision: resolvedPath.startsWith("flowread://") ? "v1" : undefined,
      });
    } else {
      // 无有效物理路径且非内置虚拟内容：明确提示并保持当前文档，绝对不切换模式或标题
      alert(`条目「${name || "未命名文档"}」未关联本地磁盘路径或有效来源，请先导入实际文件。`);
    }
  };

  // 打开本地物理文件
  const handleImportOrOpenFile = async (): Promise<void> => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "所有支持的文档 (*.pdf, *.txt, *.md, *.epub)",
            extensions: ["pdf", "txt", "md", "markdown", "epub"],
          },
          { name: "PDF 文档 (*.pdf)", extensions: ["pdf"] },
          { name: "纯文本与 Markdown (*.txt, *.md)", extensions: ["txt", "md", "markdown"] },
          { name: "EPUB 电子书 (*.epub)", extensions: ["epub"] },
        ],
      });

      if (!selected) return;
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;

      const fileName = filePath.split(/[/\\]/).pop() || "未命名文档";
      const ext = fileName.split(".").pop()?.toLowerCase() || "txt";

      handleSaveWorkspaceNodes((prev) => {
        const exists = prev.some((n) => n.fileMeta?.path === filePath);
        if (exists) return prev;
        const newNode: WorkspaceNode = {
          id: `file_${Date.now()}`,
          name: fileName,
          type: "file",
          parentId: null,
          fileMeta: { path: filePath, extension: ext, sizeBytes: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return [...prev, newNode];
      });

      void openDocument(filePath, { displayName: fileName });
    } catch (err) {
      console.error("[FlowRead] 打开本地文档失败:", err);
    }
  };

  handleImportOrOpenFileRef.current = handleImportOrOpenFile;

  /* ------------------------------------------------------------------ */
  /* PDF 云端解析：设置、导入、任务跟踪与结果打开                       */
  /* ------------------------------------------------------------------ */

  const [parseSettingsLoadError, setParseSettingsLoadError] = useState<string | null>(null);

  const ensureParseSettings = useCallback(async (): Promise<ParseSettings | null> => {
    try {
      const settings = await apiParseSettingsGet();
      if (settings && Array.isArray(settings.providers)) {
        setParseSettings(settings);
        setParseSettingsLoadError(null);
        return settings;
      }
      setParseSettingsLoadError("解析服务配置格式异常");
      return null;
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : "读取解析服务设置失败";
      console.warn("[FlowRead] 读取解析服务设置失败:", err);
      setParseSettingsLoadError(msg);
      return null;
    }
  }, []);

  const handleOpenParserSettings = useCallback(
    (provider: ParseProvider | null) => {
      setParserSettingsFocus(provider);
      setIsParserSettingsOpen(true);
      void ensureParseSettings();
    },
    [ensureParseSettings]
  );

  const handleParseSettingsChanged = useCallback((next: ParseSettings) => {
    setParseSettings(next);
  }, []);

  /** 把待解析 PDF 按既有工作区机制登记一次（同路径不重复添加） */
  const registerWorkspaceFileNode = useCallback(
    (filePath: string, fileName: string, ext: string) => {
      handleSaveWorkspaceNodes((prev) => {
        if (prev.some((n) => n.fileMeta?.path === filePath)) return prev;
        const newNode: WorkspaceNode = {
          id: `file_${Date.now()}`,
          name: fileName,
          type: "file",
          parentId: null,
          fileMeta: { path: filePath, extension: ext, sizeBytes: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        return [...prev, newNode];
      });
    },
    [handleSaveWorkspaceNodes]
  );

  /** 工作区菜单：选择 PDF 并准备解析（取消选择时不产生任务与上传） */
  const handleChoosePdfForParsing = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "PDF 文档 (*.pdf)", extensions: ["pdf"] }],
      });
      const filePath =
        typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
      if (!filePath) return;

      const fileName = filePath.split(/[/\\]/).pop() || "未命名.pdf";
      await ensureParseSettings();
      setParseSubmitError(null);
      setPdfParseTarget({ filePath, fileName });
      setIsPdfParseImportOpen(true);
    } catch (err) {
      console.error("[FlowRead] 选择待解析 PDF 失败:", err);
    }
  }, [ensureParseSettings]);

  /** 工具菜单：解析当前已打开的本地 PDF */
  const handleParseCurrentPdf = useCallback(async () => {
    const path = pdfPath;
    if (!path || path.startsWith("flowread://")) {
      setParseNotice("当前没有可解析的本地 PDF 文件。");
      return;
    }
    const fileName =
      currentDocRef.current?.display_name || path.split(/[/\\]/).pop() || "未命名.pdf";
    await ensureParseSettings();
    setParseSubmitError(null);
    setPdfParseTarget({ filePath: path, fileName });
    setIsPdfParseImportOpen(true);
  }, [pdfPath, ensureParseSettings]);

  /**
   * 提交解析任务：
   * - 点击后锁定本次 source_path / provider，防止连击；
   * - 任务身份以 parse_job_start 返回的 document_id / source_revision 为准；
   * - 若后端返回已成功的任务，直接复用已有结果并按用户意愿打开重排，不报“已提交，等待解析”；
   * - 随后复用 openDocument 打开原版 PDF。
   */
  const handleStartPdfParse = useCallback(
    async (options: { provider: ParseProvider; openAfter: boolean }) => {
      const target = pdfParseTarget;
      if (!target) return;
      if (parseSubmitTokenRef.current !== null) return;

      const token = Symbol("parse_submit");
      parseSubmitTokenRef.current = token;
      setParseSubmitting(true);
      setParseSubmitError(null);

      const sourcePath = target.filePath;
      const fileName = target.fileName;
      const docSeqAtSubmit = openSequenceRef.current;
      const viewSeqAtSubmit = viewModeManualSeqRef.current;
      const pinnedCurrentDocId = currentDocRef.current?.id ?? null;

      try {
        const job = await apiParseJobStart(sourcePath, options.provider, false);
        if (!isAppMountedRef.current) return;

        // 仅在弹窗目标仍属于本次提交时清理弹窗，迟到响应不得关闭或清空属于更新操作的弹窗状态
        setPdfParseTarget((prev) => {
          if (prev?.filePath === sourcePath) {
            setIsPdfParseImportOpen(false);
            return null;
          }
          return prev;
        });

        registerWorkspaceFileNode(sourcePath, fileName, "pdf");

        // 提交返回后，在调用 openDocument 之前判断本次打开意图是否依然有效
        // 若用户已切书、关闭目标文档或开启新导航，不得自动打开旧目标抢回视野
        const navigationStillValid =
          openSequenceRef.current === docSeqAtSubmit &&
          (currentDocRef.current?.id ?? null) === pinnedCurrentDocId;

        const isAlreadySucceeded = job.status === "succeeded";

        if (navigationStillValid) {
          const openPromise = openDocument(sourcePath, {
            mode: "pdf",
            displayName: job.document_name || fileName,
            revision: job.source_revision || undefined,
          });

          if (isAlreadySucceeded) {
            // 复用已有成功结果：立即跟踪并去重后台轮询通知
            parseTrackerRef.current?.track(job);
            handledSuccessKeysRef.current.add(`${job.job_id}:${job.version_id || "succeeded"}`);

            // 当前导入请求建立目标文档身份后，再评估本次打开意图
            void (async () => {
              const openedDoc = await openPromise;
              if (!isAppMountedRef.current) return;

              const docId = job.document_id ?? openedDoc?.id ?? null;
              const current = currentDocRef.current;
              const sameDoc = !!docId && current?.id === docId;
              const seqOk = !!openedDoc && current === openedDoc;
              const viewUntouched = viewModeManualSeqRef.current === viewSeqAtSubmit;
              const revisionOk =
                !job.source_revision || !current?.revision || job.source_revision === current.revision;
              const activatedOk = job.activated !== false;

              if (
                options.openAfter &&
                sameDoc &&
                seqOk &&
                revisionOk &&
                viewUntouched &&
                docId &&
                activatedOk &&
                job.version_id
              ) {
                const outcome = await applyActiveParsedWorkspaceForDoc(docId, job.version_id, {
                  targetRevision: job.source_revision || current?.revision || null,
                  docSeq: openSequenceRef.current,
                  viewSeq: viewSeqAtSubmit,
                  autoSwitchToReflow: true,
                });
                if (outcome === "ok") {
                  setParseNotice(`已使用《${job.document_name || fileName}》的已有解析结果。`);
                  return;
                }
              }

              // 用户未勾选自动打开、或等待期间切书/改视图，不抢回视图
              if (!sameDoc || !seqOk) {
                setParseNotice(
                  `已使用《${job.document_name || fileName}》的已有解析结果，可在“解析任务”中查看或打开重排。`
                );
              } else {
                setParseNotice(`已使用《${job.document_name || fileName}》的已有解析结果。`);
              }
            })();
          } else {
            submittedJobMetaRef.current.set(job.job_id, {
              openAfter: options.openAfter,
              docSeq: docSeqAtSubmit,
              docId: job.document_id,
              revision: job.source_revision || "",
              viewModeSeq: viewSeqAtSubmit,
              openPromise,
            });
            parseTrackerRef.current?.track(job);

            void openPromise.then((openedDoc) => {
              const meta = submittedJobMetaRef.current.get(job.job_id);
              const docId = job.document_id ?? openedDoc?.id ?? null;
              if (meta && docId && currentDocRef.current?.id === docId) {
                meta.docSeq = openSequenceRef.current;
                meta.docId = docId;
              }
            });

            // 不自动弹面板遮挡阅读；用轻提示告知任务已提交，可点“查看任务”进入
            setParseNotice(
              `已提交《${job.document_name || fileName}》的解析任务，可在“解析任务”中查看进度。`
            );
          }
        } else {
          // 意图已失效：用户在提交等待期间切书或改变导航，不得调用 openDocument 抢回旧书
          // 但 A 的任务仍应登记、跟踪并提供完成提示与结果入口
          parseTrackerRef.current?.track(job);

          if (isAlreadySucceeded) {
            handledSuccessKeysRef.current.add(`${job.job_id}:${job.version_id || "succeeded"}`);
            setParseNotice(
              `已使用《${job.document_name || fileName}》的已有解析结果，可在“解析任务”中查看或打开重排。`
            );
          } else {
            // 标记已过期 docSeq，确保未来成功时也不会抢回当前视图
            submittedJobMetaRef.current.set(job.job_id, {
              openAfter: options.openAfter,
              docSeq: docSeqAtSubmit,
              docId: job.document_id,
              revision: job.source_revision || "",
              viewModeSeq: viewSeqAtSubmit,
              openPromise: Promise.resolve(null),
            });
            setParseNotice(
              `已提交《${job.document_name || fileName}》的解析任务，可在“解析任务”中查看进度。`
            );
          }
        }
      } catch (err: any) {
        if (!isAppMountedRef.current) return;
        setParseSubmitError(
          err?.message ? String(err.message) : "提交解析任务失败，请稍后重试。"
        );
      } finally {
        if (parseSubmitTokenRef.current === token) {
          parseSubmitTokenRef.current = null;
          setParseSubmitting(false);
        }
      }
    },
    [pdfParseTarget, openDocument, registerWorkspaceFileNode]
  );

  const refreshParseJobs = useCallback(async () => {
    setParseJobsLoading(true);
    try {
      const res = await apiParseJobListFirstPage(50);
      for (const job of res.items || []) {
        parseTrackerRef.current?.applyJob(job);
      }
      setParseJobsNextCursor(res.next_cursor ?? null);
      setParseJobsError(null);
    } catch (err: any) {
      setParseJobsError(err?.message ? String(err.message) : "读取解析任务失败");
    } finally {
      setParseJobsLoading(false);
    }
  }, []);

  const handleOpenParseJobs = useCallback(() => {
    setIsParseJobsOpen(true);
    void refreshParseJobs();
  }, [refreshParseJobs]);

  const handleLoadMoreParseJobs = useCallback(async () => {
    if (!parseJobsNextCursor || parseJobsLoadingMore) return;
    setParseJobsLoadingMore(true);
    try {
      const res = await apiParseJobList({
        document_id: null,
        active_only: false,
        limit: 50,
        cursor: parseJobsNextCursor,
      });
      for (const job of res.items || []) {
        parseTrackerRef.current?.applyJob(job);
      }
      setParseJobsNextCursor(res.next_cursor ?? null);
    } catch (err: any) {
      setParseJobsError(err?.message ? String(err.message) : "加载更多任务失败");
    } finally {
      setParseJobsLoadingMore(false);
    }
  }, [parseJobsNextCursor, parseJobsLoadingMore]);

  const runParseJobAction = useCallback(
    async (jobId: string, action: () => Promise<ParseJobDto>) => {
      setParseBusyJobIds((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]));
      try {
        const updated = await action();
        if (updated?.job_id) {
          parseTrackerRef.current?.track(updated);
        }
      } catch (err: any) {
        setParseNotice(`任务操作失败：${err?.message ? String(err.message) : "未知错误"}`);
      } finally {
        setParseBusyJobIds((prev) => prev.filter((id) => id !== jobId));
      }
    },
    []
  );

  const handleCancelParseJob = useCallback(
    (job: ParseJobDto) => {
      void runParseJobAction(job.job_id, () => apiParseJobCancel(job.job_id));
    },
    [runParseJobAction]
  );

  const handleResumeParseJob = useCallback(
    (job: ParseJobDto) => {
      if (!submittedJobMetaRef.current.has(job.job_id)) {
        submittedJobMetaRef.current.set(job.job_id, {
          openAfter: false,
          docSeq: openSequenceRef.current,
          docId: job.document_id,
          revision: job.source_revision || "",
          viewModeSeq: viewModeManualSeqRef.current,
        });
      }
      void runParseJobAction(job.job_id, () => apiParseJobResume(job.job_id));
    },
    [runParseJobAction]
  );

  /** 重新解析：明确创建新任务（force_new = true），不复用旧任务记录 */
  const handleRetryParseJob = useCallback(
    (job: ParseJobDto) => {
      void runParseJobAction(job.job_id, async () => {
        const created = await apiParseJobStart(job.source_path, job.provider, true);
        submittedJobMetaRef.current.set(created.job_id, {
          openAfter: false,
          docSeq: openSequenceRef.current,
          docId: created.document_id,
          revision: created.source_revision || "",
          viewModeSeq: viewModeManualSeqRef.current,
        });
        return created;
      });
    },
    [runParseJobAction]
  );

  /**
   * 获取指定文档的激活解析版本并接管阅读会话。
   * 开始时固定文档 ID、修订、打开代次、解析操作代次与视图代次。
   * 仅当所有代次与身份仍旧有效时，才释放旧资产并接管新会话。
   * 迟到或失效的响应仅释放本次查询返回的 session，绝对不影响当前正在使用的阅读会话。
   */
  const applyActiveParsedWorkspaceForDoc = useCallback(
    async (
      docId: string,
      expectedVersionId: string,
      options?: {
        targetRevision?: string | null;
        docSeq?: number;
        parsedOpId?: number;
        viewSeq?: number;
        autoSwitchToReflow?: boolean;
      }
    ): Promise<"ok" | "missing" | "stale"> => {
      // 1. 在异步查询开始前固定必要身份与代次
      const pinnedDocSeq = options?.docSeq ?? openSequenceRef.current;
      const pinnedParsedOpId = options?.parsedOpId ?? ++parsedOpSeqRef.current;
      const pinnedTargetRevision = options?.targetRevision ?? currentDocRef.current?.revision ?? null;
      const pinnedViewSeq = options?.viewSeq ?? viewModeManualSeqRef.current;
      const autoSwitchToReflow = options?.autoSwitchToReflow ?? false;

      let active: ActiveParsedWorkspaceResponse | null = null;
      try {
        active = await apiParsedWorkspaceGetActive(docId);
      } catch {
        return "missing";
      }

      // 2. 检查是否已经被更新的操作淘汰、或者用户已切书、已改视图、组件已卸载
      const isStillValid =
        isAppMountedRef.current &&
        currentDocRef.current?.id === docId &&
        openSequenceRef.current === pinnedDocSeq &&
        parsedOpSeqRef.current === pinnedParsedOpId &&
        (!pinnedTargetRevision || !currentDocRef.current?.revision || currentDocRef.current.revision === pinnedTargetRevision) &&
        (!autoSwitchToReflow || viewModeManualSeqRef.current === pinnedViewSeq);

      if (!isStillValid) {
        // 失效响应只释放自己新建的 session，不得 dispose 当前有效资产管理器
        if (active?.session_id) {
          if (active.session_id !== parsedWorkspaceAssetManagerRef.current?.getSessionId()) {
            void apiParsedPreviewClose(active.session_id).catch(() => {});
          }
        }
        return "stale";
      }

      // 3. 校验激活版本
      if (!active || !expectedVersionId || active.version_id !== expectedVersionId) {
        if (active?.session_id) {
          if (active.session_id !== parsedWorkspaceAssetManagerRef.current?.getSessionId()) {
            void apiParsedPreviewClose(active.session_id).catch(() => {});
          }
        }
        return "missing";
      }

      // 4. 同版本短路：已经在展示同一版本时，释放本次查询新建而未接管的 session，但注意不要关闭正在使用的同一 session
      if (
        activeParsedWorkspaceRef.current?.version_id === active.version_id &&
        parsedWorkspaceAssetManagerRef.current
      ) {
        if (active.session_id && active.session_id !== parsedWorkspaceAssetManagerRef.current.getSessionId()) {
          void apiParsedPreviewClose(active.session_id).catch(() => {});
        }
        if (autoSwitchToReflow) {
          handleSetViewMode("reflow");
        }
        return "ok";
      }

      // 5. 验证通过后方可释放现有资产并接管新会话
      const prevMgr = parsedWorkspaceAssetManagerRef.current as ParsedAssetManager | null;
      if (prevMgr) prevMgr.dispose();
      parsedWorkspaceAssetManagerRef.current = new ParsedAssetManager(active.session_id);
      activeParsedWorkspaceRef.current = active;
      setActiveParsedWorkspace(active);
      if (autoSwitchToReflow) {
        handleSetViewMode("reflow");
      }
      return "ok";
    },
    [handleSetViewMode]
  );

  /**
   * 任务进入终态：只有“本会话提交 + 仍是同一文档/源版本/打开代次 + 用户未手动改视图 + 勾选自动打开”
   * 时才自动切到重排；其余情况只给轻提示与打开入口。
   */
  const handleParseJobTerminal = useCallback(
    (job: ParseJobDto) => {
      const meta = submittedJobMetaRef.current.get(job.job_id);
      if (!meta) return; // 非本会话提交或恢复的任务：不自动切换、不打扰

      if (job.status === "failed") {
        setParseNotice(
          `《${job.document_name}》解析失败：${job.error_message || "未知错误"}。原版文件与已有重排版本未受影响。`
        );
        return;
      }
      if (job.status !== "succeeded") return;

      void (async () => {
        if (meta.openPromise) {
          try {
            await meta.openPromise;
          } catch {}
        }
        if (!isAppMountedRef.current) return;

        const docId = job.document_id ?? meta.docId;
        const current = currentDocRef.current;
        const sameDoc = !!docId && current?.id === docId;
        const seqOk = meta.docSeq === openSequenceRef.current;
        const revisionOk =
          !job.source_revision || !current?.revision || job.source_revision === current.revision;
        const viewUntouched = viewModeManualSeqRef.current === meta.viewModeSeq;
        const activatedOk = job.activated !== false;

        const pagesNote =
          typeof job.completed_pages === "number" &&
          typeof job.total_pages === "number" &&
          job.completed_pages < job.total_pages
            ? `（仅完成 ${job.completed_pages}/${job.total_pages} 页）`
            : "";

        if (!meta.openAfter || !sameDoc || !seqOk || !revisionOk || !viewUntouched || !docId || !activatedOk) {
          if (!sameDoc || !seqOk) {
            setParseNotice(`《${job.document_name}》解析完成${pagesNote}，可在“解析任务”中查看结果或打开重排。`);
          } else if (!revisionOk) {
            setParseNotice(`《${job.document_name}》解析完成，但本地文件已更新，未自动应用重排；可在“解析任务”中查看结果。`);
          } else if (!activatedOk) {
            setParseNotice(`《${job.document_name}》解析完成（未激活为当前版本），可在“解析任务”中查看结果。`);
          } else {
            setParseNotice(`《${job.document_name}》解析完成${pagesNote}，可在“解析任务”中查看结果或打开重排。`);
          }
          return;
        }

        const outcome = await applyActiveParsedWorkspaceForDoc(docId, job.version_id || "", {
          targetRevision: job.source_revision || current?.revision || null,
          docSeq: meta.docSeq,
          viewSeq: meta.viewModeSeq,
          autoSwitchToReflow: true,
        });

        if (!isAppMountedRef.current) return;

        if (outcome === "ok") {
          if (pagesNote) {
            setParseNotice(`已打开流式重排${pagesNote}。`);
          } else {
            setParseNotice(null);
          }
        } else if (outcome !== "stale") {
          setParseNotice("解析完成，但当前没有可用的激活版本，已保留现有视图。");
        }
      })();
    },
    [applyActiveParsedWorkspaceForDoc]
  );

  // 让任务订阅回调始终调用最新的终态处理函数
  handleParseJobTerminalRef.current = handleParseJobTerminal;

  /** 查看任务结果：只读预览该结果，不绑定到当前文档 */
  const handleViewParseResult = useCallback(
    async (job: ParseJobDto) => {
      setParseBusyJobIds((prev) => (prev.includes(job.job_id) ? prev : [...prev, job.job_id]));
      try {
        const result = await apiParseJobResult(job.job_id);
        if (!result?.blocks_path) {
          throw new Error("任务结果缺少结构化文件路径");
        }
        setPreviewFromJob(true);
        setParsedPreviewTarget((prev) => ({
          filePath: result.blocks_path,
          loadKey: (prev?.loadKey ?? 0) + 1,
        }));
      } catch (err: any) {
        setParseNotice(`无法查看任务结果：${err?.message ? String(err.message) : "未知错误"}`);
      } finally {
        setParseBusyJobIds((prev) => prev.filter((id) => id !== job.job_id));
      }
    },
    []
  );

  /** 仅在任务结果属于当前文档且仍是激活版本时，打开重排 */
  const handleOpenParseResultDocument = useCallback(
    async (job: ParseJobDto) => {
      const docId = job.document_id;
      if (!docId || currentDocRef.current?.id !== docId) {
        setParseNotice("该解析结果属于另一本文档，请先切换到对应书籍后再打开重排。");
        return;
      }
      if (!job.version_id) return;

      const outcome = await applyActiveParsedWorkspaceForDoc(docId, job.version_id, {
        targetRevision: job.source_revision || currentDocRef.current?.revision || null,
        docSeq: openSequenceRef.current,
        viewSeq: viewModeManualSeqRef.current,
        autoSwitchToReflow: true,
      });
      if (outcome === "ok") {
        setIsParseJobsOpen(false);
        setParseNotice(null);
      } else if (outcome === "missing") {
        setParseNotice("该任务的版本已不是当前激活版本，无法直接打开重排；可先查看任务结果。");
      }
    },
    [applyActiveParsedWorkspaceForDoc]
  );

  const handleQuickCreateFolder = (): void => {
    const name = window.prompt("请输入新建文件夹名称：", "新建文件夹");
    if (name && name.trim()) {
      const newFolder: WorkspaceNode = {
        id: `folder_${Date.now()}`,
        name: name.trim(),
        type: "folder",
        parentId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      handleSaveWorkspaceNodes((prev) => [...prev, newFolder]);
    }
  };

  const handleSaveAIConfig = (newConfig: ModelProfile): void => {
    setAiConfig(newConfig);
    saveAIConfig(newConfig);
  };

  const handleSavePromptConfig = (newConfig: PromptConfig): void => {
    setPromptConfig(newConfig);
    savePromptConfig(newConfig);
  };

  const handleSaveReadingPreferences = (newPrefs: ReadingPreferences): void => {
    setReadingPrefs(newPrefs);
    saveGlobalPreferences(newPrefs);
    applyTheme(newPrefs);
    if (currentDoc) {
      void apiSaveReadingPreferences(currentDoc.id, newPrefs);
    }
  };

  return (
    <div className="app-container">
      {/* 顶部主菜单栏 */}
      <header className="main-menu-bar" ref={menuBarRef}>
        <div className="menu-bar-left">
          <div className="app-brand-badge">
            <span className="brand-logo-text">FlowRead</span>
          </div>

          <div className="menu-items-group">
            {/* 工作区菜单 */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "workspace" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "workspace" ? null : "workspace"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("workspace");
                }}
              >
                工作区 (Workspace)
              </button>
              {activeMenu === "workspace" && (
                <div className="menu-dropdown-panel">
                  <div
                    className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                    title={parsedPreviewTarget ? "关闭解析预览后使用" : undefined}
                    onClick={() => {
                      if (parsedPreviewTarget) return;
                      setActiveMenu(null);
                      void handleImportOrOpenFile();
                    }}
                  >
                    <span>打开本地文件...</span>
                    <span className="menu-shortcut-hint">Ctrl+O</span>
                  </div>
                  <div
                    className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                    title={parsedPreviewTarget ? "关闭解析预览后使用" : "选择 PDF 并上传到云端解析服务"}
                    onClick={() => {
                      if (parsedPreviewTarget) return;
                      setActiveMenu(null);
                      void handleChoosePdfForParsing();
                    }}
                  >
                    <span>导入 PDF 并解析…</span>
                  </div>
                  <div
                    className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                    title={parsedPreviewTarget ? "关闭解析预览后使用" : undefined}
                    onClick={() => {
                      if (parsedPreviewTarget) return;
                      setActiveMenu(null);
                      setExplorerInitialFolderId(null);
                      setIsWorkspaceExplorerOpen(true);
                    }}
                  >
                    <span>管理工作区...</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                    title={parsedPreviewTarget ? "关闭解析预览后使用" : undefined}
                    onClick={() => {
                      if (parsedPreviewTarget) return;
                      setActiveMenu(null);
                      handleQuickCreateFolder();
                    }}
                  >
                    <span>新建文件夹</span>
                  </div>
                  {topFolders.length > 0 && (
                    <>
                      <div className="menu-dropdown-divider" />
                      <div className="menu-dropdown-header">最近文件夹</div>
                      {topFolders.map((f) => (
                        <div
                          key={f.id}
                          className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                          title={parsedPreviewTarget ? "关闭解析预览后使用" : undefined}
                          onClick={() => {
                            if (parsedPreviewTarget) return;
                            setActiveMenu(null);
                            setExplorerInitialFolderId(f.id);
                            setIsWorkspaceExplorerOpen(true);
                          }}
                        >
                          <span>📁 {f.name}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 工具菜单 */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "tools" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "tools" ? null : "tools"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("tools");
                }}
              >
                工具 (Tools)
              </button>
              {activeMenu === "tools" && (
                <div className="menu-dropdown-panel">
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      setIsReadingSettingsOpen(true);
                    }}
                  >
                    <span>阅读外观与排版设置...</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      setIsModelConfigOpen(true);
                    }}
                  >
                    <span>模型配置中心...</span>
                    <span className="menu-shortcut-hint">Ctrl+,</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      setIsPromptConfigOpen(true);
                    }}
                  >
                    <span>提示词工程配置...</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      void handleImportParsedToCurrentDoc();
                    }}
                  >
                    <span>导入/绑定解析结果到当前文档…</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      void handleOpenParsedPreview();
                    }}
                  >
                    <span>打开解析结果预览…</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      handleOpenParserSettings(null);
                    }}
                  >
                    <span>PDF 解析服务设置…</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      handleOpenParseJobs();
                    }}
                  >
                    <span>解析任务…</span>
                  </div>
                  {readerMode === "pdf" && !!pdfPath && !pdfPath.startsWith("flowread://") && (
                    <div
                      className={`menu-dropdown-item ${parsedPreviewTarget ? "is-disabled" : ""}`}
                      title={parsedPreviewTarget ? "关闭解析预览后使用" : "将当前 PDF 上传到解析服务"}
                      onClick={() => {
                        if (parsedPreviewTarget) return;
                        setActiveMenu(null);
                        void handleParseCurrentPdf();
                      }}
                    >
                      <span>解析当前 PDF…</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 帮助菜单 */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "help" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "help" ? null : "help"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("help");
                }}
              >
                帮助 (Help)
              </button>
              {activeMenu === "help" && (
                <div className="menu-dropdown-panel">
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      alert(
                        "【FlowRead 极简交互与快捷键规范】\n\n" +
                          "1. 视口缩放：\n" +
                          "   - Ctrl + 滚轮向上/向下：动态调节缩放\n" +
                          "   - Ctrl + = / Ctrl + - ：快速放大/缩小\n" +
                          "   - Ctrl + 0 ：重置缩放为 135%\n\n" +
                          "2. 伴读卡片与 Ask：\n" +
                          "   - 划选文字即弹出工具栏：Ask、解释、翻译、简化、公式、要点、高亮\n" +
                          "   - Alt + 拖拽框选：截取图表交由多模态 Vision 模型\n" +
                          "   - 点击卡片：展开 3:4 完整回答大窗，多轮追问\n" +
                          "   - 右侧伴读：跟随视图随原文滚动连线，记录本支持全书历史与导出"
                      );
                    }}
                  >
                    <span>快捷键与伴读指南...</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      alert("FlowRead v0.3.0 - 原文关联卡片、Ask 交互与持久化阅读系统");
                    }}
                  >
                    <span>关于 FlowRead (v0.3.0)</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="menu-bar-right">
          {activeParsedWorkspace && (
            <div className="view-mode-toggle-group" role="group" aria-label="阅读视图切换">
              <button
                type="button"
                className={`view-mode-toggle-btn ${viewMode === "original" ? "is-active" : ""}`}
                onClick={() => handleSetViewMode("original")}
                title="切换为 PDF/文本原版阅读视图"
              >
                原版视图
              </button>
              <button
                type="button"
                className={`view-mode-toggle-btn ${viewMode === "reflow" ? "is-active" : ""}`}
                onClick={() => handleSetViewMode("reflow")}
                title={isRevisionMismatch ? "切换为流式重排视图（源文档已发生变更）" : "切换为无纸化流式重排视图"}
              >
                {isRevisionMismatch && <span className="view-mode-outdated-dot" title="源文档版本不一致" />}
                流式重排
              </button>
            </div>
          )}
          <span className="menu-active-workspace-tag">
            {currentDoc?.display_name || "FlowRead 本地工作区"}
          </span>
          <span className="menu-zoom-tag status-zoom-percentage" title="当前阅读缩放 (Ctrl+滚轮 或 Ctrl+加号/减号)">
            {Math.round(scale * 100)}%
          </span>
        </div>
      </header>

      {/* 核心工作区：左侧轻量 Minimap + 中间正文阅读区 + 可拖动分界手柄 + 右侧伴读画布 + SVG 连线层 */}
      <div className="app-workspace" ref={workspaceRef} style={{ position: "relative" }}>
        <div
          className="workspace-underlay-content"
          inert={parsedPreviewTarget !== null ? true : undefined}
          style={{
            display: "flex",
            flexDirection: "row",
            flex: 1,
            width: "100%",
            height: "100%",
            minHeight: 0,
            overflow: "hidden",
            pointerEvents: parsedPreviewTarget ? "none" : undefined,
            userSelect: parsedPreviewTarget ? "none" : undefined,
          }}
        >
          {/* 左侧轻量 minimap 概览与视口导航 */}
          {viewMode !== "reflow" && (
            <ReaderMinimap
              mode={readerMode}
              workspaceRef={workspaceRef}
              textParagraphLengths={textDocInfo.paragraphLengths}
              pdfTotalPages={pdfStats?.totalPages}
              anchors={anchors}
              scale={scale}
            />
          )}

          <div className="workspace-reader-column">
            {/* 原版视图阅读器：在 reflow 模式下保持挂载但使用 display: none，保持 virtualizer、canvas 缓存与阅读位置 */}
            <div
              style={{
                display: viewMode === "reflow" ? "none" : "contents",
              }}
            >
              {readerMode === "text" ? (
                <ReaderArea
                  filePath={textFilePath}
                  onOpenPdf={handleOpenPdf}
                  onDocInfoChange={setTextDocInfo}
                  scale={scale}
                  anchors={anchors}
                  highlights={highlights}
                  activeAnchorId={activeAnchorId}
                  onSelectAnchor={handleSelectAnchor}
                  onVisibleAnchorsChange={handleVisibleAnchorsChange}
                  onCreateAnchorAndCard={handleCreateAnchorAndCard}
                  onCreateHighlight={handleCreateHighlight}
                  jumpTarget={textJumpTarget}
                  onJumpComplete={handleJumpComplete}
                  documentRevision={currentDoc?.revision}
                  documentId={currentDoc?.id}
                  documentSeq={openSequenceRef.current}
                />
              ) : (
                <PDFReaderArea
                  filePath={pdfPath}
                  scale={scale}
                  onScaleChange={setScale}
                  onStatsChange={setPdfStats}
                  onClose={() => setReaderMode("text")}
                  anchors={anchors}
                  highlights={highlights}
                  activeAnchorId={activeAnchorId}
                  onSelectAnchor={handleSelectAnchor}
                  onVisibleAnchorsChange={handleVisibleAnchorsChange}
                  onCreateAnchorAndCard={handleCreateAnchorAndCard}
                  onCreateHighlight={handleCreateHighlight}
                  jumpTarget={pdfJumpTarget}
                  onJumpComplete={handleJumpComplete}
                  documentRevision={currentDoc?.revision}
                  documentId={currentDoc?.id}
                  documentSeq={openSequenceRef.current}
                />
              )}
            </div>

            {/* 流式重排视图阅读器 */}
            {viewMode === "reflow" && activeParsedWorkspace && parsedWorkspaceAssetManagerRef.current && (
              <ParsedReflowReaderArea
                workspaceData={activeParsedWorkspace}
                assetManager={parsedWorkspaceAssetManagerRef.current}
                isRevisionMismatch={isRevisionMismatch}
                onToggleView={() => handleSetViewMode("original")}
                currentDocTitle={currentDoc?.display_name}
                initialScrollTop={(() => {
                  if (!currentDoc) return 0;
                  const key = `${currentDoc.id}:${currentDoc.revision || ""}:${activeParsedWorkspace.version_id}`;
                  const inMemory = reflowScrollTopMapRef.current[key];
                  if (typeof inMemory === "number") return inMemory;
                  // 重启后没有内存记录时，从独立存储恢复该版本的位置
                  return (
                    getReflowScrollTop(
                      currentDoc.id,
                      currentDoc.revision || "",
                      activeParsedWorkspace.version_id
                    ) ?? 0
                  );
                })()}
                onScrollPositionChange={(scrollTop) => {
                  if (!currentDoc) return;
                  const revision = currentDoc.revision || "";
                  const versionId = activeParsedWorkspace.version_id;
                  const key = `${currentDoc.id}:${revision}:${versionId}`;
                  reflowScrollTopMapRef.current[key] = scrollTop;
                  // 节流写入独立存储；快照携带文档身份，切书/卸载时 flush
                  reflowPositionWriterRef.current.schedule({
                    documentId: currentDoc.id,
                    revision,
                    versionId,
                    scrollTop,
                  });
                }}
                documentId={currentDoc?.id}
                documentSeq={openSequenceRef.current}
                sourceRevision={currentDoc?.revision}
                anchors={anchors}
                highlights={highlights}
                activeAnchorId={activeAnchorId}
                onSelectAnchor={handleSelectAnchor}
                onVisibleAnchorsChange={handleVisibleAnchorsChange}
                onCreateAnchorAndCard={handleCreateAnchorAndCard}
                onCreateHighlight={handleCreateHighlight}
                jumpTarget={parsedReflowJumpTarget}
                onJumpComplete={handleJumpComplete}
                onSelectionChange={setReflowSelectionSnapshot}
              />
            )}

            {/* 正文底部的浮动 Ask 输入框 (居中于正文下方) */}
            <FloatingAskBar
              onAsk={handleBottomAsk}
              disabled={
                !currentDoc ||
                parsedPreviewTarget !== null ||
                (viewMode === "reflow" && !hasValidReflowSource)
              }
              placeholder={
                viewMode === "reflow"
                  ? hasValidReflowSource
                    ? "针对重排选中片段提问... (按 / 聚焦，Ctrl+Enter 发送)"
                    : "请先在重排正文中选择一段文字，然后再发起提问..."
                  : activeAnchorId
                  ? "针对当前选中片段提问... (按 / 聚焦，Ctrl+Enter 发送)"
                  : "在正文下方随时提问或探讨... (按 / 聚焦，Ctrl+Enter 发送)"
              }
            />
          </div>

          {/* 正文与右侧卡片画布之间的拖拽手柄 */}
          <div
            className="workspace-splitter-handle"
            onPointerDown={handleSplitterPointerDown}
            title="左右拖动调整右侧伴读栏宽度"
          />

          {/* 独立 SVG 关联虚线层 */}
          {viewMode !== "reflow" && (
            <ConnectionLinesOverlay
              workspaceRef={workspaceRef}
              activeCardId={activeCardId}
              cards={cards}
            />
          )}

          {/* 右侧跟随卡片与记录本辅助区 */}
          <RightCompanionPanel
            width={companionWidth}
            document={currentDoc}
            activeCardId={activeCardId}
            onSelectCard={(id) => {
              setActiveCardId(id);
              const found = cards.find((c) => c.card_id === id);
              if (found?.anchor_id) {
                setActiveAnchorId(found.anchor_id);
              }
            }}
            onOpenFullModal={(id) => setFullModalCardId(id)}
            onJumpToSource={handleJumpToSource}
            onDeleteCard={handleDeleteCard}
            onSendFollowUp={handleSendFollowUp}
            hasSelection={activeAnchorId !== null}
            selectionExcerpt={
              anchors.find((a) => a.anchor_id === activeAnchorId)?.excerpt || undefined
            }
            visibleAnchorIds={visibleAnchorIds}
            cards={cards}
            onRefreshCards={async () => {
              if (currentDoc) {
                const res = await apiGetCards(currentDoc.id, 100, 0, "all");
                setCards(res.items);
              }
            }}
            viewMode={viewMode}
            activeParsedVersionId={activeParsedWorkspace?.version_id}
          />
        </div>

        {/* 阶段 2A：独立解析结果只读预览临时层 (覆盖工作区，不修改底层文档身份与阅读位置) */}
        {parsedPreviewTarget && (
          <ParsedDocumentPreview
            target={parsedPreviewTarget}
            onClose={() => {
              setParsedPreviewTarget(null);
              setPreviewFromJob(false);
            }}
            onOpenAnother={handleOpenParsedPreview}
            /* 任务结果预览禁止“绑定到当前文档”，避免把历史结果误绑到此刻另一本书 */
            onBindToCurrentDoc={
              previewFromJob || !currentDoc ? undefined : handleImportParsedToCurrentDoc
            }
            currentDocName={currentDoc?.display_name}
            isModalOpenAbove={
              isReadingSettingsOpen ||
              isModelConfigOpen ||
              isPromptConfigOpen ||
              isWorkspaceExplorerOpen ||
              isParserSettingsOpen ||
              isPdfParseImportOpen ||
              isParseJobsOpen ||
              fullModalCardId !== null
            }
          />
        )}
      </div>

      {/* 完整回答大窗 (Full Answer Window - 横向 16:10 比例) */}
      <FullAnswerModal
        isOpen={fullModalCardId !== null}
        cardId={fullModalCardId}
        onClose={() => setFullModalCardId(null)}
        onJumpToSource={(cId) => handleJumpToSource(cId)}
        onCardDeleted={(cId) => handleDeleteCard(cId)}
        globalTranslateLanguage={readingPrefs.translateLanguage}
      />

      {/* 阅读外观与排版设置模态框 */}
      <ReadingSettingsModal
        isOpen={isReadingSettingsOpen}
        preferences={readingPrefs}
        onSave={handleSaveReadingPreferences}
        onClose={() => setIsReadingSettingsOpen(false)}
      />

      {/* 工作区资源管理器模态框 */}
      <WorkspaceExplorerModal
        isOpen={isWorkspaceExplorerOpen}
        nodes={workspaceNodes}
        onSaveNodes={handleSaveWorkspaceNodes}
        onClose={() => setIsWorkspaceExplorerOpen(false)}
        onOpenFile={handleOpenFileFromExplorer}
        initialFolderId={explorerInitialFolderId}
      />

      {/* 模型配置模态框 */}
      <ModelConfigModal
        isOpen={isModelConfigOpen}
        config={aiConfig}
        onSave={handleSaveAIConfig}
        onActiveProfileChange={(activeProfile) => {
          setAiConfig(activeProfile);
        }}
        onClose={() => setIsModelConfigOpen(false)}
      />

      {/* 提示词工程配置模态框 */}
      <PromptConfigModal
        isOpen={isPromptConfigOpen}
        config={promptConfig}
        onSave={handleSavePromptConfig}
        onClose={() => setIsPromptConfigOpen(false)}
      />

      {/* PDF 解析服务设置（与伴读模型配置完全独立） */}
      <ParserSettingsModal
        isOpen={isParserSettingsOpen}
        focusProvider={parserSettingsFocus}
        onClose={() => {
          setIsParserSettingsOpen(false);
          setParserSettingsFocus(null);
        }}
        onSettingsChanged={handleParseSettingsChanged}
      />

      {/* 导入 PDF 并解析确认面板 */}
      <PdfParseImportModal
        isOpen={isPdfParseImportOpen && pdfParseTarget !== null}
        filePath={pdfParseTarget?.filePath ?? ""}
        fileName={pdfParseTarget?.fileName ?? ""}
        settings={parseSettings}
        submitting={parseSubmitting}
        errorMessage={parseSubmitError || parseSettingsLoadError}
        onClose={() => {
          if (parseSubmitting) return;
          setIsPdfParseImportOpen(false);
          setPdfParseTarget(null);
          setParseSubmitError(null);
          setParseSettingsLoadError(null);
        }}
        onOpenProviderSettings={(provider) => handleOpenParserSettings(provider)}
        onSubmit={(options) => void handleStartPdfParse(options)}
      />

      {/* 解析任务面板（关闭后任务仍由应用级跟踪器轮询） */}
      <ParseJobsPanel
        isOpen={isParseJobsOpen}
        jobs={parseJobs}
        loading={parseJobsLoading}
        errorMessage={parseJobsError}
        nextCursor={parseJobsNextCursor}
        loadingMore={parseJobsLoadingMore}
        busyJobIds={parseBusyJobIds}
        currentDocumentId={currentDoc?.id ?? null}
        serviceHealth={parseServiceHealth}
        onClose={() => setIsParseJobsOpen(false)}
        onRefresh={() => void refreshParseJobs()}
        onLoadMore={() => void handleLoadMoreParseJobs()}
        onCancel={handleCancelParseJob}
        onResume={handleResumeParseJob}
        onRetry={handleRetryParseJob}
        onViewResult={(job) => void handleViewParseResult(job)}
        onOpenResultDocument={(job) => void handleOpenParseResultDocument(job)}
      />

      {/* 全局重排轻提示 */}
      {globalToast && (
        <div className="parsed-reflow-toast" role="alert">
          {globalToast}
        </div>
      )}

      {/* 解析任务轻提示：任务完成但不满足自动切换条件时提示，不打断当前阅读 */}
      {parseNotice && (
        <div className="parse-toast" role="status">
          <span>{parseNotice}</span>
          <button
            type="button"
            className="parse-toast-action"
            onClick={() => {
              setParseNotice(null);
              handleOpenParseJobs();
            }}
          >
            查看任务
          </button>
          <button
            type="button"
            className="parse-toast-close"
            onClick={() => setParseNotice(null)}
            title="关闭提示"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
