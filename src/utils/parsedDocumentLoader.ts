/**
 * FlowRead - 解析结果加载器与资产生命周期管理 (阶段 2A 原型)
 */

import { invoke } from "@tauri-apps/api/core";
import {
  ParsedBlock,
  ParsedBlockType,
  ParsedDocument,
  ParsedDocumentStats,
  ParsedDocumentValidationResult,
} from "../types/parsedDocument";

const MAX_PROTOTYPE_BLOCKS = 2000;

/**
 * 结构块类型归一化映射
 */
export function normalizeBlockType(rawType: unknown): ParsedBlockType {
  if (typeof rawType !== "string") return "unknown";
  const s = rawType.trim().toLowerCase();

  if (s === "paragraph" || s === "text") return "paragraph";
  if (s === "heading" || s === "title" || s.startsWith("heading_")) return "heading";
  if (s === "formula" || s === "equation" || s === "equation_interline") return "formula";
  if (s === "image" || s === "figure" || s === "chart" || s === "diagram") return "image";
  if (s === "table") return "table";
  if (s === "caption" || s === "figure_caption" || s === "chart_caption") return "caption";
  if (s === "page_header" || s === "pageheader") return "page_header";
  if (s === "page_number" || s === "pagefooter" || s === "footer") return "page_number";

  return "unknown";
}

/**
 * 校验并标准化 blocks.json 原始输入
 * 运行时防御性检查，不假定输入数据结构 100% 完整合法
 */
export function validateParsedBlocks(
  rawInput: unknown,
  filePath: string,
  sessionId: string,
  docDir: string,
  hasAssets: boolean
): ParsedDocumentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stats: ParsedDocumentStats = {
    totalBlocks: 0,
    renderableBlocks: 0,
    paragraphCount: 0,
    headingCount: 0,
    formulaCount: 0,
    imageCount: 0,
    tableCount: 0,
    captionCount: 0,
    pageHeaderFooterCount: 0,
    unknownCount: 0,
  };

  if (!Array.isArray(rawInput)) {
    errors.push("解析结果根结构必须为包含结构块的 JSON 数组 (Array)");
    return { valid: false, errors, warnings, stats };
  }

  if (rawInput.length === 0) {
    warnings.push("解析结果中结构块数组为空");
  }

  if (rawInput.length > MAX_PROTOTYPE_BLOCKS) {
    errors.push(
      `文档包含 ${rawInput.length} 个结构块，超出当前只读原型承载范围 (上限 ${MAX_PROTOTYPE_BLOCKS} 块)`
    );
    return { valid: false, errors, warnings, stats };
  }

  const validBlocks: ParsedBlock[] = [];

  for (let idx = 0; idx < rawInput.length; idx++) {
    const raw = rawInput[idx];
    if (!raw || typeof raw !== "object") {
      warnings.push(`第 ${idx + 1} 块不是合法的 JSON 对象，已跳过`);
      continue;
    }

    const item = raw as Record<string, unknown>;
    const blockId =
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : `parsed_blk_${String(idx + 1).padStart(4, "0")}`;

    const normalizedType = normalizeBlockType(item.type || item.raw_type);
    const rawTypeStr = typeof item.raw_type === "string" ? item.raw_type : String(item.type || "");

    const content = typeof item.content === "string" ? item.content : "";
    let contentFormat =
      typeof item.content_format === "string" ? item.content_format : "markdown";

    if (normalizedType === "formula" && !item.content_format) {
      contentFormat = "latex";
    }

    // 校验坐标系：严格为 [x0, y0, x1, y1]
    let normalizedBbox: [number, number, number, number] | null = null;
    if (
      Array.isArray(item.normalized_bbox) &&
      item.normalized_bbox.length === 4 &&
      item.normalized_bbox.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      normalizedBbox = [
        item.normalized_bbox[0],
        item.normalized_bbox[1],
        item.normalized_bbox[2],
        item.normalized_bbox[3],
      ];
    }

    // 校验内联 runs
    const inlineRuns = Array.isArray(item.inline_runs)
      ? item.inline_runs
          .filter((r) => r && typeof r === "object")
          .map((r) => ({
            type: typeof (r as any).type === "string" ? (r as any).type : "text",
            content: typeof (r as any).content === "string" ? (r as any).content : "",
          }))
      : undefined;

    // 校验图片与图注
    const assetRef = typeof item.asset_ref === "string" && item.asset_ref.trim() ? item.asset_ref.trim() : null;
    const caption = typeof item.caption === "string" && item.caption.trim() ? item.caption.trim() : null;
    const inImageText = Array.isArray(item.in_image_text)
      ? item.in_image_text.filter((t): t is string => typeof t === "string")
      : undefined;

    // 结构统计
    stats.totalBlocks++;
    if (normalizedType === "paragraph") stats.paragraphCount++;
    else if (normalizedType === "heading") stats.headingCount++;
    else if (normalizedType === "formula") stats.formulaCount++;
    else if (normalizedType === "image") stats.imageCount++;
    else if (normalizedType === "table") stats.tableCount++;
    else if (normalizedType === "caption") stats.captionCount++;
    else if (normalizedType === "page_header" || normalizedType === "page_number") {
      stats.pageHeaderFooterCount++;
    } else {
      stats.unknownCount++;
    }

    if (normalizedType !== "page_header" && normalizedType !== "page_number") {
      stats.renderableBlocks++;
    }

    validBlocks.push({
      id: blockId,
      server_id: typeof item.server_id === "string" ? item.server_id : null,
      type: normalizedType,
      raw_type: rawTypeStr || null,
      reading_order: typeof item.reading_order === "number" ? item.reading_order : idx + 1,
      content,
      content_format: contentFormat,
      inline_runs: inlineRuns,
      asset_ref: assetRef,
      caption,
      in_image_text: inImageText,
      page_sample: typeof item.page_sample === "number" ? item.page_sample : undefined,
      page_source: typeof item.page_source === "number" ? item.page_source : undefined,
      raw_bbox: Array.isArray(item.raw_bbox) ? (item.raw_bbox as number[]) : null,
      normalized_bbox: normalizedBbox,
      pt_bbox: Array.isArray(item.pt_bbox) ? (item.pt_bbox as number[]) : null,
      coordinate_system: typeof item.coordinate_system === "string" ? item.coordinate_system : undefined,
      raw_node: item.raw_node,
    });
  }

  const fileName = filePath.replace(/\\/g, "/").split("/").pop() || "blocks.json";

  const document: ParsedDocument = {
    version: "parsed_preview_v1",
    sessionId,
    filePath,
    fileName,
    docDir,
    hasAssets,
    blocks: validBlocks,
  };

  return {
    valid: errors.length === 0,
    document,
    errors,
    warnings,
    stats,
  };
}

