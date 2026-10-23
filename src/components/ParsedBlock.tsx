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
 * 修复 OCR / MinerU 产物中经真实案例证实的公式语法瑕疵
 * 规则：
 * 1. 仅在原式渲染失败后作为容错备选执行，原式可正常编译时绝不调用；
 * 2. 仅处理明确识别的、带有前导条件词且包含未转义下标/上标的表达式，例如：
 *    \text{for K > K_{crit}} -> \text{for }K > K_{crit}
 * 3. 转义符号（如 \_、\^）、未知文本、嵌套结构保持原样不变；
 * 4. 无法确认时不猜测数学含义，保持原样以便报错局部兜底。
 */
export function hasUnescapedSubOrSuper(str: string): boolean {
  return /(?<!\\)[_^]/.test(str);
}

export function repairLatexFormula(tex: string): string {
  // 匹配 \text{...} 或 \text {...}，支持一层内嵌花括号（如 K_{crit}）
  return tex.replace(/\\text\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, inner) => {
    // 若已包含 $ 公式定界符，保持原样
    if (inner.includes("$")) {
      return match;
    }
    // 若不含未转义的 _ 或 ^（例如 \text{signal\_name} 为合法文本），保持原样
    if (!hasUnescapedSubOrSuper(inner)) {
      return match;
    }
    // 仅识别受真实案例支持的前导条件词（不区分大小写）
    const prefixMatch = inner.match(
      /^(\s*(?:for|where|if|when|with|and|or|as|since|otherwise|case)\s+)(.*)$/i
    );
    if (!prefixMatch) {
      return match;
    }
    const prefix = prefixMatch[1];
    const condition = prefixMatch[2];
    // 条件部分必须确实含有未转义的 _ 或 ^
    if (!hasUnescapedSubOrSuper(condition)) {
      return match;
    }
    return `\\text{${prefix}}${condition}`;
  });
}

/**
 * 独立公式安全渲染组件
 * 包含错误局部兜底，杜绝 katex-error 穿透或单点崩溃
 */
