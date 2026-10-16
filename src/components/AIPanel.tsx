import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ModelProfile, getActiveModelProfile } from "../utils/aiConfig";
import { PromptConfig, loadPromptConfig } from "../utils/promptConfig";

export type TextSelectionAction = "translate" | "explain" | "extract-formula" | "analyze" | "summarize" | "custom";
export type ImageSelectionAction = "analyze-chart" | "extract-formula" | "analyze-image" | "custom";
export type SelectionAction = TextSelectionAction | ImageSelectionAction | string;

export type SelectionData =
  | { type: "text"; text: string; action: string; customPrompt?: string }
  | { type: "image"; imageBase64: string; action: string; customPrompt?: string };

export interface AIPanelProps {
  /** 当前选中的高亮文本或框选图像与指令动作数据 */
  selectionData: SelectionData | null;
  /** 清空当前选中内容的回调 */
  onClearSelection: () => void;
  /** 外部传入的实时 AI 引擎配置（可选） */
  aiConfig?: ModelProfile;
  /** 外部传入的提示词工程配置（可选） */
  promptConfig?: PromptConfig;
}

export interface AIResponseRendererProps {
  /** 当前流式累加的响应文本 */
  content: string;
  /** 是否正在请求或生成中 */
  isGenerating: boolean;
  /** 错误信息 */
  errorMessage?: string | null;
}

/**
 * 强化 LaTeX 规范指令（追加到每个 Action 的 System Prompt 末尾）
 */
const LATEX_PROMPT_INSTRUCTION =
  "涉及逻辑因果推导、形式化命题与数学公式时，必须严格使用标准 LaTeX 语法包裹：行内公式必须用 $...$，独立行重点公式与逻辑链必须用 $$...$$ 单独成行。严禁使用 [ ] 或 \\( \\)。";

/**
 * 指令系统提示词字典映射
 */
const SYSTEM_PROMPTS: Record<string, string> = {
  translate:
    `你是一位专业的学术翻译专家。请将该段落翻译为流畅的中文，保持学术严谨性。${LATEX_PROMPT_INSTRUCTION}`,
  explain:
    `你是一位顶尖的技术与科学专家。请用专业且清晰的逻辑解释该段落或概念的核心机理。${LATEX_PROMPT_INSTRUCTION}`,
  "extract-formula":
    `你是一个极其严谨的 LaTeX 语法检查器。规则：1. 所有的多行公式、矩阵（\\begin{vmatrix}...\\end{vmatrix}）、方程组必须独立成行，且必须在最外层严格使用 $$ 包裹。2. 绝对禁止在 $$ 内部夹杂中文文本或解析说明！数学环境必须纯净。3. 确保所有的开始和结束标签绝对匹配。请精准识别并提取框选图像中的所有数学、物理公式与推导逻辑。行内符号使用 $...$，多行公式与矩阵使用 $$...$$ 单独成行。解析与说明必须置于 $$ 公式块外部呈现。${LATEX_PROMPT_INSTRUCTION}`,
  "analyze-chart":
    `你是一位顶级的多模态视觉分析专家与工程学者。请对用户框选的工程图表、电路拓扑、系统架构图或科学插图进行深度剖析。详细解析各组件关系、流向逻辑、数值趋势及核心物理/工程机理。排版严谨，优先使用学术 Markdown 排版。${LATEX_PROMPT_INSTRUCTION}`,
  "analyze-image":
    `你是一位专业的多模态图像解析专家。请对框选的图像内容进行详细剖析与解读。${LATEX_PROMPT_INSTRUCTION}`,
  analyze:
    `你是一位顶级的学术与技术剖析专家。请深度剖析该段落的思想内核、核心机理与形式化逻辑。${LATEX_PROMPT_INSTRUCTION}`,
  summarize:
    `你是一个精准的信息萃取器。请一针见血地提取这段文字的绝对核心结论，字数越少越好。${LATEX_PROMPT_INSTRUCTION}`,
};

/**
 * 指令动作元数据（无 Emoji 纯技术标签）
 */
const ACTION_METAS: Record<string, { label: string }> = {
  translate: { label: "翻译" },
  explain: { label: "解释" },
  "extract-formula": { label: "提取公式" },
  "analyze-chart": { label: "解析图表" },
  "analyze-image": { label: "视觉解析" },
  analyze: { label: "剖析" },
  summarize: { label: "提炼" },
};

