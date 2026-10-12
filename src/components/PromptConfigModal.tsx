import React, { useState, useEffect } from "react";
import { PromptConfig, resetPromptConfig } from "../utils/promptConfig";

export interface PromptConfigModalProps {
  isOpen: boolean;
  config: PromptConfig;
  onSave: (config: PromptConfig) => void;
  onClose: () => void;
}

type ActionTabKey = "translate" | "explain" | "extractFormula" | "analyzeChart" | "summarize";

interface ActionTabMeta {
  key: ActionTabKey;
  label: string;
  hint: string;
}

const ACTION_TABS: ActionTabMeta[] = [
  { key: "translate", label: "翻译 (Translate)", hint: "划选纯文本时的学术翻译规范" },
  { key: "explain", label: "解释 (Explain)", hint: "划选概念与原理时的深层原理解析" },
  { key: "extractFormula", label: "提取公式 (LaTeX)", hint: "图像或复杂文本的严格纯净 LaTeX 语法解析" },
  { key: "analyzeChart", label: "解析图表 (Vision)", hint: "Alt 框选电路、架构、曲线等图表剖析" },
  { key: "summarize", label: "浓缩提炼 (Summarize)", hint: "学术段落核心论点与关键要义高度提炼" },
];

export default function PromptConfigModal({
  isOpen,
  config: initialConfig,
  onSave,
  onClose,
}: PromptConfigModalProps): React.JSX.Element | null {
  const [globalPrompt, setGlobalPrompt] = useState(initialConfig.globalPrompt);
  const [translate, setTranslate] = useState(initialConfig.translate);
  const [explain, setExplain] = useState(initialConfig.explain);
  const [extractFormula, setExtractFormula] = useState(initialConfig.extractFormula);
  const [analyzeChart, setAnalyzeChart] = useState(initialConfig.analyzeChart);
  const [summarize, setSummarize] = useState(initialConfig.summarize);

  const [activeTab, setActiveTab] = useState<ActionTabKey>("translate");

  // 每次打开弹窗同步最新值
  useEffect(() => {
    if (isOpen) {
      setGlobalPrompt(initialConfig.globalPrompt);
      setTranslate(initialConfig.translate);
      setExplain(initialConfig.explain);
      setExtractFormula(initialConfig.extractFormula);
      setAnalyzeChart(initialConfig.analyzeChart);
      setSummarize(initialConfig.summarize);
      setActiveTab("translate");
    }
  }, [isOpen, initialConfig]);

  // 监听 Esc 快捷键关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent): void => {
    e.preventDefault();
    onSave({
      globalPrompt: globalPrompt.trim(),
      translate: translate.trim(),
      explain: explain.trim(),
      extractFormula: extractFormula.trim(),
      analyzeChart: analyzeChart.trim(),
      summarize: summarize.trim(),
    });
    onClose();
  };

  const handleReset = (): void => {
    const defaultConfig = resetPromptConfig();
    setGlobalPrompt(defaultConfig.globalPrompt);
    setTranslate(defaultConfig.translate);
    setExplain(defaultConfig.explain);
    setExtractFormula(defaultConfig.extractFormula);
    setAnalyzeChart(defaultConfig.analyzeChart);
    setSummarize(defaultConfig.summarize);
  };

  const getActivePromptValue = (): string => {
    switch (activeTab) {
      case "translate":
        return translate;
      case "explain":
        return explain;
      case "extractFormula":
        return extractFormula;
      case "analyzeChart":
        return analyzeChart;
      case "summarize":
        return summarize;
    }
  };

  const setActivePromptValue = (val: string): void => {
    switch (activeTab) {
      case "translate":
        setTranslate(val);
        break;
      case "explain":
        setExplain(val);
        break;
      case "extractFormula":
        setExtractFormula(val);
        break;
      case "analyzeChart":
        setAnalyzeChart(val);
        break;
      case "summarize":
        setSummarize(val);
        break;
    }
  };

  const activeTabMeta = ACTION_TABS.find((t) => t.key === activeTab)!;

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="settings-modal-card prompt-config-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">提示词工程配置 (Prompt Config)</h2>
            <span className="settings-modal-subtitle">管理全局规范约束与内置动作提示词</span>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            title="关闭窗口 (Esc)"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSave} className="settings-modal-form prompt-modal-form">
          {/* 全局前置提示词 (Global Prompt) */}
          <div className="settings-form-field">
            <label className="settings-field-label">
              <span>全局前置提示词 (Global Prompt)</span>
              <span className="settings-label-hint">用于设定输出规范、LaTeX 格式等，将自动注入所有指令前置</span>
            </label>
            <textarea
              className="settings-field-textarea"
              rows={3}
              value={globalPrompt}
              onChange={(e) => setGlobalPrompt(e.target.value)}
              placeholder="例如：涉及逻辑推导与数学公式时，必须严格使用标准 LaTeX 语法..."
              required
            />
          </div>

          {/* 五大动作提示词切换 Tab */}
          <div className="prompt-actions-container">
            <label className="settings-field-label">
              <span>内置动作独立提示词配置</span>
              <span className="settings-label-hint">{activeTabMeta.hint}</span>
            </label>

            <div className="prompt-tabs-bar">
              {ACTION_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`prompt-tab-btn ${activeTab === tab.key ? "is-active" : ""}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="prompt-tab-content">
              <textarea
                className="settings-field-textarea prompt-action-textarea"
                rows={6}
                value={getActivePromptValue()}
                onChange={(e) => setActivePromptValue(e.target.value)}
                placeholder={`请输入 ${activeTabMeta.label} 动作的 System Prompt...`}
                required
              />
            </div>
          </div>

          <div className="settings-modal-footer">
            <button
              type="button"
              className="settings-btn settings-btn-subtle"
              onClick={handleReset}
            >
              恢复官方预设
            </button>
            <div className="settings-footer-actions">
              <button
                type="button"
                className="settings-btn settings-btn-secondary"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="submit"
                className="settings-btn settings-btn-primary"
              >
                保存配置
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
