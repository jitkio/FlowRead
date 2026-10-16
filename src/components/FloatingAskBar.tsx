import React, { useState, useRef, useEffect } from "react";
import { CardDepth } from "../types/records";

export interface FloatingAskBarProps {
  onAsk: (prompt: string, depth: CardDepth) => void;
  hasSelection?: boolean;
  selectionExcerpt?: string;
  defaultDepth?: CardDepth;
  placeholder?: string;
  disabled?: boolean;
}

export default function FloatingAskBar({
  onAsk,
  hasSelection = false,
  selectionExcerpt,
  defaultDepth = "quick",
  placeholder,
  disabled = false,
}: FloatingAskBarProps): React.JSX.Element {
  const [prompt, setPrompt] = useState<string>("");
  const [depth, setDepth] = useState<CardDepth>(defaultDepth);
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef<boolean>(false);

  useEffect(() => {
    if (defaultDepth) {
      setDepth(defaultDepth);
    }
  }, [defaultDepth]);

  // 按键 "/" 快捷聚焦提问框（当未处于其他输入框且非禁用状态时）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (disabled) return;

      const activeEl = document.activeElement;
      const isInputActive =
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable);

      if (e.key === "/" && !isInputActive && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (disabled) return;
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onAsk(trimmed, depth);
    setPrompt("");
  };

  return (
    <div
      className="reader-floating-ask-bar"
      role="search"
      aria-label="正文提问与伴读指令"
      onClick={(e) => e.stopPropagation()}
    >
      <form className="floating-ask-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          className="floating-ask-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter" && !isComposingRef.current) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={
            placeholder ||
            (hasSelection
              ? `针对选区提问: “${selectionExcerpt?.slice(0, 16) || ""}...”`
              : "针对当前内容提问...")
          }
          title={hasSelection ? "范围：针对当前选区内容提问" : "范围：针对当前可见内容提问"}
        />

        <kbd className="floating-ask-kbd" title="按下 / 键快速提问">
          /
        </kbd>

        {/* Quick / Deep 分段深度切换 */}
        <div className="floating-ask-seg" role="group" aria-label="提问深度">
          <button
            type="button"
            className={`floating-ask-depth-btn ${depth === "quick" ? "is-active" : ""}`}
            onClick={() => setDepth("quick")}
          >
            Quick
          </button>
          <button
            type="button"
            className={`floating-ask-depth-btn ${depth === "deep" ? "is-active" : ""}`}
            onClick={() => setDepth("deep")}
          >
            Deep
          </button>
        </div>

        {/* 发送圆形箭头按钮 */}
        <button
          type="submit"
          className="floating-ask-submit-btn"
          disabled={disabled || !prompt.trim()}
          title="发送提问 (Enter)"
        >
          ↑
        </button>
      </form>
    </div>
  );
}
