import React, { useState, useEffect } from "react";
import { ReadingPreferences, ThemeMode, CardDepth } from "../types/records";
import { applyTheme } from "../utils/themeManager";

export interface ReadingSettingsModalProps {
  isOpen: boolean;
  preferences: ReadingPreferences;
  onSave: (preferences: ReadingPreferences) => void;
  onClose: () => void;
}

type TabKey = "look" | "text" | "answers";

const THEME_OPTIONS: { key: ThemeMode; label: string; previewBg: string; previewFg: string }[] = [
  { key: "auto", label: "自动", previewBg: "linear-gradient(135deg, #f4f3ef 50%, #0d0d0c 50%)", previewFg: "#000" },
  { key: "paper", label: "纸张", previewBg: "#f4f3ef", previewFg: "#1d1c1a" },
  { key: "sepia", label: "米黄", previewBg: "#efe6d2", previewFg: "#3b3226" },
  { key: "snow", label: "纯白", previewBg: "#ffffff", previewFg: "#161616" },
  { key: "night", label: "夜间", previewBg: "#0d0d0c", previewFg: "#e8e5de" },
  { key: "ink", label: "深墨", previewBg: "#050507", previewFg: "#d9dbe6" },
];

const PEN_COLORS = [
  { color: "#e8664a", label: "珊瑚红" },
  { color: "#6b8cff", label: "明眸蓝" },
  { color: "#5cb870", label: "青翠绿" },
  { color: "#a855f7", label: "紫罗兰" },
  { color: "#85827b", label: "素灰" },
];

const HIGHLIGHT_COLORS = [
  { color: "rgba(230,200,70,.4)", hex: "#e6c846", label: "日光黄" },
  { color: "rgba(92,184,112,.4)", hex: "#5cb870", label: "薄荷绿" },
  { color: "rgba(107,140,255,.4)", hex: "#6b8cff", label: "晴空蓝" },
  { color: "rgba(230,100,170,.4)", hex: "#e664aa", label: "樱花粉" },
];

const FONT_OPTIONS = [
  {
    label: "无衬线 (Sans)",
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    label: "优雅衬线 (Serif)",
    value: "'Newsreader', 'Songti SC', 'Source Han Serif SC', Georgia, Cambria, serif",
  },
  {
    label: "等宽技术 (Mono)",
    value: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace",
  },
];

