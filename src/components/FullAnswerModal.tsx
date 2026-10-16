import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { FullCardDetail, CardTurnRecord, CardDepth } from "../types/records";
import {
  apiGetCardDetail,
  apiSaveFunctionResult,
  apiAllocateFunctionVersion,
  apiGetAssetUrl,
  apiGetAssetDataUrl,
  apiRevokeAssetUrl,
  apiDeleteCard,
  apiCreateCardTurn,
  apiUpdateCardTurnStream,
} from "../utils/recordStorage";
import { aiDispatcher } from "../utils/aiDispatcher";
import { normalizeLatex } from "./AIPanel";
import { getActiveModelProfile } from "../utils/aiConfig";
import { loadPromptConfig } from "../utils/promptConfig";
import {
  resolveTargetLanguage,
  buildTranslationSystemPrompt,
  buildFunctionConfigSignature,
} from "../utils/translationManager";
import { loadGlobalPreferences } from "../utils/themeManager";

export interface FullAnswerModalProps {
  isOpen: boolean;
  cardId: string | null;
  onClose: () => void;
  onJumpToSource?: (cardId: string) => void;
  onCardDeleted?: (cardId: string) => void;
  globalTranslateLanguage?: "auto" | "zh" | "en";
}

type TabMode = "main" | "explain" | "translate" | "formula" | "diagram";

