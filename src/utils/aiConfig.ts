/**
 * FlowRead - 模型配置 Profile 管理器 (Model Profile Manager)
 * 采用 localStorage 持久化存储，支持多 Profile (最多 5 个) 管理与动态切换
 */

export interface ModelProfile {
  id: string;
  profileName: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

// 向后兼容类型别名
export type AIConfig = ModelProfile;

export const FLOWREAD_MODEL_PROFILES_KEY = "FLOWREAD_MODEL_PROFILES";
export const FLOWREAD_ACTIVE_PROFILE_ID_KEY = "FLOWREAD_ACTIVE_PROFILE_ID";
export const MAX_MODEL_PROFILES = 5;

// 默认空初始配置（严禁保留或硬编码任何真实 API 密钥）
export const DEFAULT_EMPTY_PROFILE: ModelProfile = {
  id: "profile_default_1",
  profileName: "配置一",
  baseUrl: "",
  apiKey: "",
  modelName: "",
};

/**
 * 从 localStorage 读取所有模型配置 Profiles
 * 若无有效缓存，自动生成包含单一空配置的列表并持久化
 */
export function loadModelProfiles(): ModelProfile[] {
  try {
    const raw = localStorage.getItem(FLOWREAD_MODEL_PROFILES_KEY);
    if (!raw) {
      saveModelProfiles([DEFAULT_EMPTY_PROFILE]);
      return [DEFAULT_EMPTY_PROFILE];
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const sanitized: ModelProfile[] = parsed
        .slice(0, MAX_MODEL_PROFILES)
        .map((p, index) => ({
          id: typeof p.id === "string" && p.id.trim() ? p.id.trim() : `profile_${index + 1}`,
          profileName: typeof p.profileName === "string" && p.profileName.trim() ? p.profileName.trim() : `配置${index + 1}`,
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl.trim() : "",
          apiKey: typeof p.apiKey === "string" ? p.apiKey.trim() : "",
          modelName: typeof p.modelName === "string" ? p.modelName.trim() : "",
        }));
      return sanitized.length > 0 ? sanitized : [DEFAULT_EMPTY_PROFILE];
    }
    saveModelProfiles([DEFAULT_EMPTY_PROFILE]);
    return [DEFAULT_EMPTY_PROFILE];
  } catch (err) {
    console.warn("[aiConfig] 读取模型配置列表失败，初始化空列表:", err);
    saveModelProfiles([DEFAULT_EMPTY_PROFILE]);
    return [DEFAULT_EMPTY_PROFILE];
  }
}

/**
 * 将模型配置 Profiles 列表持久化至 localStorage (最多 5 个)
 */
export function saveModelProfiles(profiles: ModelProfile[]): void {
  try {
    const clamped = profiles.slice(0, MAX_MODEL_PROFILES);
    localStorage.setItem(FLOWREAD_MODEL_PROFILES_KEY, JSON.stringify(clamped));
  } catch (err) {
    console.error("[aiConfig] 保存模型配置列表失败:", err);
  }
}

/**
 * 读取当前正在启用的配置 ID
 */
export function loadActiveProfileId(): string {
  try {
    const activeId = localStorage.getItem(FLOWREAD_ACTIVE_PROFILE_ID_KEY);
    if (activeId && activeId.trim()) {
      return activeId.trim();
    }
  } catch (err) {
    console.warn("[aiConfig] 读取活跃配置 ID 失败:", err);
  }
  const profiles = loadModelProfiles();
  const fallbackId = profiles[0]?.id || DEFAULT_EMPTY_PROFILE.id;
  saveActiveProfileId(fallbackId);
  return fallbackId;
}

/**
 * 保存当前正在启用的配置 ID
 */
export function saveActiveProfileId(id: string): void {
  try {
    localStorage.setItem(FLOWREAD_ACTIVE_PROFILE_ID_KEY, id.trim());
  } catch (err) {
    console.error("[aiConfig] 保存活跃配置 ID 失败:", err);
  }
}

/**
 * 获取当前活跃生效的 ModelProfile
 */
export function getActiveModelProfile(): ModelProfile {
  const profiles = loadModelProfiles();
  const activeId = loadActiveProfileId();
  const found = profiles.find((p) => p.id === activeId);
  if (found) {
    return found;
  }
  if (profiles.length > 0) {
    saveActiveProfileId(profiles[0].id);
    return profiles[0];
  }
  return DEFAULT_EMPTY_PROFILE;
}

/**
 * 创建一个新的空白配置项
 */
export function createNewModelProfile(existingProfiles: ModelProfile[]): ModelProfile | null {
  if (existingProfiles.length >= MAX_MODEL_PROFILES) {
    return null;
  }
  const newIndex = existingProfiles.length + 1;
  return {
    id: `profile_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    profileName: `配置${newIndex}`,
    baseUrl: "",
    apiKey: "",
    modelName: "",
  };
}

/**
 * 兼容层：获取当前活跃 AI 配置
 */
export function loadAIConfig(): ModelProfile {
  return getActiveModelProfile();
}

/**
 * 兼容层：保存当前或指定 Profile
 */
export function saveAIConfig(profile: ModelProfile): void {
  const profiles = loadModelProfiles();
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index >= 0) {
    profiles[index] = profile;
    saveModelProfiles(profiles);
  } else if (profiles.length < MAX_MODEL_PROFILES) {
    profiles.push(profile);
    saveModelProfiles(profiles);
  }
}

/**
 * 兼容层：重置为空配置
 */
export function resetAIConfig(): ModelProfile {
  saveModelProfiles([DEFAULT_EMPTY_PROFILE]);
  saveActiveProfileId(DEFAULT_EMPTY_PROFILE.id);
  return DEFAULT_EMPTY_PROFILE;
}
