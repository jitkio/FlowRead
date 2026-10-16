import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ParsedAssetManager } from "../utils/parsedDocumentLoader";

interface ControlledContentRendererProps {
  content: string;
  assetManager?: ParsedAssetManager;
  className?: string;
  isInline?: boolean;
}

/**
 * 遍历 HAST 树的受控安全过滤器：
 * 1. 彻底剔除 script, style, iframe, object, embed, form 等危险注入标签（连同其子内容一并剔除）；
 * 2. 剥离所有元素的 on* 属性（如 onclick, onerror）。
 */
function rehypeControlledSecurityFilter() {
  return (tree: any) => {
    const dangerousTags = new Set([
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "select",
      "textarea",
      "link",
      "meta",
    ]);

    const walk = (node: any, parent: any, index: number): number | void => {
      if (!node) return;

      if (node.type === "element") {
        const tag = (node.tagName || "").toLowerCase();
        if (dangerousTags.has(tag)) {
          if (parent && Array.isArray(parent.children)) {
            parent.children.splice(index, 1);
            return index;
          }
        }

        // 剥离所有 on* 事件属性
        if (node.properties) {
          for (const key of Object.keys(node.properties)) {
            if (key.toLowerCase().startsWith("on")) {
              delete node.properties[key];
            }
          }
        }
      }

      if (node.children && Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          const nextIdx = walk(node.children[i], node, i);
          if (typeof nextIdx === "number") {
            i = nextIdx - 1;
          }
        }
      }
    };

    walk(tree, null, 0);
  };
}

/**
 * 支持在 HTML 元素内部（如 HTML 表格单元格 <td>、图注等）识别并编译内嵌数学公式 $...$
 * 不干扰代码块、行内代码与转义字符
 */
function rehypeMathInHtml() {
  return (tree: any) => {
    const skipTags = new Set(["code", "pre", "script", "style"]);

    const walk = (node: any, parent: any, index: number): number | void => {
      if (!node) return;

      if (node.type === "element" && skipTags.has((node.tagName || "").toLowerCase())) {
        return;
      }

      if (node.type === "text" && typeof node.value === "string" && node.value.includes("$")) {
        const text = node.value;
        const mathRegex = /\$([^\$]+)\$/g;
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        const newNodes: any[] = [];

        while ((match = mathRegex.exec(text)) !== null) {
          const textBefore = text.slice(lastIndex, match.index);
          if (textBefore) {
            newNodes.push({ type: "text", value: textBefore });
          }
          const mathTex = match[1].trim();
          newNodes.push({
            type: "element",
            tagName: "span",
            properties: { className: ["math", "math-inline"] },
            children: [{ type: "text", value: mathTex }],
          });
          lastIndex = match.index + match[0].length;
        }

        const remaining = text.slice(lastIndex);
        if (remaining) {
          newNodes.push({ type: "text", value: remaining });
        }

        if (newNodes.length > 0 && parent && Array.isArray(parent.children)) {
          parent.children.splice(index, 1, ...newNodes);
          return index + newNodes.length - 1;
        }
      }

      if (node.children && Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          const nextIdx = walk(node.children[i], node, i);
          if (typeof nextIdx === "number") {
            i = nextIdx;
          }
        }
      }
    };

    walk(tree, null, 0);
  };
}

/**
 * 受控内容渲染器
 * 结合 ReactMarkdown + remark-gfm + remark-math + rehype-raw + rehype-katex：
 * 1. 恢复纯正 Markdown 语法解析（标题、粗斜体、列表、代码、转义字符）；
 * 2. 允许受控 HTML 标签（如 <b>, <i>, <sup>, <sub>, <br>, 表格 rowspan/colspan）；
 * 3. 严格保护数学比较符（如 $x<y$ 不会被误认为 HTML 标签）；
 * 4. 彻底剔除危险标签与 on* 事件，拦截外链跳转与外部媒体。
 */
export default function ControlledContentRenderer({
  content,
  className,
  isInline = false,
}: ControlledContentRendererProps): React.JSX.Element {
  const trimmed = (content || "").trim();

  if (!trimmed) {
    return isInline ? (
      <span className={className} />
    ) : (
      <div className={className} />
    );
  }

  const markdownContent = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        rehypeControlledSecurityFilter,
        rehypeMathInHtml,
        [rehypeKatex, { strict: false, throwOnError: false }],
      ]}
      components={{
        ...(isInline
          ? {
              p: ({ children }) => <span className="parsed-inline-p">{children}</span>,
              div: ({ children }) => <span className="parsed-inline-div">{children}</span>,
            }
          : {}),
        a: ({ children }) => (
          <span className="parsed-disabled-link" title="只读预览中链接跳转已禁用">
            {children}
          </span>
        ),
        img: ({ alt }) => (
          <span className="parsed-restricted-media" title={alt || "外部图片"}>
            [外部图片已拦截]
          </span>
        ),
      }}
    >
      {trimmed}
    </ReactMarkdown>
  );

  if (isInline) {
    return (
      <span className={`parsed-controlled-content ${className || ""}`.trim()}>
        {markdownContent}
      </span>
    );
  }

  return (
    <div className={`parsed-controlled-content ${className || ""}`.trim()}>
      {markdownContent}
    </div>
  );
}