export function FormulaBlockView({ content }: { content: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const rawTex = content.trim();
  let cleanTex = rawTex;
  if (cleanTex.startsWith("$$") && cleanTex.endsWith("$$") && cleanTex.length >= 4) {
    cleanTex = cleanTex.slice(2, -2).trim();
  }

  let renderedHtml: string | null = null;
  let wasRepaired = false;
  let compileError: any = null;

  // 1. 优先原样渲染原公式
  try {
    renderedHtml = katex.renderToString(cleanTex, {
      displayMode: true,
      throwOnError: true,
    });
  } catch (initialErr) {
    // 2. 仅在原式编译失败后，尝试收紧的兼容修复
    const repaired = repairLatexFormula(cleanTex);
    if (repaired !== cleanTex) {
      try {
        renderedHtml = katex.renderToString(repaired, {
          displayMode: true,
          throwOnError: true,
        });
        wasRepaired = true;
      } catch {
        compileError = initialErr;
      }
    } else {
      compileError = initialErr;
    }
  }

  // 严密校验：不能只判断 includes('katex')，必须精准排查 katex-error
  if (renderedHtml && renderedHtml.includes("katex-error")) {
    renderedHtml = null;
    compileError = new Error("KaTeX 渲染包含错误标记");
  }

  if (renderedHtml) {
    const hasTag = renderedHtml.includes("katex-tag");
    return (
      <div className={`parsed-formula-container ${hasTag ? "has-tag" : "no-tag"}`}>
        <div
          className="parsed-formula-scroll"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
        {wasRepaired && (
          <div className="parsed-formula-repair-note">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="parsed-formula-repair-badge">已兼容显示</span>
              <button
                type="button"
                className="parsed-formula-raw-toggle"
                onClick={() => setShowRaw((prev) => !prev)}
              >
                {showRaw ? "收起原式" : "查看原式"}
              </button>
            </div>
            {showRaw && <pre className="parsed-formula-raw">{cleanTex}</pre>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="parsed-formula-container is-error" role="region" aria-label="公式解析异常">
      <div className="parsed-formula-error-badge">公式语法错误</div>
      <pre className="parsed-formula-raw">{cleanTex}</pre>
      <div className="parsed-formula-error-detail">
        {compileError?.message || "KaTeX 编译失败"}
      </div>
    </div>
  );
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMathRunType(type: string): boolean {
  const t = (type || "").toLowerCase();
  return t === "equation_inline" || t === "math" || t === "formula_inline";
}

function isTextRunType(type: string): boolean {
  const t = (type || "").toLowerCase();
  return t === "text" || t === "normal" || t === "string" || t === "";
}

/** 去掉公式 run 源码外层的 $ / $$ 定界符 */
function stripMathDelimiters(raw: string): string {
  const t = (raw || "").trim();
  if (t.length >= 4 && t.startsWith("$$") && t.endsWith("$$")) return t.slice(2, -2).trim();
  if (t.length >= 2 && t.startsWith("$") && t.endsWith("$")) return t.slice(1, -1).trim();
  return t;
}

/** 文本 run 与 content 之间的空白折叠差异不应阻断“完整”判定 */
function buildWhitespaceTolerantPattern(needle: string): RegExp {
  const parts = needle
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp);
  return new RegExp(parts.join("\\s+"));
}

/**
 * 公式 run 与正文空隙比较时的规范化：只剥离外层 $ / $$ 定界符与首尾空白。
 * 不做 Unicode / LaTeX 语义等价推断，也不忽略标点、运算符与字符数量。
 */
function normalizeMathSource(raw: string): string {
  return stripMathDelimiters((raw || "").trim());
}

/**
 * 按顺序消费 content 中的一段空隙：该空隙必须**整体**吃掉当前待匹配的全部公式 run。
 * - 不允许只匹配队列前缀就提前成功：剩余公式会跨过后续文本或在末尾被凭空追加；
 * - 字符数量、顺序、标点、运算符与关系符都必须完全一致，不做任何语义等价推断；
 * - 只有整体相等时才清空队列；不等或无法确定时返回 false，调用方保留原文。
 */
function consumeGapExactly(gap: string, pendingMath: string[]): boolean {
  const target = normalizeMathSource(gap);

  if (pendingMath.length === 0) {
    // 没有待匹配公式时，空隙只能是空白，否则说明 runs 漏掉了正文
    return target === "";
  }

  // 当前空隙必须与「全部待匹配公式按原顺序拼接」完全相等
  if (pendingMath.join("") !== target) return false;

  pendingMath.length = 0;
  return true;
}

/**
 * 判断 inline_runs 是否“可证实”覆盖了完整 content。
 * 不使用字符集合、长度比例或相似度：按顺序把每个 text run 在 content 中实际对齐，
 * 每段空隙必须整体匹配当前全部公式 run（不允许残留到后续文本之后或末尾），
 * 末尾不得残留正文，也不得残留未匹配的公式 run。
 * 无法可靠判定时返回 false，调用方必须优先保留原文。
 */
export function runsCoverContentFully(block: ParsedBlock): boolean {
  const content = block.content || "";
  const runs = Array.isArray(block.inline_runs) ? block.inline_runs : [];

  if (!content.trim()) {
    return runs.some((run) => ((run?.content as string) || "").trim().length > 0);
  }

  const pendingMath: string[] = [];
  let cursor = 0;
  let matchedTextRuns = 0;

  for (const run of runs) {
    const type = (run?.type || "").toLowerCase();
    if (isMathRunType(type)) {
      const source = normalizeMathSource(run?.content as string);
      if (source) pendingMath.push(source);
      continue;
    }
    // 未知 run 类型无法参与可靠对齐
    if (!isTextRunType(type)) return false;

    const needle = (run?.content || "").trim();
    if (!needle) continue;

    const match = buildWhitespaceTolerantPattern(needle).exec(content.slice(cursor));
    if (!match) return false;

    const matchStart = cursor + match.index;
    if (!consumeGapExactly(content.slice(cursor, matchStart), pendingMath)) return false;

    cursor = matchStart + match[0].length;
    matchedTextRuns += 1;
  }

  // 没有任何文本 run 参与对齐时，不具备“覆盖全文”的依据
  if (matchedTextRuns === 0) return false;

  // 尾部残余与未匹配的公式 run 都不允许：否则重建会丢正文或凭空追加正文中不存在的公式
  return consumeGapExactly(content.slice(cursor), pendingMath);
}

/** 普通文本中的字面 $ 必须转义，避免与后续公式定界符配成假公式 */
function escapeBareDollars(text: string): string {
  return text.replace(/(?<!\\)\$/g, "\\$");
}

const MATH_SLOT_PREFIX = "\uE000FR_MATH_SLOT_";
const MATH_SLOT_SUFFIX = "\uE001";

/** 代码块、行内代码与已定界公式：不参与公式补全，也不参与裸 $ 转义 */
function createProtectedSpanPattern(): RegExp {
  return /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*?`+|\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\\$|[^\$\n])+?(?<!\\)\$)/g;
}

/** 仅在代码与已有公式之外转义裸 $ */
function escapeBareDollarsOutsideProtected(text: string): string {
  const pattern = createProtectedSpanPattern();
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    out += escapeBareDollars(text.slice(lastIndex, match.index)) + match[0];
    lastIndex = match.index + match[0].length;
  }
  out += escapeBareDollars(text.slice(lastIndex));
  return out;
}

/** 仅在代码与已有公式之外，把未定界的公式替换为占位符 */
function wrapMathOutsideProtected(
  text: string,
  inner: string,
  slot: string
): { text: string; changed: boolean } {
  const isIdentifier = /^[a-zA-Z0-9_]+$/.test(inner);
  const pattern = isIdentifier
    ? new RegExp(`(?<![a-zA-Z0-9_])${escapeRegExp(inner)}(?![a-zA-Z0-9_])`, "g")
    : new RegExp(escapeRegExp(inner), "g");

  let changed = false;
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const spanPattern = createProtectedSpanPattern();

  const replacePlain = (segment: string) =>
    segment.replace(pattern, () => {
      changed = true;
      return slot;
    });

  while ((match = spanPattern.exec(text)) !== null) {
    out += replacePlain(text.slice(lastIndex, match.index)) + match[0];
    lastIndex = match.index + match[0].length;
  }
  out += replacePlain(text.slice(lastIndex));

  return { text: out, changed };
}

/** 完整 runs：按 runs 序列合成正文，公式补 $...$，普通文本裸 $ 转义 */
function synthesizeFromRuns(runs: ParsedBlock["inline_runs"]): string {
  return (runs || [])
    .map((run) => {
      if (!run) return "";
      const type = (run.type || "").toLowerCase();
      const content = run.content || "";
      if (isMathRunType(type)) {
        const trimmed = content.trim();
        if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
          return trimmed;
        }
        return `$${trimmed}$`;
      }
      return escapeBareDollars(content);
    })
    .join("");
}

/**
 * 残缺 runs：以原 content 为基准，绝不丢弃周围正文。
 * 只对正文中尚未定界的公式定点补齐 $...$，随后把普通文本中的裸 $（如货币 $10）转义，
 * 避免补出来的定界符与货币符号配成假公式而吞掉整段文字。
 */
function repairIncompleteRuns(content: string, mathRuns: ParsedBlock["inline_runs"]): string {
  let result = content;
  const wrapped: string[] = [];

  for (const run of mathRuns || []) {
    const inner = stripMathDelimiters((run?.content as string) || "");
    if (!inner) continue;
    // 正文里已用 $...$ / $$...$$ 定界的公式保持原样
    if (result.includes(`$${inner}$`) || result.includes(`$$${inner}$$`)) continue;

    const slot = `${MATH_SLOT_PREFIX}${wrapped.length}${MATH_SLOT_SUFFIX}`;
    const { text, changed } = wrapMathOutsideProtected(result, inner, slot);
    if (!changed) continue;
    wrapped.push(inner);
    result = text;
  }

  result = escapeBareDollarsOutsideProtected(result);

  wrapped.forEach((inner, index) => {
    result = result.split(`${MATH_SLOT_PREFIX}${index}${MATH_SLOT_SUFFIX}`).join(`$${inner}$`);
  });

  return result;
}

/**
 * 辅助函数：获取块的有效渲染内容
 * 规则：
 * 1. 只有能证实 inline_runs 覆盖完整 content 时才按 runs 合成（普通 text run 中的字面 $ 转义为 \$）；
 * 2. 无法可靠判定完整性时一律保留原 content，仅定点补全缺少定界符的公式，绝不按比例或相似度丢弃正文。
 */
export function getRenderableBlockContent(block: ParsedBlock): string {
  const content = block.content || "";
  const runs = Array.isArray(block.inline_runs) ? block.inline_runs : [];

  if (runs.length === 0) {
    return content;
  }

  const mathRuns = runs.filter((run) => !!run && isMathRunType(run.type || ""));
  if (mathRuns.length === 0) {
    return content;
  }

  if (runsCoverContentFully(block)) {
    return synthesizeFromRuns(runs);
  }

  return repairIncompleteRuns(content, mathRuns);
}

/**
 * 应用标题层级：为渲染内容补充 Markdown 标题前缀
 * 规则：
 * 1. 内容为空或 heading_level 非法（非 1-6 整数）时原样返回；
 * 2. 内容已有 Markdown 标题前缀（# ~ ######）时绝不重复加 #；
 * 3. 否则按合法层级加前缀；不按文字长度猜测层级、不改写标题原文。
 */
function applyHeadingLevel(content: string, block: ParsedBlock): string {
  if (!content || !content.trim()) return content;

  const level = block.heading_level;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6) {
    return content;
  }

  // 已带 Markdown 标题前缀的内容保持原样（前缀优先于 heading_level）
  if (/^\s*#{1,6}(?:\s|$)/.test(content)) return content;

  return "#".repeat(level) + " " + content;
}

/**
 * 插图与电路图渲染组件
 * showCaption：是否由本组件渲染图注与脚注这两类说明文字（默认 true；
 * 表格截图降级分支传 false，说明文字归父组件渲染，避免出现双份）
 */
export function ImageBlockView({
  block,
  assetManager,
  onViewImage,
  showCaption = true,
}: {
  block: ParsedBlock;
  assetManager: ParsedAssetManager;
  onViewImage?: (src: string, alt: string) => void;
  showCaption?: boolean;
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
      ? getRenderableBlockContent(block)
      : null);

  // 脚注：与图注同类说明文字，位于 figure 层、不依赖图片加载成功
  const footnoteText = (block.footnote || "").trim();

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
      {showCaption && captionText && (
        <figcaption className="parsed-caption-text">
          <ControlledContentRenderer
            content={captionText}
            assetManager={assetManager}
            isInline={true}
          />
        </figcaption>
      )}
      {showCaption && footnoteText && (
        <div className="parsed-standalone-caption parsed-image-footnote">
          <ControlledContentRenderer
            content={footnoteText}
            assetManager={assetManager}
            isInline={true}
          />
        </div>
      )}
    </figure>
  );
}

/**
 * 表格渲染组件
 * - HTML 表格经 ControlledContentRenderer 受控解析保留 rowspan/colspan/LaTeX
 * - 图注（caption）渲染在表格上方、脚注（footnote）渲染在表格下方
 * - 结构 HTML 缺失但存在可信备援截图（asset_ref）时明确降级显示，绝不静默展示空表格
 * - 结构与备援均缺失时给出明确错误占位
 */
export function TableBlockView({
  block,
  assetManager,
  onViewImage,
}: {
  block: ParsedBlock;
  assetManager?: ParsedAssetManager;
  onViewImage?: (src: string, alt: string) => void;
}) {
  const content = block.content.trim();
  const caption = (block.caption || "").trim();
  const footnote = (block.footnote || "").trim();

  // 结构表格不可用：优先降级到备援截图，并给出明确标识
  if (!content) {
    if (block.asset_ref && assetManager) {
      return (
        <div className="parsed-table-container is-degraded" data-block-id={block.id}>
          <div className="parsed-table-degraded-badge" role="status">
            表格结构不可用，已降级显示为表格截图
          </div>
          <ImageBlockView
            block={block}
            assetManager={assetManager}
            onViewImage={onViewImage}
            showCaption={false}
          />
          {caption && (
            <div className="parsed-standalone-caption">
              <ControlledContentRenderer
                content={caption}
                assetManager={assetManager}
                isInline={true}
              />
            </div>
          )}
          {footnote && (
            <div className="parsed-standalone-caption parsed-table-footnote">
              <ControlledContentRenderer
                content={footnote}
                assetManager={assetManager}
                isInline={true}
              />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="parsed-table-container is-error" data-block-id={block.id}>
        <div className="parsed-image-error" role="alert">
          <span className="parsed-error-icon">⚠️</span>
          <span>表格内容为空（结构 HTML 与备援截图均缺失，块 #{block.id}）</span>
        </div>
        {caption && (
          <div className="parsed-standalone-caption">
            <ControlledContentRenderer
              content={caption}
              assetManager={assetManager}
              isInline={true}
            />
          </div>
        )}
        {footnote && (
          <div className="parsed-standalone-caption parsed-table-footnote">
            <ControlledContentRenderer
              content={footnote}
              assetManager={assetManager}
              isInline={true}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="parsed-table-container" data-block-id={block.id}>
      {caption && (
        <div className="parsed-standalone-caption parsed-table-caption">
          <ControlledContentRenderer
            content={caption}
            assetManager={assetManager}
            isInline={true}
          />
        </div>
      )}
      <div className="parsed-table-scroll">
        <ControlledContentRenderer content={content} assetManager={assetManager} />
      </div>
      {footnote && (
        <div className="parsed-standalone-caption parsed-table-footnote">
          <ControlledContentRenderer
            content={footnote}
            assetManager={assetManager}
            isInline={true}
          />
        </div>
      )}
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
  // （loader 已正式将 page_footer 归一化为类型，统一按 type 过滤）
  if (
    block.type === "page_header" ||
    block.type === "page_number" ||
    block.type === "page_footer"
  ) {
    return null;
  }

  switch (block.type) {
    case "paragraph":
      return (
        <div className="parsed-paragraph-container" data-block-id={block.id}>
          <ControlledContentRenderer
            content={getRenderableBlockContent(block)}
            assetManager={assetManager}
          />
        </div>
      );

    case "heading":
      return (
        <div className="parsed-heading-container" data-block-id={block.id}>
          <ControlledContentRenderer
            content={applyHeadingLevel(getRenderableBlockContent(block), block)}
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
          <TableBlockView
            block={block}
            assetManager={assetManager}
            onViewImage={onViewImage}
          />
        </div>
      );

    case "caption":
      return (
        <div className="parsed-standalone-caption" data-block-id={block.id}>
          <ControlledContentRenderer
            content={getRenderableBlockContent(block)}
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
