import React, { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";

export interface FiveLineClampedViewProps {
  content: string;
  className?: string;
  style?: React.CSSProperties;
  onExpandClick?: () => void;
  expandLabel?: string;
  isStreaming?: boolean;
}

/**
 * FiveLineClampedView - 严格遵循五行视觉高度判定规则的展示组件
 *
 * 规则：
 * 1. 内容在当前实际渲染宽度、字号和行高下 <= 5 个视觉行：100% 完整平铺展示。
 * 2. 超过 5 行：只展示前 2 行并截断显示省略号与展开按钮。
 * 3. 严禁写死 18px 或固定字符数；采用真实 getComputedStyle(lineHeight) 与 scrollHeight。
 * 4. 流式输出阶段越过 5 行阈值后锁定收拢状态，消除反复抖动。
 */
export default function FiveLineClampedView({
  content,
  className = "",
  style = {},
  onExpandClick,
  expandLabel = "展开完整内容",
  isStreaming = false,
}: FiveLineClampedViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // 是否超过 5 行视觉高度
  const [isExceedingFiveLines, setIsExceedingFiveLines] = useState<boolean>(false);
  const [isManualExpanded, setIsManualExpanded] = useState<boolean>(false);

  // 一旦越过 5 行，在流式期间保持锁定
  const hasEverExceededRef = useRef<boolean>(false);

  const measureLines = useCallback(() => {
    const measureEl = measureRef.current;
    if (!measureEl) return;

    // 动态提取实时计算的行高 (line-height)
    const computedStyle = window.getComputedStyle(measureEl);
    let lineHeight = parseFloat(computedStyle.lineHeight);

    // 容错：如果 lineHeight 是 "normal"，按 fontSize * 1.5 兜底
    if (!lineHeight || isNaN(lineHeight)) {
      const fontSize = parseFloat(computedStyle.fontSize) || 14;
      lineHeight = fontSize * 1.5;
    }

    const scrollHeight = measureEl.scrollHeight;
    // 允许 3px 浮点微差，精确计算视觉行数
    const totalLines = Math.round((scrollHeight + 2) / lineHeight);

    if (totalLines > 5) {
      hasEverExceededRef.current = true;
      setIsExceedingFiveLines(true);
    } else {
      // 如果没有流式锁定过，恢复为未超过
      if (!hasEverExceededRef.current || !isStreaming) {
        setIsExceedingFiveLines(false);
      }
    }
  }, [isStreaming]);

  // 内容变动或排版变化时测量
  useLayoutEffect(() => {
    measureLines();
  }, [content, measureLines]);

  // 监听容器宽度变动 (ResizeObserver)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      measureLines();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureLines]);

  // 当外部 content 被重置（比如新问题或清空）重置锁定
  useEffect(() => {
    if (!content) {
      hasEverExceededRef.current = false;
      setIsExceedingFiveLines(false);
      setIsManualExpanded(false);
    }
  }, [content]);

  const handleExpandToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onExpandClick) {
      onExpandClick();
    } else {
      setIsManualExpanded((prev) => !prev);
    }
  };

  const shouldClampToTwoLines = isExceedingFiveLines && !isManualExpanded;

  return (
    <div
      ref={containerRef}
      className={`five-line-clamped-container ${className}`}
      style={{ position: "relative", ...style }}
    >
      {/* 隐藏的离屏纯净测量层：无 clamp，真实反映全文实际像素高度 */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          visibility: "hidden",
          pointerEvents: "none",
          zIndex: -1,
          lineClamp: "none",
          WebkitLineClamp: "none",
          overflow: "visible",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {content}
      </div>

      {/* 视觉呈现层 */}
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...(shouldClampToTwoLines
            ? {
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }
            : {}),
        }}
      >
        {content}
      </div>

      {/* 超过 5 行时呈现展开按钮 */}
      {isExceedingFiveLines && (
        <div style={{ marginTop: "4px" }}>
          <button
            type="button"
            className="five-line-expand-btn"
            onClick={handleExpandToggle}
            style={{
              background: "none",
              border: "none",
              padding: "0",
              fontSize: "11px",
              color: "var(--pen, #e8664a)",
              cursor: "pointer",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
            }}
          >
            {isManualExpanded ? "收起" : `${expandLabel} ›`}
          </button>
        </div>
      )}
    </div>
  );
}
