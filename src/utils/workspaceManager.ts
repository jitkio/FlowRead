/**
 * FlowRead - 工作区文件与目录管理器 (Workspace Manager)
 * 采用本地持久化存储，支持内部文件与文件夹的层级树、新建、重命名、删除及剪切/粘贴移动
 */

export type WorkspaceItemType = "folder" | "file";

export interface WorkspaceFileMeta {
  path?: string; // 本地物理磁盘绝对路径（若有）
  sizeBytes?: number;
  extension?: "pdf" | "txt" | "md" | "epub" | string;
}

export interface WorkspaceNode {
  id: string;
  name: string;
  type: WorkspaceItemType;
  parentId: string | null; // null 表示处于工作区根目录
  fileMeta?: WorkspaceFileMeta;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "flowread_workspace_nodes_v1";

export const DEFAULT_WORKSPACE_NODES: WorkspaceNode[] = [
  {
    id: "folder_default",
    name: "默认文件夹",
    type: "folder",
    parentId: null,
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000 * 3,
  },
  {
    id: "folder_math",
    name: "数学与工程",
    type: "folder",
    parentId: null,
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 86400000 * 2,
  },
  {
    id: "folder_ai",
    name: "人工智能前沿",
    type: "folder",
    parentId: null,
    createdAt: Date.now() - 86400000 * 1,
    updatedAt: Date.now() - 86400000 * 1,
  },
  {
    id: "file_sample_txt",
    name: "在流动中沉思：重新发现数字时代的深度阅读之美.txt",
    type: "file",
    parentId: "folder_default",
    fileMeta: {
      path: "flowread://default_reading_intro",
      extension: "txt",
      sizeBytes: 12400,
    },
    createdAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now() - 86400000 * 3,
  },
  {
    id: "file_math_sample",
    name: "矩阵分析与形式化推导指南.pdf",
    type: "file",
    parentId: "folder_math",
    fileMeta: {
      extension: "pdf",
      sizeBytes: 3450000,
    },
    createdAt: Date.now() - 86400000 * 2,
    updatedAt: Date.now() - 86400000 * 2,
  },
  {
    id: "file_ai_sample",
    name: "视觉语言大模型架构与切片剖析.md",
    type: "file",
    parentId: "folder_ai",
    fileMeta: {
      extension: "md",
      sizeBytes: 45600,
    },
    createdAt: Date.now() - 86400000 * 1,
    updatedAt: Date.now() - 86400000 * 1,
  },
];

/**
 * 读取当前持久化的工作区节点列表
 */
export function loadWorkspaceNodes(): WorkspaceNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      saveWorkspaceNodes(DEFAULT_WORKSPACE_NODES);
      return DEFAULT_WORKSPACE_NODES;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((n) => {
        if ((n.id === "file_sample_txt" || n.name?.includes("在流动中沉思")) && !n.fileMeta?.path) {
          return {
            ...n,
            fileMeta: {
              ...n.fileMeta,
              path: "flowread://default_reading_intro",
              extension: "txt",
            },
          };
        }
        return n;
      });
    }
    return DEFAULT_WORKSPACE_NODES;
  } catch (err) {
    console.warn("[workspaceManager] 读取节点失败，采用默认值:", err);
    return DEFAULT_WORKSPACE_NODES;
  }
}

/**
 * 保存工作区节点列表至本地存储
 */
export function saveWorkspaceNodes(nodes: WorkspaceNode[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
  } catch (err) {
    console.error("[workspaceManager] 保存节点失败:", err);
  }
}

/**
 * 获取顶层文件夹列表（用于顶部工作区下拉菜单展示，最多 3 个）
 */
export function getTopLevelFolders(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return nodes
    .filter((n) => n.type === "folder" && n.parentId === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 递归获取目标文件夹下的所有子节点 ID
 */
export function getDescendantIds(nodes: WorkspaceNode[], folderId: string): string[] {
  const result: string[] = [];
  const queue: string[] = [folderId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = nodes.filter((n) => n.parentId === currentId);
    for (const child of children) {
      result.push(child.id);
      if (child.type === "folder") {
        queue.push(child.id);
      }
    }
  }

  return result;
}

/**
 * 格式化文件大小为易读字符串
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}
