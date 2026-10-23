use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use serde::{Deserialize, Serialize};
use rusqlite::Connection;
use crate::db;

pub const KEYRING_SERVICE: &str = "flowread_parse_provider";
pub const DEFAULT_PROVIDER_KEY: &str = "default_parse_provider";
pub const PROVIDER_MINERU: &str = "mineru";
pub const PROVIDER_DATALAB: &str = "datalab";

// ================= 凭据后端抽象 =================

/// 凭据读写后端。生产实现走操作系统凭据管理器；
/// 测试可替换为进程内实现，避免读写真实系统凭据。
pub trait CredentialBackend: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, token: &str) -> Result<(), String>;
    fn clear(&self, provider: &str) -> Result<(), String>;
}

/// Windows Credential Manager / macOS Keychain / Secret Service 实现。
/// 服务名可注入，便于用独立临时服务名做原生往返验证，避免触碰真实账户。
pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, provider: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, provider)
            .map_err(|e| format!("初始化系统凭据管理器失败 ({}): {}", provider, e))
    }
}

impl CredentialBackend for KeyringBackend {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        match self.entry(provider)?.get_password() {
            Ok(pw) => {
                let trimmed = pw.trim().to_string();
                if trimmed.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(trimmed))
                }
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取系统凭据失败 ({}): {}", provider, e)),
        }
    }

    fn set(&self, provider: &str, token: &str) -> Result<(), String> {
        let entry = self.entry(provider)?;
        entry
            .set_password(token)
            .map_err(|e| format!("保存系统凭据失败 ({}): {}", provider, e))?;

        // 保存后必须回读确认：不能仅凭写入调用返回 Ok 就向上报告“已配置”。
        match entry.get_password() {
            Ok(stored) if stored == token => Ok(()),
            Ok(_) => Err(format!(
                "系统凭据写入后回读不一致 ({}); 凭据未生效",
                provider
            )),
            Err(e) => Err(format!(
                "系统凭据写入后无法回读 ({}): {}",
                provider, e
            )),
        }
    }

    fn clear(&self, provider: &str) -> Result<(), String> {
        let entry = self.entry(provider)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("清除系统凭据失败 ({}): {}", provider, e)),
        }

        // 清除后回读确认，避免“命令成功但凭据仍在”的假成功。
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => Ok(()),
            Ok(_) => Err(format!("系统凭据清除后仍可读取 ({}); 请重试", provider)),
            Err(e) => Err(format!("系统凭据清除后无法确认状态 ({}): {}", provider, e)),
        }
    }
}

/// 进程内后端：仅用于自动化测试，绝不接触真实系统凭据。
#[derive(Default)]
pub struct InMemoryBackend {
    map: Mutex<HashMap<String, String>>,
}

impl CredentialBackend for InMemoryBackend {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        Ok(self.map.lock().unwrap().get(provider).cloned())
    }
    fn set(&self, provider: &str, token: &str) -> Result<(), String> {
        self.map
            .lock()
            .unwrap()
            .insert(provider.to_string(), token.to_string());
        Ok(())
    }
    fn clear(&self, provider: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(provider);
        Ok(())
    }
}

static ACTIVE_BACKEND: OnceLock<RwLock<Arc<dyn CredentialBackend>>> = OnceLock::new();

fn backend_cell() -> &'static RwLock<Arc<dyn CredentialBackend>> {
    ACTIVE_BACKEND.get_or_init(|| RwLock::new(Arc::new(KeyringBackend::new(KEYRING_SERVICE))))
}

fn active_backend() -> Arc<dyn CredentialBackend> {
    backend_cell().read().unwrap().clone()
}

/// 测试用：把全局后端切换为回填内存实现，并在 drop 时恢复。
/// 内部持有一把全局串行锁，避免并发用例互相污染。
#[cfg(test)]
pub struct TestCredentialGuard<'a> {
    _serial: std::sync::MutexGuard<'a, ()>,
    previous: Arc<dyn CredentialBackend>,
}

#[cfg(test)]
static CREDENTIAL_TEST_SERIAL: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub fn test_credential_store() -> TestCredentialGuard<'static> {
    let serial = CREDENTIAL_TEST_SERIAL
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let previous = active_backend();
    *backend_cell().write().unwrap() = Arc::new(InMemoryBackend::default());
    TestCredentialGuard {
        _serial: serial,
        previous,
    }
}

