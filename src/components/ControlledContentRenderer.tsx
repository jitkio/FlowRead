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

export const ESCAPED_DOLLAR_PLACEHOLDER = "\uE000FR_ESC_DL\uE001";
export const MATH_ESCAPED_DOLLAR_PLACEHOLDER = "\uE000FR_MATH_DL\uE001";

/**
 * 在进入 Markdown 引擎前对转义的美元符号 \$ 进行占位保护
 * 必须跳过代码块 (```...``` 或 ~~~...~~~) 与行内代码 (`...`)，
 * 针对公式内部的合法转义 \$ 进行专用保护，防止 remark-math 提前截断公式，并在 Rehype 编译前精准还原为 \\$
 */
export function protectEscapedDollars(text: string): string {
  // 必须识别：
  // 1. 块级代码与行内代码：```...```、~~~...~~~、`...`
  // 2. 块级数学公式：$$...$$
  // 3. 行内数学公式：(?<!\\)\$(?:\\\$|[^\$\n])+?(?<!\\)\$
  const protectedPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`]*?`+|\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\\$|[^\$\n])+?(?<!\\)\$)/g;
  let lastIndex = 0;
  let result = "";
  let match: RegExpExecArray | null;

  const replaceDollar = (str: string) => {
    // 匹配未被偶数个反斜杠抵消的 \$ (即单个 \$ 或奇数个反斜杠后的 $)
    return str.replace(/(^|[^\\])(\\\\)*\\(\$)/g, (m) => {
      return m.slice(0, -2) + ESCAPED_DOLLAR_PLACEHOLDER;
    });
  };

  while ((match = protectedPattern.exec(text)) !== null) {
    const nonProtected = text.slice(lastIndex, match.index);
    result += replaceDollar(nonProtected);

    const matchedText = match[0];
    if (
      (matchedText.startsWith("$") || matchedText.startsWith("$$")) &&
      matchedText.includes("\\$")
    ) {
      // 在进入 remark 前将公式内的 \$ 替换为专用占位符，防止 remark-math 提前截断公式
      const inner = matchedText.replace(/(^|[^\\])(\\\\)*\\(\$)/g, (m) => {
        return m.slice(0, -2) + MATH_ESCAPED_DOLLAR_PLACEHOLDER;
      });
      result += inner;
    } else {
      result += matchedText; // 代码区域等原样保留
    }

    lastIndex = match.index + match[0].length;
  }

  const remaining = text.slice(lastIndex);
  result += replaceDollar(remaining);

  return result;
}

/**
 * 遍历 HAST 树的受控安全过滤器：
 * 1. 彻底剔除 script, style, iframe, object, embed, form 等危险注入标签（连同其子内容一并剔除）；
 * 2. 剥离所有元素的 on* 属性（如 onclick, onerror）；
 * 3. 检查 href, src, xlinkHref, action 等属性，剔除任何 javascript:, vbscript:, data:text/html 协议属性。
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

        // 剥离所有 on* 事件属性及危险协议属性
        if (node.properties) {
          for (const key of Object.keys(node.properties)) {
            const lowerKey = key.toLowerCase();
            if (lowerKey.startsWith("on")) {
              delete node.properties[key];
              continue;
            }

            if (
              lowerKey === "href" ||
              lowerKey === "src" ||
              lowerKey === "xlinkhref" ||
              lowerKey === "xlink:href" ||
              lowerKey === "action"
            ) {
              const val = String(node.properties[key] || "")
                .trim()
                .toLowerCase();
              const sanitizedVal = val.replace(/[\x00-\x20\s]+/g, "");
              if (
                sanitizedVal.startsWith("javascript:") ||
                sanitizedVal.startsWith("vbscript:") ||
                sanitizedVal.startsWith("data:text/html")
              ) {
                delete node.properties[key];
              }
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
        const mathRegex = /(?<!\\)\$((?:\\\$|[^\$\n])+?)(?<!\\)\$/g;
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
 * 将 HAST 树中的占位符还原为字面量美元符号 $ 或公式内 \\$
 */
