import React, { useState, useEffect } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { ParsedBlock } from "../types/parsedDocument";
import { ParsedAssetManager } from "../utils/parsedDocumentLoader";
import ControlledContentRenderer from "./ControlledContentRenderer";

interface ParsedBlockProps {
  block: ParsedBlock;
  assetManager: ParsedAssetManager;
  onViewImage?: (src: string, alt: string) => void;
}

/**
 * 独立公式安全渲染组件
 * 包含错误局部兜底，杜绝 katex-error 穿透或单点崩溃
 */
export function FormulaBlockView({ content }: { content: string }) {
  const rawTex = content.trim();
  let cleanTex = rawTex;
  if (cleanTex.startsWith("$$") && cleanTex.endsWith("$$") && cleanTex.length >= 4) {
    cleanTex = cleanTex.slice(2, -2).trim();
  }

  try {
    const renderedHtml = katex.renderToString(cleanTex, {
      displayMode: true,
      throwOnError: true,
    });

    // 严密校验：不能只判断 includes('katex')，必须精准排查 katex-error
    if (renderedHtml.includes("katex-error")) {
      return (
        <div className="parsed-formula-container is-error" role="region" aria-label="公式解析异常">
          <div className="parsed-formula-error-badge">公式渲染异常</div>
          <pre className="parsed-formula-raw">{cleanTex}</pre>
        </div>
      );
    }

    return (
      <div className="parsed-formula-container">
        <div
          className="parsed-formula-scroll"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      </div>
    );
  } catch (err: any) {
    return (
      <div className="parsed-formula-container is-error" role="region" aria-label="公式解析异常">
        <div className="parsed-formula-error-badge">公式语法错误</div>
        <pre className="parsed-formula-raw">{cleanTex}</pre>
        <div className="parsed-formula-error-detail">
          {err?.message || "KaTeX 编译失败"}
        </div>
      </div>
    );
  }
}

/**
 * 插图与电路图渲染组件
 */
export function ImageBlockView({
  block,
  assetManager,
  onViewImage,
}: {
  block: ParsedBlock;
  assetManager: ParsedAssetManager;
  onViewImage?: (src: string, alt: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!block.asset_ref) {
      setLoading(false);
      setError("无图片资产引用");
      return;
    }

    setLoading(true);
    setError(null);

    assetManager
      .loadAsset(block.asset_ref)
      .then((url) => {
        if (!active) return;
        if (url) {
          setSrc(url);
        } else {
          setError(`图片资产加载失败 (${block.asset_ref})`);
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(`图片加载异常: ${err?.message || err}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [block.asset_ref, assetManager]);

  const captionText =
    block.caption ||
    (block.type === "image" && block.content && !block.content.startsWith("![")
      ? block.content
      : null);

  return (
    <figure className="parsed-figure-container">
      <div className="parsed-image-box">
        {loading && <div className="parsed-image-loading">正在加载插图资产...</div>}
        {error && (
          <div className="parsed-image-error">
            <span className="parsed-error-icon">🖼️</span>
            <span>{error}</span>
          </div>
        )}
        {src && (
          <img
            src={src}
            alt={captionText || block.asset_ref || "文档插图"}
            className="parsed-image-element"
            loading="lazy"
            onClick={() => onViewImage?.(src, captionText || block.asset_ref || "插图")}
            onError={() => {
              // 捕获浏览器端图片解码失败（文件数据损坏或不支持格式）
              setError(`图片解码失败 (文件数据损坏或格式不支持: ${block.asset_ref})`);
              setSrc(null);
            }}
            title="点击查看大图"
          />
        )}
      </div>
      {captionText && (
        <figcaption className="parsed-caption-text">
          <ControlledContentRenderer
            content={captionText}
            assetManager={assetManager}
            isInline={true}
          />
        </figcaption>
      )}
    </figure>
  );
}

/**
 * 表格渲染组件
 * HTML 表格直接经 ControlledContentRenderer 受控解析保留 rowspan/colspan/LaTeX
 * Markdown 表格经 ReactMarkdown 渲染，且禁用恶意外链
 */
export function TableBlockView({
  block,
  assetManager,
}: {
  block: ParsedBlock;
  assetManager?: ParsedAssetManager;
}) {
  const content = block.content.trim();
  return (
    <div className="parsed-table-container">
      <div className="parsed-table-scroll">
        <ControlledContentRenderer content={content} assetManager={assetManager} />
      </div>
    </div>
  );
}

/**
 * 单个结构块分流渲染器
 */
export default function ParsedBlockView({
  block,
  assetManager,
  onViewImage,
}: ParsedBlockProps): React.JSX.Element | null {
  // 页眉、页脚、页码在流式正文中不予显示，避免视觉打断
  if (block.type === "page_header" || block.type === "page_number") {
    return null;
  }

  switch (block.type) {
    case "paragraph":
      return (
        <div className="parsed-paragraph-container" data-block-id={block.id}>
          <ControlledContentRenderer
            content={block.content}
            assetManager={assetManager}
          />
        </div>
      );

    case "heading":
      return (
        <div className="parsed-heading-container" data-block-id={block.id}>
          <ControlledContentRenderer
            content={block.content}
            assetManager={assetManager}
          />
        </div>
      );

    case "formula":
      return (
        <div className="parsed-block-wrapper" data-block-id={block.id}>
          <FormulaBlockView content={block.content} />
        </div>
      );

    case "image":
      return (
        <div className="parsed-block-wrapper" data-block-id={block.id}>
          <ImageBlockView
            block={block}
            assetManager={assetManager}
            onViewImage={onViewImage}
          />
        </div>
      );

    case "table":
      return (
        <div className="parsed-block-wrapper" data-block-id={block.id}>
          <TableBlockView block={block} assetManager={assetManager} />
        </div>
      );

    case "caption":
      return (
        <div className="parsed-standalone-caption" data-block-id={block.id}>
          <ControlledContentRenderer
            content={block.content}
            assetManager={assetManager}
            isInline={true}
          />
        </div>
      );

    default:
      return (
        <div className="parsed-unknown-container" data-block-id={block.id}>
          <div className="parsed-unknown-hint">
            <span>未识别结构块 (#{block.id}, 原始类型: {block.raw_type || "未知"})</span>
          </div>
          {block.content && (
            <pre className="parsed-unknown-raw">{block.content}</pre>
          )}
        </div>
      );
  }
}
