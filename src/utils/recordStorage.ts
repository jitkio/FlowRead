/**
 * FlowRead - 持久化记录存储前端客户端封装
 * 对接 Rust SQLite 与 AppData Assets 引擎
 */

import { invoke } from "@tauri-apps/api/core";
import {
  DocumentRecord,
  CardRecord,
  SourceAnchorRecord,
  SourceLocationData,
  FullCardDetail,
  HighlightRecord,
  CardTurnRecord,
  CardListResponse,
  ReadingPreferences,
  CardAction,
  CardDepth,
  CardStatus,
} from "../types/records";
import { loadGlobalPreferences } from "./themeManager";

export async function apiGetOrCreateDocument(
  filePath: string,
  displayName: string,
  fileSize: number,
  revision?: string
): Promise<DocumentRecord> {
  return await invoke<DocumentRecord>("db_get_or_create_document", {
    filePath,
    displayName,
    fileSize,
    revision: revision || "",
  });
}

export async function apiSaveReadingPosition(
  documentId: string,
  positionJson: string
): Promise<void> {
  await invoke("db_save_reading_position", { documentId, positionJson });
}

export async function apiSaveReadingPreferences(
  documentId: string,
  preferences: ReadingPreferences
): Promise<void> {
  await invoke("db_save_reading_preferences", {
    documentId,
    preferencesJson: JSON.stringify(preferences),
  });
}

export async function apiGetReadingPreferences(
  documentId: string
): Promise<ReadingPreferences> {
  const globalPrefs = loadGlobalPreferences();
  try {
    const raw = await invoke<string | null>("db_get_reading_preferences", {
      documentId,
    });
    if (!raw) return globalPrefs;
    const docParsed = JSON.parse(raw);
    // 新书继承全局设置，文档排版覆盖不能覆盖全局翻译、模型或提示词设置
    return {
      ...globalPrefs,
      ...docParsed,
      translateLanguage: globalPrefs.translateLanguage,
    };
  } catch {
    return globalPrefs;
  }
}

/**
 * 将二进制图像切片保存为应用资产文件，返回 assetId
 */
export async function apiSaveImageAsset(
  documentId: string,
  fileName: string,
  data: Uint8Array | number[],
  mimeType: string = "image/jpeg"
): Promise<string> {
  const byteArr = data instanceof Uint8Array ? Array.from(data) : data;
  return await invoke<string>("db_save_asset", {
    documentId,
    fileName,
    data: byteArr,
    mimeType,
  });
}

/**
 * 将 Base64 图片保存为资产
 */