/**
 * LaTeX 文本预处理与定界符规范化
 * 1. 将模型偶发的 \[ \], \( \), 以及单方括号 [ \text{...} ] 清洗为 remark-math 支持的标准 $$ 和 $
 * 2. 检测未被 $$ 包裹的裸矩阵及多行数学环境（\begin{vmatrix}、\begin{bmatrix} 等），强制在前后包裹 \n$$\n
 * 3. 规范化公式内部的误入中文全角标点，避免 KaTeX 解析崩溃
 */
export function normalizeLatex(text: string): string {
  if (!text) return "";

  // 1. 将行间公式定界符 \[ ... \] 替换为标准双美元符 $$ ... $$
  let cleaned = text.replace(/\\\[([\s\S]*?)\\\]/g, "\n\n$$$$$1$$$$\n\n");

  // 2. 将行内公式定界符 \( ... \) 替换为标准单美元符 $ ... $
  cleaned = cleaned.replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");

  // 3. 兼容处理大模型有时吐出的单方括号推导块（如 [ \text{...} ] 或 [ \frac... ]），清洗为 $$...$$
  cleaned = cleaned
    .replace(/\[\s*(\\text\{[\s\S]*?\})\s*\](?!\()/g, "\n\n$$$$$1$$$$\n\n")
    .replace(/\[\s*(\\[a-zA-Z]+[\s\S]*?)\s*\](?!\()/g, "\n\n$$$$$1$$$$\n\n");

  // 4. 增强兜底：检测未被 $$ 包裹的裸矩阵与复杂环境（或被错误包在单 $ 中的跨行矩阵），强制在它们前后补全 \n$$\n
  // 支持各类常见矩阵环境 (matrix, pmatrix, bmatrix, Bmatrix, vmatrix, Vmatrix) 以及 cases, aligned, array
  const BARE_ENV_REGEX =
    /(?:\$)?\s*(\\begin\{((?:p|b|B|v|V)?matrix|cases|aligned|array)\}([\s\S]*?)\\end\{\2\})\s*(?:\$)?/g;

  // 将文本按已有的 $$ 切割：偶数索引位于公式环境外部，奇数索引位于公式环境内部
  const parts = cleaned.split("$$");
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // 在 $$ 外部区域：将裸环境或错误单美元环境统一规范为 \n\n$$\n环境\n$$\n\n
      parts[i] = parts[i].replace(BARE_ENV_REGEX, (_match, envBlock) => {
        return `\n\n$$\n${envBlock.trim()}\n$$\n\n`;
      });
    } else {
      // 在 $$ 内部区域：修复全角标点，避免 KaTeX 误触发 parse error
      parts[i] = parts[i]
        .replace(/（/g, "(")
        .replace(/）/g, ")")
        .replace(/【/g, "[")
        .replace(/】/g, "]")
        .replace(/，/g, ", ")
        .replace(/；/g, "; ");
    }
  }
  cleaned = parts.join("$$");

  return cleaned;
}

/**
 * AIResponseRenderer - Generative UI 核心富文本与学术公式渲染层
 * 基于 ReactMarkdown + remarkGfm + remarkMath + rehypeKatex
 */
export function AIResponseRenderer({
  content,
  isGenerating,
  errorMessage,
}: AIResponseRendererProps): React.JSX.Element {
  // 错误提示
  if (errorMessage) {
    return (
      <div className="generative-ui-slot">
        <div className="generative-error">
          <p className="error-title">伴读请求遇到问题</p>
          <p className="error-detail">{errorMessage}</p>
        </div>
      </div>
    );
  }

  // 极简“正在深思”状态
  if (isGenerating && !content) {
    return (
      <div className="generative-ui-slot">
        <div className="generative-thinking">
          <span className="thinking-text">正在深思</span>
          <span className="thinking-dots">...</span>
        </div>
      </div>
    );
  }

  // 预清洗 LaTeX 定界符
  const cleanText = normalizeLatex(content);

  // Generative UI：ReactMarkdown 富文本与 KaTeX 公式容错渲染
  return (
    <div className="generative-ui-slot">
      <div className="markdown-stream-wrapper">
        <div className="markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
          >
            {cleanText}
          </ReactMarkdown>
        </div>
        {isGenerating && <span className="typing-cursor">▌</span>}
      </div>
    </div>
  );
}

