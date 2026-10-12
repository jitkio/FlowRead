/**
 * FlowRead - 提示词工程配置管理器 (Prompt Config Manager)
 * 管理全局前置规则与五个核心动作的独立提示词，采用 localStorage 持久化
 */

export interface PromptConfig {
  /** 全局前置提示词（用于设定输出规范、LaTeX 格式等，将前置注入所有指令） */
  globalPrompt: string;
  /** 翻译动作专属提示词 */
  translate: string;
  /** 解释动作专属提示词 */
  explain: string;
  /** 提取公式动作专属提示词 */
  extractFormula: string;
  /** 解析图表动作专属提示词 */
  analyzeChart: string;
  /** 浓缩提炼动作专属提示词 */
  summarize: string;
}

const STORAGE_KEY = "flowread_prompt_config_v1";

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  globalPrompt:
    "涉及逻辑因果推导、形式化命题与数学公式时，必须严格使用标准 LaTeX 语法包裹：行内公式必须用 $...$，独立行重点公式与逻辑链必须用 $$...$$ 单独成行。严禁使用 [ ] 或 \\( \\)。学术排版严谨，格式规范。",
  translate:
    "你是一位专业的学术翻译专家。请将该段落翻译为流畅的中文，保持学术严谨性与学科专业术语的准确性。",
  explain:
    "你是一位顶尖的技术与科学专家。请用专业且清晰的逻辑深度解释该段落或概念的核心机理、前置假设与应用场景。",
  extractFormula:
    "你是一个极其严谨的 LaTeX 语法检查器。规则：1. 所有的多行公式、矩阵（\\begin{vmatrix}...\\end{vmatrix}）、方程组必须独立成行，且必须在最外层严格使用 $$ 包裹。2. 绝对禁止在 $$ 内部夹杂中文文本或解析说明！数学环境必须纯净。3. 确保所有的开始和结束标签绝对匹配。请精准识别并提取其中的所有数学、物理公式与推导逻辑。",
  analyzeChart:
    "你是一位顶级的多模态视觉分析专家与工程学者。请对用户框选的工程图表、电路拓扑、系统架构图或科学插图进行深度剖析。详细解析各组件关系、流向逻辑、数值趋势及核心物理/工程机理。排版严谨，优先使用学术 Markdown 排版。",
  summarize:
    "你是一个精准的信息萃取器。请一针见血地提炼该内容的绝对核心论点、技术要义与关键结论，字数精炼节制，层次清晰。",
};

/**
 * 读取当前持久化的 Prompt 配置
 */
export function loadPromptConfig(): PromptConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROMPT_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      globalPrompt:
        parsed.globalPrompt !== undefined
          ? parsed.globalPrompt
          : DEFAULT_PROMPT_CONFIG.globalPrompt,
      translate: parsed.translate || DEFAULT_PROMPT_CONFIG.translate,
      explain: parsed.explain || DEFAULT_PROMPT_CONFIG.explain,
      extractFormula: parsed.extractFormula || DEFAULT_PROMPT_CONFIG.extractFormula,
      analyzeChart: parsed.analyzeChart || DEFAULT_PROMPT_CONFIG.analyzeChart,
      summarize: parsed.summarize || DEFAULT_PROMPT_CONFIG.summarize,
    };
  } catch (err) {
    console.warn("[promptConfig] 读取配置失败，采用默认值:", err);
    return DEFAULT_PROMPT_CONFIG;
  }
}

/**
 * 持久化保存 Prompt 配置
 */
export function savePromptConfig(config: PromptConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.error("[promptConfig] 保存配置失败:", err);
  }
}

/**
 * 恢复为官方默认 Prompt 配置
 */
export function resetPromptConfig(): PromptConfig {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return DEFAULT_PROMPT_CONFIG;
}
