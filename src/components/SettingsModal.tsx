import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ModelProfile,
  MAX_MODEL_PROFILES,
  loadModelProfiles,
  saveModelProfiles,
  loadActiveProfileId,
  saveActiveProfileId,
  getActiveModelProfile,
  createNewModelProfile,
} from "../utils/aiConfig";

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onActiveProfileChange?: (activeProfile: ModelProfile) => void;
  /** 兼容旧接口传参 */
  config?: ModelProfile;
  onSave?: (config: ModelProfile) => void;
}

export default function ModelConfigModal({
  isOpen,
  onClose,
  onActiveProfileChange,
  onSave,
}: SettingsModalProps): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");

  // 表单编辑字段状态
  const [formProfileName, setFormProfileName] = useState<string>("");
  const [formBaseUrl, setFormBaseUrl] = useState<string>("");
  const [formApiKey, setFormApiKey] = useState<string>("");
  const [formModelName, setFormModelName] = useState<string>("");
  const [showKey, setShowKey] = useState<boolean>(false);
  const [saveStatusText, setSaveStatusText] = useState<string>("");

  const saveTimerRef = useRef<number | null>(null);

  // 初始化与打开时同步
  useEffect(() => {
    if (isOpen) {
      const loadedProfiles = loadModelProfiles();
      const currentActiveId = loadActiveProfileId();
      setProfiles(loadedProfiles);
      setActiveProfileId(currentActiveId);

      // 默认选中当前生效的 Profile 进行查看/编辑
      const initialSelected =
        loadedProfiles.find((p) => p.id === currentActiveId) || loadedProfiles[0];

      if (initialSelected) {
        setSelectedProfileId(initialSelected.id);
        setFormProfileName(initialSelected.profileName);
        setFormBaseUrl(initialSelected.baseUrl);
        setFormApiKey(initialSelected.apiKey);
        setFormModelName(initialSelected.modelName);
      }
      setShowKey(false);
      setSaveStatusText("");
    }
  }, [isOpen]);

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

  // 显示临时保存状态
  const flashSaveStatus = (msg: string): void => {
    setSaveStatusText(msg);
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      setSaveStatusText("");
    }, 2000);
  };

  /**
   * 将当前表单的编辑内容持久化至状态与 localStorage
   */
  const commitCurrentForm = useCallback(
    (targetId = selectedProfileId): void => {
      if (!targetId) return;

      setProfiles((prevProfiles) => {
        const next = prevProfiles.map((p) => {
          if (p.id === targetId) {
            return {
              ...p,
              profileName: formProfileName.trim() || p.profileName,
              baseUrl: formBaseUrl.trim(),
              apiKey: formApiKey.trim(),
              modelName: formModelName.trim(),
            };
          }
          return p;
        });

        saveModelProfiles(next);

        // 如果保存的是当前活跃生效的 Profile，同步通知外部
        if (targetId === activeProfileId) {
          const updatedActive = next.find((p) => p.id === targetId);
          if (updatedActive) {
            onActiveProfileChange?.(updatedActive);
            onSave?.(updatedActive);
          }
        }

        return next;
      });
      flashSaveStatus("✓ 已保存");
    },
    [selectedProfileId, formProfileName, formBaseUrl, formApiKey, formModelName, activeProfileId, onActiveProfileChange, onSave]
  );

  /**
   * 切换左侧列表选中的 Profile
   */
  const handleSelectProfile = (profile: ModelProfile): void => {
    if (profile.id === selectedProfileId) return;
    // 切换前自动保存旧表单内容
    commitCurrentForm(selectedProfileId);

    // 载入新选中项的数据
    setSelectedProfileId(profile.id);
    setFormProfileName(profile.profileName);
    setFormBaseUrl(profile.baseUrl);
    setFormApiKey(profile.apiKey);
    setFormModelName(profile.modelName);
    setShowKey(false);
  };

  /**
   * 切换活跃生效的 Profile (通过 Radio 单选框或“设为生效”按钮)
   */
  const handleSetActive = (id: string, e?: React.MouseEvent | React.ChangeEvent): void => {
    if (e) {
      e.stopPropagation();
    }
    commitCurrentForm(selectedProfileId);

    setActiveProfileId(id);
    saveActiveProfileId(id);

    const target = profiles.find((p) => p.id === id);
    if (target) {
      onActiveProfileChange?.(target);
      onSave?.(target);
      flashSaveStatus(`已激活: ${target.profileName}`);
    }
  };

  /**
   * 添加新配置项 (最多 5 个)
   */
  const handleAddProfile = (): void => {
    if (profiles.length >= MAX_MODEL_PROFILES) return;
    // 先提交当前表单
    commitCurrentForm(selectedProfileId);

    const newProfile = createNewModelProfile(profiles);
    if (!newProfile) return;

    const nextProfiles = [...profiles, newProfile];
    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);

    // 选中新配置项
    setSelectedProfileId(newProfile.id);
    setFormProfileName(newProfile.profileName);
    setFormBaseUrl(newProfile.baseUrl);
    setFormApiKey(newProfile.apiKey);
    setFormModelName(newProfile.modelName);
    setShowKey(false);
    flashSaveStatus("已新建配置项");
  };

  /**
   * 删除指定配置项
   */
  const handleDeleteProfile = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation();
    if (profiles.length <= 1) {
      alert("请至少保留一个模型配置项。");
      return;
    }

    const nextProfiles = profiles.filter((p) => p.id !== id);
    setProfiles(nextProfiles);
    saveModelProfiles(nextProfiles);

    // 如果删除的是当前活跃项，重置活跃项为列表第一项
    let newActiveId = activeProfileId;
    if (activeProfileId === id) {
      newActiveId = nextProfiles[0].id;
      setActiveProfileId(newActiveId);
      saveActiveProfileId(newActiveId);
      onActiveProfileChange?.(nextProfiles[0]);
      onSave?.(nextProfiles[0]);
    }

    // 如果删除的是当前查看的项，更新查看项为第一项
    if (selectedProfileId === id) {
      const fallback = nextProfiles[0];
      setSelectedProfileId(fallback.id);
      setFormProfileName(fallback.profileName);
      setFormBaseUrl(fallback.baseUrl);
      setFormApiKey(fallback.apiKey);
      setFormModelName(fallback.modelName);
    }
    flashSaveStatus("已删除配置项");
  };

  if (!isOpen) return null;

  const currentSelectedProfile =
    profiles.find((p) => p.id === selectedProfileId) || profiles[0];
  const isCurrentActive = selectedProfileId === activeProfileId;
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || getActiveModelProfile();

  return (
    <div className="settings-modal-overlay" onClick={() => {
      commitCurrentForm(selectedProfileId);
      onClose();
    }}>
      <div
        className="model-config-modal-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 顶部标题区 */}
        <div className="settings-modal-header">
          <div className="settings-modal-title-group">
            <h2 className="settings-modal-title">模型配置 (Model Config)</h2>
            <span className="settings-modal-subtitle">
              多 Profile 本地鉴权管理 · 最多支持 5 个配置项
            </span>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={() => {
              commitCurrentForm(selectedProfileId);
              onClose();
            }}
            title="关闭窗口 (Esc)"
          >
            ×
          </button>
        </div>

        {/* 主体区：List + Detail 结构 */}
        <div className="model-config-modal-body">
          {/* 左侧：Profile 列表区 */}
          <aside className="model-config-sidebar">
            <div className="model-config-list-header">
              <span className="sidebar-section-title">配置列表</span>
              <span className="sidebar-count-badge">
                {profiles.length} / {MAX_MODEL_PROFILES}
              </span>
            </div>

            <div className="model-config-profile-list">
              {profiles.map((item) => {
                const isActive = item.id === activeProfileId;
                const isSelected = item.id === selectedProfileId;
                return (
                  <div
                    key={item.id}
                    className={`model-profile-list-item ${isSelected ? "is-selected" : ""} ${
                      isActive ? "is-active" : ""
                    }`}
                    onClick={() => handleSelectProfile(item)}
                    title={`点击编辑: ${item.profileName}`}
                  >
                    <label
                      className="profile-radio-wrapper"
                      onClick={(e) => e.stopPropagation()}
                      title={isActive ? "当前生效中" : "单选以设为生效配置"}
                    >
                      <input
                        type="radio"
                        name="activeModelProfileRadio"
                        checked={isActive}
                        onChange={(e) => handleSetActive(item.id, e)}
                        className="profile-radio-input"
                      />
                    </label>

                    <div className="profile-item-info">
                      <span className="profile-item-name">{item.profileName}</span>
                      {isActive && <span className="profile-active-tag">生效</span>}
                    </div>

                    {profiles.length > 1 && (
                      <button
                        type="button"
                        className="profile-delete-btn"
                        onClick={(e) => handleDeleteProfile(item.id, e)}
                        title="删除此配置"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="model-config-sidebar-footer">
              <button
                type="button"
                className="add-profile-btn"
                onClick={handleAddProfile}
                disabled={profiles.length >= MAX_MODEL_PROFILES}
                title={
                  profiles.length >= MAX_MODEL_PROFILES
                    ? "已达 5 个配置项上限"
                    : "添加新模型配置"
                }
              >
                + 添加配置
              </button>
            </div>
          </aside>

          {/* 右侧：Profile 详情编辑表单区 */}
          <main className="model-config-detail-view">
            {currentSelectedProfile ? (
              <form
                className="model-config-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  commitCurrentForm(selectedProfileId);
                }}
              >
                <div className="detail-view-header">
                  <div className="detail-title-group">
                    <span className="detail-title">{currentSelectedProfile.profileName}</span>
                    {isCurrentActive ? (
                      <span className="detail-status-pill is-active">● 当前生效中</span>
                    ) : (
                      <button
                        type="button"
                        className="detail-activate-btn"
                        onClick={() => handleSetActive(selectedProfileId)}
                      >
                        设为当前生效
                      </button>
                    )}
                  </div>
                  {saveStatusText && (
                    <span className="detail-save-feedback">{saveStatusText}</span>
                  )}
                </div>

                {/* 1. 配置名称 (Profile Name) */}
                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>配置名称 (Profile Name)</span>
                    <span className="settings-label-hint">用于识别与切换，如 DeepSeek / GPT-4o</span>
                  </label>
                  <input
                    type="text"
                    className="settings-field-input"
                    value={formProfileName}
                    onChange={(e) => setFormProfileName(e.target.value)}
                    onBlur={() => commitCurrentForm(selectedProfileId)}
                    placeholder="配置一"
                    maxLength={24}
                    required
                  />
                </div>

                {/* 2. Base URL */}
                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>Base URL</span>
                    <span className="settings-label-hint">API 端点 (含 /chat/completions)</span>
                  </label>
                  <input
                    type="text"
                    className="settings-field-input settings-field-mono"
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    onBlur={() => commitCurrentForm(selectedProfileId)}
                    placeholder="https://api.deepseek.com/chat/completions"
                  />
                </div>

                {/* 3. API Key */}
                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>API Key (密钥)</span>
                    <button
                      type="button"
                      className="settings-key-toggle-btn"
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? "隐藏密钥" : "显示密钥"}
                    </button>
                  </label>
                  <input
                    type={showKey ? "text" : "password"}
                    className="settings-field-input settings-field-mono"
                    value={formApiKey}
                    onChange={(e) => setFormApiKey(e.target.value)}
                    onBlur={() => commitCurrentForm(selectedProfileId)}
                    placeholder="sk-..."
                  />
                </div>

                {/* 4. Model Name */}
                <div className="settings-form-field">
                  <label className="settings-field-label">
                    <span>模型名称 (Model Name)</span>
                    <span className="settings-label-hint">如 deepseek-chat, gpt-4o, qwen-max 等</span>
                  </label>
                  <input
                    type="text"
                    className="settings-field-input settings-field-mono"
                    value={formModelName}
                    onChange={(e) => setFormModelName(e.target.value)}
                    onBlur={() => commitCurrentForm(selectedProfileId)}
                    placeholder="deepseek-chat"
                  />
                </div>

                <div className="model-config-form-actions">
                  <span className="auto-save-tip">编辑内容在失去焦点时自动保存</span>
                  <button
                    type="submit"
                    className="settings-btn settings-btn-primary"
                  >
                    保存配置
                  </button>
                </div>
              </form>
            ) : (
              <div className="model-config-empty-state">
                <span>请在左侧选择或添加配置项</span>
              </div>
            )}
          </main>
        </div>

        {/* 底部通用状态与关闭栏 */}
        <div className="model-config-modal-footer">
          <div className="footer-active-status">
            <span className="footer-indicator-dot" />
            <span className="footer-status-label">生效配置:</span>
            <span className="footer-status-name">
              {activeProfile?.profileName || "未指定"}
            </span>
          </div>

          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            onClick={() => {
              commitCurrentForm(selectedProfileId);
              onClose();
            }}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