#[cfg(test)]
impl Drop for TestCredentialGuard<'_> {
    fn drop(&mut self) {
        *backend_cell().write().unwrap() = self.previous.clone();
    }
}

// ================= 基础校验 =================

pub fn validate_provider_name(provider: &str) -> Result<&'static str, String> {
    match provider.trim().to_ascii_lowercase().as_str() {
        PROVIDER_MINERU => Ok(PROVIDER_MINERU),
        PROVIDER_DATALAB => Ok(PROVIDER_DATALAB),
        other => Err(format!("不支持的解析服务商: '{}'，仅支持 'mineru' 与 'datalab'", other)),
    }
}

pub fn get_provider_display_name(provider: &str) -> &'static str {
    match provider {
        PROVIDER_MINERU => "MinerU",
        PROVIDER_DATALAB => "Datalab",
        _ => "Unknown",
    }
}

// ================= 凭据读写 =================

/// 读取 Token。`Ok(None)` 表示确实未配置；读取故障返回 `Err`，
/// 不能把“读取失败”伪装成“未配置”。
pub fn get_provider_token(provider: &str) -> Result<Option<String>, String> {
    let canonical = validate_provider_name(provider)?;
    active_backend().get(canonical)
}

pub fn set_provider_token(provider: &str, token: &str) -> Result<(), String> {
    let canonical = validate_provider_name(provider)?;
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token 不能为空；如需清除已配置 Token 请使用独立清除命令".to_string());
    }
    active_backend().set(canonical, trimmed)
}

pub fn clear_provider_token(provider: &str) -> Result<(), String> {
    let canonical = validate_provider_name(provider)?;
    active_backend().clear(canonical)
}

/// 是否已配置凭据。读取失败会向上传播，不会被当成“未配置”。
pub fn provider_credential_status(provider: &str) -> Result<bool, String> {
    Ok(get_provider_token(provider)?.is_some())
}