export default function ReadingSettingsModal({
  isOpen,
  preferences: initialPrefs,
  onSave,
  onClose,
}: ReadingSettingsModalProps): React.JSX.Element | null {
  const [prefs, setPrefs] = useState<ReadingPreferences>(initialPrefs);
  const [activeTab, setActiveTab] = useState<TabKey>("look");

  useEffect(() => {
    if (isOpen) {
      setPrefs(initialPrefs);
    }
  }, [isOpen, initialPrefs]);

  // 监听 Esc 快捷键关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const update = (partial: Partial<ReadingPreferences>): void => {
    const next = { ...prefs, ...partial };
    setPrefs(next);
    // 即时应用预览
    applyTheme(next);
  };

  const handleSave = (e: React.FormEvent): void => {
    e.preventDefault();
    onSave(prefs);
    onClose();
  };

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="settings-modal-card reading-settings-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">阅读外观与排版设置</h2>
            <span className="settings-modal-subtitle">自定义主题底色、排版度量、强调色与卡片呈现</span>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            title="关闭窗口 (Esc)"
          >
            ×
          </button>
        </div>

        {/* 顶部标签切换 */}
        <div className="prompt-tabs-bar" style={{ margin: "16px 24px 0", display: "flex", gap: "6px" }}>
          <button
            type="button"
            className={`prompt-tab-btn ${activeTab === "look" ? "is-active" : ""}`}
            onClick={() => setActiveTab("look")}
          >
            外观色彩 (Look)
          </button>
          <button
            type="button"
            className={`prompt-tab-btn ${activeTab === "text" ? "is-active" : ""}`}
            onClick={() => setActiveTab("text")}
          >
            正文排版 (Text)
          </button>
          <button
            type="button"
            className={`prompt-tab-btn ${activeTab === "answers" ? "is-active" : ""}`}
            onClick={() => setActiveTab("answers")}
          >
            卡片与回答 (Cards)
          </button>
        </div>

        <form onSubmit={handleSave} className="settings-modal-form" style={{ padding: "16px 24px 24px" }}>
          {activeTab === "look" && (
            <div className="settings-form-section">
              {/* 主题选择 */}
              <div className="settings-form-field">
                <label className="settings-field-label">
                  <span>阅读底色主题 (Theme)</span>
                  <span className="settings-label-hint">统一作用于全局背景、卡片、侧栏与窗口</span>
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "8px", marginTop: "6px" }}>
                  {THEME_OPTIONS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => update({ theme: t.key })}
                      style={{
                        padding: "10px 4px",
                        borderRadius: "8px",
                        border: prefs.theme === t.key ? "2px solid var(--pen, #e8664a)" : "1px solid var(--border-light, #e2e8f0)",
                        background: t.previewBg,
                        color: t.previewFg,
                        fontWeight: prefs.theme === t.key ? 600 : 400,
                        fontSize: "12px",
                        cursor: "pointer",
                        outline: "none",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <span style={{ fontSize: "14px" }}>Aa</span>
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 强调/笔触颜色 */}
              <div className="settings-form-field" style={{ marginTop: "16px" }}>
                <label className="settings-field-label">
                  <span>强调与连线色 (Pen Color)</span>
                  <span className="settings-label-hint">用于卡片左边框、关联虚线及操作高亮</span>
                </label>
                <div style={{ display: "flex", gap: "10px", marginTop: "6px" }}>
                  {PEN_COLORS.map((p) => (
                    <button
                      key={p.color}
                      type="button"
                      onClick={() => update({ penColor: p.color })}
                      title={p.label}
                      style={{
                        width: "28px",
                        height: "28px",
                        borderRadius: "50%",
                        background: p.color,
                        border: prefs.penColor === p.color ? "2px solid #fff" : "none",
                        outline: prefs.penColor === p.color ? "2px solid var(--text-main, #0f172a)" : "none",
                        cursor: "pointer",
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 默认划词高亮色 */}
              <div className="settings-form-field" style={{ marginTop: "16px" }}>
                <label className="settings-field-label">
                  <span>默认高亮色彩 (Highlighter)</span>
                  <span className="settings-label-hint">用于阅读区划词永久高亮底色</span>
                </label>
                <div style={{ display: "flex", gap: "10px", marginTop: "6px" }}>
                  {HIGHLIGHT_COLORS.map((h) => (
                    <button
                      key={h.color}
                      type="button"
                      onClick={() => update({ highlighterColor: h.color })}
                      title={h.label}
                      style={{
                        width: "36px",
                        height: "22px",
                        borderRadius: "4px",
                        background: h.hex,
                        border: prefs.highlighterColor === h.color ? "2px solid #fff" : "1px solid rgba(0,0,0,0.1)",
                        outline: prefs.highlighterColor === h.color ? "2px solid var(--text-main, #0f172a)" : "none",
                        cursor: "pointer",
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "text" && (
            <div className="settings-form-section">
              {/* 正文字号 */}
              <div className="settings-form-field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label className="settings-field-label" style={{ margin: 0 }}>
                    <span>正文字号 (Font Size)</span>
                  </label>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--pen, #e8664a)" }}>
                    {prefs.fontSize} px
                  </span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={26}
                  value={prefs.fontSize}
                  onChange={(e) => update({ fontSize: Number(e.target.value) })}
                  style={{ width: "100%", marginTop: "8px", accentColor: "var(--pen, #e8664a)" }}
                />
              </div>

              {/* 字体预设 */}
              <div className="settings-form-field" style={{ marginTop: "14px" }}>
                <label className="settings-field-label">
                  <span>字体栈 (Typeface)</span>
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  {FONT_OPTIONS.map((f) => (
                    <button
                      key={f.label}
                      type="button"
                      className={`settings-btn ${prefs.fontFamily === f.value ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ fontFamily: f.value })}
                      style={{ flex: 1, padding: "6px 8px", fontSize: "12px" }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 行高 */}
              <div className="settings-form-field" style={{ marginTop: "14px" }}>
                <label className="settings-field-label">
                  <span>行高间距 (Line Height)</span>
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  {[
                    { label: "紧凑 (1.5)", val: 1.5 },
                    { label: "适中 (1.7)", val: 1.7 },
                    { label: "疏朗 (1.95)", val: 1.95 },
                  ].map((lh) => (
                    <button
                      key={lh.val}
                      type="button"
                      className={`settings-btn ${prefs.lineHeight === lh.val ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ lineHeight: lh.val })}
                      style={{ flex: 1, padding: "6px 8px", fontSize: "12px" }}
                    >
                      {lh.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 版心宽度 */}
              <div className="settings-form-field" style={{ marginTop: "14px" }}>
                <label className="settings-field-label">
                  <span>版心宽度 (Content Width)</span>
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  {[
                    { label: "收敛 (740px)", val: 740 },
                    { label: "黄金 (987px)", val: 987 },
                    { label: "宽阔 (1160px)", val: 1160 },
                  ].map((w) => (
                    <button
                      key={w.val}
                      type="button"
                      className={`settings-btn ${prefs.contentWidth === w.val ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ contentWidth: w.val })}
                      style={{ flex: 1, padding: "6px 8px", fontSize: "12px" }}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 对齐与缩进 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "14px" }}>
                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>对齐方式</span>
                  </label>
                  <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                    <button
                      type="button"
                      className={`settings-btn ${prefs.textAlign === "left" ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ textAlign: "left" })}
                      style={{ flex: 1, padding: "5px", fontSize: "11px" }}
                    >
                      靠左
                    </button>
                    <button
                      type="button"
                      className={`settings-btn ${prefs.textAlign === "justify" ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ textAlign: "justify" })}
                      style={{ flex: 1, padding: "5px", fontSize: "11px" }}
                    >
                      两端对齐
                    </button>
                  </div>
                </div>

                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>段落样式</span>
                  </label>
                  <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                    <button
                      type="button"
                      className={`settings-btn ${prefs.paragraphStyle === "spaced" ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ paragraphStyle: "spaced" })}
                      style={{ flex: 1, padding: "5px", fontSize: "11px" }}
                    >
                      段落间距
                    </button>
                    <button
                      type="button"
                      className={`settings-btn ${prefs.paragraphStyle === "indented" ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ paragraphStyle: "indented" })}
                      style={{ flex: 1, padding: "5px", fontSize: "11px" }}
                    >
                      首行缩进
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "answers" && (
            <div className="settings-form-section">
              {/* 卡片独立字号 */}
              <div className="settings-form-field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label className="settings-field-label" style={{ margin: 0 }}>
                    <span>卡片与弹窗独立字号 (Card Font Size)</span>
                    <span className="settings-label-hint">与正文字号解耦，独立保持舒适阅读</span>
                  </label>
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--pen, #e8664a)" }}>
                    {prefs.cardFontSize} px
                  </span>
                </div>
                <input
                  type="range"
                  min={12}
                  max={16}
                  value={prefs.cardFontSize}
                  onChange={(e) => update({ cardFontSize: Number(e.target.value) })}
                  style={{ width: "100%", marginTop: "8px", accentColor: "var(--pen, #e8664a)" }}
                />
              </div>

              {/* 默认回答深度 */}
              <div className="settings-form-field" style={{ marginTop: "16px" }}>
                <label className="settings-field-label">
                  <span>默认思考深度 (Default Depth)</span>
                  <span className="settings-label-hint">Quick 为极简精要，Deep 提供详尽学术论证与步骤推演</span>
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  {(["quick", "deep"] as CardDepth[]).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`settings-btn ${prefs.defaultDepth === d ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ defaultDepth: d })}
                      style={{ flex: 1, padding: "8px", fontSize: "12px" }}
                    >
                      {d === "quick" ? "⚡ Quick 快速精要" : "✦ Deep 深度解析"}
                    </button>
                  ))}
                </div>
              </div>

              {/* 翻译目标语言 */}
              <div className="settings-form-field" style={{ marginTop: "16px" }}>
                <label className="settings-field-label">
                  <span>默认翻译目标语言 (Translate To)</span>
                </label>
                <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                  {[
                    { label: "自动检测 (Auto)", val: "auto" as const },
                    { label: "中文 (Chinese)", val: "zh" as const },
                    { label: "English", val: "en" as const },
                  ].map((l) => (
                    <button
                      key={l.val}
                      type="button"
                      className={`settings-btn ${prefs.translateLanguage === l.val ? "settings-btn-primary" : "settings-btn-secondary"}`}
                      onClick={() => update({ translateLanguage: l.val })}
                      style={{ flex: 1, padding: "8px", fontSize: "12px" }}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="settings-modal-footer" style={{ marginTop: "24px" }}>
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="settings-btn settings-btn-primary"
            >
              应用并保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
