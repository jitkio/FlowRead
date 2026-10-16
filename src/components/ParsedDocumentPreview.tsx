import React, { useState, useEffect, useRef, useCallback } from "react";
import { ParsedDocument } from "../types/parsedDocument";
import {
  ParsedDocumentLoader,
  ParsedAssetManager,
} from "../utils/parsedDocumentLoader";
import ParsedBlockView from "./ParsedBlock";
import "./ParsedDocumentPreview.css";

export interface ParsedPreviewTarget {
  filePath: string;
  loadKey: number;
}

interface ParsedDocumentPreviewProps {
  target: ParsedPreviewTarget;
  onClose: () => void;
  onOpenAnother: () => Promise<void>;
  isModalOpenAbove?: boolean;
}

export default function ParsedDocumentPreview({
  target,
  onClose,
  onOpenAnother,
  isModalOpenAbove = false,
}: ParsedDocumentPreviewProps): React.JSX.Element {
  const [loading, setLoading] = useState<boolean>(true);
  const [document, setDocument] = useState<ParsedDocument | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  const previewRootRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLElement>(null);
  const triggerElRef = useRef<HTMLElement | null>(null);
  const loaderRef = useRef<ParsedDocumentLoader>(new ParsedDocumentLoader());
  const assetManagerRef = useRef<ParsedAssetManager | null>(null);

  // 焦点管理与恢复：打开时主动聚焦预览层，关闭时平滑恢复原触发控件，防止页面跳动
  useEffect(() => {
    triggerElRef.current = window.document.activeElement as HTMLElement | null;
    previewRootRef.current?.focus({ preventScroll: true });

    return () => {
      try {
        if (triggerElRef.current && typeof triggerElRef.current.focus === "function") {
          triggerElRef.current.focus({ preventScroll: true });
        }
      } catch {}
    };
  }, []);

  // 加载指定路径的解析结果
  const loadPath = useCallback(async (filePath: string) => {
    setLoading(true);
    setErrors([]);
    setWarnings([]);

    // 释放旧资产会话
    if (assetManagerRef.current) {
      assetManagerRef.current.dispose();
      assetManagerRef.current = null;
    }

    const loaded = await loaderRef.current.loadDocument(filePath);
    if (!loaded) {
      // 被后续请求打断或已关闭，忽略迟到结果
      return;
    }

    assetManagerRef.current = loaded.assetManager;

    if (loaded.result.valid && loaded.result.document) {
      setDocument(loaded.result.document);
      setWarnings(loaded.result.warnings);
      setErrors([]);
    } else {
      setDocument(loaded.result.document || null);
      setErrors(loaded.result.errors);
      setWarnings(loaded.result.warnings);
    }
    setLoading(false);
  }, []);

  // 响应目标变化（包含切换文件及重新选择同一文件的 loadKey 变化）
  useEffect(() => {
    // 切换文档时清理旧大图状态，避免大图继续持有已释放的 Blob URL
    setLightboxImage(null);
    // 新文档显示后从合理顶部起始位置阅读
    if (scrollAreaRef.current) {
      if (typeof scrollAreaRef.current.scrollTo === "function") {
        scrollAreaRef.current.scrollTo({ top: 0, behavior: "instant" });
      } else {
        scrollAreaRef.current.scrollTop = 0;
      }
    }

    loadPath(target.filePath);
  }, [target.filePath, target.loadKey, loadPath]);

  // 组件卸载时释放所有已加载资产与会话，取消在途加载
  useEffect(() => {
    return () => {
      loaderRef.current.cancelActiveLoad();
      if (assetManagerRef.current) {
        assetManagerRef.current.dispose();
        assetManagerRef.current = null;
      }
    };
  }, []);

  // 统一的 Esc 层级处理：设置弹窗优先 -> 图片大图 -> 解析预览
  const handleEsc = useCallback(() => {
    // 1. 若顶层仍有活动弹窗（如阅读外观设置），预览层绝不提前抢截 Esc
    if (isModalOpenAbove) {
      return;
    }

    // 2. 优先关闭大图 Lightbox
    if (lightboxImage) {
      setLightboxImage(null);
      return;
    }

    // 3. 关闭预览层
    onClose();
  }, [isModalOpenAbove, lightboxImage, onClose]);

  // 组件根节点的键盘事件监听：捕获内部子元素（按钮、大图等）发出的按键
  const handleRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (isModalOpenAbove) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleEsc();
      return;
    }

    // 阻止非 Esc 快捷键穿透至主阅读器，但保留文本复制 (Ctrl+C / Cmd+C) 等操作
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "a")) {
      return;
    }
    e.stopPropagation();
  };

  // 全局备用 Esc 监听（当焦点偶尔落在外部无焦点区域时兜底）
  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        if (isModalOpenAbove) return;
        e.preventDefault();
        handleEsc();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [handleEsc, isModalOpenAbove]);

  return (
    <div
      ref={previewRootRef}
      className="flowread-parsed-preview"
      tabIndex={-1}
      role="region"
      aria-label="FlowRead 解析结果预览"
      onKeyDown={handleRootKeyDown}
    >
      {/* 顶部控制子栏 */}
      <header className="parsed-preview-header">
        <div className="parsed-preview-header-left">
          <span className="parsed-preview-badge">解析预览</span>
          <span className="parsed-preview-title" title={target.filePath}>
            {document?.fileName || "blocks.json"}
          </span>
        </div>

        <div className="parsed-preview-header-right">
          <button
            type="button"
            className="parsed-preview-btn"
            onClick={() => {
              void onOpenAnother();
            }}
            title="选择打开另一份 blocks.json"
          >
            打开其他结果...
          </button>
          <button
            type="button"
            className="parsed-preview-btn is-close"
            onClick={onClose}
            title="关闭解析预览，回到原有阅读界面 (Esc)"
          >
            关闭预览 (Esc)
          </button>
        </div>
      </header>

      {/* 主滚动阅读区 */}
      <main className="parsed-preview-scroll-area" ref={scrollAreaRef}>
        <div className="parsed-preview-content-column">
          {/* 错误提示横幅 */}
          {errors.length > 0 && (
            <div className="parsed-preview-banner is-error" role="alert">
              <div>
                <strong>解析结果存在错误：</strong>
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* 警告提示横幅 */}
          {warnings.length > 0 && errors.length === 0 && (
            <div className="parsed-preview-banner is-warning">
              <div>
                <strong>解析结果提示：</strong>
                <ul style={{ margin: "4px 0 0 18px" }}>
                  {warnings.map((warn, i) => (
                    <li key={i}>{warn}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* 加载中动画 */}
          {loading && (
            <div className="parsed-preview-loading-box">
              <div className="parsed-preview-spinner" />
              <span>正在校验并加载解析结构...</span>
            </div>
          )}

          {/* 连续正文与块流式排版 */}
          {!loading && document && assetManagerRef.current && (
            <article className="parsed-preview-article">
              {document.blocks.map((block) => (
                <ParsedBlockView
                  key={block.id}
                  block={block}
                  assetManager={assetManagerRef.current!}
                  onViewImage={(src, alt) => setLightboxImage({ src, alt })}
                />
              ))}
            </article>
          )}
        </div>
      </main>

      {/* 图片放大查看模态框 */}
      {lightboxImage && (
        <div
          className="parsed-lightbox-overlay"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="parsed-lightbox-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="parsed-lightbox-close"
              onClick={() => setLightboxImage(null)}
              title="关闭大图 (Esc)"
            >
              ×
            </button>
            <img
              src={lightboxImage.src}
              alt={lightboxImage.alt}
              className="parsed-lightbox-img"
            />
            {lightboxImage.alt && (
              <div className="parsed-lightbox-caption">{lightboxImage.alt}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
