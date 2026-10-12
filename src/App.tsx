import React, { useState, useRef, useEffect, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ReaderArea from "./components/ReaderArea";
import PDFReaderArea, { PDFDocumentStats } from "./components/PDFReaderArea";
import AIPanel, { SelectionData } from "./components/AIPanel";
import ModelConfigModal from "./components/SettingsModal";
import PromptConfigModal from "./components/PromptConfigModal";
import WorkspaceExplorerModal from "./components/WorkspaceExplorerModal";
import { ModelProfile, loadAIConfig, saveAIConfig } from "./utils/aiConfig";
import { PromptConfig, loadPromptConfig, savePromptConfig } from "./utils/promptConfig";
import {
  WorkspaceNode,
  loadWorkspaceNodes,
  saveWorkspaceNodes,
  getTopLevelFolders,
} from "./utils/workspaceManager";
import "./App.css";

export default function App(): React.JSX.Element {
  // 协议状态：存储当前选中文本与用户所选指令动作
  const [selectionData, setSelectionData] = useState<SelectionData | null>(null);

  // 阅读器模式：支持纯文本/EPUB 模式 与 PDF 极简流式阅读模式
  const [readerMode, setReaderMode] = useState<"text" | "pdf">("text");
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [textFilePath, setTextFilePath] = useState<string | null>(null);

  // 缩放比例状态（默认 1.35x 高保真视角，由 Ctrl+滚轮 与 Ctrl+/- 动态控制）
  const [scale, setScale] = useState<number>(1.35);

  // PDF 文档统计与加载状态
  const [pdfStats, setPdfStats] = useState<PDFDocumentStats | null>(null);
  const [pdfIsLoading, setPdfIsLoading] = useState<boolean>(false);
  const [pdfStatusMessage, setPdfStatusMessage] = useState<string>("");
  const [pdfErrorMessage, setPdfErrorMessage] = useState<string | null>(null);

  // 纯文本文档统计
  const [textDocInfo, setTextDocInfo] = useState<{ title: string; paragraphs: number }>({
    title: "在流动中沉思：重新发现数字时代的深度阅读之美",
    paragraphs: 0,
  });

  // 菜单与工作区状态
  const [activeMenu, setActiveMenu] = useState<"workspace" | "tools" | "help" | null>(null);
  const menuBarRef = useRef<HTMLElement>(null);

  // 工作区节点持久化管理
  const [workspaceNodes, setWorkspaceNodes] = useState<WorkspaceNode[]>(() => loadWorkspaceNodes());
  const [isWorkspaceExplorerOpen, setIsWorkspaceExplorerOpen] = useState<boolean>(false);
  const [explorerInitialFolderId, setExplorerInitialFolderId] = useState<string | null>(null);

  // 模型配置 (Model Config) 模态框
  const [aiConfig, setAiConfig] = useState<ModelProfile>(() => loadAIConfig());
  const [isModelConfigOpen, setIsModelConfigOpen] = useState<boolean>(false);

  // 提示词工程 (Prompt Config) 模态框
  const [promptConfig, setPromptConfig] = useState<PromptConfig>(() => loadPromptConfig());
  const [isPromptConfigOpen, setIsPromptConfigOpen] = useState<boolean>(false);

  /**
   * 顶层文件夹列表（用于工作区下拉菜单，最多展示 3 个最近或顶层文件夹）
   */
  const topFolders = useMemo(() => {
    return getTopLevelFolders(workspaceNodes).slice(0, 3);
  }, [workspaceNodes]);

  /**
   * 监听全局外部点击以收起主菜单下拉栏
   */
  useEffect(() => {
    const handleGlobalPointerDown = (e: MouseEvent): void => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener("mousedown", handleGlobalPointerDown);
    return () => window.removeEventListener("mousedown", handleGlobalPointerDown);
  }, []);

  /**
   * 纯净缩放交互：Ctrl + 鼠标滚轮向上/向下调节比例
   */
  useEffect(() => {
    const handleWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY;
        setScale((prev) => {
          const step = 0.1;
          const next = delta < 0 ? prev + step : prev - step;
          return Math.min(3.0, Math.max(0.5, +next.toFixed(2)));
        });
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  /**
   * 全局快捷键监听 (Ctrl+O: 打开/导入文件, Ctrl+,: 模型配置, Ctrl+=/-: 缩放, Esc: 关闭菜单)
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "o") {
          e.preventDefault();
          void handleImportOrOpenFile();
        } else if (e.key === ",") {
          e.preventDefault();
          setIsModelConfigOpen(true);
        } else if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          setScale((s) => Math.min(3.0, +(s + 0.1).toFixed(2)));
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)));
        } else if (e.key === "0") {
          e.preventDefault();
          setScale(1.35);
        }
      } else if (e.key === "Escape") {
        setActiveMenu(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  /**
   * 接收来自划词悬浮菜单选择的数据并更新状态
   */
  const handleSelect = (data: SelectionData): void => {
    setSelectionData(data);
  };

  /**
   * 清空当前选中文本与指令数据
   */
  const handleClearSelection = (): void => {
    setSelectionData(null);
  };

  /**
   * 切换至 PDF 阅读器并载入指定文件
   */
  const handleOpenPdf = (filePath?: string): void => {
    if (filePath) {
      setPdfPath(filePath);
    }
    setReaderMode("pdf");
  };

  /**
   * 保存更新后的工作区节点
   */
  const handleSaveWorkspaceNodes = (newNodes: WorkspaceNode[]): void => {
    saveWorkspaceNodes(newNodes);
    setWorkspaceNodes(newNodes);
  };

  /**
   * 从工作区管理器中打开文件
   */
  const handleOpenFileFromExplorer = (filePath?: string, extension?: string, name?: string): void => {
    if (filePath) {
      const ext = (extension || filePath.split(".").pop() || "").toLowerCase();
      if (ext === "pdf") {
        setPdfPath(filePath);
        setReaderMode("pdf");
      } else {
        setTextFilePath(filePath);
        setReaderMode("text");
      }
    } else {
      // 预置默认虚拟文件处理
      if (extension === "pdf") {
        setReaderMode("pdf");
      } else {
        setReaderMode("text");
      }
      if (name) {
        setTextDocInfo((prev) => ({ ...prev, title: name }));
      }
    }
  };

  /**
   * 打开本地物理文件（自动 Import/登记至工作区根目录并即刻载入阅读）
   */
  const handleImportOrOpenFile = async (): Promise<void> => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "所有支持的文档 (*.pdf, *.txt, *.md, *.epub)",
            extensions: ["pdf", "txt", "md", "markdown", "epub"],
          },
          {
            name: "PDF 文档 (*.pdf)",
            extensions: ["pdf"],
          },
          {
            name: "纯文本与 Markdown (*.txt, *.md)",
            extensions: ["txt", "md", "markdown"],
          },
          {
            name: "EPUB 电子书 (*.epub)",
            extensions: ["epub"],
          },
        ],
      });

      if (!selected) return;

      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return;

      const fileName = filePath.split(/[/\\]/).pop() || "未命名文档";
      const ext = fileName.split(".").pop()?.toLowerCase() || "txt";

      // 登记入工作区节点（如果尚未存在）
      const exists = workspaceNodes.some((n) => n.fileMeta?.path === filePath);
      if (!exists) {
        const newNode: WorkspaceNode = {
          id: `file_${Date.now()}`,
          name: fileName,
          type: "file",
          parentId: null, // 放入顶层
          fileMeta: {
            path: filePath,
            extension: ext,
            sizeBytes: 1024 * 1024,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        handleSaveWorkspaceNodes([...workspaceNodes, newNode]);
      }

      if (ext === "pdf") {
        setPdfPath(filePath);
        setReaderMode("pdf");
      } else {
        setTextFilePath(filePath);
        setReaderMode("text");
      }
    } catch (err) {
      console.error("[FlowRead] 打开本地文档失败:", err);
    }
  };

  /**
   * 快速创建新文件夹（工作区下拉菜单触发）
   */
  const handleQuickCreateFolder = (): void => {
    const name = window.prompt("请输入新建文件夹名称：", "新建文件夹");
    if (name && name.trim()) {
      const newFolder: WorkspaceNode = {
        id: `folder_${Date.now()}`,
        name: name.trim(),
        type: "folder",
        parentId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      handleSaveWorkspaceNodes([...workspaceNodes, newFolder]);
    }
  };

  /**
   * 保存模型配置
   */
  const handleSaveAIConfig = (newConfig: ModelProfile): void => {
    saveAIConfig(newConfig);
    setAiConfig(newConfig);
  };

  /**
   * 保存提示词配置
   */
  const handleSavePromptConfig = (newPromptConfig: PromptConfig): void => {
    savePromptConfig(newPromptConfig);
    setPromptConfig(newPromptConfig);
  };

  return (
    <div className="app-container">
      {/* 顶层：VS Code 风格系统菜单栏 (Main Menu Bar - 34px) */}
      <header className="main-menu-bar" ref={menuBarRef}>
        <div className="menu-bar-left">
          <div className="app-brand-badge">
            <span className="brand-logo-text">FlowRead</span>
          </div>

          <div className="menu-items-group">
            {/* 1. 工作区 (Workspace) */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "workspace" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "workspace" ? null : "workspace"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("workspace");
                }}
              >
                工作区 (Workspace)
              </button>
              {activeMenu === "workspace" && (
                <div className="menu-dropdown-panel">
                  {/* 顶部固定项 */}
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      void handleImportOrOpenFile();
                    }}
                  >
                    <span>打开本地文件...</span>
                    <span className="menu-shortcut-hint">Ctrl+O</span>
                  </div>
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      handleQuickCreateFolder();
                    }}
                  >
                    <span>创建新文件夹...</span>
                    <span className="menu-shortcut-hint">+</span>
                  </div>

                  <div className="menu-dropdown-divider" />

                  {/* 动态展示区：最多展示 3 个最近或顶层文件夹，不展开深层 */}
                  <div className="menu-dropdown-section-header">顶层文件夹</div>
                  {topFolders.length === 0 ? (
                    <div className="menu-dropdown-item menu-empty-hint">
                      <span>暂无文件夹，待添加</span>
                    </div>
                  ) : (
                    topFolders.map((folder) => (
                      <div
                        key={folder.id}
                        className="menu-dropdown-item menu-folder-item"
                        onClick={() => {
                          setActiveMenu(null);
                          setExplorerInitialFolderId(folder.id);
                          setIsWorkspaceExplorerOpen(true);
                        }}
                        title={`进入「${folder.name}」目录管理`}
                      >
                        <div className="menu-folder-item-title">
                          <span className="menu-folder-prefix">[DIR]</span>
                          <span>{folder.name}</span>
                        </div>
                        <span className="menu-shortcut-hint">浏览 ⇢</span>
                      </div>
                    ))
                  )}

                  <div className="menu-dropdown-divider" />

                  {/* 底部固定项：打开工作区资源管理器 */}
                  <div
                    className="menu-dropdown-item menu-dropdown-highlight"
                    onClick={() => {
                      setActiveMenu(null);
                      setExplorerInitialFolderId(null);
                      setIsWorkspaceExplorerOpen(true);
                    }}
                  >
                    <span>打开工作区 (Open Workspace)</span>
                    <span className="menu-shortcut-hint">Explorer</span>
                  </div>
                </div>
              )}
            </div>

            {/* 2. 工具 (Tools) */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "tools" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "tools" ? null : "tools"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("tools");
                }}
              >
                工具 (Tools)
              </button>
              {activeMenu === "tools" && (
                <div className="menu-dropdown-panel">
                  {/* 模型配置 (Model Config) */}
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      setIsModelConfigOpen(true);
                    }}
                  >
                    <span>模型配置 (Model Config)...</span>
                    <span className="menu-shortcut-hint">Ctrl+,</span>
                  </div>

                  {/* 提示词工程配置 (Prompt Config) */}
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      setIsPromptConfigOpen(true);
                    }}
                  >
                    <span>提示词工程配置 (Prompt Config)...</span>
                    <span className="menu-shortcut-hint">Prompt</span>
                  </div>

                  <div className="menu-dropdown-divider" />

                  {readerMode === "pdf" ? (
                    <div
                      className="menu-dropdown-item"
                      onClick={() => {
                        setActiveMenu(null);
                        setReaderMode("text");
                      }}
                    >
                      <span>切换至纯文本 / Markdown 模式</span>
                    </div>
                  ) : (
                    <div
                      className="menu-dropdown-item"
                      onClick={() => {
                        setActiveMenu(null);
                        setReaderMode("pdf");
                      }}
                    >
                      <span>切换至 PDF 流式阅读模式</span>
                    </div>
                  )}
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      handleClearSelection();
                    }}
                  >
                    <span>清空当前选区与会话</span>
                    <span className="menu-shortcut-hint">Esc</span>
                  </div>
                </div>
              )}
            </div>

            {/* 3. 帮助 (Help) */}
            <div className="menu-item-wrapper">
              <button
                type="button"
                className={`menu-bar-btn ${activeMenu === "help" ? "is-active" : ""}`}
                onClick={() => setActiveMenu((prev) => (prev === "help" ? null : "help"))}
                onMouseEnter={() => {
                  if (activeMenu) setActiveMenu("help");
                }}
              >
                帮助 (Help)
              </button>
              {activeMenu === "help" && (
                <div className="menu-dropdown-panel">
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      alert(
                        "【FlowRead 极简交互与快捷键规范】\n\n" +
                          "1. 视口缩放：\n" +
                          "   - Ctrl + 鼠标滚轮向上/向下：动态调节缩放\n" +
                          "   - Ctrl + = / Ctrl + - ：快速放大/缩小\n" +
                          "   - Ctrl + 0 ：重置缩放为 135%\n\n" +
                          "2. 工作区与文档：\n" +
                          "   - Ctrl + O ：打开/导入本地文档 (PDF/TXT/MD/EPUB)\n" +
                          "   - 工作区菜单 -> 打开工作区 ：微型资源管理器管理文件与目录\n\n" +
                          "3. 模型与提示词：\n" +
                          "   - Ctrl + , ：模型配置中心 (Base URL / API Key / Model)\n" +
                          "   - 提示词工程配置 ：管理全局 LaTeX 前置规范与 5 大动作 Prompt\n\n" +
                          "4. 阅读交互：\n" +
                          "   - 划词伴读 ：选中即弹浮动工具栏，顶栏回车直接发送自定义 Prompt\n" +
                          "   - 多模态框选 ：Alt + 拖拽鼠标，截取图表交由 Vision AI 深度剖析"
                      );
                    }}
                  >
                    <span>快捷键与多模态指南...</span>
                    <span className="menu-shortcut-hint">?</span>
                  </div>
                  <div className="menu-dropdown-divider" />
                  <div
                    className="menu-dropdown-item"
                    onClick={() => {
                      setActiveMenu(null);
                      alert(
                        "FlowRead v0.2.0 - 工程化桌面学术阅读器\n\n" +
                          "· 架构体系：pdfjs-dist 原生渲染 + Rust FileByteSource 范围流式读取\n" +
                          "· 资源中心：弹窗式工作区资源管理器 (新建 / 删除 / 重命名 / 剪切移动)\n" +
                          "· 智能引擎：模型鉴权与提示词工程中心独立解耦\n" +
                          "· 纯净交互：Ctrl + Wheel 动力学缩放，零冗余按键"
                      );
                    }}
                  >
                    <span>关于 FlowRead (v0.2.0)</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="menu-bar-right">
          <span className="menu-active-workspace-tag">
            工作区节点: {workspaceNodes.length} 项
          </span>
        </div>
      </header>

      {/* 核心工作区：中间阅读区 (70%) + 右侧 AI 面板 (30%) */}
      <div className="app-workspace">
        {readerMode === "text" ? (
          <ReaderArea
            onSelect={handleSelect}
            filePath={textFilePath}
            onOpenPdf={handleOpenPdf}
            onDocInfoChange={setTextDocInfo}
            scale={scale}
          />
        ) : (
          <PDFReaderArea
            filePath={pdfPath}
            scale={scale}
            onScaleChange={setScale}
            onStatsChange={setPdfStats}
            onLoadingChange={(loading, msg) => {
              setPdfIsLoading(loading);
              setPdfStatusMessage(msg);
            }}
            onErrorChange={setPdfErrorMessage}
            onClose={() => setReaderMode("text")}
            onSelect={handleSelect}
          />
        )}

        {/* 右侧 AI 助手面板 (已净化底部无用按钮) */}
        <AIPanel
          selectionData={selectionData}
          onClearSelection={handleClearSelection}
          aiConfig={aiConfig}
          promptConfig={promptConfig}
        />
      </div>

      {/* 全局底部状态栏 (Global Status Bar) - VS Code 极简冷色标准 (24px) */}
      <footer className="global-status-bar">
        {/* 左侧：文档参数纯文本紧凑排列 */}
        <div className="status-bar-left">
          {readerMode === "pdf" ? (
            pdfIsLoading ? (
              <div className="status-loading-indicator">
                <span className="status-loading-spinner" />
                <span className="status-loading-text">
                  {pdfStatusMessage || "正在按需解析 PDF 范围流..."}
                </span>
              </div>
            ) : pdfStats ? (
              <div className="status-stats-text">
                <span className="status-filename" title={pdfStats.filePath}>
                  {pdfStats.fileName}
                </span>
                <span className="status-separator">|</span>
                <span>{(pdfStats.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
                <span className="status-separator">|</span>
                <span>{pdfStats.totalPages} 页</span>
                <span className="status-separator">|</span>
                <span>{pdfStats.loadDurationMs} ms</span>
              </div>
            ) : (
              <span className="status-idle-text">未载入文档 · 点击“工作区” → “打开本地文件”开始阅读</span>
            )
          ) : (
            <div className="status-stats-text">
              <span className="status-filename">{textDocInfo.title}</span>
              <span className="status-separator">|</span>
              <span>{textDocInfo.paragraphs} 个段落</span>
              <span className="status-separator">|</span>
              <span>纯文本 / EPUB 解析</span>
            </div>
          )}

          {readerMode === "pdf" && pdfErrorMessage && (
            <span className="status-error-text">[{pdfErrorMessage}]</span>
          )}
        </div>

        {/* 中间：技术标签 (无边框，次级文字颜色) */}
        <div className="status-bar-center">
          {readerMode === "pdf" ? (
            <>
              <span className="status-badge-text">
                <span className="check-icon">✓</span> 页面级虚拟化
              </span>
              <span className="status-badge-text">
                <span className="check-icon">✓</span> 零内存泄漏
              </span>
              <span className="status-badge-text">
                <span className="check-icon">✓</span> DPR 高清采样
              </span>
            </>
          ) : (
            <>
              <span className="status-badge-text">
                <span className="check-icon">✓</span> 动力学平滑滚动
              </span>
              <span className="status-badge-text">
                <span className="check-icon">✓</span> 原生划词伴读
              </span>
            </>
          )}
        </div>

        {/* 右侧：纯净缩放交互 (仅保留当前比例的百分比纯文本) */}
        <div className="status-bar-right">
          <span
            className="status-zoom-percentage"
            title="Ctrl + 滚轮 或 Ctrl +/- 调节视口缩放"
          >
            {Math.round(scale * 100)}%
          </span>
        </div>
      </footer>

      {/* 工作区资源管理器模态框 (Workspace Explorer Modal) */}
      <WorkspaceExplorerModal
        isOpen={isWorkspaceExplorerOpen}
        nodes={workspaceNodes}
        onSaveNodes={handleSaveWorkspaceNodes}
        onClose={() => setIsWorkspaceExplorerOpen(false)}
        onOpenFile={handleOpenFileFromExplorer}
        initialFolderId={explorerInitialFolderId}
      />

      {/* 模型配置模态框 (Model Config Modal) */}
      <ModelConfigModal
        isOpen={isModelConfigOpen}
        config={aiConfig}
        onSave={handleSaveAIConfig}
        onActiveProfileChange={(activeProfile) => {
          setAiConfig(activeProfile);
        }}
        onClose={() => setIsModelConfigOpen(false)}
      />

      {/* 提示词工程配置模态框 (Prompt Config Modal) */}
      <PromptConfigModal
        isOpen={isPromptConfigOpen}
        config={promptConfig}
        onSave={handleSavePromptConfig}
        onClose={() => setIsPromptConfigOpen(false)}
      />
    </div>
  );
}
