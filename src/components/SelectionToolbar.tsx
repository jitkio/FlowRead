import React, { useState, useRef, useEffect } from "react";
import { CardAction, CardDepth } from "../types/records";

export interface SelectionToolbarProps {
  position: { top: number; left: number } | null;
  selectionType: "text" | "image";
  selectedText?: string;
  onAction: (action: CardAction, customPrompt?: string, depth?: CardDepth) => void;
  onHighlight?: (color: string) => void;
  onCopy?: () => void;
  onClose: () => void;
}

const HIGHLIGHT_PRESETS = [
  { color: "rgba(230,200,70,.4)", bg: "#e6c846", title: "日光黄" },
  { color: "rgba(92,184,112,.4)", bg: "#5cb870", title: "薄荷绿" },
  { color: "rgba(107,140,255,.4)", bg: "#6b8cff", title: "晴空蓝" },
  { color: "rgba(230,100,170,.4)", bg: "#e664aa", title: "樱花粉" },
];

export default function SelectionToolbar({
  position,
  selectionType,
  selectedText = "",
  onAction,
  onHighlight,
  onCopy,
  onClose,
}: SelectionToolbarProps): React.JSX.Element | null {
  const [mode, setMode] = useState<"menu" | "ask" | "more">("menu");
  const [askInput, setAskInput] = useState<string>("");
  const [askDepth, setAskDepth] = useState<CardDepth>("quick");
  const isComposingRef = useRef<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // 当 position 变化或重新挂载时重置状态
  useEffect(() => {
    setMode("menu");
    setAskInput("");
  }, [position]);

  // 当进入 ask 模式时自动聚焦输入框
  useEffect(() => {
    if (mode === "ask") {
      inputRef.current?.focus();
    }
  }, [mode]);

  if (!position) return null;

  // 边界避让计算
  const toolbarWidth = mode === "ask" ? 420 : 360;
  const halfW = toolbarWidth / 2;
  const clampedLeft = Math.max(halfW + 16, Math.min(window.innerWidth - halfW - 16, position.left));
  const showBelow = position.top < 60;
  const clampedTop = showBelow ? position.top + 14 : position.top - 14;

  const handleSendAsk = () => {
    const q = askInput.trim();
    if (!q) return;
    onAction("Ask", q, askDepth);
    setAskInput("");
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setMode("menu");
      return;
    }

    if (e.key === "Enter" && !isComposingRef.current) {
      e.preventDefault();
      handleSendAsk();
    }
  };

  return (
    <div
      ref={toolbarRef}
      className={`floating-selection-toolbar ${showBelow ? "is-below" : ""}`}
      style={{
        position: "fixed",
        left: `${clampedLeft}px`,
        top: `${clampedTop}px`,
        transform: showBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        zIndex: 1200,
        backgroundColor: "var(--cd, #ffffff)",
        border: "1px solid var(--ln, #e2e8f0)",
        borderRadius: "10px",
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.16)",
        padding: "4px 6px",
        fontSize: "12px",
        display: "flex",
        alignItems: "center",
        gap: "4px",
        userSelect: "none",
        animation: "fadeInEditorial 0.15s ease-out",
      }}
      onMouseDown={(e) => {
        // 阻止失焦，但允许 input 获取焦点
        if ((e.target as HTMLElement).tagName !== "INPUT") {
          e.preventDefault();
        }
      }}
    >
      {mode === "menu" && (
        <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
          <button
            type="button"
            className="selection-tb-btn"
            onClick={() => setMode("ask")}
            style={{ fontWeight: 600, color: "var(--pen, #e8664a)" }}
          >
            Ask
          </button>
          <button
            type="button"
            className="selection-tb-btn"
            onClick={() => {
              onAction("explain", undefined, "quick");
              onClose();
            }}
          >
            ✧ 解释
          </button>
          <button
            type="button"
            className="selection-tb-btn"
            onClick={() => {
              onAction("translate", undefined, "quick");
              onClose();
            }}
          >
            翻译
          </button>
          <button
            type="button"
            className="selection-tb-btn"
            onClick={() => {
              onAction("simplify", undefined, "quick");
              onClose();
            }}
          >
            简化
          </button>
          <button
            type="button"
            className="selection-tb-btn"
            onClick={() => setMode("more")}
          >
            ••• 更多
          </button>
          <button
            type="button"
            className="selection-tb-btn"
            title="复制选区文字"
            onClick={() => {
              if (onCopy) onCopy();
              else if (selectedText) navigator.clipboard.writeText(selectedText);
              onClose();
            }}
          >
            ⧉
          </button>
        </div>
      )}

      {mode === "ask" && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}>
          <button
            type="button"
            onClick={() => setMode("menu")}
            style={{
              background: "none",
              border: "none",
              color: "var(--mut, #85827b)",
              cursor: "pointer",
              padding: "0 4px",
              fontSize: "12px",
            }}
            title="返回主工具栏 (Esc)"
          >
            ‹
          </button>
          <input
            ref={inputRef}
            type="text"
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              selectionType === "image"
                ? "针对框选图表提问..."
                : "Ask about the selection / 针对选区提问..."
            }
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: "12px",
              padding: "4px 6px",
              color: "var(--fg, #0f172a)",
              background: "transparent",
              minWidth: "160px",
            }}
          />

          {/* Web 联网状态 (未配置工具时禁用并给出清楚说明) */}
          <span
            title="当前未配置联网搜索工具"
            style={{
              fontSize: "11px",
              color: "var(--mut, #85827b)",
              opacity: 0.6,
              cursor: "not-allowed",
              padding: "2px 4px",
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
            }}
          >
            ◍ Web
          </span>

          {/* Quick / Deep 分段切换 */}
          <div
            style={{
              display: "inline-flex",
              background: "var(--ln, #e2e8f0)",
              borderRadius: "6px",
              padding: "2px",
              fontSize: "11px",
            }}
          >
            <button
              type="button"
              onClick={() => setAskDepth("quick")}
              style={{
                border: "none",
                padding: "2px 6px",
                borderRadius: "4px",
                cursor: "pointer",
                background: askDepth === "quick" ? "var(--cd, #ffffff)" : "transparent",
                color: askDepth === "quick" ? "var(--fg, #0f172a)" : "var(--mut, #85827b)",
                fontWeight: askDepth === "quick" ? 600 : 400,
              }}
            >
              Quick
            </button>
            <button
              type="button"
              onClick={() => setAskDepth("deep")}
              style={{
                border: "none",
                padding: "2px 6px",
                borderRadius: "4px",
                cursor: "pointer",
                background: askDepth === "deep" ? "var(--cd, #ffffff)" : "transparent",
                color: askDepth === "deep" ? "var(--fg, #0f172a)" : "var(--mut, #85827b)",
                fontWeight: askDepth === "deep" ? 600 : 400,
              }}
            >
              Deep
            </button>
          </div>

          {/* 圆形发送箭头 */}
          <button
            type="button"
            onClick={handleSendAsk}
            disabled={!askInput.trim()}
            style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              border: "none",
              background: "var(--pen, #e8664a)",
              color: "#ffffff",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              fontSize: "12px",
              opacity: !askInput.trim() ? 0.5 : 1,
            }}
            title="发送提问 (Enter)"
          >
            ↑
          </button>
        </div>
      )}

      {mode === "more" && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            type="button"
            onClick={() => setMode("menu")}
            style={{
              background: "none",
              border: "none",
              color: "var(--mut, #85827b)",
              cursor: "pointer",
              padding: "0 4px",
              fontSize: "12px",
            }}
          >
            ‹
          </button>

          {selectionType === "text" ? (
            <>
              <button
                type="button"
                className="selection-tb-btn"
                onClick={() => {
                  onAction("extract-formula", undefined, "quick");
                  onClose();
                }}
              >
                提取公式
              </button>
              <button
                type="button"
                className="selection-tb-btn"
                onClick={() => {
                  onAction("summarize", undefined, "quick");
                  onClose();
                }}
              >
                提炼要点
              </button>
              {/* 高亮选色点 */}
              <div style={{ display: "flex", gap: "4px", padding: "0 4px" }}>
                {HIGHLIGHT_PRESETS.map((h) => (
                  <span
                    key={h.color}
                    className="selection-tb-color-dot"
                    onClick={() => {
                      onHighlight?.(h.color);
                      onClose();
                    }}
                    title={h.title}
                    style={{
                      width: "16px",
                      height: "16px",
                      borderRadius: "3px",
                      background: h.bg,
                      cursor: "pointer",
                      display: "inline-block",
                      border: "1px solid rgba(0,0,0,0.1)",
                    }}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="selection-tb-btn"
                onClick={() => {
                  onAction("extract-text", undefined, "quick");
                  onClose();
                }}
              >
                提取文字
              </button>
              <button
                type="button"
                className="selection-tb-btn"
                onClick={() => {
                  onAction("analyze-chart", undefined, "quick");
                  onClose();
                }}
              >
                解析图表
              </button>
              <button
                type="button"
                className="selection-tb-btn"
                onClick={() => {
                  onAction("extract-formula", undefined, "quick");
                  onClose();
                }}
              >
                提取公式
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
