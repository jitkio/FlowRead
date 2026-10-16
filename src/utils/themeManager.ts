/**
 * FlowRead - 主题与阅读排版样式管理器
 * 统一同步 CSS 变量至 document.documentElement
 */

import { ReadingPreferences, DEFAULT_READING_PREFERENCES } from "../types/records";

const GLOBAL_PREFS_KEY = "flowread_global_reading_preferences_v1";

export function loadGlobalPreferences(): ReadingPreferences {
  try {
    const raw = localStorage.getItem(GLOBAL_PREFS_KEY);
    if (!raw) return DEFAULT_READING_PREFERENCES;
    return { ...DEFAULT_READING_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_READING_PREFERENCES;
  }
}

export function saveGlobalPreferences(prefs: ReadingPreferences): void {
  try {
    localStorage.setItem(GLOBAL_PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.error("[themeManager] 保存全局偏好失败:", err);
  }
}

export function applyTheme(prefs: ReadingPreferences): void {
  const root = document.documentElement;

  // 1. 主题判断
  let effectiveTheme = prefs.theme;
  if (effectiveTheme === "auto") {
    effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "night"
      : "paper";
  }
  root.setAttribute("data-theme", effectiveTheme);

  // 2. 强调色与高亮色
  root.style.setProperty("--pen", prefs.penColor || "#e8664a");
  root.style.setProperty("--hlc", prefs.highlighterColor || "rgba(230,200,70,.4)");

  // 3. 正文排版 (作用于 ReaderArea 纯文本/MD/EPUB)
  root.style.setProperty("--reader-fs", `${prefs.fontSize}px`);
  root.style.setProperty("--reader-lh", `${prefs.lineHeight}`);
  root.style.setProperty("--reader-w", `${prefs.contentWidth}px`);
  root.style.setProperty("--reader-f", prefs.fontFamily);

  // 4. 卡片与大窗独立字号 (不受正文字号或 zoom 干扰)
  root.style.setProperty("--card-fs", `${prefs.cardFontSize}px`);

  // 5. 段落对齐与缩进模式
  if (prefs.textAlign === "justify") {
    document.body.classList.add("al-j");
  } else {
    document.body.classList.remove("al-j");
  }

  if (prefs.paragraphStyle === "indented") {
    document.body.classList.add("pg-i");
  } else {
    document.body.classList.remove("pg-i");
  }
}