export default function AIPanel({
  selectionData,
  onClearSelection: _onClearSelection,
  aiConfig: propAiConfig,
  promptConfig: propPromptConfig,
}: AIPanelProps): React.JSX.Element {
  // 流式输出累加内容
  const [aiResponse, setAiResponse] = useState<string>("");
  // 请求与生成中状态
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  // 错误信息
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 始终同步最新配置引用，确保下一次主动发起的请求使用最新配置，且配置更新不会触发旧请求重发
  const promptConfigRef = useRef(propPromptConfig);
  promptConfigRef.current = propPromptConfig;

  const aiConfigRef = useRef(propAiConfig);
  aiConfigRef.current = propAiConfig;

  // 请求序列号与中止控制器 Ref，用于精准解决快速切换选区或清空时的竞态问题
  const requestIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * 核心流式请求函数 (fetchSSE)
   * 实时读取 AIConfig 与 PromptConfig，支持自定义 Prompt 注入与多模态切片请求
   */
  const fetchSSE = useCallback(async (data: SelectionData): Promise<void> => {
    const currentRequestId = ++requestIdRef.current;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsGenerating(true);
    setAiResponse("");
    setErrorMessage(null);

    // 统一以持久化活跃配置为准读取生效模型，确保与界面生效模型及持久化活跃 ID 绝对一致
    const activeProfile = getActiveModelProfile();
    const pConfig = promptConfigRef.current || loadPromptConfig();
    const apiKey = activeProfile.apiKey.trim();
    const baseUrl = activeProfile.baseUrl.trim() || "https://api.deepseek.com/chat/completions";
    const modelName = activeProfile.modelName.trim() || "deepseek-chat";

    // 拦截器：如果检测到 apiKey 为空，立即中断请求并给用户提示
    if (!apiKey) {
      if (requestIdRef.current === currentRequestId) {
        setIsGenerating(false);
        setAiResponse("请先前往 [工具 -> 模型配置] 完善您的 API 密钥");
      }
      return;
    }

    // 动作级专属提示词匹配
    let actionSystemPrompt = "";
    if (data.action === "translate") {
      actionSystemPrompt = pConfig.translate;
    } else if (data.action === "explain") {
      actionSystemPrompt = pConfig.explain;
    } else if (data.action === "extract-formula") {
      actionSystemPrompt = pConfig.extractFormula;
    } else if (data.action === "analyze-chart") {
      actionSystemPrompt = pConfig.analyzeChart;
    } else if (data.action === "summarize") {
      actionSystemPrompt = pConfig.summarize;
    } else {
      actionSystemPrompt = SYSTEM_PROMPTS[data.action] || pConfig.explain;
    }

    // 构建系统提示词：全局前置提示词 (Global Prompt) + 动作约束
    const baseSystemPrompt = data.customPrompt
      ? `你是一位专业严谨的高级学术与工程助手。用户输入了定制指令，请严格按该指令进行深度解答。`
      : actionSystemPrompt;

    const systemPrompt = pConfig.globalPrompt.trim()
      ? `${pConfig.globalPrompt.trim()}\n\n${baseSystemPrompt}`
      : baseSystemPrompt;

    // 根据模式构建 OpenAI 兼容的消息体：文本直接传纯文本，图片以 Vision 格式传递
    const userMessageContent =
      data.type === "image"
        ? [
            {
              type: "text",
              text: data.customPrompt
                ? `请根据以下指令剖析框选的图像切片内容：\n【定制指令】：${data.customPrompt}`
                : data.action === "extract-formula"
                ? "你是一个极其严谨的 LaTeX 语法检查器。规则：1. 所有的多行公式、矩阵（\\begin{vmatrix}...\\end{vmatrix}）、方程组必须独立成行，且必须在最外层严格使用 $$ 包裹。2. 绝对禁止在 $$ 内部夹杂中文文本或解析说明！数学环境必须纯净。3. 确保所有的开始和结束标签绝对匹配。请精准提取并识别此图像中的所有数学、物理公式与推导逻辑。"
                : "请对框选的图像（工程图表、电路拓扑、系统架构图或数据曲线）进行深度剖析。详细解析各组件关系、流向逻辑、数值趋势及核心物理/工程机理。排版严谨，优先使用学术 Markdown 排版。",
            },
            {
              type: "image_url",
              image_url: {
                url: data.imageBase64,
              },
            },
          ]
        : data.customPrompt
        ? `【指令】：${data.customPrompt}\n\n【选中文本】：\n「${data.text}」`
        : data.action === "translate"
        ? `请将该段落翻译为流畅的中文，保持学术严谨性：\n\n「${data.text}」`
        : data.action === "explain"
        ? `请用专业且清晰的逻辑解释该段落或概念的核心机理：\n\n「${data.text}」`
        : data.action === "extract-formula"
        ? `请识别并提取以下文本中的所有数学与物理公式，严格转录为标准 LaTeX 语法（行内 $...$，独行 $$...$$）：\n\n「${data.text}」`
        : data.action === "summarize"
        ? `请对以下选中文本进行浓缩提炼，总结其核心要义：\n\n「${data.text}」`
        : `请对以下选中文本执行指令：\n\n「${data.text}」`;

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          stream: true,
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userMessageContent,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 响应异常 [${response.status}]: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("无法读取响应数据流 (response.body 为空)");
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let streamDone = false;

      while (true) {
        if (controller.signal.aborted || requestIdRef.current !== currentRequestId) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const dataPayload = trimmed.replace(/^data:\s*/, "");
          if (dataPayload === "[DONE]") {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(dataPayload);
            const deltaContent = parsed.choices?.[0]?.delta?.content;
            if (deltaContent && requestIdRef.current === currentRequestId) {
              setAiResponse((prev) => prev + deltaContent);
            }
          } catch {
            // 忽略未接收完全的片段，继续缓冲读取
          }
        }

        if (streamDone) {
          try {
            await reader.cancel();
          } catch {
            // 忽略取消异常
          }
          break;
        }
      }
    } catch (err: unknown) {
      // 若当前请求已被后续请求废弃，则绝不修改组件状态
      if (requestIdRef.current !== currentRequestId) {
        return;
      }
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          console.log("[FlowRead AI] 上一次请求已被主动取消");
          return;
        }
        setErrorMessage(err.message);
      } else {
        setErrorMessage(String(err));
      }
    } finally {
      // 仅当当前请求仍是最新发起的请求时，才重置生成中状态
      if (requestIdRef.current === currentRequestId) {
        setIsGenerating(false);
      }
    }
  }, []);

  /**
   * 监听 selectionData 变动：自动触发对应指令的流式伴读
   */
  useEffect(() => {
    const hasValidSelection =
      selectionData &&
      ((selectionData.type === "text" && selectionData.text.trim().length > 0) ||
        (selectionData.type === "image" && selectionData.imageBase64.length > 0));

    if (hasValidSelection && selectionData) {
      fetchSSE(selectionData);
    } else {
      requestIdRef.current++;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setAiResponse("");
      setIsGenerating(false);
      setErrorMessage(null);
    }

    return () => {
      requestIdRef.current++;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [selectionData, fetchSSE]);

  // 极简空状态：大面积绝对留白，正中央显示极淡提示
  if (!selectionData) {
    return (
      <aside className="ai-panel">
        <div className="panel-empty-state">
          <span className="empty-hint">划选文本或 Alt+拖拽框选以分析</span>
        </div>
      </aside>
    );
  }

  const actionMeta = ACTION_METAS[selectionData.action] || ACTION_METAS.analyze;

  // 捕获状态：顶格排版（文本显示优雅衬线引文，图片显示高精缩略图） + Generative UI 富文本公式流式渲染
  return (
    <aside className="ai-panel">
      <div className="panel-content-flow">
        {/* 指令类型微徽标 (VS Code 纯文本标签风格) */}
        <div className="action-indicator">
          <span className="action-indicator-badge">
            {selectionData.customPrompt ? "自定义指令" : actionMeta.label}
          </span>
          {selectionData.customPrompt && (
            <span className="action-indicator-custom-text" title={selectionData.customPrompt}>
              "{selectionData.customPrompt}"
            </span>
          )}
        </div>

        {/* 顶格排版：VS Code 代码引文风格 或 框选区域缩略图 */}
        {selectionData.type === "text" ? (
          <blockquote className="editorial-quote">
            {selectionData.text}
          </blockquote>
        ) : (
          <div className="editorial-image-preview">
            <img
              src={selectionData.imageBase64}
              alt="框选区域预览"
              className="preview-thumbnail"
            />
            <div className="preview-meta">
              <span className="preview-badge">视觉切片</span>
              <span className="preview-caption">CANVAS CROP</span>
            </div>
          </div>
        )}

        {/* Generative UI：Markdown & KaTeX 流式输出 */}
        <AIResponseRenderer
          content={aiResponse}
          isGenerating={isGenerating}
          errorMessage={errorMessage}
        />
      </div>
    </aside>
  );
}
