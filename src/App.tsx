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
  CardAction,
  CardDepth,
  ReadingPreferences,
} from "./types/records";
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
} from "./utils/recordStorage";
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

  // 页面/段落双向跳转目标（一次性可取消请求，带唯一请求ID与文档身份）
  const [pdfJumpTarget, setPdfJumpTarget] = useState<PDFJumpTarget | null>(null);
  const [textJumpTarget, setTextJumpTarget] = useState<TextJumpTarget | null>(null);
  const latestJumpRequestIdRef = useRef<number>(0);

  const handleJumpComplete = useCallback((completedReqId: string) => {
    setTextJumpTarget((prev) => (prev?.requestId === completedReqId ? null : prev));
    setPdfJumpTarget((prev) => (prev?.requestId === completedReqId ? null : prev));
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

  const activeMenuRef = useRef(activeMenu);
  activeMenuRef.current = activeMenu;

  const isAnyModalOpenRef = useRef(false);
  isAnyModalOpenRef.current =
    isWorkspaceExplorerOpen ||
    isModelConfigOpen ||
    isPromptConfigOpen ||
    isReadingSettingsOpen ||
    fullModalCardId !== null ||
    parsedPreviewTarget !== null;

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
    ) => {
      // 1. 立即递增打开序号，建立目标路径与模式
      const seq = ++openSequenceRef.current;
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

      // 3. 立即重置旧文档身份与关联数据，废弃任何进行中的跳转请求，避免身份未就绪时新书操作登记到旧书
      latestJumpRequestIdRef.current++;
      setTextJumpTarget(null);
      setPdfJumpTarget(null);
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
          if (seq !== openSequenceRef.current) return;
          sizeBytes = meta.size;
          revision = meta.revision;
        } catch (err) {
          if (seq !== openSequenceRef.current) return;
          console.warn("[FlowRead] 获取文件元数据失败:", err);
        }
      }

      if (seq !== openSequenceRef.current) return;

      try {
        // 6. 从 SQLite 获取或创建文档身份（校验 seq）
        const doc = await apiGetOrCreateDocument(filePath, displayName, sizeBytes, revision);
        if (seq !== openSequenceRef.current) return;
        currentDocRef.current = doc;
        setCurrentDoc(doc);

        // 7. 读取该文档的阅读偏好并应用（校验 seq）
        const prefs = await apiGetReadingPreferences(doc.id);
        if (seq !== openSequenceRef.current) return;
        setReadingPrefs(prefs);
        applyTheme(prefs);

        // 8. 读取锚点、卡片列表、高亮列表（校验 seq）
        const [loadedAnchors, cardListRes, loadedHighlights] = await Promise.all([
          apiGetAnchors(doc.id),
          apiGetCards(doc.id, 100, 0, "all"),
          apiGetHighlights(doc.id),
        ]);
        if (seq !== openSequenceRef.current) return;

        setAnchors(loadedAnchors);
        setCards(cardListRes.items);
        setHighlights(loadedHighlights);
        setActiveCardId(cardListRes.items[0]?.card_id || null);
      } catch (err) {
        if (seq !== openSequenceRef.current) return;
        console.error("[FlowRead] 载入文档身份失败:", err);
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
    }) => {
      const targetDoc = currentDocRef.current;
      if (!targetDoc) return;
      if (!params.boundDocId || params.boundDocId !== targetDoc.id) return;
      const targetDocId = targetDoc.id;
      const seq = params.boundSeq;
      if (seq === undefined || openSequenceRef.current !== seq) return;
      if (params.boundRevision && targetDoc.revision && params.boundRevision !== targetDoc.revision) return;

      let anchorId: string | null = null;
      let finalLocation = params.location;

      // 如果为图像裁切，先保存二进制文件至 app data assets
      if (params.imageBase64) {
        try {
          const assetId = await apiSaveBase64Image(targetDocId, "crop.jpg", params.imageBase64);
          if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;
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

      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;

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
        if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;
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

      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) {
        // 创建记录后因切书而放弃入队的 queued 记录，同样需要结算，不能留下永远等待的任务
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

      // 发送真实 AI 请求到调度器（若已切书，不入队）
      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;

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
    }) => {
      const targetDoc = currentDocRef.current;
      if (!targetDoc) return;
      if (!params.boundDocId || params.boundDocId !== targetDoc.id) return;
      const targetDocId = targetDoc.id;
      const seq = params.boundSeq;
      if (seq === undefined || openSequenceRef.current !== seq) return;
      if (params.boundRevision && targetDoc.revision && params.boundRevision !== targetDoc.revision) return;

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
        if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;
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
      if (openSequenceRef.current !== seq || currentDocRef.current?.id !== targetDocId) return;
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

    // 如果当前有激活的卡片锚点，借用该锚点；否则作为文档级提问
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
      // 若处于独立解析预览层，缩放操作完全静默，避免修改底层文档 scale
      if (parsedPreviewTargetRef.current) return;

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
          setScale((s) => Math.min(3.0, +(s + 0.1).toFixed(2)));
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)));
        } else if (e.key === "0") {
          e.preventDefault();
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
      setParsedPreviewTarget((prev) => ({
        filePath: targetPath!,
        loadKey: (prev ? prev.loadKey : 0) + 1,
      }));
    }
  }, []);

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
                      void handleOpenParsedPreview();
                    }}
                  >
                    <span>打开解析结果预览…</span>
                  </div>
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
          <ReaderMinimap
            mode={readerMode}
            workspaceRef={workspaceRef}
            textParagraphLengths={textDocInfo.paragraphLengths}
            pdfTotalPages={pdfStats?.totalPages}
            anchors={anchors}
            scale={scale}
          />

          <div className="workspace-reader-column">
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

            {/* 正文底部的浮动 Ask 输入框 (居中于正文下方) */}
            <FloatingAskBar
              onAsk={handleBottomAsk}
              disabled={!currentDoc || parsedPreviewTarget !== null}
              placeholder={
                activeAnchorId
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
          <ConnectionLinesOverlay
            workspaceRef={workspaceRef}
            activeCardId={activeCardId}
            cards={cards}
          />

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
          />
        </div>

        {/* 阶段 2A：独立解析结果只读预览临时层 (覆盖工作区，不修改底层文档身份与阅读位置) */}
        {parsedPreviewTarget && (
          <ParsedDocumentPreview
            target={parsedPreviewTarget}
            onClose={() => setParsedPreviewTarget(null)}
            onOpenAnother={handleOpenParsedPreview}
            isModalOpenAbove={
              isReadingSettingsOpen ||
              isModelConfigOpen ||
              isPromptConfigOpen ||
              isWorkspaceExplorerOpen ||
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
    </div>
  );
}
