/**
 * FlowRead - 隐式重排阅读状态持久化（独立存储键，不覆盖旧阅读/伴读配置）
 *
 * 记录两类信息：
 * 1. 按 document_id 记住用户选择的视图模式（original / reflow）；
 * 2. 按 document_id + source_revision + version_id 记住重排视图的滚动位置。
 *
 * 位置写入使用节流/防抖 + 显式 flush（切书、卸载时调用），
 * 不依赖 beforeunload，也不做持续 scrollTop 回写。
 */

export type ParsedViewMode = "original" | "reflow";

export const PARSED_READING_STORAGE_KEY = "flowread_parsed_reading_state_v1";

const STORE_VERSION = 1;
const MAX_POSITION_ENTRIES = 200;
const MAX_MODE_ENTRIES = 200;

interface PositionEntry {
  top: number;
  updated_at: number;
}

interface ParsedReadingStateStore {
  version: number;
  modes: Record<string, ParsedViewMode>;
  positions: Record<string, PositionEntry>;
}

export interface ReflowPositionSnapshot {
  documentId: string;
  revision: string;
  versionId: string;
  scrollTop: number;
}

function emptyStore(): ParsedReadingStateStore {
  return { version: STORE_VERSION, modes: {}, positions: {} };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 读取整份状态；损坏或版本不符时返回空结构，不抛错 */
export function loadParsedReadingState(): ParsedReadingStateStore {
  try {
    const raw = localStorage.getItem(PARSED_READING_STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Partial<ParsedReadingStateStore> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== STORE_VERSION) {
      return emptyStore();
    }
    const modes: Record<string, ParsedViewMode> = {};
    const positions: Record<string, PositionEntry> = {};

    if (parsed.modes && typeof parsed.modes === "object") {
      for (const [key, value] of Object.entries(parsed.modes)) {
        if (value === "original" || value === "reflow") {
          modes[key] = value;
        }
      }
    }
    if (parsed.positions && typeof parsed.positions === "object") {
      for (const [key, value] of Object.entries(parsed.positions)) {
        if (value && isFiniteNumber((value as PositionEntry).top)) {
          positions[key] = {
            top: Math.max(0, (value as PositionEntry).top),
            updated_at: isFiniteNumber((value as PositionEntry).updated_at)
              ? (value as PositionEntry).updated_at
              : 0,
          };
        }
      }
    }
    return { version: STORE_VERSION, modes, positions };
  } catch {
    return emptyStore();
  }
}

function persist(state: ParsedReadingStateStore): void {
  try {
    localStorage.setItem(PARSED_READING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级：仅影响重启后的位置恢复，不影响当前阅读
  }
}

/** 只保留最近更新的若干条，避免无限增长 */
function prunePositions(state: ParsedReadingStateStore): void {
  const entries = Object.entries(state.positions);
  if (entries.length <= MAX_POSITION_ENTRIES) return;
  entries
    .sort((a, b) => a[1].updated_at - b[1].updated_at)
    .slice(0, entries.length - MAX_POSITION_ENTRIES)
    .forEach(([key]) => {
      delete state.positions[key];
    });
}

function pruneModes(state: ParsedReadingStateStore): void {
  const keys = Object.keys(state.modes);
  if (keys.length <= MAX_MODE_ENTRIES) return;
  for (const key of keys.slice(0, keys.length - MAX_MODE_ENTRIES)) {
    delete state.modes[key];
  }
}

export function getPreferredViewMode(documentId: string): ParsedViewMode | null {
  if (!documentId) return null;
  return loadParsedReadingState().modes[documentId] ?? null;
}

export function savePreferredViewMode(documentId: string, mode: ParsedViewMode): void {
  if (!documentId) return;
  const state = loadParsedReadingState();
  state.modes[documentId] = mode;
  pruneModes(state);
  persist(state);
}

/** 位置键：document_id + source_revision + version_id 严格隔离 */
export function buildReflowPositionKey(
  documentId: string,
  revision: string,
  versionId: string
): string {
  return `${documentId}:${revision || ""}:${versionId}`;
}

export function getReflowScrollTop(
  documentId: string,
  revision: string,
  versionId: string
): number | null {
  if (!documentId || !versionId) return null;
  const key = buildReflowPositionKey(documentId, revision, versionId);
  const entry = loadParsedReadingState().positions[key];
  return entry ? entry.top : null;
}

export function saveReflowScrollTop(
  documentId: string,
  revision: string,
  versionId: string,
  scrollTop: number
): void {
  if (!documentId || !versionId || !isFiniteNumber(scrollTop)) return;
  const state = loadParsedReadingState();
  const key = buildReflowPositionKey(documentId, revision, versionId);
  state.positions[key] = { top: Math.max(0, scrollTop), updated_at: Date.now() };
  prunePositions(state);
  persist(state);
}

/**
 * 滚动位置写入器：schedule 只保留最后一次快照并延迟落盘，flush 立即写入最后一次快照。
 * 快照里带有完整的文档身份，避免切书后把位置写到新书上。
 */
export function createReflowPositionWriter(delayMs = 400) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ReflowPositionSnapshot | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const snapshot = pending;
    pending = null;
    saveReflowScrollTop(
      snapshot.documentId,
      snapshot.revision,
      snapshot.versionId,
      snapshot.scrollTop
    );
  };

  const schedule = (snapshot: ReflowPositionSnapshot): void => {
    pending = snapshot;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return { schedule, flush, cancel };
}
