import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ParseProvider,
  ParseProviderStatus,
  ParseSettings,
  parseProviderLabel,
} from "../types/parserService";
import {
  apiParseProviderClearToken,
  apiParseProviderSetToken,
  apiParseSettingsGet,
  apiParseSettingsSave,
} from "../utils/parserService";
import "./PdfParseFlow.css";

export interface ParserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 设置变化后通知 App（默认厂家、凭据状态） */
  onSettingsChanged?: (settings: ParseSettings) => void;
  /** 从导入面板跳转过来时，聚焦对应厂家的输入框 */
  focusProvider?: ParseProvider | null;
}

interface ProviderFormState {
  token: string;
  showToken: boolean;
  saving: boolean;
  clearing: boolean;
  feedback: string;
  error: string;
}

function createFormState(): ProviderFormState {
  return {
    token: "",
    showToken: false,
    saving: false,
    clearing: false,
    feedback: "",
    error: "",
  };
}

const PROVIDER_ORDER: ParseProvider[] = ["mineru", "datalab"];

function providerHint(provider: ParseProvider): string {
  return provider === "datalab" ? "API Key" : "API Token";
}

/**
 * PDF 解析服务设置：MinerU 与 Datalab Convert 分别独立配置。
 * 说明：
 * - 已保存的 Token 绝不回填到前端，输入框只用于新增或替换；
 * - 保存成功仅表示“已配置”，不表示服务商已验证；
 * - 空输入不会清除已有凭据，清除必须使用独立的“清除”操作。
 */
