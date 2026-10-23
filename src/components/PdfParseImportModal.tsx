import React, { useEffect, useState } from "react";
import {
  ParseProvider,
  ParseSettings,
  parseProviderLabel,
} from "../types/parserService";
import "./PdfParseFlow.css";

export interface PdfParseImportModalProps {
  isOpen: boolean;
  filePath: string;
  fileName: string;
  settings: ParseSettings | null;
  submitting: boolean;
  /** 提交失败的明确错误（不改变面板中的选择） */
  errorMessage?: string | null;
  onClose: () => void;
  onOpenProviderSettings: (provider: ParseProvider) => void;
  onSubmit: (options: { provider: ParseProvider; openAfter: boolean }) => void;
}

/**
 * “导入 PDF 并解析”确认面板：
 * - 只显示文件名、厂家、该厂家配置状态与上传提示；
 * - 关闭或取消不会产生任务与上传；
 * - 缺少凭据时只能前往设置，保存后返回本面板，不自动提交。
 */
export default function PdfParseImportModal({
  isOpen,
  filePath,
  fileName,
  settings,
  submitting,
  errorMessage,
  onClose,
  onOpenProviderSettings,
  onSubmit,
}: PdfParseImportModalProps): React.JSX.Element | null {
  const [provider, setProvider] = useState<ParseProvider>("mineru");
  const [openAfter, setOpenAfter] = useState(true);

  // 每次换文件或重新打开时复位，避免沿用上一次的选择
  useEffect(() => {
    if (!isOpen) return;
    setProvider(settings?.default_provider ?? "mineru");
    setOpenAfter(true);
  }, [isOpen, filePath, settings?.default_provider]);

  // Esc 关闭：未提交时关闭面板不会产生任务与上传
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !submitting) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const configured =
    settings?.providers?.find((p) => p.provider === provider)?.credential_configured === true;
  const providerName = parseProviderLabel(provider);
  const canSubmit = configured && !submitting;

  return (
    <div className="settings-modal-overlay" onClick={submitting ? undefined : onClose}>
      <div
        className="parse-modal-card parse-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入 PDF 并解析"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">导入 PDF 并解析</h2>
            <span className="settings-modal-subtitle">使用云端解析服务生成无纸化重排版本</span>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            disabled={submitting}
            title="关闭 (Esc)"
          >
            ×
          </button>
        </div>

        <div className="parse-modal-body">
          <div className="parse-file-block">
            <span className="parse-field-label">文件</span>
            <div className="parse-file-name" title={filePath}>
              {fileName}
            </div>
            <div className="parse-file-path">{filePath}</div>
          </div>

          <div className="parse-field-block">
            <span className="parse-field-label">解析服务商</span>
            <select
              className="parse-select"
              aria-label="解析服务商"
              value={provider}
              disabled={submitting}
              onChange={(e) => setProvider(e.target.value as ParseProvider)}
            >
              <option value="mineru">MinerU (API Token)</option>
              <option value="datalab">Datalab Convert (API Key)</option>
            </select>
            <span
              className={`parse-status-pill ${configured ? "is-configured" : "is-empty"}`}
              data-testid="import-credential-status"
            >
              {configured
                ? `${providerName}（${provider === "datalab" ? "API Key" : "API Token"}）：已配置（未验证）`
                : `${providerName}（${provider === "datalab" ? "API Key" : "API Token"}）：尚未配置凭据`}
            </span>
          </div>

          {!configured && (
            <div className="parse-warning-box">
              <div>该服务商还没有保存凭据，无法提交解析任务。</div>
              <button
                type="button"
                className="settings-btn settings-btn-secondary parse-btn-small"
                onClick={() => onOpenProviderSettings(provider)}
              >
                前往配置 {providerName}（{provider === "datalab" ? "API Key" : "API Token"}）
              </button>
            </div>
          )}

          <label className="parse-checkbox-row">
            <input
              type="checkbox"
              checked={openAfter}
              disabled={submitting}
              onChange={(e) => setOpenAfter(e.target.checked)}
            />
            <span>完成后打开流式重排</span>
          </label>

          <div className="parse-upload-notice">
            文件将上传到所选解析服务商（{providerName}）进行云端解析，请确认内容适合发送给第三方服务。
          </div>

          {errorMessage && <div className="parse-error-text">{errorMessage}</div>}
        </div>

        <div className="parse-modal-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={() => onSubmit({ provider, openAfter })}
            disabled={!canSubmit}
            title={!configured ? "请先配置该服务商凭据" : undefined}
          >
            {submitting ? "正在提交…" : "上传并解析"}
          </button>
        </div>
      </div>
    </div>
  );
}
