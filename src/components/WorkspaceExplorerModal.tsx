import React, { useState, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  WorkspaceNode,
  formatFileSize,
  formatTimestamp,
  getDescendantIds,
} from "../utils/workspaceManager";

export interface WorkspaceExplorerModalProps {
  isOpen: boolean;
  nodes: WorkspaceNode[];
  onSaveNodes: (nodes: WorkspaceNode[] | ((prev: WorkspaceNode[]) => WorkspaceNode[])) => void;
  onClose: () => void;
  onOpenFile: (filePath?: string, extension?: string, name?: string) => void;
  initialFolderId?: string | null;
}

export default function WorkspaceExplorerModal({
  isOpen,
  nodes,
  onSaveNodes,
  onClose,
  onOpenFile,
  initialFolderId = null,
}: WorkspaceExplorerModalProps): React.JSX.Element | null {
  // 当前所处的文件夹层级 (null 为根目录)
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(initialFolderId);
  // 当前选中的项目 ID
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // 剪切板状态（基础剪切/粘贴移动逻辑）
  const [clipboard, setClipboard] = useState<{ action: "cut"; nodeId: string } | null>(null);

  // 搜索关键字
  const [searchQuery, setSearchQuery] = useState<string>("");

  // 新建文件夹与重命名状态
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState<string>("");

  // 当弹窗打开或 initialFolderId 变化时重置
  useEffect(() => {
    if (isOpen) {
      setCurrentFolderId(initialFolderId);
      setSelectedNodeId(null);
      setSearchQuery("");
      setIsCreatingFolder(false);
      setRenamingNodeId(null);
    }
  }, [isOpen, initialFolderId]);

  // 监听 Esc 快捷键关闭（优先关闭弹窗并停止冒泡）
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // 当前文件夹节点
  const currentFolder = nodes.find((n) => n.id === currentFolderId && n.type === "folder");

  // 面包屑路径计算
  const breadcrumbs = useMemo<{ id: string | null; name: string }[]>(() => {
    const crumbs: { id: string | null; name: string }[] = [{ id: null, name: "工作区根目录" }];
    let curr = currentFolder;
    const pathStack: { id: string; name: string }[] = [];
    while (curr) {
      pathStack.unshift({ id: curr.id, name: curr.name });
      curr = nodes.find((n) => n.id === curr?.parentId && n.type === "folder");
    }
    return crumbs.concat(pathStack);
  }, [currentFolder, nodes]);

  // 当前目录下的直接子项目（按文件夹在前、文件在后，按名称排序）
  const displayedItems = useMemo(() => {
    let items = nodes.filter((n) => {
      if (searchQuery.trim()) {
        return n.name.toLowerCase().includes(searchQuery.toLowerCase().trim());
      }
      return n.parentId === currentFolderId;
    });

    return items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, [nodes, currentFolderId, searchQuery]);

  // 严格在所有 Hook 执行完毕后进行早退判断，避免 Hook 调用数量变化
  if (!isOpen) return null;

  // 选中的节点对象
  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  // 剪切节点对象
  const cutNode = clipboard ? nodes.find((n) => n.id === clipboard.nodeId) : null;

  /**
   * 向上返回上一级目录
   */
  const handleGoUp = (): void => {
    if (!currentFolder) return;
    setCurrentFolderId(currentFolder.parentId);
    setSelectedNodeId(null);
  };

  /**
   * 双击条目处理：文件夹则进入深层，文件则调用阅读器打开
   */
  const handleItemDoubleClick = (item: WorkspaceNode): void => {
    if (item.type === "folder") {
      setCurrentFolderId(item.id);
      setSelectedNodeId(null);
      setSearchQuery("");
    } else {
      let filePath = item.fileMeta?.path;
      if (!filePath && (item.id === "file_sample_txt" || item.name.includes("在流动中沉思"))) {
        filePath = "flowread://default_reading_intro";
      }
      onOpenFile(filePath, item.fileMeta?.extension, item.name);
      onClose();
    }
  };

  /**
   * 新建文件夹提交
   */
  const handleCreateFolderSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setIsCreatingFolder(false);
      return;
    }

    const newNode: WorkspaceNode = {
      id: `folder_${Date.now()}`,
      name: trimmed,
      type: "folder",
      parentId: currentFolderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    onSaveNodes((prev) => [...prev, newNode]);
    setNewFolderName("");
    setIsCreatingFolder(false);
    setSelectedNodeId(newNode.id);
  };

  /**
   * 导入本地物理文件到当前目录
   */
  const handleImportLocalFile = async (): Promise<void> => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "支持的文档 (*.pdf, *.txt, *.md, *.epub)",
            extensions: ["pdf", "txt", "md", "markdown", "epub"],
          },
        ],
      });

      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;

      const fileName = filePath.split(/[/\\]/).pop() || "未命名文档";
      const ext = fileName.split(".").pop()?.toLowerCase() || "txt";

      let sizeBytes = 0;
      try {
        const meta = await invoke<{ size: number }>("get_file_metadata", { path: filePath });
        sizeBytes = meta.size;
      } catch (err) {
        console.warn("[WorkspaceExplorer] 获取文件大小失败:", err);
      }

      const newFileNode: WorkspaceNode = {
        id: `file_${Date.now()}`,
        name: fileName,
        type: "file",
        parentId: currentFolderId,
        fileMeta: {
          path: filePath,
          extension: ext,
          sizeBytes,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      onSaveNodes((prev) => [...prev, newFileNode]);
      setSelectedNodeId(newFileNode.id);
    } catch (err) {
      console.error("[WorkspaceExplorer] 导入本地文件失败:", err);
    }
  };

  /**
   * 删除当前选中的项目（若为文件夹则递归清除其内部所有层级）
   */
  const handleDeleteSelected = (): void => {
    if (!selectedNode) return;
    const confirmed = window.confirm(
      `确定要从工作区移除「${selectedNode.name}」吗？（仅移除工作区登记，不会删除磁盘上的原始文件${
        selectedNode.type === "folder" ? "；文件夹内所有登记也将一并移除" : ""
      }）`
    );
    if (!confirmed) return;

    const idsToRemove = new Set<string>([selectedNode.id]);
    if (selectedNode.type === "folder") {
      const descIds = getDescendantIds(nodes, selectedNode.id);
      descIds.forEach((id) => idsToRemove.add(id));
    }

    onSaveNodes((prev) => prev.filter((n) => !idsToRemove.has(n.id)));
    setSelectedNodeId(null);
    if (clipboard?.nodeId && idsToRemove.has(clipboard.nodeId)) {
      setClipboard(null);
    }
  };

  /**
   * 开始重命名
   */
  const handleStartRename = (): void => {
    if (!selectedNode) return;
    setRenamingNodeId(selectedNode.id);
    setRenameInput(selectedNode.name);
  };

  /**
   * 提交重命名
   */
  const handleRenameSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!renamingNodeId) return;
    const trimmed = renameInput.trim();
    if (!trimmed) {
      setRenamingNodeId(null);
      return;
    }

    onSaveNodes((prev) =>
      prev.map((n) => {
        if (n.id === renamingNodeId) {
          return { ...n, name: trimmed, updatedAt: Date.now() };
        }
        return n;
      })
    );
    setRenamingNodeId(null);
  };

  /**
   * 剪切当前选中的项目
   */
  const handleCut = (): void => {
    if (!selectedNode) return;
    setClipboard({ action: "cut", nodeId: selectedNode.id });
  };

  /**
   * 粘贴当前剪切的项目至当前文件夹
   */
  const handlePaste = (): void => {
    if (!clipboard || !cutNode) return;

    // 防止将文件夹移动至自身或自身子目录下形成循环死锁
    if (cutNode.type === "folder") {
      if (currentFolderId === cutNode.id) {
        alert("不能将文件夹移动到自身内部！");
        return;
      }
      const descIds = getDescendantIds(nodes, cutNode.id);
      if (currentFolderId && descIds.includes(currentFolderId)) {
        alert("不能将文件夹移动到其自身的子文件夹中！");
        return;
      }
    }

    onSaveNodes((prev) =>
      prev.map((n) => {
        if (n.id === cutNode.id) {
          return {
            ...n,
            parentId: currentFolderId,
            updatedAt: Date.now(),
          };
        }
        return n;
      })
    );
    setClipboard(null);
    setSelectedNodeId(cutNode.id);
  };

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="settings-modal-card workspace-explorer-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 顶部标题栏 */}
        <div className="explorer-header">
          <div className="explorer-title-group">
            <span className="explorer-brand-tag">FLOWREAD</span>
            <h2 className="explorer-title">工作区管理器 (Workspace Explorer)</h2>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            ×
          </button>
        </div>

        {/* 资源管理器动作工具栏 */}
        <div className="explorer-toolbar">
          <div className="explorer-toolbar-left">
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={handleGoUp}
              disabled={!currentFolder}
              title="返回上一级目录"
            >
              ⇡ 向上
            </button>
            <div className="explorer-tool-divider" />
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={() => {
                setIsCreatingFolder(true);
                setNewFolderName("");
              }}
              title="在当前目录创建新文件夹"
            >
              + 新建文件夹
            </button>
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={() => void handleImportLocalFile()}
              title="导入本地物理文档到工作区"
            >
              + 导入文件
            </button>
            <div className="explorer-tool-divider" />
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={handleCut}
              disabled={!selectedNode}
              title="剪切选中的文件或文件夹"
            >
              ✂ 剪切
            </button>
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={handlePaste}
              disabled={!clipboard}
              title={clipboard ? `粘贴「${cutNode?.name}」到此处` : "剪切板为空"}
            >
              📋 粘贴
            </button>
            <button
              type="button"
              className="explorer-tool-btn"
              onClick={handleStartRename}
              disabled={!selectedNode}
              title="重命名选中的项目"
            >
              ✎ 重命名
            </button>
            <button
              type="button"
              className="explorer-tool-btn explorer-btn-danger"
              onClick={handleDeleteSelected}
              disabled={!selectedNode}
              title="彻底删除选中项目"
            >
              🗑 删除
            </button>
          </div>

          <div className="explorer-toolbar-right">
            <input
              type="text"
              className="explorer-search-input"
              placeholder="搜索工作区内部项目..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* 面包屑导航栏 */}
        <div className="explorer-breadcrumbs-bar">
          <span className="explorer-location-label">位置:</span>
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.id || "root"}>
              {idx > 0 && <span className="explorer-crumb-sep">/</span>}
              <button
                type="button"
                className={`explorer-crumb-btn ${idx === breadcrumbs.length - 1 ? "is-current" : ""}`}
                onClick={() => {
                  setCurrentFolderId(crumb.id);
                  setSelectedNodeId(null);
                }}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* 新建文件夹内嵌行 */}
        {isCreatingFolder && (
          <form onSubmit={handleCreateFolderSubmit} className="explorer-create-form">
            <span className="explorer-create-icon">[DIR]</span>
            <input
              type="text"
              className="explorer-create-input"
              placeholder="输入新文件夹名称并回车..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              autoFocus
            />
            <button type="submit" className="explorer-form-submit-btn">
              创建
            </button>
            <button
              type="button"
              className="explorer-form-cancel-btn"
              onClick={() => setIsCreatingFolder(false)}
            >
              取消
            </button>
          </form>
        )}

        {/* 核心文件列表视图 (List/Table View) */}
        <div className="explorer-list-container">
          <div className="explorer-list-header">
            <div className="explorer-col explorer-col-name">名称</div>
            <div className="explorer-col explorer-col-type">类型</div>
            <div className="explorer-col explorer-col-size">大小</div>
            <div className="explorer-col explorer-col-date">修改时间</div>
          </div>

          <div className="explorer-list-body">
            {displayedItems.length === 0 ? (
              <div className="explorer-empty-hint">
                <span>{searchQuery ? "未匹配到任何工作区项目" : "此文件夹为空，点击上方按钮新建或导入"}</span>
              </div>
            ) : (
              displayedItems.map((item) => {
                const isSelected = selectedNodeId === item.id;
                const isCut = clipboard?.nodeId === item.id;
                const isRenaming = renamingNodeId === item.id;

                const ext = item.fileMeta?.extension?.toUpperCase() || (item.type === "folder" ? "DIR" : "FILE");

                return (
                  <div
                    key={item.id}
                    className={`explorer-row ${isSelected ? "is-selected" : ""} ${isCut ? "is-cut" : ""}`}
                    onClick={() => setSelectedNodeId(item.id)}
                    onDoubleClick={() => handleItemDoubleClick(item)}
                  >
                    <div className="explorer-col explorer-col-name">
                      <span className={`explorer-type-tag tag-${ext.toLowerCase()}`}>
                        [{ext}]
                      </span>
                      {isRenaming ? (
                        <form onSubmit={handleRenameSubmit} className="explorer-inline-rename-form">
                          <input
                            type="text"
                            className="explorer-inline-rename-input"
                            value={renameInput}
                            onChange={(e) => setRenameInput(e.target.value)}
                            onBlur={() => setRenamingNodeId(null)}
                            autoFocus
                          />
                        </form>
                      ) : (
                        <span className="explorer-item-name-text" title={item.name}>
                          {item.name}
                        </span>
                      )}
                    </div>
                    <div className="explorer-col explorer-col-type">
                      {item.type === "folder" ? "文件夹" : `${ext} 文档`}
                    </div>
                    <div className="explorer-col explorer-col-size">
                      {formatFileSize(item.fileMeta?.sizeBytes)}
                    </div>
                    <div className="explorer-col explorer-col-date">
                      {formatTimestamp(item.updatedAt)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 底部微型状态栏 */}
        <div className="explorer-status-bar">
          <div className="explorer-status-left">
            <span>共 {displayedItems.length} 个项目</span>
            {selectedNode && <span>· 当前选中: {selectedNode.name}</span>}
          </div>
          <div className="explorer-status-right">
            {clipboard && cutNode && (
              <span className="explorer-clipboard-info">
                [剪切中: {cutNode.name}]
              </span>
            )}
            <span className="explorer-tip-text">提示: 双击进入文件夹或打开文档</span>
          </div>
        </div>
      </div>
    </div>
  );
}
