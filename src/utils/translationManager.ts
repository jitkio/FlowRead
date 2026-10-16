/**
 * FlowRead - 全局翻译配置与请求管理器
 * 统一管理目标语言判定 (auto/zh/en)、提示词构建与多入口翻译规范
 */

import { loadGlobalPreferences } from "./themeManager";
import { loadPromptConfig, PromptConfig } from "./promptConfig";

export type ConfiguredTranslateLang = "auto" | "zh" | "en";
export type ConcreteTranslateLang = "zh" | "en";

export interface ResolvedTranslationTarget {
  /** 最终解析出的具体目标语言代码 */
  targetLang: ConcreteTranslateLang;
  /** 用于界面展示的目标语言标签 */
  displayLabel: string;
  /** 原文是否判定为中文 */
  isSourceChinese: boolean;
  /** 是否由 auto 规则自动推断 */
  isAutoDetected: boolean;
  /** 是否自动推断模式 */
  isAuto?: boolean;
}

/**
 * 统一解析目标语言：
 * - zh: 强行译为简体中文
 * - en: 强行译为 English
 * - auto: 检查原文汉字数量占比。
 *   若包含明显中文内容，则译为英文 (English)；
 *   否则（英文、法文、日文等外文），译为中文 (简体中文)。
 */
export function resolveTargetLanguage(
  sourceText: string,
  configuredLang?: ConfiguredTranslateLang
): ResolvedTranslationTarget {
  const prefLang = configuredLang || loadGlobalPreferences().translateLanguage || "auto";

  if (prefLang === "zh") {
    return {
      targetLang: "zh",
      displayLabel: "简体中文",
      isSourceChinese: false,
      isAutoDetected: false,
      isAuto: false,
    };
  }

  if (prefLang === "en") {
    return {
      targetLang: "en",
      displayLabel: "English",
      isSourceChinese: true,
      isAutoDetected: false,
      isAuto: false,
    };
  }

  // auto 规则判定
  const trimmed = (sourceText || "").trim();
  const chineseMatches = trimmed.match(/[\u4e00-\u9fa5]/g) || [];
  const chineseRatio = trimmed.length > 0 ? chineseMatches.length / trimmed.length : 0;

  // 汉字数量 >= 2 且占比大于 15%，判定为中文原文，目标为英文
  const isSourceChinese = chineseMatches.length >= 2 && chineseRatio >= 0.15;

  if (isSourceChinese) {
    return {
      targetLang: "en",
      displayLabel: "English",
      isSourceChinese: true,
      isAutoDetected: true,
      isAuto: true,
    };
  } else {
    return {
      targetLang: "zh",
      displayLabel: "中文",
      isSourceChinese: false,
      isAutoDetected: true,
      isAuto: true,
    };
  }
}

/**
 * 统一构建翻译动作的 System Prompt：
 * 绝不私自覆盖用户的 promptConfig.translate，而是将用户自定义规范与目标语言明确融合
 */
export function buildTranslationSystemPrompt(
  target: ResolvedTranslationTarget | "zh" | "en" | string,
  customPromptConfig?: Partial<PromptConfig>
): string {
  const base = loadPromptConfig();
  const userTranslatePrompt = (customPromptConfig?.translate ?? base.translate).trim();
  const globalPrompt = (customPromptConfig?.globalPrompt ?? base.globalPrompt).trim();
  const targetLang = typeof target === "string" ? target : target.targetLang;
  const langName = targetLang === "zh" ? "中文 (Simplified Chinese)" : "English";

  const prefix = globalPrompt ? `${globalPrompt}\n\n` : "";
  return `${prefix}${userTranslatePrompt}\n\n【翻译目标语言规范】：请严格将输入的原文完整、精准地翻译为：${langName}。保持原文字词句段的对应关系与学术/学科术语严谨性。输出格式：直接输出最终译文，不要附加无意义的自述或客套。`;
}

/**
 * 补齐生成配置签名：
 * 至少包含来源版本或内容哈希、功能、实际目标语言、有效提示词、模型配置和深度。
 * 相同配置复用缓存；配置改变后，用户再次执行该功能应生成对应结果。
 * 严格保持旧数据库兼容，绝不记录或输出 API 密钥！
 */
export function buildFunctionConfigSignature(params: {
  sourceText: string;
  sourceRevision?: string;
  mode: string;
  targetLang?: string;
  prompt: string;
  modelName: string;
  baseUrl: string;
  depth: string;
}): string {
  const payload = JSON.stringify({
    rev: params.sourceRevision || "",
    text: params.sourceText,
    mode: params.mode,
    target: params.targetLang || "",
    prompt: params.prompt,
    model: params.modelName,
    url: params.baseUrl,
    depth: params.depth,
  });
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
  }
  return `sig_${(hash >>> 0).toString(16)}_${payload.length}`;
}