/**
 * 资产管理器：负责会话内图片按需加载、Blob URL 创建与释放
 */
export class ParsedAssetManager {
  private sessionId: string;
  private urlCache = new Map<string, string>();
  private inFlight = new Map<string, Promise<string | null>>();
  private disposed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public isSessionDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 按需读取图片资产二进制并生成 Blob URL
   */
  public async loadAsset(assetRef: string): Promise<string | null> {
    if (this.disposed || !assetRef) return null;

    if (this.urlCache.has(assetRef)) {
      return this.urlCache.get(assetRef)!;
    }

    if (this.inFlight.has(assetRef)) {
      return this.inFlight.get(assetRef)!;
    }

    const promise = (async () => {
      try {
        const bytes = await invoke<number[] | Uint8Array>("parsed_preview_read_asset", {
          sessionId: this.sessionId,
          assetRef,
        });

        if (this.disposed) return null;
        if (!bytes || (bytes as any).length === 0) return null;

        const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const mimeType = this.detectMimeType(assetRef);
        const blob = new Blob([uint8.buffer as ArrayBuffer], { type: mimeType });
        const url = URL.createObjectURL(blob);

        if (this.disposed) {
          URL.revokeObjectURL(url);
          return null;
        }

        this.urlCache.set(assetRef, url);
        return url;
      } catch (err) {
        console.warn(`[ParsedAssetManager] 加载资产失败 (${assetRef}):`, err);
        return null;
      } finally {
        this.inFlight.delete(assetRef);
      }
    })();

    this.inFlight.set(assetRef, promise);
    return promise;
  }

  private detectMimeType(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
  }

  /**
   * 彻底释放会话内所有已创建的 Blob URL 并通知 Rust 端注销
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const url of this.urlCache.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    this.urlCache.clear();
    this.inFlight.clear();

    if (this.sessionId) {
      invoke("parsed_preview_close", { sessionId: this.sessionId }).catch(() => {
        // 忽略关闭时的清理异常
      });
    }
  }
}

/**
 * 文档加载器单例/包装函数，具备切书竞态保护
 */
export class ParsedDocumentLoader {
  private activeLoadId = 0;

  /**
   * 打开并校验 blocks.json
   */
  public async loadDocument(
    filePath: string
  ): Promise<{ result: ParsedDocumentValidationResult; assetManager: ParsedAssetManager } | null> {
    const currentId = ++this.activeLoadId;

    try {
      const info = await invoke<{
        session_id: string;
        blocks_path: string;
        doc_dir: string;
        raw_json: string;
        has_assets: boolean;
      }>("parsed_preview_open", { path: filePath });

      // 竞态守卫：若加载期间已被后续打开请求打断，直接丢弃迟到结果并释放 Rust 会话
      if (currentId !== this.activeLoadId) {
        if (info.session_id) {
          invoke("parsed_preview_close", { sessionId: info.session_id }).catch(() => {});
        }
        return null;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(info.raw_json);
      } catch (jsonErr: any) {
        const stats: ParsedDocumentStats = {
          totalBlocks: 0,
          renderableBlocks: 0,
          paragraphCount: 0,
          headingCount: 0,
          formulaCount: 0,
          imageCount: 0,
          tableCount: 0,
          captionCount: 0,
          pageHeaderFooterCount: 0,
          unknownCount: 0,
        };
        const failResult: ParsedDocumentValidationResult = {
          valid: false,
          errors: [`JSON 语法解析失败: ${jsonErr?.message || jsonErr}`],
          warnings: [],
          stats,
        };
        const assetMgr = new ParsedAssetManager(info.session_id);
        return { result: failResult, assetManager: assetMgr };
      }

      const valResult = validateParsedBlocks(
        parsedJson,
        info.blocks_path,
        info.session_id,
        info.doc_dir,
        info.has_assets
      );

      const assetMgr = new ParsedAssetManager(info.session_id);
      return { result: valResult, assetManager: assetMgr };
    } catch (err: any) {
      if (currentId !== this.activeLoadId) return null;

      const stats: ParsedDocumentStats = {
        totalBlocks: 0,
        renderableBlocks: 0,
        paragraphCount: 0,
        headingCount: 0,
        formulaCount: 0,
        imageCount: 0,
        tableCount: 0,
        captionCount: 0,
        pageHeaderFooterCount: 0,
        unknownCount: 0,
      };

      const failResult: ParsedDocumentValidationResult = {
        valid: false,
        errors: [`读取解析文件失败: ${err?.message || String(err)}`],
        warnings: [],
        stats,
      };

      return { result: failResult, assetManager: new ParsedAssetManager("") };
    }
  }

  public cancelActiveLoad(): void {
    this.activeLoadId++;
  }
}