// ================= DTOs =================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderSettingDto {
    pub provider: String,
    pub display_name: String,
    pub credential_configured: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseSettingsResponse {
    pub default_provider: String,
    pub providers: Vec<ProviderSettingDto>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseSettingsSaveRequest {
    pub default_provider: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderTokenSetRequest {
    pub provider: String,
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderTokenClearRequest {
    pub provider: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProviderTokenResult {
    pub provider: String,
    pub display_name: String,
    pub credential_configured: bool,
}

// ================= Business Logics =================

pub fn get_settings_internal(conn: &Connection) -> Result<ParseSettingsResponse, String> {
    let default_provider = db::get_app_setting(conn, DEFAULT_PROVIDER_KEY)?
        .unwrap_or_else(|| PROVIDER_MINERU.to_string());

    let providers = vec![
        ProviderSettingDto {
            provider: PROVIDER_MINERU.to_string(),
            display_name: get_provider_display_name(PROVIDER_MINERU).to_string(),
            credential_configured: provider_credential_status(PROVIDER_MINERU)?,
        },
        ProviderSettingDto {
            provider: PROVIDER_DATALAB.to_string(),
            display_name: get_provider_display_name(PROVIDER_DATALAB).to_string(),
            credential_configured: provider_credential_status(PROVIDER_DATALAB)?,
        },
    ];

    Ok(ParseSettingsResponse {
        default_provider,
        providers,
    })
}

pub fn save_settings_internal(
    conn: &Connection,
    default_provider: &str,
) -> Result<ParseSettingsResponse, String> {
    let canonical = validate_provider_name(default_provider)?;
    db::set_app_setting(conn, DEFAULT_PROVIDER_KEY, canonical)?;
    get_settings_internal(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_name_validation() {
        assert_eq!(validate_provider_name("mineru").unwrap(), PROVIDER_MINERU);
        assert_eq!(validate_provider_name("MinerU  ").unwrap(), PROVIDER_MINERU);
        assert_eq!(validate_provider_name("datalab").unwrap(), PROVIDER_DATALAB);
        assert_eq!(validate_provider_name("  DataLab ").unwrap(), PROVIDER_DATALAB);
        assert!(validate_provider_name("unknown").is_err());
        assert!(validate_provider_name("").is_err());
    }

    #[test]
    fn test_credential_lifecycle_in_memory() {
        let _guard = test_credential_store();

        // 初始无 token
        assert!(!provider_credential_status("mineru").unwrap());
        assert!(!provider_credential_status("datalab").unwrap());

        // 空 token 报错
        assert!(set_provider_token("mineru", "").is_err());
        assert!(set_provider_token("mineru", "   ").is_err());

        // 设置 MinerU Token，写入后必须能回读
        set_provider_token("mineru", "test_mineru_secret_token").unwrap();
        assert!(provider_credential_status("mineru").unwrap());
        assert_eq!(
            get_provider_token("mineru").unwrap(),
            Some("test_mineru_secret_token".to_string())
        );

        // 设置 Datalab Token
        set_provider_token("datalab", "test_datalab_key").unwrap();
        assert!(provider_credential_status("datalab").unwrap());
        assert_eq!(
            get_provider_token("datalab").unwrap(),
            Some("test_datalab_key".to_string())
        );

        // 清除 MinerU Token 后确认不可读
        clear_provider_token("mineru").unwrap();
        assert!(!provider_credential_status("mineru").unwrap());
        assert_eq!(get_provider_token("mineru").unwrap(), None);

        // Datalab 仍保持配置
        assert!(provider_credential_status("datalab").unwrap());
    }

    #[test]
    fn test_settings_db_persistence() {
        let _guard = test_credential_store();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::run_migrations(&conn).unwrap();

        // 默认设置为 mineru
        let settings = get_settings_internal(&conn).unwrap();
        assert_eq!(settings.default_provider, "mineru");
        assert_eq!(settings.providers.len(), 2);
        assert_eq!(settings.providers[0].provider, "mineru");
        assert_eq!(settings.providers[1].provider, "datalab");

        // 修改默认设置为 datalab
        let updated = save_settings_internal(&conn, "datalab").unwrap();
        assert_eq!(updated.default_provider, "datalab");

        // 验证读取结果
        let reloaded = get_settings_internal(&conn).unwrap();
        assert_eq!(reloaded.default_provider, "datalab");

        // 非法设置拒绝
        assert!(save_settings_internal(&conn, "invalid_provider").is_err());
    }

    /// 读取故障不能被伪装成“未配置”
    #[test]
    fn test_read_failure_is_not_reported_as_unconfigured() {
        struct FailingBackend;
        impl CredentialBackend for FailingBackend {
            fn get(&self, _p: &str) -> Result<Option<String>, String> {
                Err("凭据库被锁定".to_string())
            }
            fn set(&self, _p: &str, _t: &str) -> Result<(), String> {
                Err("凭据库被锁定".to_string())
            }
            fn clear(&self, _p: &str) -> Result<(), String> {
                Err("凭据库被锁定".to_string())
            }
        }

        let _serial = super::CREDENTIAL_TEST_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = active_backend();
        *backend_cell().write().unwrap() = Arc::new(FailingBackend);

        let result = provider_credential_status("mineru");
        *backend_cell().write().unwrap() = previous;

        assert!(result.is_err(), "读取失败必须返回错误，而不是 false");
    }

    /// 原生 Windows Credential Manager 往返验证：使用独立临时服务名与假值，
    /// 结束后清理自己创建的记录，绝不读写真实服务账户。
    /// 环境不支持时明确跳过，不能把内存测试冒充为原生验证。
    #[test]
    fn test_native_windows_credential_roundtrip() {
        let service = format!(
            "flowread_parse_provider_native_test_{}",
            uuid::Uuid::new_v4().simple()
        );
        let writer = KeyringBackend::new(service.clone());

        if let Err(e) = writer.set("mineru", "fake_native_test_token") {
            println!("跳过原生凭据测试：当前环境无法使用系统凭据库 ({})", e);
            return;
        }

        // 跨 Entry 读取：新建一个 backend 实例，确认不是进程内缓存
        let reader = KeyringBackend::new(service.clone());
        let read_back = reader.get("mineru");
        let cleared = reader.clear("mineru");
        let after_clear = reader.get("mineru");

        assert_eq!(
            read_back.unwrap(),
            Some("fake_native_test_token".to_string()),
            "原生凭据库必须能跨 Entry 读回刚写入的假值"
        );
        cleared.unwrap();
        assert_eq!(after_clear.unwrap(), None, "清除后必须真的读不到");
    }
}
