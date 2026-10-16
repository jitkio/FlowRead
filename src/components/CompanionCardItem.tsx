import React, { useState, useRef, useEffect } from "react";
import { CardRecord, CardDepth } from "../types/records";
import FiveLineClampedView from "./FiveLineClampedView";
import { apiGetCardDetail, apiGetAssetUrl } from "../utils/recordStorage";

export interface CompanionCardItemProps {
  card: CardRecord;
  isActive: boolean;
  onSelectCard: () => void;
  onOpenFullModal: () => void;
  onJumpToSource?: () => void;
  onDelete?: () => void;
  onSendFollowUp?: (prompt: string, depth: CardDepth) => void;
  sourceLabel?: string;
  isDense?: boolean;
}

export default function CompanionCardItem({
  card,
  isActive,
  onSelectCard,
  onOpenFullModal,
  onJumpToSource,
  onDelete,
  onSendFollowUp,
  sourceLabel,
  isDense = false,
}: CompanionCardItemProps): React.JSX.Element {
  const [showFollowUpInput, setShowFollowUpInput] = useState<boolean>(false);
  const [followUpText, setFollowUpText] = useState<string>("");
  const [followUpDepth, setFollowUpDepth] = useState<CardDepth>("quick");
  const isComposingRef = useRef<boolean>(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState<boolean>(false);

  useEffect(() => {
    if (card.anchor_source_type === "pdf_image" && card.anchor_location_json) {
      try {
        const loc = JSON.parse(card.anchor_location_json);
        const imgLoc = loc.location || loc;
        if (imgLoc.assetId) {
          apiGetAssetUrl(imgLoc.assetId)
            .then(setThumbUrl)
            .catch(() => setThumbError(true));
        }
      } catch {
        setThumbError(true);
      }
    }
  }, [card.anchor_source_type, card.anchor_location_json]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const detail = await apiGetCardDetail(card.card_id);
      const fullText = detail.card.ai_response || detail.card.preview || card.preview || card.ai_response || card.anchor_excerpt || "";
      await navigator.clipboard.writeText(fullText);
    } catch {
      const text = card.preview || card.ai_response || card.anchor_excerpt || "";
      await navigator.clipboard.writeText(text);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) onDelete();
  };

  const handleJump = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onJumpToSource) onJumpToSource();
  };

  const handleFollowUpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const prompt = followUpText.trim();
    if (!prompt) return;
    if (onSendFollowUp) {
      onSendFollowUp(prompt, followUpDepth);
    }
    setFollowUpText("");
    setShowFollowUpInput(false);
  };

  return (
    <article
      className={`companion-card ${isActive ? "is-active" : ""} ${isDense ? "is-dense" : ""}`}
      onClick={() => {
        onSelectCard();
      }}
      style={{
        borderRadius: "10px",
        padding: "10px 12px",
        border: "1px solid var(--ln, #262523)",
        borderLeft: isActive ? "2px solid var(--pen, #e8664a)" : "1px solid var(--ln, #262523)",
        backgroundColor: "var(--cd, #151514)",
        boxShadow: isActive
          ? "0 4px 18px rgba(0, 0, 0, 0.35)"
          : "0 2px 6px rgba(0, 0, 0, 0.15)",
        cursor: "pointer",
        position: "relative",
        transition: "box-shadow 0.15s ease, border-color 0.15s ease, opacity 0.15s ease",
        marginBottom: "10px",
        opacity: isActive ? 1 : 0.88,
      }}
    >
      {/* 头部：动作标签、来源标识、操作按钮 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
          fontSize: "11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span
            style={{
              fontWeight: 600,
              color: "var(--pen, #e8664a)",
              textTransform: "uppercase",
              fontSize: "11px",
            }}
          >
            {card.action}
          </span>
          {sourceLabel && (
            <span style={{ color: "var(--mut, #85827b)", fontSize: "11px" }}>
              {sourceLabel}
            </span>
          )}
          {card.depth === "deep" && (
            <span style={{ fontSize: "10px", color: "var(--mut, #85827b)", opacity: 0.8 }}>
              ✦ Deep
            </span>
          )}
        </div>

        {/* 顶部操作小按钮 */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          {card.anchor_id && onJumpToSource && (
            <button
              type="button"
              className="card-icon-btn"
              onClick={handleJump}
              title="回到原文位置"
              style={{
                background: "none",
                border: "none",
                color: "var(--mut, #85827b)",
                cursor: "pointer",
                padding: "2px 4px",
                fontSize: "12px",
              }}
            >
              ⤾
            </button>
          )}
          <button
            type="button"
            className="card-icon-btn"
            onClick={onOpenFullModal}
            title="查看完整回答窗口 (大窗)"
            style={{
              background: "none",
              border: "none",
              color: "var(--mut, #85827b)",
              cursor: "pointer",
              padding: "2px 4px",
              fontSize: "12px",
            }}
          >
            ⤢
          </button>
          <button
            type="button"
            className="card-icon-btn"
            onClick={handleCopy}
            title="复制回答"
            style={{
              background: "none",
              border: "none",
              color: "var(--mut, #85827b)",
              cursor: "pointer",
              padding: "2px 4px",
              fontSize: "12px",
            }}
          >
            ⧉
          </button>
          <button
            type="button"
            className="card-icon-btn"
            onClick={handleDelete}
            title="删除卡片"
            style={{
              background: "none",
              border: "none",
              color: "var(--mut, #85827b)",
              cursor: "pointer",
              padding: "2px 4px",
              fontSize: "12px",
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 原文引用摘要 */}
      {card.anchor_excerpt && (
        <div
          style={{
            fontSize: "11.5px",
            color: "var(--mut, #85827b)",
            borderLeft: "2px solid var(--ln, #e2e8f0)",
            paddingLeft: "6px",
            margin: "4px 0 6px",
            fontStyle: "italic",
            lineHeight: 1.4,
          }}
        >
          “{card.anchor_excerpt.slice(0, 48)}{card.anchor_excerpt.length > 48 ? "…" : ""}”
        </div>
      )}

      {/* 图像卡片缩略图或错误提示 */}
      {card.anchor_source_type === "pdf_image" && (
        thumbUrl ? (
          <div
            style={{
              margin: "6px 0",
              maxHeight: "110px",
              overflow: "hidden",
              borderRadius: "6px",
              border: "1px solid var(--ln, #e2e8f0)",
              backgroundColor: "var(--bg-subtle, #f8fafc)",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <img
              src={thumbUrl}
              alt="图表切片"
              style={{
                width: "100%",
                maxHeight: "110px",
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>
        ) : thumbError ? (
          <div
            style={{
              fontSize: "11px",
              color: "#f43f5e",
              margin: "4px 0",
              padding: "4px 8px",
              borderRadius: "4px",
              backgroundColor: "rgba(244, 63, 94, 0.08)",
            }}
          >
            ⚠️ 本地图片资产读取失败
          </div>
        ) : null
      )}

      {/* 用户问题 (如有) */}
      {card.user_prompt && (
        <div
          style={{
            fontSize: "var(--card-fs, 13px)",
            fontWeight: 500,
            color: "var(--fg, #e8e5de)",
            marginBottom: "6px",
          }}
        >
          {card.user_prompt}
        </div>
      )}

      {/* 回答正文预览 (严格应用五行规则) */}
      <div style={{ fontSize: "var(--card-fs, 13px)", lineHeight: 1.55, color: "var(--fg, #e8e5de)" }}>
        {card.status === "generating" && !card.preview && !card.ai_response ? (
          <div style={{ color: "var(--mut, #85827b)", display: "flex", alignItems: "center", gap: "6px" }}>
            <span>正在深思</span>
            <span className="thinking-dots">...</span>
          </div>
        ) : card.status === "queued" ? (
          <div style={{ color: "var(--mut, #85827b)", fontStyle: "italic" }}>
            已排队等待执行...
          </div>
        ) : card.status === "failed" ? (
          <div style={{ color: "#f43f5e" }}>
            [生成失败]: {card.error_message || "请求异常"}
          </div>
        ) : card.status === "interrupted" && !card.preview && !card.ai_response ? (
          <div style={{ color: "var(--mut, #85827b)", fontStyle: "italic" }}>
            已中断
          </div>
        ) : (
          <FiveLineClampedView
            content={card.preview || card.ai_response}
            onExpandClick={onOpenFullModal}
            expandLabel="查看完整回答"
            isStreaming={card.status === "generating"}
          />
        )}
      </div>

      {/* 底部追问轮数指示 (仅多轮追问时紧凑显示，移除'独立学习记录'冗余文本) */}
      {card.turns_count > 0 && !isActive && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: "6px",
            fontSize: "10.5px",
            color: "var(--mut, #85827b)",
          }}
        >
          <span>{card.turns_count} 轮追问</span>
        </div>
      )}

      {/* 激活态自动呈现简明追问条 (参考 7gloss .fu) */}
      {(isActive || showFollowUpInput) && onSendFollowUp && (
        <form
          className="card-fu-bar"
          onSubmit={handleFollowUpSubmit}
          onClick={(e) => e.stopPropagation()}
          style={{
            marginTop: "8px",
            display: "flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 6px 3px 10px",
            border: "1px solid var(--ln, #262523)",
            borderRadius: "8px",
            background: "rgba(0, 0, 0, 0.25)",
          }}
        >
          <input
            type="text"
            value={followUpText}
            onChange={(e) => setFollowUpText(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isComposingRef.current) {
                e.preventDefault();
                handleFollowUpSubmit(e);
              }
            }}
            placeholder="追问..."
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "11.5px",
              color: "var(--fg, #e8e5de)",
            }}
          />
          <div
            style={{
              display: "inline-flex",
              backgroundColor: "rgba(255, 255, 255, 0.06)",
              borderRadius: "5px",
              padding: "1px",
              fontSize: "10px",
            }}
          >
            <button
              type="button"
              onClick={() => setFollowUpDepth("quick")}
              style={{
                border: "none",
                padding: "1px 5px",
                borderRadius: "3px",
                cursor: "pointer",
                background: followUpDepth === "quick" ? "var(--cd, #151514)" : "transparent",
                color: followUpDepth === "quick" ? "var(--fg, #e8e5de)" : "var(--mut, #85827b)",
                fontWeight: followUpDepth === "quick" ? 600 : 400,
              }}
            >
              Q
            </button>
            <button
              type="button"
              onClick={() => setFollowUpDepth("deep")}
              style={{
                border: "none",
                padding: "1px 5px",
                borderRadius: "3px",
                cursor: "pointer",
                background: followUpDepth === "deep" ? "var(--cd, #151514)" : "transparent",
                color: followUpDepth === "deep" ? "var(--fg, #e8e5de)" : "var(--mut, #85827b)",
                fontWeight: followUpDepth === "deep" ? 600 : 400,
              }}
            >
              D
            </button>
          </div>
          <button
            type="submit"
            disabled={!followUpText.trim()}
            style={{
              width: "20px",
              height: "20px",
              borderRadius: "50%",
              border: "none",
              backgroundColor: "var(--pen, #e8664a)",
              color: "#fff",
              cursor: "pointer",
              fontSize: "10px",
              display: "grid",
              placeItems: "center",
              opacity: !followUpText.trim() ? 0.4 : 1,
              flexShrink: 0,
            }}
            title="发送追问 (Enter)"
          >
            ↑
          </button>
        </form>
      )}
    </article>
  );
}