function rehypeRestoreEscapedDollars() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === "text" && typeof node.value === "string") {
        if (node.value.includes(ESCAPED_DOLLAR_PLACEHOLDER)) {
          node.value = node.value.split(ESCAPED_DOLLAR_PLACEHOLDER).join("$");
        }
        if (node.value.includes(MATH_ESCAPED_DOLLAR_PLACEHOLDER)) {
          node.value = node.value.split(MATH_ESCAPED_DOLLAR_PLACEHOLDER).join("\\$");
        }
      }
      if (node.properties) {
        for (const key of Object.keys(node.properties)) {
          if (typeof node.properties[key] === "string") {
            if (node.properties[key].includes(ESCAPED_DOLLAR_PLACEHOLDER)) {
              node.properties[key] = node.properties[key]
                .split(ESCAPED_DOLLAR_PLACEHOLDER)
                .join("$");
            }
            if (node.properties[key].includes(MATH_ESCAPED_DOLLAR_PLACEHOLDER)) {
              node.properties[key] = node.properties[key]
                .split(MATH_ESCAPED_DOLLAR_PLACEHOLDER)
                .join("\\$");
            }
          }
        }
      }
      if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}

/**
 * 受控内联本地图片子组件
 */
function ControlledLocalImage({
  src,
  alt,
  title,
  assetManager,
}: {
  src: string;
  alt?: string;
  title?: string;
  assetManager: ParsedAssetManager;
}) {
  const [blobUrl, setBlobUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    assetManager
      .loadAsset(src)
      .then((url) => {
        if (!active) return;
        if (url) {
          setBlobUrl(url);
        } else {
          setError(`图片加载失败 (${src})`);
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
  }, [src, assetManager]);

  if (loading) {
    return (
      <span className="parsed-inline-image-wrapper" data-inline-image="true">
        <span className="parsed-image-inline-loading">正在加载图片...</span>
      </span>
    );
  }

  if (error || !blobUrl) {
    return (
      <span className="parsed-inline-image-wrapper" data-inline-image="true">
        <span className="parsed-image-inline-error" title={error || "加载失败"}>
          [图片加载失败: {alt || src}]
        </span>
      </span>
    );
  }

  return (
    <span className="parsed-inline-image-wrapper" data-inline-image="true">
      <img
        src={blobUrl}
        alt={alt || src}
        title={title || alt || src}
        className="parsed-inline-image"
        loading="lazy"
        onError={() => {
          setError(`图片解码失败 (${src})`);
          setBlobUrl(null);
        }}
      />
    </span>
  );
}

/**
 * 受控内容渲染器
 * 结合 ReactMarkdown + remark-gfm + remark-math + rehype-raw + rehype-katex：
 * 1. 恢复纯正 Markdown 语法解析（标题、粗斜体、列表、代码、转义字符）；
 * 2. 允许受控 HTML 标签（如 <b>, <i>, <sup>, <sub>, <br>, 表格 rowspan/colspan）；
 * 3. 严格保护数学比较符（如 $x<y$ 不会被误认为 HTML 标签）；
 * 4. 转义美元符号 \$ 保护与还原，避免误入 KaTeX；
 * 5. 本地相对路径图片经 assetManager 安全按需加载，严格拦截外部图片与危险跳转。
 */
export default function ControlledContentRenderer({
  content,
  assetManager,
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

  const protectedContent = protectEscapedDollars(trimmed);

  const markdownContent = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        rehypeControlledSecurityFilter,
        rehypeMathInHtml,
        rehypeRestoreEscapedDollars,
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
        img: ({ src, alt, title }) => {
          const rawSrc = (src || "").trim();
          const isExternal =
            !rawSrc ||
            /^(?:https?:|\/\/|data:|blob:|ftp:|file:)/i.test(rawSrc);

          if (isExternal || !assetManager) {
            return (
              <span className="parsed-inline-image-wrapper" data-inline-image="true">
                <span className="parsed-restricted-media" title={alt || rawSrc || "外部图片"}>
                  [外部图片已拦截]
                </span>
              </span>
            );
          }

          return (
            <ControlledLocalImage
              src={rawSrc}
              alt={alt}
              title={title}
              assetManager={assetManager}
            />
          );
        },
      }}
    >
      {protectedContent}
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