export async function apiSaveBase64Image(
  documentId: string,
  fileName: string,
  base64DataUrl: string
): Promise<string> {
  const parts = base64DataUrl.split(",");
  const base64Str = parts.length > 1 ? parts[1] : parts[0];
  const mimeMatch = base64DataUrl.match(/data:([^;]+);/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const binaryStr = atob(base64Str);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return await apiSaveImageAsset(documentId, fileName, bytes, mimeType);
}

/**
 * 获取资产字节流并转为可展示的 ObjectURL 或 Data URL
 * 采用严格容量限制 (LRU 30 项) 与 URL.revokeObjectURL 防内存泄漏
 */
const MAX_ASSET_CACHE_SIZE = 30;
const assetUrlCache = new Map<string, string>();

export async function apiGetAssetData(
  assetId: string
): Promise<{ mime_type: string; data: number[] }> {
  return await invoke<{ mime_type: string; data: number[] }>("db_get_asset_data", { assetId });
}

export async function apiGetAssetDataUrl(assetId: string): Promise<string> {
  const asset = await apiGetAssetData(assetId);
  const uint8 = new Uint8Array(asset.data);
  let binary = "";
  const len = uint8.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = uint8.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  const mime = asset.mime_type || "image/jpeg";
  return `data:${mime};base64,${btoa(binary)}`;
}

export async function apiGetAssetUrl(assetId: string): Promise<string> {
  if (assetUrlCache.has(assetId)) {
    const url = assetUrlCache.get(assetId)!;
    // 刷新 LRU 位置
    assetUrlCache.delete(assetId);
    assetUrlCache.set(assetId, url);
    return url;
  }

  const asset = await apiGetAssetData(assetId);
  const uint8 = new Uint8Array(asset.data);
  const blob = new Blob([uint8], { type: asset.mime_type || "image/jpeg" });
  const url = URL.createObjectURL(blob);

  // 超过容量上限时释放最久未使用的 ObjectURL
  if (assetUrlCache.size >= MAX_ASSET_CACHE_SIZE) {
    const oldestKey = assetUrlCache.keys().next().value;
    if (oldestKey) {
      const oldUrl = assetUrlCache.get(oldestKey);
      if (oldUrl) {
        URL.revokeObjectURL(oldUrl);
      }
      assetUrlCache.delete(oldestKey);
    }
  }

  assetUrlCache.set(assetId, url);
  return url;
}

export function apiRevokeAssetUrl(assetId: string): void {
  const url = assetUrlCache.get(assetId);
  if (url) {
    URL.revokeObjectURL(url);
    assetUrlCache.delete(assetId);
  }
}

export function apiClearAssetUrlCache(): void {
  for (const url of assetUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  assetUrlCache.clear();
}

export async function apiCreateAnchor(
  documentId: string,
  documentRevision: string,
  locationData: SourceLocationData,
  excerpt: string
): Promise<string> {
  return await invoke<string>("db_create_anchor", {
    documentId,
    documentRevision,
    sourceType: locationData.type,
    excerpt,
    locationJson: JSON.stringify(locationData),
  });
}

export async function apiGetAnchors(
  documentId: string
): Promise<SourceAnchorRecord[]> {
  return await invoke<SourceAnchorRecord[]>("db_get_anchors", { documentId });
}

export async function apiCreateCard(params: {
  documentId: string;
  anchorId: string | null;
  action: CardAction;
  depth: CardDepth;
  status: CardStatus;
  userPrompt: string;
  aiResponse: string;
  modelName: string;
}): Promise<string> {
  return await invoke<string>("db_create_card", {
    documentId: params.documentId,
    anchorId: params.anchorId,
    action: params.action,
    depth: params.depth,
    status: params.status,
    userPrompt: params.userPrompt,
    aiResponse: params.aiResponse,
    modelName: params.modelName,
  });
}

export async function apiUpdateCardStream(
  cardId: string,
  aiResponse: string,
  status: CardStatus,
  errorMessage?: string | null
): Promise<void> {
  await invoke("db_update_card_stream", {
    cardId,
    aiResponse,
    status,
    errorMessage: errorMessage || null,
  });
}

export async function apiCreateCardTurn(
  cardId: string,
  userPrompt: string,
  turnId?: string,
  status?: string
): Promise<string> {
  return await invoke<string>("db_create_card_turn", {
    cardId,
    userPrompt,
    turnId: turnId || null,
    status: status || "queued",
  });
}

export async function apiUpdateCardTurnStream(
  turnId: string,
  aiResponse: string,
  status: string
): Promise<void> {
  await invoke("db_update_card_turn_stream", {
    turnId,
    aiResponse,
    status,
  });
}

export async function apiSaveCardTurn(
  cardId: string,
  userPrompt: string,
  aiResponse: string,
  status: string = "completed"
): Promise<string> {
  return await invoke<string>("db_save_card_turn", {
    cardId,
    userPrompt,
    aiResponse,
    status,
  });
}

export async function apiAllocateFunctionVersion(
  cardId: string,
  mode: string
): Promise<number> {
  return await invoke<number>("db_allocate_function_version", {
    cardId,
    mode,
  });
}

export async function apiSaveFunctionResult(
  cardId: string,
  mode: string,
  resultContent: string,
  configSignature?: string,
  version?: number
): Promise<string> {
  return await invoke<string>("db_save_function_result", {
    cardId,
    mode,
    resultContent,
    configSignature,
    version,
  });
}

export async function apiGetCards(
  documentId: string,
  limit: number = 50,
  offset: number = 0,
  filterType?: string,
  cursorCreatedAt?: number | null,
  cursorCardId?: string | null
): Promise<CardListResponse> {
  return await invoke<CardListResponse>("db_get_cards", {
    documentId,
    limit,
    offset,
    filterType: filterType || "all",
    cursorCreatedAt: cursorCreatedAt || null,
    cursorCardId: cursorCardId || null,
  });
}

export async function apiGetCardsByAnchorIds(
  documentId: string,
  anchorIds: string[]
): Promise<CardRecord[]> {
  if (!anchorIds || anchorIds.length === 0) return [];
  const res = await invoke<CardRecord[]>("db_get_cards_by_anchor_ids", {
    documentId,
    anchorIds,
  });
  return res || [];
}

export async function apiExportDocumentMarkdown(
  documentId: string
): Promise<string> {
  return await invoke<string>("db_export_document_markdown", {
    documentId,
  });
}

export async function apiGetCardDetail(cardId: string): Promise<FullCardDetail> {
  return await invoke<FullCardDetail>("db_get_card_detail", { cardId });
}

export async function apiGetCardTurns(cardId: string): Promise<CardTurnRecord[]> {
  const detail = await apiGetCardDetail(cardId);
  return detail.turns || [];
}

export async function apiDeleteCard(cardId: string): Promise<void> {
  await invoke("db_delete_card", { cardId });
}

export async function apiCreateHighlight(
  documentId: string,
  anchorId: string,
  color: string
): Promise<string> {
  return await invoke<string>("db_create_highlight", {
    documentId,
    anchorId,
    color,
  });
}

export async function apiGetHighlights(
  documentId: string
): Promise<HighlightRecord[]> {
  const res = await invoke<HighlightRecord[]>("db_get_highlights", { documentId });
  return res || [];
}

export async function apiDeleteHighlight(highlightId: string): Promise<void> {
  await invoke("db_delete_highlight", { highlightId });
}