export default function FullAnswerModal({
  isOpen,
  cardId,
  onClose,
  onJumpToSource,
  onCardDeleted,
  globalTranslateLanguage,
}: FullAnswerModalProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<FullCardDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<TabMode>("main");
  const [imageDisplayUrl, setImageDisplayUrl] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // 追问与初答生成状态区分
  const [followUpPrompt, setFollowUpPrompt] = useState<string>("");
  const [followUpDepth, setFollowUpDepth] = useState<CardDepth>("quick");
  const [isInitialGenerating, setIsInitialGenerating] = useState<boolean>(false);
  const [isFollowUpGenerating, setIsFollowUpGenerating] = useState<boolean>(false);
  const [currentStreamingTurn, setCurrentStreamingTurn] = useState<CardTurnRecord | null>(null);

  // 功能页切页状态与异步序号绑定
  const [tabLoading, setTabLoading] = useState<boolean>(false);
  const [tabError, setTabError] = useState<string | null>(null);

  // 实时配置源：优先本地卡片临时覆盖；未覆盖时默认继承全局设置。
  const [localOverrideLang, setLocalOverrideLang] = useState<("auto" | "zh" | "en") | null>(null);
  const effectiveGlobalLang = globalTranslateLanguage || loadGlobalPreferences().translateLanguage || "auto";
  const translateLang: "auto" | "zh" | "en" = localOverrideLang ?? effectiveGlobalLang;

  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef<number>(0);
  const tabReqSeqRef = useRef<number>(0);
  const currentCardIdRef = useRef<string | null>(cardId);
  currentCardIdRef.current = cardId;
  const isOpenRef = useRef<boolean>(isOpen);
  isOpenRef.current = isOpen;
  const activeTabRef = useRef<TabMode>(activeTab);
  activeTabRef.current = activeTab;
  const translateLangRef = useRef<"auto" | "zh" | "en">(translateLang);
  translateLangRef.current = translateLang;
  const activeTurnPromptsRef = useRef<Map<string, string>>(new Map());
  const activeTabAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // 加载卡片全部详情 (严格先校验卡片与窗口有效性，再修改序号、loading及图片状态)
  const loadDetail = useCallback(async (cId: string) => {
    if (!isOpenRef.current || !cId || currentCardIdRef.current !== cId) {
      return;
    }

    const seq = ++loadSeqRef.current;
    setLoading(true);
    setImageDisplayUrl(null);
    setImageDataUrl(null);
    setImageError(null);

    try {
      const data = await apiGetCardDetail(cId);
      if (seq !== loadSeqRef.current || !isOpenRef.current || currentCardIdRef.current !== cId) {
        return;
      }
      // 同步历史问题文本到 activeTurnPromptsRef，防止重开或刷新详情时丢失问题
      for (const t of data.turns) {
        if (t.user_prompt && !activeTurnPromptsRef.current.has(t.turn_id)) {
          activeTurnPromptsRef.current.set(t.turn_id, t.user_prompt);
        }
      }

      setDetail(data);

      // 仅当流式块已进入终态 (completed/failed/interrupted) 且已落库时，才清理临时块
      setCurrentStreamingTurn((prev) => {
        if (!prev) return null;
        const isTerminal =
          prev.status === "completed" ||
          prev.status === "failed" ||
          prev.status === "interrupted";
        if (isTerminal && data.turns.some((t) => t.turn_id === prev.turn_id)) {
          activeTurnPromptsRef.current.delete(prev.turn_id);
          return null;
        }
        return prev;
      });

      // 区分初答生成和追问生成，读取真实任务状态，防止按钮异常禁用或永久生成中
      const initialActive =
        aiDispatcher.isCardInitialActive(cId) ||
        data.card.status === "generating" ||
        data.card.status === "queued";
      const followUpActive = aiDispatcher.isCardFollowUpActive(cId);

      setIsInitialGenerating(initialActive);
      setIsFollowUpGenerating(followUpActive);

      // 如果有图片资产，加载图片真实数据 URL 与显示 URL
      if (data.anchor?.source_type === "pdf_image") {
        try {
          const loc = JSON.parse(data.anchor.location_json);
          const assetId = loc.location?.assetId || loc.assetId;
          if (assetId) {
            // 1. 读取带正确 MIME 的 data URL (base64) 用于发送给外部 AI 多模态模型
            const dataUrl = await apiGetAssetDataUrl(assetId);
            if (seq !== loadSeqRef.current || !isOpenRef.current || currentCardIdRef.current !== cId) {
              return;
            }
            setImageDataUrl(dataUrl);

            // 2. 读取本机用于快速渲染展示的 Blob URL
            const displayUrl = await apiGetAssetUrl(assetId);
            if (seq !== loadSeqRef.current || !isOpenRef.current || currentCardIdRef.current !== cId) {
              return;
            }
            setImageDisplayUrl(displayUrl);
          }
        } catch (imgErr) {
          if (seq !== loadSeqRef.current || !isOpenRef.current || currentCardIdRef.current !== cId) {
            return;
          }
          console.warn("[FullAnswerModal] 读取图片资产失败:", imgErr);
          setImageError(imgErr instanceof Error ? imgErr.message : "图片资产文件读取失败或已丢失");
        }
      }
    } catch (err) {
      if (seq !== loadSeqRef.current || !isOpenRef.current || currentCardIdRef.current !== cId) {
        return;
      }
      console.error("[FullAnswerModal] 加载卡片详情异常:", err);
    } finally {
      if (seq === loadSeqRef.current && isOpenRef.current && currentCardIdRef.current === cId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setLocalOverrideLang(null);
    if (isOpen && cardId) {
      setActiveTab("main");
      setTabError(null);
      setTabLoading(false);
      setCurrentStreamingTurn(null);
      void loadDetail(cardId);
    } else {
      setDetail(null);
      setImageDisplayUrl(null);
      setImageDataUrl(null);
      setImageError(null);
      setIsInitialGenerating(false);
      setIsFollowUpGenerating(false);
      setCurrentStreamingTurn(null);
    }
  }, [isOpen, cardId, loadDetail]);

  // 监听全局 Esc 键退出
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // 监听当前卡片的 AI 流式更新
  useEffect(() => {
    if (!isOpen || !cardId) return;

    const unsubscribe = aiDispatcher.subscribe((update) => {
      if (update.cardId === cardId) {
        if (update.turnId) {
          // 正在进行追问流：使用提交时固定的完整问题文本，不从已清空的输入框读取
          const fixedPrompt =
            activeTurnPromptsRef.current.get(update.turnId) ||
            currentStreamingTurn?.user_prompt ||
            detail?.turns.find((t) => t.turn_id === update.turnId)?.user_prompt ||
            "";
          setCurrentStreamingTurn({
            turn_id: update.turnId,
            card_id: cardId,
            user_prompt: fixedPrompt,
            ai_response: update.accumulatedText,
            status: update.status,
            created_at: Date.now(),
          });

          if (
            update.status === "completed" ||
            update.status === "failed" ||
            update.status === "interrupted"
          ) {
            setIsFollowUpGenerating(false);
            void loadDetail(cardId);
          } else if (update.status === "generating" || update.status === "queued") {
            setIsFollowUpGenerating(true);
          }
        } else {
          // 主回答在流式更新
          setDetail((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              card: {
                ...prev.card,
                preview: update.accumulatedText.slice(0, 400),
                ai_response: update.accumulatedText,
                status: update.status,
                error_message: update.errorMessage || null,
              },
            };
          });

          if (
            update.status === "completed" ||
            update.status === "failed" ||
            update.status === "interrupted"
          ) {
            setIsInitialGenerating(false);
          } else if (update.status === "generating" || update.status === "queued") {
            setIsInitialGenerating(true);
          }
        }
      }
    });

    return () => unsubscribe();
  }, [isOpen, cardId, followUpPrompt, loadDetail]);

  if (!isOpen || !cardId) return null;

  // 执行具体功能切页的按需生成与读取
  const handleTabSwitch = async (
    mode: TabMode,
    langOverride?: "auto" | "zh" | "en",
    forceRegenerate: boolean = false
  ) => {
    // 每次切换功能页都先处理请求身份和 loading，阻断旧请求并确保切回缓存时 loading 立即结束
    const reqSeq = ++tabReqSeqRef.current;
    setActiveTab(mode);
    setTabError(null);
    setTabLoading(false);

    // 再判断 main 或无详情
    if (mode === "main" || !detail) return;

    const excerpt = detail.anchor?.excerpt || detail.card.user_prompt;
    const targetConfigLang = langOverride !== undefined ? langOverride : translateLang;
    const resolved = resolveTargetLanguage(excerpt, targetConfigLang);
    const targetLang = mode === "translate" ? resolved.targetLang : "";
    const modeKey = mode === "translate" ? `translate:${targetLang}` : mode;

    const reqCardId = detail.card.card_id;
    const reqMode = mode;
    const reqLang = targetLang;
    const reqKey = `${reqCardId}:${modeKey}`;

    const isImage = detail.anchor?.source_type === "pdf_image";
    const activeProfile = getActiveModelProfile();
    const promptConfig = loadPromptConfig();
    const apiKey = activeProfile.apiKey.trim();
    const baseUrl = activeProfile.baseUrl.trim() || "https://api.deepseek.com/chat/completions";
    const modelName = activeProfile.modelName.trim() || "deepseek-chat";

    let systemPrompt = "";
    let userContent: unknown = "";

    if (mode === "translate") {
      systemPrompt = buildTranslationSystemPrompt(resolved, promptConfig);
      userContent = excerpt;
    } else if (mode === "explain") {
      systemPrompt = `${promptConfig.globalPrompt}\n\n${promptConfig.explain}`;
      userContent = `请深度剖析并解释以下选区：\n\n「${excerpt}」`;
    } else if (mode === "formula") {
      systemPrompt = `${promptConfig.globalPrompt}\n\n${promptConfig.extractFormula}`;
      userContent = isImage && imageDataUrl
        ? [
            { type: "text", text: "请精准提取识别该图像切片中的所有数学与物理公式，输出标准 LaTeX 排版。" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ]
        : `请提取以下文本中的所有公式并转为标准 LaTeX：\n\n「${excerpt}」`;
    } else if (mode === "diagram") {
      systemPrompt = `${promptConfig.globalPrompt}\n\n${promptConfig.analyzeChart}`;
      userContent = isImage && imageDataUrl
        ? [
            { type: "text", text: "请对框选的工程图表/拓扑/架构进行全面深入分析。" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ]
        : `请解析该内容中的图表结构：\n\n「${excerpt}」`;
    }

    const currentConfigSignature = buildFunctionConfigSignature({
      sourceText: excerpt,
      sourceRevision: detail.anchor?.document_revision,
      mode,
      targetLang,
      prompt: systemPrompt,
      modelName,
      baseUrl,
      depth: detail.card.depth || "quick",
    });

    // 1. 缓存精确匹配：非 forceRegenerate 且配置签名一致时，直接命中已有缓存
    // 用户执行功能时，只复用严格匹配当前配置签名的结果；无签名旧缓存不得冒充当前有效缓存
    if (!forceRegenerate) {
      const existing = detail.function_results.find((f) => f.mode === modeKey);
      if (existing) {
        if (existing.config_signature && existing.config_signature === currentConfigSignature) {
          return;
        }
      }
    }

    // 中断同卡同功能的旧请求
    activeTabAbortControllersRef.current.get(reqKey)?.abort();
    const abortController = new AbortController();
    activeTabAbortControllersRef.current.set(reqKey, abortController);
    setTabLoading(true);
    setTabError(null);

    try {
      // 1. 分配数据库提交版本号：分配失败明确报错并终止，不降级为版本1后发起付费请求
      let reqVersion: number;
      try {
        reqVersion = await apiAllocateFunctionVersion(reqCardId, modeKey);
      } catch (allocErr) {
        throw new Error(
          `分配功能任务版本失败: ${allocErr instanceof Error ? allocErr.message : String(allocErr)}`
        );
      }

      // 2. 检查是否有有效输入（公式/图表缺失时如实告知并落库）
      if (mode === "formula") {
        const hasFormula = /[\\$^_={}]|[\u0370-\u03ff]|\d+\s*[+\-*/=]/.test(excerpt);
        if (!hasFormula && !isImage) {
          const noFormulaMsg = "【公式检测结论】：所选原文未检测到明确的数学或物理公式。";
          await apiSaveFunctionResult(reqCardId, "formula", noFormulaMsg, currentConfigSignature, reqVersion);
          if (
            isOpenRef.current &&
            currentCardIdRef.current === reqCardId &&
            activeTabRef.current === reqMode &&
            tabReqSeqRef.current === reqSeq
          ) {
            await loadDetail(reqCardId);
          }
          return;
        }
      }

      if (mode === "diagram" && !isImage) {
        const noDiagramMsg = "【视觉图表结论】：当前选区为纯文本，未包含工程拓扑图、电路图或数据曲线插图。";
        await apiSaveFunctionResult(reqCardId, "diagram", noDiagramMsg, currentConfigSignature, reqVersion);
        if (
          isOpenRef.current &&
          currentCardIdRef.current === reqCardId &&
          activeTabRef.current === reqMode &&
          tabReqSeqRef.current === reqSeq
        ) {
          await loadDetail(reqCardId);
        }
        return;
      }

      // 3. 校验 API Key
      if (!apiKey) {
        throw new Error("请先在 [工具 -> 模型配置] 中配置 API 密钥");
      }

      // 4. 真实发送请求进行针对性生成
      const res = await fetch(baseUrl, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API 请求错误 [${res.status}]: ${errText}`);
      }

      const json = await res.json();
      const resultText = json.choices?.[0]?.message?.content || "";

      // 数据库提交时校验有效版本，版本过旧不会覆盖新生成
      await apiSaveFunctionResult(reqCardId, modeKey, resultText, currentConfigSignature, reqVersion);

      // 但不能刷新或改变新卡片窗口：必须严格校验卡片、模式、语言和请求序号
      if (
        isOpenRef.current &&
        currentCardIdRef.current === reqCardId &&
        activeTabRef.current === reqMode &&
        (reqMode !== "translate" || translateLangRef.current === targetConfigLang || translateLangRef.current === reqLang) &&
        tabReqSeqRef.current === reqSeq
      ) {
        await loadDetail(reqCardId);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (
        isOpenRef.current &&
        currentCardIdRef.current === reqCardId &&
        activeTabRef.current === reqMode &&
        tabReqSeqRef.current === reqSeq
      ) {
        setTabError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (
        isOpenRef.current &&
        currentCardIdRef.current === reqCardId &&
        activeTabRef.current === reqMode &&
        tabReqSeqRef.current === reqSeq
      ) {
        setTabLoading(false);
      }
    }
  };

  // 提交追问
  const handleSendFollowUp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const prompt = followUpPrompt.trim();
    if (!prompt || !detail || isInitialGenerating || isFollowUpGenerating) return;

    setIsFollowUpGenerating(true);
    const turnId = `trn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const targetCardId = detail.card.card_id;

    // 1. 记录提交时固定的完整问题文本，不从已清空的输入框读取
    activeTurnPromptsRef.current.set(turnId, prompt);

    // 2. 追问开始前在数据库建立持久轮次，保证即使中断也保留已有记录
    await apiCreateCardTurn(targetCardId, prompt, turnId, "queued");

    if (!isOpenRef.current || currentCardIdRef.current !== targetCardId) {
      void apiUpdateCardTurnStream(turnId, "", "interrupted");
      return;
    }

    // 2. 组装历史上下文
    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: detail.card.user_prompt || detail.card.action },
      { role: "assistant", content: detail.card.ai_response },
    ];
    for (const t of detail.turns) {
      if (t.user_prompt && t.ai_response) {
        history.push({ role: "user", content: t.user_prompt });
        history.push({ role: "assistant", content: t.ai_response });
      }
    }

    aiDispatcher.enqueue({
      jobId: `${targetCardId}_turn_${turnId}`,
      cardId: targetCardId,
      documentId: detail.card.document_id,
      turnId,
      action: "Ask",
      depth: followUpDepth,
      userPrompt: prompt,
      contextExcerpt: detail.anchor?.excerpt,
      imageBase64: imageDataUrl || undefined,
      history,
    });

    setFollowUpPrompt("");
  };

  // 复制全文 Markdown
  const handleCopyFullMarkdown = () => {
    if (!detail) return;
    const lines = [
      `# FlowRead 深度伴读记录`,
      `- 来源: ${detail.anchor?.source_type === "pdf_image" ? "图像选区" : "原文摘录"}`,
      detail.anchor?.excerpt ? `> ${detail.anchor.excerpt}\n` : "",
      `## 核心回答 (${detail.card.action})`,
      detail.card.ai_response,
    ];

    if (detail.turns.length > 0) {
      lines.push(`\n## 追问记录`);
      for (const t of detail.turns) {
        lines.push(`### 问：${t.user_prompt}\n${t.ai_response}\n`);
      }
    }

    navigator.clipboard.writeText(lines.join("\n"));
  };

  // 删除卡片
  const handleDeleteCard = async () => {
    if (!detail) return;
    if (window.confirm("确定删除本条伴读记录吗？")) {
      if (detail.anchor?.source_type === "pdf_image") {
        try {
          const loc = JSON.parse(detail.anchor.location_json);
          const aid = loc.location?.assetId || loc.assetId;
          if (aid) apiRevokeAssetUrl(aid);
        } catch {}
      }
      await apiDeleteCard(detail.card.card_id);
      onCardDeleted?.(detail.card.card_id);
      onClose();
    }
  };

  // 回到原文
  const handleJump = () => {
    if (detail && onJumpToSource) {
      onJumpToSource(detail.card.card_id);
      onClose();
    }
  };

  const resolvedTarget = resolveTargetLanguage(
    detail?.anchor?.excerpt || detail?.card.user_prompt || "",
    translateLang
  );

  const currentTabResult = detail?.function_results.find((f) => {
    if (activeTab === "translate") {
      return f.mode === `translate:${resolvedTarget.targetLang}`;
    }
    return f.mode === activeTab;
  });

  return (
    <div
      className="full-answer-modal-overlay"
      onClick={onClose}
    >
      <div
        className="full-answer-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 固定顶部栏 */}
        <header
          style={{
            padding: "16px 22px",
            borderBottom: "1px solid var(--ln, #e2e8f0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "var(--pen, #e8664a)",
                background: "rgba(232, 102, 74, 0.12)",
                padding: "3px 8px",
                borderRadius: "6px",
                textTransform: "uppercase",
              }}
            >
              {detail?.card.action || "Answer"}
            </span>
            <span style={{ fontSize: "13px", color: "var(--mut, #85827b)", whiteSpace: "nowrap" }}>
              {detail?.card.depth === "deep" ? "✦ Deep 深度模式" : "⚡ Quick 快速模式"}
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              className="toolbar-action-btn"
              onClick={handleJump}
              title="定位并回到原文位置"
              style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "6px" }}
            >
              ⤾ 回到原文
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onClick={handleCopyFullMarkdown}
              title="复制完整 Markdown 报告"
              style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "6px" }}
            >
              ⧉ 复制
            </button>
            <button
              type="button"
              className="toolbar-action-btn"
              onClick={handleDeleteCard}
              title="删除本条学习记录"
              style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "6px", color: "#f43f5e" }}
            >
              ✕ 删除
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                fontSize: "18px",
                lineHeight: 1,
                cursor: "pointer",
                padding: "4px 8px",
                color: "var(--mut, #85827b)",
              }}
              title="关闭 (Esc)"
            >
              ×
            </button>
          </div>
        </header>

        {/* 功能 Tab 栏 (主体回答 / 解释 / 翻译 / 公式 / 图表) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "8px 22px",
            background: "var(--bg, #f8fafc)",
            borderBottom: "1px solid var(--ln, #e2e8f0)",
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          {[
            { key: "main", label: "完整回答" },
            { key: "explain", label: "✧ 深度解释" },
            { key: "translate", label: "对照翻译" },
            { key: "formula", label: "提取公式" },
            { key: "diagram", label: "图表解析" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => handleTabSwitch(t.key as TabMode)}
              style={{
                border: "none",
                background: activeTab === t.key ? "var(--cd, #ffffff)" : "transparent",
                color: activeTab === t.key ? "var(--pen, #e8664a)" : "var(--mut, #85827b)",
                fontWeight: activeTab === t.key ? 600 : 400,
                padding: "5px 12px",
                borderRadius: "8px",
                fontSize: "12px",
                cursor: "pointer",
                boxShadow: activeTab === t.key ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                flexShrink: 0,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 内容主体滚动区 */}
        <div
          ref={scrollBodyRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "22px 28px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            minHeight: 0,
          }}
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: "60px 0", color: "var(--mut, #85827b)" }}>
              正在加载伴读详情...
            </div>
          ) : (
            <>
              {/* 原文摘录或框选图像 */}
              <div
                style={{
                  borderLeft: "3px solid var(--pen, #e8664a)",
                  backgroundColor: "rgba(232, 102, 74, 0.05)",
                  padding: "12px 16px",
                  borderRadius: "0 8px 8px 0",
                }}
              >
                <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--pen, #e8664a)", marginBottom: "4px" }}>
                  原文来源
                </div>
                {imageError ? (
                  <div
                    style={{
                      marginTop: "6px",
                      padding: "8px 12px",
                      background: "rgba(244, 63, 94, 0.08)",
                      border: "1px solid rgba(244, 63, 94, 0.3)",
                      borderRadius: "6px",
                      color: "#f43f5e",
                      fontSize: "12px",
                    }}
                  >
                    [图片资产读取异常]: {imageError}
                  </div>
                ) : imageDisplayUrl ? (
                  <div style={{ marginTop: "6px" }}>
                    <img
                      src={imageDisplayUrl}
                      alt="框选区域切片"
                      style={{
                        maxWidth: "100%",
                        maxHeight: "220px",
                        objectFit: "contain",
                        borderRadius: "6px",
                        border: "1px solid var(--ln, #e2e8f0)",
                      }}
                    />
                  </div>
                ) : (
                  <blockquote
                    style={{
                      margin: 0,
                      fontSize: "13px",
                      lineHeight: 1.6,
                      color: "var(--fg, #0f172a)",
                      fontStyle: "italic",
                    }}
                  >
                    “{detail?.anchor?.excerpt || detail?.card.user_prompt}”
                  </blockquote>
                )}
              </div>

              {/* 用户问题 (如有) */}
              {detail?.card.user_prompt && (
                <div style={{ fontSize: "14px", fontWeight: 500, color: "var(--fg, #0f172a)" }}>
                  提问：{detail.card.user_prompt}
                </div>
              )}

              {/* 渲染当前选中 Tab 的内容 */}
              {activeTab === "main" ? (
                <div className="markdown-body" style={{ fontSize: "var(--card-fs, 13px)", lineHeight: 1.7 }}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                  >
                    {normalizeLatex(detail?.card.ai_response || "")}
                  </ReactMarkdown>

                  {detail?.card.status === "generating" && <span className="typing-cursor">▌</span>}
                  {detail?.card.error_message && (
                    <div style={{ color: "#f43f5e", marginTop: "12px" }}>
                      [生成异常]: {detail.card.error_message}
                    </div>
                  )}
                </div>
              ) : activeTab === "translate" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "8px",
                      paddingBottom: "8px",
                      borderBottom: "1px solid var(--ln, #e2e8f0)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontSize: "13px", fontWeight: 600 }}>对照翻译</span>
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--mut, #85827b)",
                          background: "var(--bg, #f1f5f9)",
                          padding: "2px 6px",
                          borderRadius: "4px",
                        }}
                      >
                        目标: {resolvedTarget.displayLabel} {resolvedTarget.isAuto ? "(自动检测)" : ""}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ display: "flex", gap: "4px" }}>
                        {([
                          { id: "auto", label: "自动" },
                          { id: "zh", label: "中文" },
                          { id: "en", label: "English" },
                        ] as const).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setLocalOverrideLang(item.id);
                              void handleTabSwitch("translate", item.id);
                            }}
                            style={{
                              padding: "3px 8px",
                              borderRadius: "6px",
                              border: "1px solid var(--ln, #e2e8f0)",
                              background: translateLang === item.id ? "var(--pen, #e8664a)" : "transparent",
                              color: translateLang === item.id ? "#fff" : "var(--mut, #85827b)",
                              fontSize: "11px",
                              cursor: "pointer",
                              fontWeight: translateLang === item.id ? 600 : 400,
                            }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleTabSwitch("translate", translateLang, true)}
                        disabled={tabLoading}
                        style={{
                          padding: "3px 10px",
                          borderRadius: "6px",
                          border: "1px solid var(--pen, #e8664a)",
                          background: "transparent",
                          color: "var(--pen, #e8664a)",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: tabLoading ? "not-allowed" : "pointer",
                          opacity: tabLoading ? 0.6 : 1,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                        title="强制重新请求翻译，绕过现有缓存"
                      >
                        🔄 重新生成
                      </button>
                    </div>
                  </div>

                  {/* 原文与译文按上下顺序展示 */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                    <div
                      style={{
                        padding: "14px",
                        borderRadius: "8px",
                        background: "var(--bg, #f8fafc)",
                        border: "1px solid var(--ln, #e2e8f0)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "var(--mut, #85827b)",
                          marginBottom: "6px",
                          letterSpacing: "0.5px",
                        }}
                      >
                        【原文】
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          lineHeight: 1.7,
                          color: "var(--fg, #0f172a)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {detail?.anchor?.excerpt || "（无原文摘录）"}
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "14px",
                        borderRadius: "8px",
                        background: "var(--bg, #f8fafc)",
                        border: "1px solid var(--pen, #e8664a)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "var(--pen, #e8664a)",
                          marginBottom: "6px",
                          letterSpacing: "0.5px",
                        }}
                      >
                        【译文】
                      </div>
                      {tabLoading ? (
                        <div style={{ color: "var(--mut, #85827b)", fontSize: "13px", padding: "8px 0" }}>
                          正在翻译中...
                        </div>
                      ) : tabError ? (
                        <div style={{ color: "#f43f5e", fontSize: "13px" }}>
                          翻译失败: {tabError}
                          <button
                            type="button"
                            onClick={() => void handleTabSwitch("translate", translateLang, true)}
                            style={{ marginLeft: "8px", color: "var(--pen, #e8664a)", cursor: "pointer", background: "none", border: "none" }}
                          >
                            重试
                          </button>
                        </div>
                      ) : (
                        <div
                          className="markdown-body"
                          style={{
                            fontSize: "13px",
                            lineHeight: 1.7,
                            color: "var(--fg, #0f172a)",
                          }}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                          >
                            {currentTabResult?.result_content || "暂无翻译结果，请点击重新生成"}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {tabLoading ? (
                    <div style={{ textAlign: "center", padding: "40px 0", color: "var(--mut, #85827b)" }}>
                      正在生成 {activeTab} 分析...
                    </div>
                  ) : tabError ? (
                    <div style={{ color: "#f43f5e", padding: "12px" }}>
                      生成遇到问题: {tabError}
                      <button
                        type="button"
                        onClick={() => handleTabSwitch(activeTab)}
                        style={{ marginLeft: "10px", color: "var(--pen, #e8664a)", cursor: "pointer" }}
                      >
                        重试
                      </button>
                    </div>
                  ) : currentTabResult ? (
                    <div className="markdown-body" style={{ fontSize: "var(--card-fs, 13px)", lineHeight: 1.7 }}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                      >
                        {normalizeLatex(currentTabResult.result_content)}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div style={{ color: "var(--mut, #85827b)", textAlign: "center", padding: "30px 0" }}>
                      暂无结果，请点击重新分析
                    </div>
                  )}
                </div>
              )}

              {/* 多轮追问历史呈现 */}
              {detail && detail.turns.length > 0 && (
                <div style={{ marginTop: "24px", borderTop: "1px solid var(--ln, #e2e8f0)", paddingTop: "16px" }}>
                  <h4 style={{ fontSize: "13px", fontWeight: 600, color: "var(--mut, #85827b)", marginBottom: "12px" }}>
                    历史追问 ({detail.turns.length} 轮)
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                    {detail.turns.map((turn) => {
                      const isMatchingStreaming =
                        Boolean(currentStreamingTurn && currentStreamingTurn.turn_id === turn.turn_id);
                      const isTurnActive =
                        Boolean(
                          isMatchingStreaming &&
                            (currentStreamingTurn?.status === "generating" ||
                              currentStreamingTurn?.status === "queued")
                        );

                      const displayPrompt =
                        isTurnActive && currentStreamingTurn?.user_prompt
                          ? currentStreamingTurn.user_prompt
                          : turn.user_prompt;
                      const displayResponse =
                        isTurnActive && currentStreamingTurn?.ai_response !== undefined
                          ? currentStreamingTurn.ai_response
                          : turn.ai_response;

                      return (
                        <div
                          key={turn.turn_id}
                          style={{
                            padding: "10px 14px",
                            borderRadius: "10px",
                            background: "var(--bg, #f8fafc)",
                            border: isTurnActive
                              ? "1px solid var(--pen, #e8664a)"
                              : "1px solid var(--ln, #e2e8f0)",
                          }}
                        >
                          <div
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              color: "var(--pen, #e8664a)",
                              marginBottom: "4px",
                            }}
                          >
                            问：{displayPrompt}
                          </div>
                          <div className="markdown-body" style={{ fontSize: "12.5px", lineHeight: 1.6 }}>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm, remarkMath]}
                              rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                            >
                              {normalizeLatex(displayResponse)}
                            </ReactMarkdown>
                            {isTurnActive && isFollowUpGenerating && <span className="typing-cursor">▌</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 正在生成的单轮追问（终态历史加载后，按 turnId 合并或清理，同一轮只显示一次） */}
              {currentStreamingTurn &&
                !detail?.turns.some((t) => t.turn_id === currentStreamingTurn.turn_id) && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: "10px",
                    background: "var(--bg, #f8fafc)",
                    border: "1px solid var(--pen, #e8664a)",
                  }}
                >
                  <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--pen, #e8664a)", marginBottom: "4px" }}>
                    问：{currentStreamingTurn.user_prompt}
                  </div>
                  <div className="markdown-body" style={{ fontSize: "12.5px", lineHeight: 1.6 }}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
                    >
                      {normalizeLatex(currentStreamingTurn.ai_response)}
                    </ReactMarkdown>
                    {isFollowUpGenerating && <span className="typing-cursor">▌</span>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部圆润追问输入栏 */}
        <footer
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--ln, #e2e8f0)",
            background: "var(--bg, #f8fafc)",
            flexShrink: 0,
          }}
        >
          <form
            onSubmit={handleSendFollowUp}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 8px 6px 14px",
              border: "1px solid var(--ln, #e2e8f0)",
              borderRadius: "14px",
              backgroundColor: "var(--cd, #ffffff)",
            }}
          >
            <input
              type="text"
              value={followUpPrompt}
              onChange={(e) => setFollowUpPrompt(e.target.value)}
              placeholder={
                isInitialGenerating
                  ? "初答生成中，完成后即可追问..."
                  : isFollowUpGenerating
                  ? "追问生成中..."
                  : "在此输入追问，保留上下文继续探讨..."
              }
              disabled={isInitialGenerating || isFollowUpGenerating}
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                fontSize: "12.5px",
                color: "var(--fg, #0f172a)",
                background: "transparent",
              }}
            />
            {/* Quick / Deep 分段按钮 */}
            <div
              style={{
                display: "inline-flex",
                background: "var(--ln, #e2e8f0)",
                borderRadius: "7px",
                padding: "2px",
                fontSize: "11px",
              }}
            >
              <button
                type="button"
                onClick={() => setFollowUpDepth("quick")}
                style={{
                  border: "none",
                  padding: "2px 8px",
                  borderRadius: "5px",
                  cursor: "pointer",
                  background: followUpDepth === "quick" ? "var(--cd, #ffffff)" : "transparent",
                  color: followUpDepth === "quick" ? "var(--fg, #0f172a)" : "var(--mut, #85827b)",
                  fontWeight: followUpDepth === "quick" ? 600 : 400,
                }}
              >
                Quick
              </button>
              <button
                type="button"
                onClick={() => setFollowUpDepth("deep")}
                style={{
                  border: "none",
                  padding: "2px 8px",
                  borderRadius: "5px",
                  cursor: "pointer",
                  background: followUpDepth === "deep" ? "var(--cd, #ffffff)" : "transparent",
                  color: followUpDepth === "deep" ? "var(--fg, #0f172a)" : "var(--mut, #85827b)",
                  fontWeight: followUpDepth === "deep" ? 600 : 400,
                }}
              >
                Deep
              </button>
            </div>
            <button
              type="submit"
              disabled={isInitialGenerating || isFollowUpGenerating || !followUpPrompt.trim()}
              style={{
                width: "26px",
                height: "26px",
                borderRadius: "50%",
                border: "none",
                background: "var(--pen, #e8664a)",
                color: "#ffffff",
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                fontSize: "12px",
                opacity: isInitialGenerating || isFollowUpGenerating || !followUpPrompt.trim() ? 0.5 : 1,
              }}
              title="发送追问"
            >
              ↑
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}