export default function ParserSettingsModal({
  isOpen,
  onClose,
  onSettingsChanged,
  focusProvider = null,
}: ParserSettingsModalProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<ParseSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingDefault, setSavingDefault] = useState(false);
  const [forms, setForms] = useState<Record<ParseProvider, ProviderFormState>>({
    mineru: createFormState(),
    datalab: createFormState(),
  });

  const updateForm = useCallback(
    (provider: ParseProvider, patch: Partial<ProviderFormState>) => {
      setForms((prev) => ({
        ...prev,
        [provider]: { ...prev[provider], ...patch },
      }));
    },
    []
  );

  // 通过 ref 通知外部，避免父组件内联回调的身份变化导致下面的加载 effect 反复执行
  // （那会清空输入与保存反馈，并在每次父组件渲染时重复请求设置）
  const onSettingsChangedRef = useRef(onSettingsChanged);
  onSettingsChangedRef.current = onSettingsChanged;

  const applySettings = useCallback((next: ParseSettings) => {
    setSettings(next);
    onSettingsChangedRef.current?.(next);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    setForms({ mineru: createFormState(), datalab: createFormState() });

    apiParseSettingsGet()
      .then((next) => {
        if (!active) return;
        applySettings(next);
      })
      .catch((err: any) => {
        if (!active) return;
        setLoadError(err?.message ? String(err.message) : "读取解析服务设置失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, applySettings]);

  useEffect(() => {
    if (!isOpen || !focusProvider) return;
    const el = document.querySelector<HTMLInputElement>(
      `[data-provider-input="${focusProvider}"]`
    );
    el?.focus();
  }, [isOpen, focusProvider]);

  // Esc 关闭（不提交任何内容；已保存的凭据不受影响）
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

  const statusOf = (provider: ParseProvider): ParseProviderStatus | null =>
    settings?.providers?.find((p) => p.provider === provider) ?? null;

  const handleSaveToken = async (provider: ParseProvider): Promise<void> => {
    const token = forms[provider].token.trim();
    if (!token) {
      // 空输入不清除已有凭据，也不发起任何 IPC
      updateForm(provider, {
        feedback: "",
        error: "请输入 Token；空内容不会清除已保存的凭据。",
      });
      return;
    }

    updateForm(provider, { saving: true, error: "", feedback: "" });
    try {
      const result = await apiParseProviderSetToken(provider, token);
      if (!result || result.credential_configured !== true) {
        updateForm(provider, {
          saving: false,
          error: `${parseProviderLabel(provider)} 凭据未成功保存到系统凭据管理器`,
        });
        return;
      }
      if (settings) {
        const next: ParseSettings = {
          ...settings,
          providers: settings.providers.map((p) =>
            p.provider === result.provider ? { ...p, ...result } : p
          ),
        };
        applySettings(next);
      }
      updateForm(provider, {
        saving: false,
        token: "",
        showToken: false,
        feedback: "已保存，仅表示本机已配置，未向服务商验证。",
      });
    } catch (err: any) {
      updateForm(provider, {
        saving: false,
        error: err?.message ? String(err.message) : `${parseProviderLabel(provider)} 凭据保存失败`,
      });
    }
  };

  const handleClearToken = async (provider: ParseProvider): Promise<void> => {
    const name = parseProviderLabel(provider);
    if (!window.confirm(`确定清除 ${name} 已保存的凭据吗？清除后需要重新填写才能继续解析。`)) {
      return;
    }
    updateForm(provider, { clearing: true, error: "", feedback: "" });
    try {
      const result = await apiParseProviderClearToken(provider);
      if (settings) {
        applySettings({
          ...settings,
          providers: settings.providers.map((p) =>
            p.provider === result.provider ? { ...p, ...result } : p
          ),
        });
      }
      updateForm(provider, { clearing: false, feedback: "已清除该厂家的本机凭据。" });
    } catch (err: any) {
      updateForm(provider, {
        clearing: false,
        error: err?.message ? String(err.message) : `${name} 凭据清除失败`,
      });
    }
  };

  const handleSelectDefault = async (provider: ParseProvider): Promise<void> => {
    if (!settings || settings.default_provider === provider || savingDefault) return;
    const previous = settings;
    setSettings({ ...settings, default_provider: provider });
    setSavingDefault(true);
    try {
      const next = await apiParseSettingsSave(provider);
      applySettings(next);
    } catch (err: any) {
      setSettings(previous);
      setLoadError(err?.message ? String(err.message) : "默认解析厂家保存失败");
    } finally {
      setSavingDefault(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div
        className="parse-modal-card parse-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="PDF 解析服务设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">PDF 解析服务设置</h2>
            <span className="settings-modal-subtitle">
              凭据仅保存在本机，由后台进程使用；前端不会读取已保存的 Token
            </span>
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

        <div className="parse-modal-body">
          {loading && <div className="parse-hint">正在读取设置…</div>}
          {loadError && <div className="parse-error-text">{loadError}</div>}

          <div className="parse-settings-default">
            <span className="parse-settings-label">默认解析厂家</span>
            <div className="parse-radio-group" role="radiogroup" aria-label="默认解析厂家">
              {PROVIDER_ORDER.map((provider) => (
                <label key={provider} className="parse-radio-item">
                  <input
                    type="radio"
                    name="parse-default-provider"
                    value={provider}
                    checked={settings?.default_provider === provider}
                    disabled={!settings || savingDefault}
                    onChange={() => void handleSelectDefault(provider)}
                  />
                  <span>{parseProviderLabel(provider)}</span>
                </label>
              ))}
            </div>
          </div>

          {PROVIDER_ORDER.map((provider) => {
            const status = statusOf(provider);
            const form = forms[provider];
            const configured = status?.credential_configured === true;
            const name = parseProviderLabel(provider);
            return (
              <section
                key={provider}
                className="parse-provider-section"
                aria-label={`${name} 凭据`}
              >
                <header className="parse-provider-header">
                  <span className="parse-provider-name">
                    {name}（{providerHint(provider)}）
                  </span>
                  <span
                    className={`parse-status-pill ${configured ? "is-configured" : "is-empty"}`}
                    data-testid={`credential-status-${provider}`}
                  >
                    {configured ? "已配置（未验证）" : "未配置"}
                  </span>
                </header>

                <label className="parse-field-label" htmlFor={`parse-token-${provider}`}>
                  {providerHint(provider)}
                </label>
                <div className="parse-token-row">
                  <input
                    id={`parse-token-${provider}`}
                    data-provider-input={provider}
                    className="parse-token-input"
                    type={form.showToken ? "text" : "password"}
                    value={form.token}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={configured ? "已保存，如需更换请粘贴新的凭据" : "粘贴凭据后保存"}
                    onChange={(e) => updateForm(provider, { token: e.target.value })}
                  />
                  <button
                    type="button"
                    className="parse-link-btn"
                    onClick={() => updateForm(provider, { showToken: !form.showToken })}
                  >
                    {form.showToken ? "隐藏" : "显示"}
                  </button>
                </div>

                <div className="parse-provider-actions">
                  <button
                    type="button"
                    className="settings-btn settings-btn-primary parse-btn-small"
                    onClick={() => void handleSaveToken(provider)}
                    disabled={form.saving || form.clearing}
                  >
                    {form.saving ? "保存中…" : configured ? "替换凭据" : "保存凭据"}
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-btn-secondary parse-btn-small"
                    onClick={() => void handleClearToken(provider)}
                    disabled={!configured || form.saving || form.clearing}
                    title={configured ? "清除该厂家本机凭据" : "当前没有可清除的凭据"}
                  >
                    {form.clearing ? "清除中…" : "清除"}
                  </button>
                </div>

                {form.feedback && <div className="parse-feedback-text">{form.feedback}</div>}
                {form.error && <div className="parse-error-text">{form.error}</div>}
              </section>
            );
          })}

          <div className="parse-footnote">
            保存成功只代表凭据已写入本机配置，不代表服务商已完成验证；实际可用性由解析任务的提交结果体现。
          </div>
        </div>

        <div className="parse-modal-footer">
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
