use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub struct DbState {
    pub conn: Mutex<Connection>,
    pub assets_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DocumentRecord {
    pub id: String,
    pub file_path: String,
    pub display_name: String,
    pub file_size: i64,
    pub revision: String,
    pub last_read_position: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SourceAnchorRecord {
    pub anchor_id: String,
    pub document_id: String,
    pub document_revision: String,
    pub source_type: String, // "pdf_text" | "pdf_image" | "text_segment"
    pub excerpt: String,
    pub location_json: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardRecord {
    pub card_id: String,
    pub document_id: String,
    pub anchor_id: Option<String>,
    pub action: String,
    pub depth: String,
    pub status: String, // "queued" | "generating" | "completed" | "failed" | "interrupted"
    pub user_prompt: String,
    pub preview: String,
    pub ai_response: String,
    pub model_name: String,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    // Joined anchor excerpt/type for lightweight list
    pub anchor_excerpt: Option<String>,
    pub anchor_source_type: Option<String>,
    pub anchor_location_json: Option<String>,
    pub turns_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssetData {
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardTurnRecord {
    pub turn_id: String,
    pub card_id: String,
    pub user_prompt: String,
    pub ai_response: String,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardFunctionResultRecord {
    pub result_id: String,
    pub card_id: String,
    pub mode: String,
    pub result_content: String,
    pub created_at: i64,
    #[serde(default)]
    pub config_signature: Option<String>,
    #[serde(default = "default_fn_version")]
    pub version: i64,
}

fn default_fn_version() -> i64 {
    1
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FullCardDetail {
    pub card: CardRecord,
    pub anchor: Option<SourceAnchorRecord>,
    pub turns: Vec<CardTurnRecord>,
    pub function_results: Vec<CardFunctionResultRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HighlightRecord {
    pub highlight_id: String,
    pub document_id: String,
    pub anchor_id: String,
    pub color: String,
    pub created_at: i64,
    pub excerpt: String,
    pub location_json: String,
    pub source_type: String,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct AssetRecord {
    pub asset_id: String,
    pub document_id: String,
    pub file_name: String,
    pub file_path: String,
    pub mime_type: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedDocumentVersionRecord {
    pub version_id: String,
    pub document_id: String,
    pub source_revision: String,
    pub provider: String,
    pub config_signature: String,
    pub storage_rel_path: String,
    pub block_count: i64,
    pub asset_count: i64,
    pub is_active: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CardListResponse {
    pub items: Vec<CardRecord>,
    pub total: i64,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct ParseJobRecord {
    pub job_id: String,
    pub document_id: String,
    pub source_path: String,
    pub document_name: String,
    pub source_hash: String,
    pub source_revision: String,
    pub provider: String,
    pub config_signature: String,
    pub status: String,
    pub progress_percent: Option<i64>,
    pub completed_pages: Option<i64>,
    pub total_pages: Option<i64>,
    pub remote_id: Option<String>,
    pub remote_meta_json: Option<String>,
    pub version_id: Option<String>,
    pub activated: i64,
    pub can_cancel: i64,
    pub can_resume: i64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub update_seq: i64,
    pub created_at: i64,
    pub updated_at: i64,
    // ---- 恢复检查点（应用重启后继续任务所需的持久状态）----
    pub snapshot_rel_path: Option<String>,
    pub remote_submitted: i64,
    pub upload_completed: i64,
    pub artifacts_downloaded: i64,
    pub normalized_ready: i64,
    pub activation_baseline_version_id: Option<String>,
    /// 是否已经发出过“可能被服务商受理”的提交请求（发出前持久化，跨重启保留）
    pub submit_attempted: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParseJobDto {
    pub job_id: String,
    pub document_id: String,
    pub source_path: String,
    pub document_name: String,
    pub source_revision: String,
    pub provider: String,
    pub status: String,
    pub progress_percent: Option<i64>,
    pub completed_pages: Option<i64>,
    pub total_pages: Option<i64>,
    pub version_id: Option<String>,
    pub activated: bool,
    pub can_cancel: bool,
    pub can_resume: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub update_seq: i64,
}

impl ParseJobRecord {
    pub fn to_dto(&self) -> ParseJobDto {
        ParseJobDto {
            job_id: self.job_id.clone(),
            document_id: self.document_id.clone(),
            source_path: self.source_path.clone(),
            document_name: self.document_name.clone(),
            source_revision: self.source_revision.clone(),
            provider: self.provider.clone(),
            status: self.status.clone(),
            progress_percent: self.progress_percent,
            completed_pages: self.completed_pages,
            total_pages: self.total_pages,
            version_id: self.version_id.clone(),
            activated: self.activated == 1,
            can_cancel: self.can_cancel == 1,
            can_resume: self.can_resume == 1,
            error_code: self.error_code.clone(),
            error_message: self.error_message.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            update_seq: self.update_seq,
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn init_db(app_handle: &AppHandle) -> Result<DbState, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 路径失败: {}", e))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("创建 AppData 目录失败: {}", e))?;

    let assets_dir = app_data_dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("创建 Assets 目录失败: {}", e))?;

    let db_path = app_data_dir.join("flowread.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开数据库失败 ({}): {:?}", e, db_path))?;

    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        ",
    )
    .map_err(|e| format!("配置 SQLite PRAGMA 失败: {}", e))?;

    // 运行表结构初始化与迁移
    run_migrations(&conn)?;

    // 启动时将旧未完成卡片与追问置为 interrupted
    let _ = conn.execute(
        "UPDATE cards SET status = 'interrupted' WHERE status IN ('queued', 'generating')",
        [],
    );
    let _ = conn.execute(
        "UPDATE card_turns SET status = 'interrupted' WHERE status IN ('queued', 'generating')",
        [],
    );

    Ok(DbState {
        conn: Mutex::new(conn),
        assets_dir,
    })
}

pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            file_path TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            revision TEXT NOT NULL DEFAULT '',
            last_read_position TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_anchors (
            anchor_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            document_revision TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            location_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cards (
            card_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            anchor_id TEXT REFERENCES source_anchors(anchor_id) ON DELETE SET NULL,
            action TEXT NOT NULL,
            depth TEXT NOT NULL DEFAULT 'quick',
            status TEXT NOT NULL DEFAULT 'completed',
            user_prompt TEXT NOT NULL DEFAULT '',
            ai_response TEXT NOT NULL DEFAULT '',
            model_name TEXT NOT NULL DEFAULT '',
            error_message TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS card_turns (
            turn_id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
            user_prompt TEXT NOT NULL,
            ai_response TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS card_function_results (
            result_id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
            mode TEXT NOT NULL,
            result_content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            config_signature TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            UNIQUE(card_id, mode)
        );

        CREATE TABLE IF NOT EXISTS card_function_versions (
            card_id TEXT NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
            mode TEXT NOT NULL,
            latest_version INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(card_id, mode)
        );

        CREATE TABLE IF NOT EXISTS highlights (
            highlight_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            anchor_id TEXT NOT NULL REFERENCES source_anchors(anchor_id) ON DELETE CASCADE,
            color TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS assets (
            asset_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reading_preferences (
            document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            preferences_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parsed_document_versions (
            version_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            source_revision TEXT NOT NULL,
            provider TEXT NOT NULL,
            config_signature TEXT NOT NULL,
            storage_rel_path TEXT NOT NULL,
            block_count INTEGER NOT NULL DEFAULT 0,
            asset_count INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_anchors_doc ON source_anchors(document_id);
        CREATE INDEX IF NOT EXISTS idx_cards_doc ON cards(document_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_doc_cursor ON cards(document_id, created_at DESC, card_id DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_action ON cards(document_id, action, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_anchor ON cards(anchor_id);
        CREATE INDEX IF NOT EXISTS idx_turns_card ON card_turns(card_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_fn_results_card ON card_function_results(card_id, mode);
        CREATE INDEX IF NOT EXISTS idx_highlights_doc ON highlights(document_id);
        CREATE INDEX IF NOT EXISTS idx_assets_doc ON assets(document_id);
        CREATE INDEX IF NOT EXISTS idx_parsed_doc_active ON parsed_document_versions(document_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_parsed_doc_created ON parsed_document_versions(document_id, created_at DESC);
        ",
    )
    .map_err(|e| format!("执行数据库初始化 SQL 失败: {}", e))?;

    // 兼容历史数据库：补齐 card_function_results 的 config_signature 和 version 列
    let _ = conn.execute(
        "ALTER TABLE card_function_results ADD COLUMN config_signature TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE card_function_results ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
        [],
    );

    // 幂等清理历史可能残留的多激活版本（按每篇文档保留最新一条），并建立唯一激活部分索引
    conn.execute(
        "UPDATE parsed_document_versions
         SET is_active = 0
         WHERE version_id NOT IN (
             SELECT version_id FROM (
                 SELECT version_id,
                        ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY created_at DESC) as rn
                 FROM parsed_document_versions
                 WHERE is_active = 1
             ) WHERE rn = 1
         ) AND is_active = 1",
        [],
    )
    .map_err(|e| format!("清理历史多激活解析版本数据失败: {}", e))?;

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_parsed_doc_single_active 
         ON parsed_document_versions(document_id) 
         WHERE is_active = 1",
        [],
    )
    .map_err(|e| format!("创建解析版本单激活唯一索引失败: {}", e))?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parse_jobs (
            job_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            source_path TEXT NOT NULL,
            document_name TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            source_revision TEXT NOT NULL,
            provider TEXT NOT NULL,
            config_signature TEXT NOT NULL,
            status TEXT NOT NULL,
            progress_percent INTEGER,
            completed_pages INTEGER,
            total_pages INTEGER,
            remote_id TEXT,
            remote_meta_json TEXT,
            version_id TEXT,
            activated INTEGER NOT NULL DEFAULT 0,
            can_cancel INTEGER NOT NULL DEFAULT 0,
            can_resume INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            error_message TEXT,
            update_seq INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            snapshot_rel_path TEXT,
            remote_submitted INTEGER NOT NULL DEFAULT 0,
            upload_completed INTEGER NOT NULL DEFAULT 0,
            artifacts_downloaded INTEGER NOT NULL DEFAULT 0,
            normalized_ready INTEGER NOT NULL DEFAULT 0,
            activation_baseline_version_id TEXT,
            submit_attempted INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_parse_jobs_doc ON parse_jobs(document_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_parse_jobs_status_created ON parse_jobs(status, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_parse_jobs_hash ON parse_jobs(source_hash, provider, config_signature);
        ",
    )
    .map_err(|e| format!("执行解析任务与应用设置表初始化 SQL 失败: {}", e))?;

    // 兼容已存在的用户数据库：检查点列必须幂等补齐，不能要求用户重建库。
    ensure_parse_job_checkpoint_columns(conn)?;

    // 一个任务最多对应一个结果版本（version_id 由 job 派生，正常不会重复）。
    // 若历史数据已存在重复，创建索引会失败；此时保留原数据并继续启动，由代码层再做校验。
    let _ = conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_jobs_version_unique
         ON parse_jobs(version_id) WHERE version_id IS NOT NULL",
        [],
    );

    Ok(())
}

fn ensure_parse_job_checkpoint_columns(conn: &Connection) -> Result<(), String> {
    let mut existing = std::collections::HashSet::new();
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info(parse_jobs)")
            .map_err(|e| format!("读取 parse_jobs 表结构失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("读取 parse_jobs 列名失败: {}", e))?;
        for name in rows.flatten() {
            existing.insert(name);
        }
    }

    let required: [(&str, &str); 7] = [
        ("snapshot_rel_path", "TEXT"),
        ("remote_submitted", "INTEGER NOT NULL DEFAULT 0"),
        ("upload_completed", "INTEGER NOT NULL DEFAULT 0"),
        ("artifacts_downloaded", "INTEGER NOT NULL DEFAULT 0"),
        ("normalized_ready", "INTEGER NOT NULL DEFAULT 0"),
        ("activation_baseline_version_id", "TEXT"),
        ("submit_attempted", "INTEGER NOT NULL DEFAULT 0"),
    ];

    for (name, ddl) in required {
        if !existing.contains(name) {
            conn.execute(
                &format!("ALTER TABLE parse_jobs ADD COLUMN {} {}", name, ddl),
                [],
            )
            .map_err(|e| format!("为 parse_jobs 增加列 {} 失败: {}", name, e))?;
        }
    }
    Ok(())
}

pub fn record_parsed_version(
    conn: &mut Connection,
    record: &ParsedDocumentVersionRecord,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("启动 SQLite 事务失败: {}", e))?;

    // 1. 严格校验目标文档在 documents 表中是否存在
    let doc_exists: bool = tx
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            params![record.document_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| format!("校验目标文档失败: {}", e))?
        .unwrap_or(false);

    if !doc_exists {
        return Err(format!("目标文档不存在: {}", record.document_id));
    }

    // 2. 将当前文档所有旧版本置为 is_active = 0 (仅当新版本要激活时)
    if record.is_active == 1 {
        tx.execute(
            "UPDATE parsed_document_versions SET is_active = 0 WHERE document_id = ?1 AND is_active = 1",
            params![record.document_id],
        )
        .map_err(|e| format!("更新旧解析版本状态失败: {}", e))?;
    }

    // 3. 插入新版本记录并激活
    tx.execute(
        "INSERT INTO parsed_document_versions (version_id, document_id, source_revision, provider, config_signature, storage_rel_path, block_count, asset_count, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            record.version_id,
            record.document_id,
            record.source_revision,
            record.provider,
            record.config_signature,
            record.storage_rel_path,
            record.block_count,
            record.asset_count,
            record.is_active,
            record.created_at,
        ],
    )
    .map_err(|e| format!("保存解析版本记录失败: {}", e))?;

    tx.commit()
        .map_err(|e| format!("提交解析版本事务失败: {}", e))?;

    Ok(())
}

/// 条件化登记解析版本并激活：
/// 仅当源文件 revision 未变且当前激活版本符合启动时的预期时，才自动激活新版本；
/// 若期间发生源文件修改或用户另行激活了其他版本，仍保存该解析版本，但保持 is_active = 0。
/// 返回值：Ok(true) 表示新版本已成功激活；Ok(false) 表示已保存为非激活版本。
pub fn record_parsed_version_conditional(
    conn: &mut Connection,
    record: &ParsedDocumentVersionRecord,
    expected_doc_revision: &str,
    expected_active_version_id: Option<&str>,
) -> Result<bool, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("启动 SQLite 事务失败: {}", e))?;

    let activated = record_version_in_tx(&tx, record, expected_doc_revision, expected_active_version_id)?;

    tx.commit()
        .map_err(|e| format!("提交解析版本事务失败: {}", e))?;

    Ok(activated)
}

/// 版本登记与“任务成功”更新在同一事务内完成：
/// 任一步失败都会整体回滚，重试不会产生第二个版本，也不会出现“版本已登记但任务仍非成功”。
pub fn record_parsed_version_and_finish_job(
    conn: &mut Connection,
    record: &ParsedDocumentVersionRecord,
    expected_doc_revision: &str,
    expected_active_version_id: Option<&str>,
    job_id: &str,
    allow_activation: bool,
) -> Result<bool, String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("启动入库事务失败: {}", e))?;

    // 源修订已变化或用户已选择其它版本时，仍保存结果但不自动替换当前激活版本。
    let activation_guard: Option<&str> = if allow_activation {
        expected_active_version_id
    } else {
        Some("__source_or_selection_changed__")
    };

    let activated = record_version_in_tx(&tx, record, expected_doc_revision, activation_guard)?;

    let updated = tx
        .execute(
            "UPDATE parse_jobs SET
                status = 'succeeded', version_id = ?1, activated = ?2,
                can_cancel = 0, can_resume = 0, progress_percent = 100,
                error_code = NULL, error_message = NULL,
                update_seq = update_seq + 1, updated_at = ?3
             WHERE job_id = ?4 AND status = 'importing'",
            params![record.version_id, if activated { 1 } else { 0 }, now_ms(), job_id],
        )
        .map_err(|e| format!("更新任务成功状态失败: {}", e))?;

    if updated != 1 {
        // 任务在入库期间已被取消或已被其它执行者推进，放弃本次登记（事务回滚）
        return Err("任务状态已变化（可能已取消），放弃本次入库登记".to_string());
    }

    tx.commit()
        .map_err(|e| format!("提交入库事务失败: {}", e))?;

    Ok(activated)
}

fn record_version_in_tx(
    tx: &rusqlite::Transaction<'_>,
    record: &ParsedDocumentVersionRecord,
    expected_doc_revision: &str,
    expected_active_version_id: Option<&str>,
) -> Result<bool, String> {
    // 1. 校验文档存在且 revision 未改变
    let doc_rev: Option<String> = tx
        .query_row(
            "SELECT revision FROM documents WHERE id = ?1",
            params![record.document_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("校验目标文档失败: {}", e))?;

    let doc_rev = match doc_rev {
        Some(r) => r,
        None => return Err(format!("目标文档不存在: {}", record.document_id)),
    };

    let doc_revision_matches = doc_rev == expected_doc_revision;

    // 2. 检查当前 active 版本是否与任务创建时固定的基准一致
    let current_active_ver: Option<String> = tx
        .query_row(
            "SELECT version_id FROM parsed_document_versions WHERE document_id = ?1 AND is_active = 1",
            params![record.document_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("查询当前激活版本失败: {}", e))?;

    let active_version_matches = match (expected_active_version_id, current_active_ver.as_deref()) {
        (None, None) => true,
        (Some(expected), Some(current)) => expected == current,
        (None, Some(_)) => false, // 任务创建时无激活版本，但期间有版本被激活了
        (Some(_), None) => false, // 任务创建时有激活版本，但期间被移除了
    };

    let should_activate = doc_revision_matches && active_version_matches;

    if should_activate {
        tx.execute(
            "UPDATE parsed_document_versions SET is_active = 0 WHERE document_id = ?1 AND is_active = 1",
            params![record.document_id],
        )
        .map_err(|e| format!("更新旧解析版本状态失败: {}", e))?;
    }

    let is_active_val = if should_activate { 1 } else { 0 };

    tx.execute(
        "INSERT INTO parsed_document_versions (version_id, document_id, source_revision, provider, config_signature, storage_rel_path, block_count, asset_count, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            record.version_id,
            record.document_id,
            record.source_revision,
            record.provider,
            record.config_signature,
            record.storage_rel_path,
            record.block_count,
            record.asset_count,
            is_active_val,
            record.created_at,
        ],
    )
    .map_err(|e| format!("保存解析版本记录失败: {}", e))?;

    Ok(should_activate)
}

pub fn get_active_parsed_version(
    conn: &Connection,
    document_id: &str,
) -> Result<Option<ParsedDocumentVersionRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT version_id, document_id, source_revision, provider, config_signature, storage_rel_path, block_count, asset_count, is_active, created_at
             FROM parsed_document_versions
             WHERE document_id = ?1 AND is_active = 1
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

    let row = stmt
        .query_row(params![document_id], |r| {
            Ok(ParsedDocumentVersionRecord {
                version_id: r.get(0)?,
                document_id: r.get(1)?,
                source_revision: r.get(2)?,
                provider: r.get(3)?,
                config_signature: r.get(4)?,
                storage_rel_path: r.get(5)?,
                block_count: r.get(6)?,
                asset_count: r.get(7)?,
                is_active: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .optional()
        .map_err(|e| format!("查询激活解析版本失败: {}", e))?;

    Ok(row)
}

// ================= App Settings =================

pub fn get_app_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("获取应用设置失败: {}", e))
}

pub fn set_app_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )
    .map_err(|e| format!("保存应用设置失败: {}", e))?;
    Ok(())
}

// ================= Parse Jobs Database Helpers =================

pub const PARSE_JOB_SELECT_FIELDS: &str = "\
    job_id, document_id, source_path, document_name, source_hash, source_revision, \
    provider, config_signature, status, progress_percent, completed_pages, total_pages, \
    remote_id, remote_meta_json, version_id, activated, can_cancel, can_resume, \
    error_code, error_message, update_seq, created_at, updated_at, \
    snapshot_rel_path, remote_submitted, upload_completed, artifacts_downloaded, \
    normalized_ready, activation_baseline_version_id, submit_attempted";

pub fn map_parse_job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ParseJobRecord> {
    Ok(ParseJobRecord {
        job_id: row.get(0)?,
        document_id: row.get(1)?,
        source_path: row.get(2)?,
        document_name: row.get(3)?,
        source_hash: row.get(4)?,
        source_revision: row.get(5)?,
        provider: row.get(6)?,
        config_signature: row.get(7)?,
        status: row.get(8)?,
        progress_percent: row.get(9)?,
        completed_pages: row.get(10)?,
        total_pages: row.get(11)?,
        remote_id: row.get(12)?,
        remote_meta_json: row.get(13)?,
        version_id: row.get(14)?,
        activated: row.get(15)?,
        can_cancel: row.get(16)?,
        can_resume: row.get(17)?,
        error_code: row.get(18)?,
        error_message: row.get(19)?,
        update_seq: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        snapshot_rel_path: row.get(23)?,
        remote_submitted: row.get(24)?,
        upload_completed: row.get(25)?,
        artifacts_downloaded: row.get(26)?,
        normalized_ready: row.get(27)?,
        activation_baseline_version_id: row.get(28)?,
        submit_attempted: row.get(29)?,
    })
}

pub fn insert_parse_job(conn: &Connection, job: &ParseJobRecord) -> Result<(), String> {
    conn.execute(
        "INSERT INTO parse_jobs (
            job_id, document_id, source_path, document_name, source_hash, source_revision,
            provider, config_signature, status, progress_percent, completed_pages, total_pages,
            remote_id, remote_meta_json, version_id, activated, can_cancel, can_resume,
            error_code, error_message, update_seq, created_at, updated_at,
            snapshot_rel_path, remote_submitted, upload_completed, artifacts_downloaded,
            normalized_ready, activation_baseline_version_id, submit_attempted
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23,
            ?24, ?25, ?26, ?27, ?28, ?29, ?30
        )",
        params![
            job.job_id, job.document_id, job.source_path, job.document_name, job.source_hash, job.source_revision,
            job.provider, job.config_signature, job.status, job.progress_percent, job.completed_pages, job.total_pages,
            job.remote_id, job.remote_meta_json, job.version_id, job.activated, job.can_cancel, job.can_resume,
            job.error_code, job.error_message, job.update_seq, job.created_at, job.updated_at,
            job.snapshot_rel_path, job.remote_submitted, job.upload_completed,
            job.artifacts_downloaded, job.normalized_ready, job.activation_baseline_version_id,
            job.submit_attempted
        ],
    )
    .map_err(|e| format!("插入解析任务失败: {}", e))?;
    Ok(())
}

pub fn update_parse_job(conn: &Connection, job: &ParseJobRecord) -> Result<(), String> {
    conn.execute(
        "UPDATE parse_jobs SET
            status = ?1, progress_percent = ?2, completed_pages = ?3, total_pages = ?4,
            remote_id = ?5, remote_meta_json = ?6, version_id = ?7, activated = ?8,
            can_cancel = ?9, can_resume = ?10, error_code = ?11, error_message = ?12,
            snapshot_rel_path = ?13, remote_submitted = ?14, upload_completed = ?15,
            artifacts_downloaded = ?16, normalized_ready = ?17,
            activation_baseline_version_id = ?18, submit_attempted = ?19,
            update_seq = update_seq + 1, updated_at = ?20
         WHERE job_id = ?21",
        params![
            job.status, job.progress_percent, job.completed_pages, job.total_pages,
            job.remote_id, job.remote_meta_json, job.version_id, job.activated,
            job.can_cancel, job.can_resume, job.error_code, job.error_message,
            job.snapshot_rel_path, job.remote_submitted, job.upload_completed,
            job.artifacts_downloaded, job.normalized_ready, job.activation_baseline_version_id,
            job.submit_attempted, now_ms(), job.job_id
        ],
    )
    .map_err(|e| format!("更新解析任务失败: {}", e))?;
    Ok(())
}

/// 检查点写入（与状态转换分离）：
/// 只更新“恢复所需”的本地进度字段，绝不改写 status / can_cancel / can_resume / 终态信息。
/// 通过 `expected_status` 与 `update_seq` 做原子条件校验；影响行数不为 1 时返回错误，
/// 调用方必须立刻停止当前执行（例如任务已被取消）。
pub fn update_parse_job_checkpoint(
    conn: &Connection,
    job: &ParseJobRecord,
    expected_status: &str,
) -> Result<i64, String> {
    let (current_status, current_seq): (String, i64) = conn
        .query_row(
            "SELECT status, update_seq FROM parse_jobs WHERE job_id = ?1",
            params![job.job_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("读取任务状态失败: {}", e))?;

    if current_status != expected_status {
        return Err(format!(
            "任务状态已变化（期望 '{}'，实际 '{}'），停止当前执行",
            expected_status, current_status
        ));
    }

    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                snapshot_rel_path = ?1, remote_id = ?2, remote_meta_json = ?3,
                submit_attempted = ?4, remote_submitted = ?5, upload_completed = ?6,
                artifacts_downloaded = ?7, normalized_ready = ?8,
                update_seq = update_seq + 1, updated_at = ?9
             WHERE job_id = ?10 AND status = ?11 AND update_seq = ?12",
            params![
                job.snapshot_rel_path,
                job.remote_id,
                job.remote_meta_json,
                job.submit_attempted,
                job.remote_submitted,
                job.upload_completed,
                job.artifacts_downloaded,
                job.normalized_ready,
                now_ms(),
                job.job_id,
                expected_status,
                current_seq
            ],
        )
        .map_err(|e| format!("写入任务检查点失败: {}", e))?;

    if updated != 1 {
        return Err("检查点写入冲突：任务已被其它执行者推进".to_string());
    }

    Ok(current_seq + 1)
}

/// 仅在任务仍处于预期状态时写回整条记录（用于入库失败等终态收尾）。
/// 状态已变化时返回 false，调用方不得重试覆盖。
pub fn update_parse_job_if_status(
    conn: &Connection,
    job: &ParseJobRecord,
    expected_status: &str,
) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                status = ?1, progress_percent = ?2, completed_pages = ?3, total_pages = ?4,
                remote_id = ?5, remote_meta_json = ?6, version_id = ?7, activated = ?8,
                can_cancel = ?9, can_resume = ?10, error_code = ?11, error_message = ?12,
                snapshot_rel_path = ?13, submit_attempted = ?14, remote_submitted = ?15,
                upload_completed = ?16, artifacts_downloaded = ?17, normalized_ready = ?18,
                activation_baseline_version_id = ?19,
                update_seq = update_seq + 1, updated_at = ?20
             WHERE job_id = ?21 AND status = ?22",
            params![
                job.status,
                job.progress_percent,
                job.completed_pages,
                job.total_pages,
                job.remote_id,
                job.remote_meta_json,
                job.version_id,
                job.activated,
                job.can_cancel,
                job.can_resume,
                job.error_code,
                job.error_message,
                job.snapshot_rel_path,
                job.submit_attempted,
                job.remote_submitted,
                job.upload_completed,
                job.artifacts_downloaded,
                job.normalized_ready,
                job.activation_baseline_version_id,
                now_ms(),
                job.job_id,
                expected_status
            ],
        )
        .map_err(|e| format!("更新解析任务失败: {}", e))?;
    Ok(updated == 1)
}

/// 阶段推进：仅当任务未进入入库/未结束/未取消时才允许改写状态。
/// 返回 false 表示任务已被取消或已结束，工作流必须立刻停止，不能覆盖既有状态。
pub fn transition_parse_job_status(
    conn: &Connection,
    job_id: &str,
    to_status: &str,
    can_cancel: i64,
    can_resume: i64,
    error_code: Option<&str>,
    error_message: Option<&str>,
) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                status = ?1, progress_percent = NULL, can_cancel = ?2, can_resume = ?3,
                error_code = ?4, error_message = ?5,
                update_seq = update_seq + 1, updated_at = ?6
             WHERE job_id = ?7
               AND status NOT IN ('importing', 'succeeded', 'cancelled')",
            params![
                to_status,
                can_cancel,
                can_resume,
                error_code,
                error_message,
                now_ms(),
                job_id
            ],
        )
        .map_err(|e| format!("推进解析任务状态失败: {}", e))?;
    Ok(updated == 1)
}

/// 进度更新结果：仅在合法的 processing 状态下允许原子推进页数与 update_seq
#[derive(Debug, PartialEq, Eq)]
pub enum ProgressUpdateOutcome {
    /// 成功更新页数并自增 update_seq，携带新的序号
    Updated(i64),
    /// 任务已脱离 processing 状态（如已被取消或已完成），拒绝写入
    NotProcessing,
    /// 页数无有效实质变更，跳过写入与序号递增
    NoChange,
}

/// 受状态保护的原子进度更新：
/// 1. 只有当前任务处于 'processing' 状态才允许写入；
/// 2. 页数发生有效变化时，在同一 SQL 更新中递增 update_seq 并更新 updated_at；
/// 3. 保留已有有效值，不因服务商未返回某可选字段而清空已有值；
/// 4. 明确区分 Updated、NotProcessing、NoChange 与数据库错误；
/// 5. 终态任务绝不被迟到的进度响应污染。
pub fn update_parse_job_progress(
    conn: &Connection,
    job_id: &str,
    completed_pages: Option<i64>,
    total_pages: Option<i64>,
) -> Result<ProgressUpdateOutcome, String> {
    let row = conn
        .query_row(
            "SELECT status, completed_pages, total_pages, update_seq FROM parse_jobs WHERE job_id = ?1",
            params![job_id],
            |r| Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
            )),
        )
        .optional()
        .map_err(|e| format!("查询任务状态失败: {}", e))?;

    let (current_status, current_completed, current_total, current_seq) = match row {
        Some(data) => data,
        None => return Err(format!("任务不存在: {}", job_id)),
    };

    if current_status != "processing" {
        return Ok(ProgressUpdateOutcome::NotProcessing);
    }

    // 保留已有有效值：若传入为 None，则继承现有值，不无故清空已有有效值
    let effective_completed = completed_pages.or(current_completed);
    let effective_total = total_pages.or(current_total);

    if effective_completed == current_completed && effective_total == current_total {
        return Ok(ProgressUpdateOutcome::NoChange);
    }

    let now = now_ms();
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                completed_pages = ?1,
                total_pages = ?2,
                update_seq = update_seq + 1,
                updated_at = ?3
             WHERE job_id = ?4 AND status = 'processing' AND update_seq = ?5",
            params![effective_completed, effective_total, now, job_id, current_seq],
        )
        .map_err(|e| format!("更新任务进度失败: {}", e))?;

    if updated == 1 {
        Ok(ProgressUpdateOutcome::Updated(current_seq + 1))
    } else {
        // 重新检查当前状态，判断是脱离了 processing 还是并发 CAS 冲突
        let recheck_status: Option<String> = conn
            .query_row(
                "SELECT status FROM parse_jobs WHERE job_id = ?1",
                params![job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("重新检查任务状态失败: {}", e))?;

        match recheck_status.as_deref() {
            Some("processing") => Err("进度更新冲突：任务已被其它操作并发推进".to_string()),
            Some(_) => Ok(ProgressUpdateOutcome::NotProcessing),
            None => Err(format!("任务不存在: {}", job_id)),
        }
    }
}

/// 取消结果：取消先成功才允许真正取消；入库已取得执行权时取消被拒绝。
#[derive(Debug)]
pub enum CancelOutcome {
    Cancelled(ParseJobRecord),
    /// 任务已进入入库阶段或已结束，返回当前状态
    Rejected(ParseJobRecord),
    NotFound,
}

/// 原子取消：状态条件更新与“是否允许取消”是同一个 SQL 语句，
/// 不存在“检查完再取消”的竞态窗口。
pub fn cancel_parse_job_cas(conn: &Connection, job_id: &str) -> Result<CancelOutcome, String> {
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                status = 'cancelled', can_cancel = 0, can_resume = 0,
                error_code = 'ERR_CANCELLED', error_message = '任务已被用户取消',
                update_seq = update_seq + 1, updated_at = ?1
             WHERE job_id = ?2
               AND status NOT IN ('importing', 'succeeded', 'cancelled')",
            params![now_ms(), job_id],
        )
        .map_err(|e| format!("取消解析任务失败: {}", e))?;

    let job = get_parse_job(conn, job_id)?;
    match (updated, job) {
        (_, None) => Ok(CancelOutcome::NotFound),
        (1, Some(j)) => Ok(CancelOutcome::Cancelled(j)),
        (_, Some(j)) => Ok(CancelOutcome::Rejected(j)),
    }
}

/// 入库执行权：仅当任务仍处于 normalizing 时才能进入 importing。
/// 与取消使用同一条记录的条件更新，谁先成功谁生效。
pub fn try_begin_parse_import(conn: &Connection, job_id: &str) -> Result<bool, String> {
    let updated = conn
        .execute(
            "UPDATE parse_jobs SET
                status = 'importing', can_cancel = 0, can_resume = 0,
                progress_percent = NULL,
                update_seq = update_seq + 1, updated_at = ?1
             WHERE job_id = ?2 AND status = 'normalizing'",
            params![now_ms(), job_id],
        )
        .map_err(|e| format!("取得入库执行权失败: {}", e))?;
    Ok(updated == 1)
}

/// 应用启动时的中断恢复：
/// 1. 已经发出提交意图但没有可靠远端 ID → `submission_unknown`（绝不重新提交）；
/// 2. 迁移前的旧记录处于“提交之后”的状态却缺少远端 ID → 保守视为可能已受理；
/// 3. 其余中间态 → `paused`（可继续）。
/// 全部为幂等更新：处理过的记录不会再匹配同一条件。
pub fn recover_interrupted_parse_jobs(conn: &Connection) -> Result<usize, String> {
    let now = now_ms();
    let mut total = 0usize;

    // 1. 新代码留下的“可能已受理但未保存远端 ID”
    total += conn
        .execute(
            "UPDATE parse_jobs SET
                status = 'submission_unknown', can_cancel = 0, can_resume = 0,
                progress_percent = NULL,
                error_code = 'ERR_SUBMISSION_UNCONFIRMED',
                error_message = '上次提交在保存远端标识前中断，无法确认服务商是否已受理；请核对后使用“重新解析”',
                update_seq = update_seq + 1, updated_at = ?1
             WHERE submit_attempted = 1 AND remote_submitted = 0 AND remote_id IS NULL
               AND status IN ('preparing', 'submitting', 'uploading', 'processing', 'downloading', 'normalizing', 'importing')",
            params![now],
        )
        .map_err(|e| format!("恢复未确认的提交任务失败: {}", e))?;

    // 2. 迁移前的旧记录：已进入提交之后的状态但无远端 ID。
    //    无法判断服务商是否受理 → 保守标记为待确认，并补写 submit_attempted=1，
    //    避免后续再次进入普通恢复流程。
    total += conn
        .execute(
            "UPDATE parse_jobs SET
                submit_attempted = 1, status = 'submission_unknown',
                can_cancel = 0, can_resume = 0, progress_percent = NULL,
                error_code = 'ERR_SUBMISSION_UNCONFIRMED',
                error_message = '升级前任务在提交阶段中断，无法确认服务商是否已受理；请核对后使用“重新解析”',
                update_seq = update_seq + 1, updated_at = ?1
             WHERE submit_attempted = 0 AND remote_submitted = 0 AND remote_id IS NULL
               AND status IN ('submitting', 'uploading', 'processing', 'downloading', 'normalizing', 'importing')",
            params![now],
        )
        .map_err(|e| format!("迁移旧的未确认提交任务失败: {}", e))?;

    // 3. 迁移前的旧 paused 记录：排除“明确发生在提交之前”的暂停
    //    （未配置凭据 / 认证被拒），其余无法判断者同样保守处理。
    total += conn
        .execute(
            "UPDATE parse_jobs SET
                submit_attempted = 1, status = 'submission_unknown',
                can_cancel = 0, can_resume = 0, progress_percent = NULL,
                error_code = 'ERR_SUBMISSION_UNCONFIRMED',
                error_message = '升级前任务在提交阶段中断，无法确认服务商是否已受理；请核对后使用“重新解析”',
                update_seq = update_seq + 1, updated_at = ?1
             WHERE submit_attempted = 0 AND remote_submitted = 0 AND remote_id IS NULL
               AND status = 'paused'
               AND (error_code IS NULL OR error_code NOT IN ('ERR_AUTH_REJECTED', 'ERR_CREDENTIAL_STORE'))",
            params![now],
        )
        .map_err(|e| format!("迁移旧暂停任务失败: {}", e))?;

    // 4. 其余中间态 → 可继续
    total += conn
        .execute(
            "UPDATE parse_jobs SET
                status = 'paused', can_cancel = 1, can_resume = 1,
                progress_percent = NULL,
                error_code = 'ERR_INTERRUPTED',
                error_message = '应用退出导致任务中断，可点击“继续任务”从检查点恢复',
                update_seq = update_seq + 1, updated_at = ?1
             WHERE status IN ('preparing', 'submitting', 'uploading', 'processing', 'downloading', 'normalizing', 'importing')",
            params![now],
        )
        .map_err(|e| format!("恢复中断的解析任务失败: {}", e))?;

    Ok(total)
}

/// 按结果版本反查任务，保证 job_id ↔ version_id 的唯一关联可核对。
pub fn find_parse_job_by_version(
    conn: &Connection,
    version_id: &str,
) -> Result<Option<ParseJobRecord>, String> {
    let sql = format!(
        "SELECT {} FROM parse_jobs WHERE version_id = ?1 LIMIT 1",
        PARSE_JOB_SELECT_FIELDS
    );
    conn.query_row(
        &sql,
        params![version_id],
        map_parse_job_row,
    )
    .optional()
    .map_err(|e| format!("查询解析版本对应的任务失败: {}", e))
}

pub fn get_parse_job(conn: &Connection, job_id: &str) -> Result<Option<ParseJobRecord>, String> {
    let sql = format!(
        "SELECT {} FROM parse_jobs WHERE job_id = ?1",
        PARSE_JOB_SELECT_FIELDS
    );
    conn.query_row(
        &sql,
        params![job_id],
        map_parse_job_row,
    )
    .optional()
    .map_err(|e| format!("查询解析任务失败: {}", e))
}

/// 获取下一条排队的解析任务（按创建时间先后顺序 FIFO）：
/// 只有确实没有排队任务才返回 Ok(None)；SQL、列映射、锁错误等均作为 Err 向上传播，
/// 绝不被隐式吞掉转成 None。
pub fn get_next_queued_job(conn: &Connection) -> Result<Option<ParseJobRecord>, String> {
    let sql = format!(
        "SELECT {} FROM parse_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
        PARSE_JOB_SELECT_FIELDS
    );
    conn.query_row(&sql, [], map_parse_job_row)
        .optional()
        .map_err(|e| format!("查询下一条排队任务失败: {}", e))
}

/// 只在同一文档（同一路径）内复用任务：
/// 相同字节但不同路径的文件必须拥有各自的文档身份与版本绑定。
pub fn find_active_parse_job(
    conn: &Connection,
    document_id: &str,
    source_path: &str,
    source_hash: &str,
    provider: &str,
    config_signature: &str,
) -> Result<Option<ParseJobRecord>, String> {
    let sql = format!(
        "SELECT {}
         FROM parse_jobs
         WHERE source_hash = ?1 AND provider = ?2 AND config_signature = ?3
           AND document_id = ?4 AND source_path = ?5
           AND status IN ('queued', 'preparing', 'submitting', 'uploading', 'processing', 'downloading', 'normalizing', 'importing', 'paused', 'submission_unknown')
         ORDER BY created_at DESC LIMIT 1",
        PARSE_JOB_SELECT_FIELDS
    );
    conn.query_row(
        &sql,
        params![source_hash, provider, config_signature, document_id, source_path],
        map_parse_job_row,
    )
    .optional()
    .map_err(|e| format!("查询活跃解析任务失败: {}", e))
}

pub fn find_latest_succeeded_job(
    conn: &Connection,
    document_id: &str,
    source_path: &str,
    source_hash: &str,
    provider: &str,
    config_signature: &str,
) -> Result<Option<ParseJobRecord>, String> {
    let sql = format!(
        "SELECT {}
         FROM parse_jobs
         WHERE source_hash = ?1 AND provider = ?2 AND config_signature = ?3
           AND document_id = ?4 AND source_path = ?5
           AND status = 'succeeded' AND version_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1",
        PARSE_JOB_SELECT_FIELDS
    );
    conn.query_row(
        &sql,
        params![source_hash, provider, config_signature, document_id, source_path],
        map_parse_job_row,
    )
    .optional()
    .map_err(|e| format!("查询历史成功解析任务失败: {}", e))
}

pub fn list_parse_jobs_internal(
    conn: &Connection,
    document_id: Option<&str>,
    active_only: bool,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<ParseJobRecord>, Option<String>), String> {
    let limit = limit.clamp(1, 100);
    let mut conditions = Vec::new();
    let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(doc_id) = document_id {
        conditions.push("document_id = ?");
        params_vec.push(rusqlite::types::Value::from(doc_id.to_string()));
    }

    if active_only {
        conditions.push("status IN ('queued', 'preparing', 'submitting', 'uploading', 'processing', 'downloading', 'normalizing', 'importing', 'paused', 'submission_unknown')");
    }

    if let Some(c_str) = cursor {
        use base64::Engine;
        if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(c_str.trim()) {
            if let Ok(s) = String::from_utf8(decoded) {
                let parts: Vec<&str> = s.split(':').collect();
                if parts.len() == 2 {
                    if let Ok(c_time) = parts[0].parse::<i64>() {
                        let c_id = parts[1].to_string();
                        conditions.push("(created_at < ? OR (created_at = ? AND job_id < ?))");
                        params_vec.push(rusqlite::types::Value::from(c_time));
                        params_vec.push(rusqlite::types::Value::from(c_time));
                        params_vec.push(rusqlite::types::Value::from(c_id));
                    }
                }
            }
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT {}
         FROM parse_jobs
         {}
         ORDER BY created_at DESC, job_id DESC
         LIMIT ?",
        PARSE_JOB_SELECT_FIELDS,
        where_clause
    );

    params_vec.push(rusqlite::types::Value::from(limit + 1));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|v| v as &dyn rusqlite::ToSql)
        .collect();

    let rows = stmt
        .query_map(&params_slice[..], map_parse_job_row)
        .map_err(|e| format!("查询任务列表失败: {}", e))?;

    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }

    let has_more = items.len() > (limit as usize);
    let next_cursor = if has_more {
        items.truncate(limit as usize);
        items.last().map(|last| {
            use base64::Engine;
            let raw = format!("{}:{}", last.created_at, last.job_id);
            base64::engine::general_purpose::STANDARD.encode(raw)
        })
    } else {
        None
    };

    Ok((items, next_cursor))
}

// ================= Documents Helper =================

pub fn get_or_create_document_internal(
    conn: &Connection,
    file_path: &str,
    display_name: &str,
    file_size: i64,
    revision: Option<&str>,
) -> Result<DocumentRecord, String> {
    let rev = revision.unwrap_or_default();
    let now = now_ms();

    // 查找已有文档
    let existing = conn
        .query_row(
            "SELECT id, file_path, display_name, file_size, revision, last_read_position, created_at, updated_at
             FROM documents WHERE file_path = ?1",
            params![file_path],
            |row| {
                Ok(DocumentRecord {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    display_name: row.get(2)?,
                    file_size: row.get(3)?,
                    revision: row.get(4)?,
                    last_read_position: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("查询文档失败: {}", e))?;

    if let Some(mut doc) = existing {
        // 如果版本或文件名有变化，更新信息
        if (!rev.is_empty() && doc.revision != rev) || doc.display_name != display_name {
            conn.execute(
                "UPDATE documents SET display_name = ?1, revision = ?2, file_size = ?3, updated_at = ?4 WHERE id = ?5",
                params![display_name, rev, file_size, now, doc.id],
            )
            .map_err(|e| format!("更新文档元数据失败: {}", e))?;
            doc.display_name = display_name.to_string();
            doc.revision = rev.to_string();
            doc.file_size = file_size;
            doc.updated_at = now;
        }
        return Ok(doc);
    }

    // 创建新文档
    let doc_id = format!("doc_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO documents (id, file_path, display_name, file_size, revision, last_read_position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
        params![doc_id, file_path, display_name, file_size, rev, now, now],
    )
    .map_err(|e| format!("插入新文档记录失败: {}", e))?;

    Ok(DocumentRecord {
        id: doc_id,
        file_path: file_path.to_string(),
        display_name: display_name.to_string(),
        file_size,
        revision: rev.to_string(),
        last_read_position: None,
        created_at: now,
        updated_at: now,
    })
}

// ================= Tauri IPC Commands =================

#[tauri::command]
pub fn db_get_or_create_document(
    state: tauri::State<'_, DbState>,
    file_path: String,
    display_name: String,
    file_size: i64,
    revision: Option<String>,
) -> Result<DocumentRecord, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_or_create_document_internal(&conn, &file_path, &display_name, file_size, revision.as_deref())
}

#[tauri::command]
pub fn db_save_reading_position(
    state: tauri::State<'_, DbState>,
    document_id: String,
    position_json: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "UPDATE documents SET last_read_position = ?1, updated_at = ?2 WHERE id = ?3",
        params![position_json, now, document_id],
    )
    .map_err(|e| format!("更新阅读位置失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn db_save_reading_preferences(
    state: tauri::State<'_, DbState>,
    document_id: String,
    preferences_json: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO reading_preferences (document_id, preferences_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(document_id) DO UPDATE SET preferences_json = ?2, updated_at = ?3",
        params![document_id, preferences_json, now],
    )
    .map_err(|e| format!("保存阅读偏好失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn db_get_reading_preferences(
    state: tauri::State<'_, DbState>,
    document_id: String,
) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let res = conn
        .query_row(
            "SELECT preferences_json FROM reading_preferences WHERE document_id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取阅读偏好失败: {}", e))?;
    Ok(res)
}

#[tauri::command]
pub fn db_save_asset(
    state: tauri::State<'_, DbState>,
    document_id: String,
    file_name: String,
    data: Vec<u8>,
    mime_type: String,
) -> Result<String, String> {
    let asset_id = format!("ast_{}", Uuid::new_v4().simple());
    let ext = Path::new(&file_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("jpg");
    let disk_file_name = format!("{}.{}", asset_id, ext);
    let disk_path = state.assets_dir.join(&disk_file_name);

    fs::write(&disk_path, &data).map_err(|e| format!("写入资源文件失败: {}", e))?;

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO assets (asset_id, document_id, file_name, file_path, mime_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            asset_id,
            document_id,
            file_name,
            disk_file_name,
            mime_type,
            now
        ],
    )
    .map_err(|e| format!("保存资源记录失败: {}", e))?;

    Ok(asset_id)
}

#[tauri::command]
pub fn db_get_asset(
    state: tauri::State<'_, DbState>,
    asset_id: String,
) -> Result<Vec<u8>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let rel_path: String = conn
        .query_row(
            "SELECT file_path FROM assets WHERE asset_id = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("未找到指定资源记录: {}", e))?;

    let disk_path = state.assets_dir.join(rel_path);
    fs::read(&disk_path).map_err(|e| format!("读取资源文件失败: {}", e))
}

#[tauri::command]
pub fn db_get_asset_data(
    state: tauri::State<'_, DbState>,
    asset_id: String,
) -> Result<AssetData, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let (rel_path, mime_type): (String, String) = conn
        .query_row(
            "SELECT file_path, mime_type FROM assets WHERE asset_id = ?1",
            params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("未找到指定资源记录: {}", e))?;

    let disk_path = state.assets_dir.join(rel_path);
    let data = fs::read(&disk_path).map_err(|e| format!("读取资源文件失败: {}", e))?;
    Ok(AssetData { mime_type, data })
}

#[tauri::command]
pub fn db_create_anchor(
    state: tauri::State<'_, DbState>,
    document_id: String,
    document_revision: String,
    source_type: String,
    excerpt: String,
    location_json: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let anchor_id = format!("anc_{}", Uuid::new_v4().simple());
    let now = now_ms();

    conn.execute(
        "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            anchor_id,
            document_id,
            document_revision,
            source_type,
            excerpt,
            location_json,
            now
        ],
    )
    .map_err(|e| format!("插入来源锚点失败: {}", e))?;

    Ok(anchor_id)
}

#[tauri::command]
pub fn db_get_anchors(
    state: tauri::State<'_, DbState>,
    document_id: String,
) -> Result<Vec<SourceAnchorRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at
             FROM source_anchors WHERE document_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| format!("准备查询锚点语句失败: {}", e))?;

    let rows = stmt
        .query_map(params![document_id], |row| {
            Ok(SourceAnchorRecord {
                anchor_id: row.get(0)?,
                document_id: row.get(1)?,
                document_revision: row.get(2)?,
                source_type: row.get(3)?,
                excerpt: row.get(4)?,
                location_json: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("查询锚点失败: {}", e))?;

    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
pub fn db_create_card(
    state: tauri::State<'_, DbState>,
    document_id: String,
    anchor_id: Option<String>,
    action: String,
    depth: String,
    status: String,
    user_prompt: String,
    ai_response: String,
    model_name: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let card_id = format!("crd_{}", Uuid::new_v4().simple());
    let now = now_ms();

    conn.execute(
        "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, error_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
        params![
            card_id,
            document_id,
            anchor_id,
            action,
            depth,
            status,
            user_prompt,
            ai_response,
            model_name,
            now,
            now
        ],
    )
    .map_err(|e| format!("插入卡片记录失败: {}", e))?;

    Ok(card_id)
}

#[tauri::command]
pub fn db_update_card_stream(
    state: tauri::State<'_, DbState>,
    card_id: String,
    ai_response: String,
    status: String,
    error_message: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "UPDATE cards SET ai_response = ?1, status = ?2, error_message = ?3, updated_at = ?4 WHERE card_id = ?5",
        params![ai_response, status, error_message, now, card_id],
    )
    .map_err(|e| format!("更新流式卡片数据失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn db_create_card_turn(
    state: tauri::State<'_, DbState>,
    card_id: String,
    turn_id: Option<String>,
    user_prompt: String,
    status: Option<String>,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tid = turn_id.unwrap_or_else(|| format!("trn_{}", Uuid::new_v4().simple()));
    let stat = status.unwrap_or_else(|| "queued".to_string());
    let now = now_ms();

    conn.execute(
        "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5)",
        params![tid, card_id, user_prompt, stat, now],
    )
    .map_err(|e| format!("创建追问轮次失败: {}", e))?;

    let _ = conn.execute(
        "UPDATE cards SET updated_at = ?1 WHERE card_id = ?2",
        params![now, card_id],
    );

    Ok(tid)
}

#[tauri::command]
pub fn db_update_card_turn_stream(
    state: tauri::State<'_, DbState>,
    turn_id: String,
    ai_response: String,
    status: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();

    conn.execute(
        "UPDATE card_turns SET ai_response = ?1, status = ?2 WHERE turn_id = ?3",
        params![ai_response, status, turn_id],
    )
    .map_err(|e| format!("更新追问流式数据失败: {}", e))?;

    let _ = conn.execute(
        "UPDATE cards SET updated_at = ?1 WHERE card_id = (SELECT card_id FROM card_turns WHERE turn_id = ?2)",
        params![now, turn_id],
    );

    Ok(())
}

#[tauri::command]
pub fn db_save_card_turn(
    state: tauri::State<'_, DbState>,
    card_id: String,
    user_prompt: String,
    ai_response: String,
    status: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let turn_id = format!("trn_{}", Uuid::new_v4().simple());
    let now = now_ms();

    conn.execute(
        "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![turn_id, card_id, user_prompt, ai_response, status, now],
    )
    .map_err(|e| format!("保存追问轮次失败: {}", e))?;

    // 同步更新卡片的 updated_at
    let _ = conn.execute(
        "UPDATE cards SET updated_at = ?1 WHERE card_id = ?2",
        params![now, card_id],
    );

    Ok(turn_id)
}

pub fn allocate_function_version_internal(
    conn: &Connection,
    card_id: &str,
    mode: &str,
) -> Result<i64, String> {
    let mut stmt = conn
        .prepare("SELECT latest_version FROM card_function_versions WHERE card_id = ?1 AND mode = ?2")
        .map_err(|e| e.to_string())?;

    let existing_ver: Option<i64> = stmt
        .query_row(params![card_id, mode], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    let next_ver = match existing_ver {
        Some(v) => v + 1,
        None => {
            let curr_in_res: Option<i64> = conn
                .query_row(
                    "SELECT version FROM card_function_results WHERE card_id = ?1 AND mode = ?2",
                    params![card_id, mode],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            curr_in_res.unwrap_or(0) + 1
        }
    };

    conn.execute(
        "INSERT INTO card_function_versions (card_id, mode, latest_version)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(card_id, mode) DO UPDATE SET latest_version = ?3",
        params![card_id, mode, next_ver],
    )
    .map_err(|e| format!("分配功能生成版本号失败: {}", e))?;

    Ok(next_ver)
}

#[tauri::command]
pub fn db_allocate_function_version(
    state: tauri::State<'_, DbState>,
    card_id: String,
    mode: String,
) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    allocate_function_version_internal(&conn, &card_id, &mode)
}

pub fn save_function_result_internal(
    conn: &Connection,
    card_id: &str,
    mode: &str,
    result_content: &str,
    config_signature: Option<&str>,
    version: Option<i64>,
) -> Result<String, String> {
    let result_id = format!("fnr_{}", Uuid::new_v4().simple());
    let now = now_ms();

    // 校验版本机制：如果传入版本号低于当前已注册的最新版本或已有结果版本，则拒绝覆盖！
    if let Some(req_ver) = version {
        let active_ver: Option<i64> = conn
            .query_row(
                "SELECT latest_version FROM card_function_versions WHERE card_id = ?1 AND mode = ?2",
                params![card_id, mode],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);

        if let Some(act) = active_ver {
            if req_ver < act {
                return Ok("superseded".to_string());
            }
        }

        let existing_res_ver: Option<i64> = conn
            .query_row(
                "SELECT version FROM card_function_results WHERE card_id = ?1 AND mode = ?2",
                params![card_id, mode],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);

        if let Some(ex_ver) = existing_res_ver {
            if req_ver < ex_ver {
                return Ok("superseded".to_string());
            }
        }
    }

    let ver_to_save = version.unwrap_or(1);

    conn.execute(
        "INSERT INTO card_function_results (result_id, card_id, mode, result_content, created_at, config_signature, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(card_id, mode) DO UPDATE SET 
            result_content = ?4, 
            created_at = ?5,
            config_signature = ?6,
            version = ?7",
        params![result_id, card_id, mode, result_content, now, config_signature, ver_to_save],
    )
    .map_err(|e| format!("保存功能切页结果失败: {}", e))?;

    let _ = conn.execute(
        "INSERT INTO card_function_versions (card_id, mode, latest_version)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(card_id, mode) DO UPDATE SET latest_version = MAX(latest_version, ?3)",
        params![card_id, mode, ver_to_save],
    );

    Ok(result_id)
}

#[tauri::command]
pub fn db_save_function_result(
    state: tauri::State<'_, DbState>,
    card_id: String,
    mode: String,
    result_content: String,
    config_signature: Option<String>,
    version: Option<i64>,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    save_function_result_internal(
        &conn,
        &card_id,
        &mode,
        &result_content,
        config_signature.as_deref(),
        version,
    )
}

pub fn get_cards_internal(
    conn: &Connection,
    document_id: &str,
    limit: i64,
    offset: i64,
    filter_type: Option<&str>,
    cursor_created_at: Option<i64>,
    cursor_card_id: Option<&str>,
) -> Result<CardListResponse, String> {
    let filter = filter_type.unwrap_or("all");

    // 统计总数 (与查询过滤条件严格保持 100% 一致)
    let (count_sql, count_params): (String, Vec<rusqlite::types::Value>) = if filter == "all" {
        (
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1".to_string(),
            vec![rusqlite::types::Value::from(document_id.to_string())],
        )
    } else if filter == "qa" || filter == "Ask" {
        (
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1 AND action = 'Ask'".to_string(),
            vec![rusqlite::types::Value::from(document_id.to_string())],
        )
    } else if filter == "actions" {
        (
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1 AND action != 'Ask'".to_string(),
            vec![rusqlite::types::Value::from(document_id.to_string())],
        )
    } else {
        (
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1 AND action = ?2".to_string(),
            vec![
                rusqlite::types::Value::from(document_id.to_string()),
                rusqlite::types::Value::from(filter.to_string()),
            ],
        )
    };

    let total: i64 = {
        let mut count_stmt = conn.prepare(&count_sql).map_err(|e| e.to_string())?;
        let count_params_slice: Vec<&dyn rusqlite::ToSql> = count_params
            .iter()
            .map(|v| v as &dyn rusqlite::ToSql)
            .collect();
        count_stmt
            .query_row(&count_params_slice[..], |r| r.get(0))
            .unwrap_or(0)
    };

    let (sql, params_vec): (String, Vec<rusqlite::types::Value>) = {
        let mut conditions = vec!["c.document_id = ?".to_string()];
        let mut p = vec![rusqlite::types::Value::from(document_id.to_string())];

        if filter == "qa" || filter == "Ask" {
            conditions.push("c.action = 'Ask'".to_string());
        } else if filter == "actions" {
            conditions.push("c.action != 'Ask'".to_string());
        } else if filter != "all" {
            conditions.push("c.action = ?".to_string());
            p.push(rusqlite::types::Value::from(filter.to_string()));
        }

        if let Some(cursor_time) = cursor_created_at {
            if let Some(cursor_id) = cursor_card_id {
                conditions.push(
                    "(c.created_at < ? OR (c.created_at = ? AND c.card_id < ?))".to_string(),
                );
                p.push(rusqlite::types::Value::from(cursor_time));
                p.push(rusqlite::types::Value::from(cursor_time));
                p.push(rusqlite::types::Value::from(cursor_id.to_string()));
            } else {
                conditions.push("c.created_at < ?".to_string());
                p.push(rusqlite::types::Value::from(cursor_time));
            }
        }

        let where_clause = conditions.join(" AND ");
        let q = format!(
            "SELECT c.card_id, c.document_id, c.anchor_id, c.action, c.depth, c.status,
                    c.user_prompt, SUBSTR(c.ai_response, 1, 400) AS preview, '' AS ai_response, c.model_name, c.error_message, c.created_at, c.updated_at,
                    a.excerpt, a.source_type, a.location_json,
                    (SELECT COUNT(*) FROM card_turns t WHERE t.card_id = c.card_id) as turns_count
             FROM cards c
             LEFT JOIN source_anchors a ON c.anchor_id = a.anchor_id
             WHERE {}
             ORDER BY c.created_at DESC, c.card_id DESC
             LIMIT ? OFFSET ?",
            where_clause
        );

        p.push(rusqlite::types::Value::from(limit + 1));
        p.push(rusqlite::types::Value::from(offset));
        (q, p)
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|v| v as &dyn rusqlite::ToSql)
        .collect();

    let rows = stmt
        .query_map(&params_slice[..], map_card_row)
        .map_err(|e| format!("查询卡片列表失败: {}", e))?;

    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }

    let has_more = items.len() > (limit as usize);
    if has_more {
        items.truncate(limit as usize);
    }

    Ok(CardListResponse {
        items,
        total,
        has_more,
    })
}

#[tauri::command]
pub fn db_get_cards(
    state: tauri::State<'_, DbState>,
    document_id: String,
    limit: i64,
    offset: i64,
    filter_type: Option<String>,
    cursor_created_at: Option<i64>,
    cursor_card_id: Option<String>,
) -> Result<CardListResponse, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_cards_internal(
        &conn,
        &document_id,
        limit,
        offset,
        filter_type.as_deref(),
        cursor_created_at,
        cursor_card_id.as_deref(),
    )
}

pub fn get_cards_by_anchor_ids_internal(
    conn: &Connection,
    document_id: &str,
    anchor_ids: &[String],
) -> Result<Vec<CardRecord>, String> {
    if anchor_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = (0..anchor_ids.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT c.card_id, c.document_id, c.anchor_id, c.action, c.depth, c.status,
                c.user_prompt, SUBSTR(c.ai_response, 1, 400) AS preview, '' AS ai_response, c.model_name, c.error_message, c.created_at, c.updated_at,
                a.excerpt, a.source_type, a.location_json,
                (SELECT COUNT(*) FROM card_turns t WHERE t.card_id = c.card_id) as turns_count
         FROM cards c
         LEFT JOIN source_anchors a ON c.anchor_id = a.anchor_id
         WHERE c.document_id = ? AND c.anchor_id IN ({})
         ORDER BY c.created_at DESC, c.card_id DESC",
        placeholders.join(",")
    );

    let mut params_vec: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::from(document_id.to_string())];
    for aid in anchor_ids {
        params_vec.push(rusqlite::types::Value::from(aid.clone()));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_slice: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|v| v as &dyn rusqlite::ToSql)
        .collect();

    let rows = stmt
        .query_map(&params_slice[..], map_card_row)
        .map_err(|e| format!("根据锚点列表查询卡片失败: {}", e))?;

    let mut items = Vec::new();
    for r in rows {
        items.push(r.map_err(|e| e.to_string())?);
    }

    Ok(items)
}

#[tauri::command]
pub fn db_get_cards_by_anchor_ids(
    state: tauri::State<'_, DbState>,
    document_id: String,
    anchor_ids: Vec<String>,
) -> Result<Vec<CardRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_cards_by_anchor_ids_internal(&conn, &document_id, &anchor_ids)
}

fn map_card_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CardRecord> {
    Ok(CardRecord {
        card_id: row.get(0)?,
        document_id: row.get(1)?,
        anchor_id: row.get(2)?,
        action: row.get(3)?,
        depth: row.get(4)?,
        status: row.get(5)?,
        user_prompt: row.get(6)?,
        preview: row.get(7)?,
        ai_response: row.get(8)?,
        model_name: row.get(9)?,
        error_message: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        anchor_excerpt: row.get(13)?,
        anchor_source_type: row.get(14)?,
        anchor_location_json: row.get(15)?,
        turns_count: row.get(16)?,
    })
}

pub fn get_card_detail_internal(
    conn: &Connection,
    card_id: &str,
) -> Result<FullCardDetail, String> {
    let card = conn
        .query_row(
            "SELECT c.card_id, c.document_id, c.anchor_id, c.action, c.depth, c.status,
                    c.user_prompt, SUBSTR(c.ai_response, 1, 400) AS preview, c.ai_response, c.model_name, c.error_message, c.created_at, c.updated_at,
                    a.excerpt, a.source_type, a.location_json,
                    (SELECT COUNT(*) FROM card_turns t WHERE t.card_id = c.card_id) as turns_count
             FROM cards c
             LEFT JOIN source_anchors a ON c.anchor_id = a.anchor_id
             WHERE c.card_id = ?1",
            params![card_id],
            map_card_row,
        )
        .map_err(|e| format!("查询卡片详情失败: {}", e))?;

    let anchor = if let Some(ref anc_id) = card.anchor_id {
        conn.query_row(
            "SELECT anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at
             FROM source_anchors WHERE anchor_id = ?1",
            params![anc_id],
            |row| {
                Ok(SourceAnchorRecord {
                    anchor_id: row.get(0)?,
                    document_id: row.get(1)?,
                    document_revision: row.get(2)?,
                    source_type: row.get(3)?,
                    excerpt: row.get(4)?,
                    location_json: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
    } else {
        None
    };

    // 查 turns
    let mut turns_stmt = conn
        .prepare(
            "SELECT turn_id, card_id, user_prompt, ai_response, status, created_at
             FROM card_turns WHERE card_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let turns_rows = turns_stmt
        .query_map(params![card_id], |row| {
            Ok(CardTurnRecord {
                turn_id: row.get(0)?,
                card_id: row.get(1)?,
                user_prompt: row.get(2)?,
                ai_response: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut turns = Vec::new();
    for t in turns_rows {
        turns.push(t.map_err(|e| e.to_string())?);
    }

    // 查 function_results
    let mut fn_stmt = conn
        .prepare(
            "SELECT result_id, card_id, mode, result_content, created_at, config_signature, version
             FROM card_function_results WHERE card_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let fn_rows = fn_stmt
        .query_map(params![card_id], |row| {
            Ok(CardFunctionResultRecord {
                result_id: row.get(0)?,
                card_id: row.get(1)?,
                mode: row.get(2)?,
                result_content: row.get(3)?,
                created_at: row.get(4)?,
                config_signature: row.get(5)?,
                version: row.get::<_, Option<i64>>(6)?.unwrap_or(1),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut function_results = Vec::new();
    for f in fn_rows {
        function_results.push(f.map_err(|e| e.to_string())?);
    }

    Ok(FullCardDetail {
        card,
        anchor,
        turns,
        function_results,
    })
}

#[tauri::command]
pub fn db_get_card_detail(
    state: tauri::State<'_, DbState>,
    card_id: String,
) -> Result<FullCardDetail, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    get_card_detail_internal(&conn, &card_id)
}

fn cleanup_anchor_and_assets(conn: &Connection, assets_dir: &std::path::Path, anc_id: &str) {
    let location_json: Option<String> = conn
        .query_row(
            "SELECT location_json FROM source_anchors WHERE anchor_id = ?1",
            params![anc_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);

    let mut asset_id_to_check: Option<String> = None;
    if let Some(ref loc) = location_json {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(loc) {
            if let Some(aid) = val.get("location").and_then(|l| l.get("assetId")).and_then(|a| a.as_str()) {
                asset_id_to_check = Some(aid.to_string());
            } else if let Some(aid) = val.get("assetId").and_then(|a| a.as_str()) {
                asset_id_to_check = Some(aid.to_string());
            }
        }
    }

    let _ = conn.execute("DELETE FROM source_anchors WHERE anchor_id = ?1", params![anc_id]);

    if let Some(aid) = asset_id_to_check {
        let pattern = format!("%{}%", aid);
        let remaining_refs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM source_anchors WHERE location_json LIKE ?1",
                params![pattern],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if remaining_refs == 0 {
            if let Ok(rel_path) = conn.query_row(
                "SELECT file_path FROM assets WHERE asset_id = ?1",
                params![aid],
                |r| r.get::<_, String>(0),
            ) {
                let _ = fs::remove_file(assets_dir.join(rel_path));
            }
            let _ = conn.execute("DELETE FROM assets WHERE asset_id = ?1", params![aid]);
        }
    }
}

pub fn delete_card_internal(
    conn: &Connection,
    assets_dir: &std::path::Path,
    card_id: &str,
) -> Result<(), String> {
    // 获取 anchor_id，看是否还有其他卡片或高亮共享该 anchor
    let anchor_id: Option<String> = conn
        .query_row(
            "SELECT anchor_id FROM cards WHERE card_id = ?1",
            params![card_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);

    conn.execute("DELETE FROM cards WHERE card_id = ?1", params![card_id])
        .map_err(|e| format!("删除卡片失败: {}", e))?;

    // 如果该 anchor 没有其他卡片且没有高亮引用，可清理孤立 anchor 及关联物理资产
    if let Some(anc_id) = anchor_id {
        let card_ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE anchor_id = ?1",
                params![anc_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let hl_ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM highlights WHERE anchor_id = ?1",
                params![anc_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if card_ref_count == 0 && hl_ref_count == 0 {
            cleanup_anchor_and_assets(conn, assets_dir, &anc_id);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn db_delete_card(
    state: tauri::State<'_, DbState>,
    card_id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    delete_card_internal(&conn, &state.assets_dir, &card_id)
}

#[tauri::command]
pub fn db_create_highlight(
    state: tauri::State<'_, DbState>,
    document_id: String,
    anchor_id: String,
    color: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let highlight_id = format!("hl_{}", Uuid::new_v4().simple());
    let now = now_ms();

    conn.execute(
        "INSERT INTO highlights (highlight_id, document_id, anchor_id, color, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![highlight_id, document_id, anchor_id, color, now],
    )
    .map_err(|e| format!("创建高亮失败: {}", e))?;

    Ok(highlight_id)
}

#[tauri::command]
pub fn db_get_highlights(
    state: tauri::State<'_, DbState>,
    document_id: String,
) -> Result<Vec<HighlightRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT h.highlight_id, h.document_id, h.anchor_id, h.color, h.created_at,
                    a.excerpt, a.location_json, a.source_type
             FROM highlights h
             JOIN source_anchors a ON h.anchor_id = a.anchor_id
             WHERE h.document_id = ?1
             ORDER BY h.created_at ASC",
        )
        .map_err(|e| format!("准备查询高亮语句失败: {}", e))?;

    let rows = stmt
        .query_map(params![document_id], |row| {
            Ok(HighlightRecord {
                highlight_id: row.get(0)?,
                document_id: row.get(1)?,
                anchor_id: row.get(2)?,
                color: row.get(3)?,
                created_at: row.get(4)?,
                excerpt: row.get(5)?,
                location_json: row.get(6)?,
                source_type: row.get(7)?,
            })
        })
        .map_err(|e| format!("查询高亮失败: {}", e))?;

    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
pub fn db_delete_highlight(
    state: tauri::State<'_, DbState>,
    highlight_id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

    let anchor_id: Option<String> = conn
        .query_row(
            "SELECT anchor_id FROM highlights WHERE highlight_id = ?1",
            params![highlight_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);

    conn.execute(
        "DELETE FROM highlights WHERE highlight_id = ?1",
        params![highlight_id],
    )
    .map_err(|e| format!("删除高亮失败: {}", e))?;

    if let Some(anc_id) = anchor_id {
        let card_ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE anchor_id = ?1",
                params![anc_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let hl_ref_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM highlights WHERE anchor_id = ?1",
                params![anc_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if card_ref_count == 0 && hl_ref_count == 0 {
            cleanup_anchor_and_assets(&conn, &state.assets_dir, &anc_id);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn db_export_document_markdown(
    state: tauri::State<'_, DbState>,
    document_id: String,
) -> Result<String, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let doc_name: String = conn
        .query_row(
            "SELECT display_name FROM documents WHERE id = ?1",
            params![document_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "FlowRead 学习笔记".to_string());

    let mut out = String::new();
    out.push_str(&format!("# {} · 完整学习记录\n\n", doc_name));

    // 获取所有高亮
    let mut hl_stmt = conn
        .prepare(
            "SELECT a.excerpt, h.color, h.created_at
             FROM highlights h
             JOIN source_anchors a ON h.anchor_id = a.anchor_id
             WHERE h.document_id = ?1 ORDER BY h.created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let hls = hl_stmt
        .query_map(params![document_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut hl_count = 0;
    let mut hl_section = String::from("## 划词高亮\n\n");
    for h in hls {
        if let Ok((excerpt, color, _)) = h {
            hl_count += 1;
            hl_section.push_str(&format!("- [{}] 「{}」\n", color, excerpt));
        }
    }
    if hl_count > 0 {
        out.push_str(&hl_section);
        out.push_str("\n---\n\n");
    }

    // 获取所有卡片及其追问
    let mut card_stmt = conn
        .prepare(
            "SELECT c.card_id, c.action, c.depth, c.user_prompt, c.ai_response, a.excerpt, c.created_at
             FROM cards c
             LEFT JOIN source_anchors a ON c.anchor_id = a.anchor_id
             WHERE c.document_id = ?1 ORDER BY c.created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let card_rows = card_stmt
        .query_map(params![document_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    out.push_str("## 思考与伴读卡片\n\n");
    let mut card_idx = 1;
    for c in card_rows {
        if let Ok((cid, action, depth, prompt, resp, excerpt, _)) = c {
            out.push_str(&format!("### {}. 【{}】({})\n\n", card_idx, action, depth));
            if let Some(exc) = excerpt {
                if !exc.is_empty() {
                    out.push_str(&format!("> 来源原文：\n> 「{}」\n\n", exc));
                }
            }
            if !prompt.is_empty() {
                out.push_str(&format!("**提问 / 指令**：{}\n\n", prompt));
            }
            out.push_str(&format!("**回答**：\n\n{}\n\n", resp));

            // 获取该卡片的追问轮次
            let mut turn_stmt = conn
                .prepare(
                    "SELECT user_prompt, ai_response FROM card_turns WHERE card_id = ?1 ORDER BY created_at ASC",
                )
                .map_err(|e| e.to_string())?;
            let turn_rows = turn_stmt
                .query_map(params![cid], |tr| {
                    Ok((tr.get::<_, String>(0)?, tr.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;

            let mut turn_idx = 1;
            for tr in turn_rows {
                if let Ok((t_prompt, t_resp)) = tr {
                    out.push_str(&format!(
                        "#### 追问 {}:\n\n**问**：{}\n\n**答**：\n\n{}\n\n",
                        turn_idx, t_prompt, t_resp
                    ));
                    turn_idx += 1;
                }
            }

            out.push_str("---\n\n");
            card_idx += 1;
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrations_and_idempotence() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY;",
        ).unwrap();

        assert!(run_migrations(&conn).is_ok());
        // Run again to ensure migrations are idempotent
        assert!(run_migrations(&conn).is_ok());

        // Check tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(tables.contains(&"documents".to_string()));
        assert!(tables.contains(&"source_anchors".to_string()));
        assert!(tables.contains(&"cards".to_string()));
        assert!(tables.contains(&"card_turns".to_string()));
        assert!(tables.contains(&"card_function_results".to_string()));
        assert!(tables.contains(&"highlights".to_string()));
        assert!(tables.contains(&"reading_preferences".to_string()));
    }

    #[test]
    fn test_document_and_anchor_lifecycle() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let doc_id = "doc_test_1";
        let now = now_ms();
        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![doc_id, "C:/test/file.pdf", "file.pdf", 1024, "rev1", now, now],
        ).unwrap();

        let anc_id = "anc_test_1";
        conn.execute(
            "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![anc_id, doc_id, "rev1", "pdf_text", "Some excerpt", "{}", now],
        ).unwrap();

        let card_id = "card_test_1";
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![card_id, doc_id, anc_id, "ask", "quick", "generating", "Explain this", "", "gemini-1.5-flash", now, now],
        ).unwrap();

        // Also test card turns and function results
        conn.execute(
            "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params!["turn_1", card_id, "What about step 2?", "Here is step 2", "completed", now],
        ).unwrap();

        conn.execute(
            "INSERT INTO card_function_results (result_id, card_id, mode, result_content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["fr_1", card_id, "explain", "Detailed explanation text", now],
        ).unwrap();

        // Check startup recovery: generating becomes interrupted
        let count_updated = conn.execute(
            "UPDATE cards SET status = 'interrupted' WHERE status IN ('queued', 'generating')",
            [],
        ).unwrap();
        assert_eq!(count_updated, 1);

        let status: String = conn.query_row(
            "SELECT status FROM cards WHERE card_id = ?1",
            params![card_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(status, "interrupted");

        let turn_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM card_turns WHERE card_id = ?1",
            params![card_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(turn_count, 1);

        let fr_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM card_function_results WHERE card_id = ?1",
            params![card_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(fr_count, 1);
    }

    #[test]
    fn test_highlight_and_orphan_cleanup() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let doc_id = "doc_hl_test";
        let now = now_ms();
        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![doc_id, "C:/test/sample.txt", "sample.txt", 500, "rev1", now, now],
        ).unwrap();

        let anc_id = "anc_hl_1";
        conn.execute(
            "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![anc_id, doc_id, "rev1", "text", "Highlighted quote", "{}", now],
        ).unwrap();

        let hl_id = "hl_1";
        conn.execute(
            "INSERT INTO highlights (highlight_id, document_id, anchor_id, color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hl_id, doc_id, anc_id, "yellow", now],
        ).unwrap();

        // Simulate db_delete_highlight logic
        let card_ref_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE anchor_id = ?1",
            params![anc_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(card_ref_count, 0);

        conn.execute("DELETE FROM highlights WHERE highlight_id = ?1", params![hl_id]).unwrap();

        let hl_ref_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM highlights WHERE anchor_id = ?1",
            params![anc_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(hl_ref_count, 0);

        // Orphan anchor should be deleted
        conn.execute("DELETE FROM source_anchors WHERE anchor_id = ?1", params![anc_id]).unwrap();

        let anc_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM source_anchors WHERE anchor_id = ?1",
            params![anc_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(anc_count, 0);
    }

    #[test]
    fn test_follow_up_turn_does_not_overwrite_card_answer() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let doc_id = "doc_turn_isolation";
        let now = now_ms();
        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![doc_id, "C:/test/file.pdf", "file.pdf", 1024, "rev1", now, now],
        ).unwrap();

        let card_id = "card_init_1";
        let initial_answer = "This is the primary initial answer to the card.";
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![card_id, doc_id, "ask", "quick", "completed", "Initial question", initial_answer, "model", now, now],
        ).unwrap();

        let turn_id = "turn_stream_1";
        conn.execute(
            "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
             VALUES (?1, ?2, ?3, '', 'generating', ?4)",
            params![turn_id, card_id, "Follow up question", now],
        ).unwrap();

        // Stream updates turn
        let turn_answer = "This is the streamed follow up response.";
        conn.execute(
            "UPDATE card_turns SET ai_response = ?1, status = 'completed' WHERE turn_id = ?2",
            params![turn_answer, turn_id],
        ).unwrap();

        // Verify card's ai_response was NOT overwritten!
        let card_res: String = conn.query_row(
            "SELECT ai_response FROM cards WHERE card_id = ?1",
            params![card_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(card_res, initial_answer);

        // Verify turn's ai_response is the new response
        let turn_res: String = conn.query_row(
            "SELECT ai_response FROM card_turns WHERE turn_id = ?1",
            params![turn_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(turn_res, turn_answer);

        // Verify startup recovery marks generating turns as interrupted
        let turn2_id = "turn_generating_2";
        conn.execute(
            "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
             VALUES (?1, ?2, ?3, 'partial text', 'generating', ?4)",
            params![turn2_id, card_id, "Another follow up", now],
        ).unwrap();

        conn.execute(
            "UPDATE card_turns SET status = 'interrupted' WHERE status IN ('queued', 'generating')",
            [],
        ).unwrap();

        let turn2_status: String = conn.query_row(
            "SELECT status FROM card_turns WHERE turn_id = ?1",
            params![turn2_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(turn2_status, "interrupted");
    }

    #[test]
    fn test_benchmark_performance_scale_0_100_10000() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let doc_id = "doc_benchmark_scale";
        let now = now_ms();
        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![doc_id, "C:/test/benchmark.pdf", "benchmark.pdf", 1024 * 1024, "rev1", now, now],
        ).unwrap();

        // 1. 测试 0 条记录基线
        let t0 = std::time::Instant::now();
        let total_0: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1",
            params![doc_id],
            |r| r.get(0),
        ).unwrap();
        let query_0_dur = t0.elapsed();
        assert_eq!(total_0, 0);
        println!("[Benchmark] 0 条记录查询耗时: {:?}", query_0_dur);

        // 2. 测试 100 条记录规模
        let tx = conn.transaction().unwrap();
        for i in 0..100 {
            let c_id = format!("card_100_{}", i);
            let c_time = now + i as i64;
            let long_response = format!("## Paragraph {}\n\n{}", i, "A".repeat(2000));
            tx.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'Ask', 'quick', 'completed', 'Prompt', ?3, 'model', ?4, ?4)",
                params![c_id, doc_id, long_response, c_time],
            ).unwrap();
        }
        tx.commit().unwrap();

        // 验证 100 条记录首屏与轻量级预览切片 (SUBSTR 400)
        let t100_start = std::time::Instant::now();
        let mut stmt_100 = conn.prepare(
            "SELECT c.card_id, SUBSTR(c.ai_response, 1, 400) FROM cards c
             WHERE c.document_id = ?1 ORDER BY c.created_at DESC LIMIT 50"
        ).unwrap();
        let rows_100: Vec<(String, String)> = stmt_100.query_map(params![doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        }).unwrap().map(|r| r.unwrap()).collect();
        let dur_100_page1 = t100_start.elapsed();
        assert_eq!(rows_100.len(), 50);
        assert!(rows_100[0].1.len() <= 400); // 确保严格轻量预览
        println!("[Benchmark] 100 条记录首屏加载耗时: {:?}", dur_100_page1);
        drop(stmt_100);

        // 3. 测试 10,000 条记录规模
        let t_insert_10k = std::time::Instant::now();
        let tx_10k = conn.transaction().unwrap();
        for i in 100..10000 {
            let c_id = format!("card_10k_{}", i);
            let c_time = now + i as i64;
            let sample_ai = format!("AI Response content block {} for benchmark performance.", i);
            tx_10k.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'Ask', 'quick', 'completed', 'Prompt', ?3, 'model', ?4, ?4)",
                params![c_id, doc_id, sample_ai, c_time],
            ).unwrap();
        }
        tx_10k.commit().unwrap();
        println!("[Benchmark] 批量写入 10,000 条记录耗时: {:?}", t_insert_10k.elapsed());

        // 验证 10,000 条记录总数统计
        let total_10k: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1",
            params![doc_id],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(total_10k, 10000);

        // 验证 10,000 条记录首屏 50 条快速游标查询（索引加速）
        let t_10k_page1 = std::time::Instant::now();
        let mut stmt_10k = conn.prepare(
            "SELECT c.card_id, c.created_at, SUBSTR(c.ai_response, 1, 400) FROM cards c
             WHERE c.document_id = ?1 ORDER BY c.created_at DESC LIMIT 50"
        ).unwrap();
        let p1_10k: Vec<(String, i64, String)> = stmt_10k.query_map(params![doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        }).unwrap().map(|r| r.unwrap()).collect();
        let dur_10k_page1 = t_10k_page1.elapsed();
        assert_eq!(p1_10k.len(), 50);
        println!("[Benchmark] 10,000 条记录首屏加载耗时: {:?}", dur_10k_page1);
        assert!(dur_10k_page1.as_millis() < 50); // 首屏必须低于 50ms (通常 < 2ms)
        drop(stmt_10k);

        // 验证深层游标分页 (利用 created_at 索引进行 O(log N) 检索)
        let middle_cursor = p1_10k[49].1;
        let t_cursor = std::time::Instant::now();
        let mut stmt_cursor = conn.prepare(
            "SELECT c.card_id, c.created_at, SUBSTR(c.ai_response, 1, 400) FROM cards c
             WHERE c.document_id = ?1 AND c.created_at < ?2 ORDER BY c.created_at DESC LIMIT 50"
        ).unwrap();
        let p2_10k: Vec<(String, i64, String)> = stmt_cursor.query_map(params![doc_id, middle_cursor], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        }).unwrap().map(|r| r.unwrap()).collect();
        let dur_cursor = t_cursor.elapsed();
        assert_eq!(p2_10k.len(), 50);
        println!("[Benchmark] 10,000 条记录游标分页耗时: {:?}", dur_cursor);
        assert!(dur_cursor.as_millis() < 20); // 游标翻页必须低于 20ms
        drop(stmt_cursor);

        // 验证 10,000 条记录全量 Markdown 导出生成性能
        let t_export = std::time::Instant::now();
        let mut export_stmt = conn.prepare(
            "SELECT c.action, c.depth, c.user_prompt, c.ai_response, a.excerpt
             FROM cards c
             LEFT JOIN source_anchors a ON c.anchor_id = a.anchor_id
             WHERE c.document_id = ?1
             ORDER BY c.created_at ASC"
        ).unwrap();
        let mut md_out = String::with_capacity(1024 * 1024);
        let export_rows = export_stmt.query_map(params![doc_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?))
        }).unwrap();
        for r in export_rows {
            let (action, depth, user_prompt, ai_response, excerpt) = r.unwrap();
            md_out.push_str(&format!("### {} ({})\n", action, depth));
            if let Some(ex) = excerpt {
                md_out.push_str(&format!("> {}\n\n", ex));
            }
            if !user_prompt.is_empty() {
                md_out.push_str(&format!("**Q**: {}\n\n", user_prompt));
            }
            md_out.push_str(&format!("**A**:\n{}\n\n", ai_response));
        }
        let dur_export = t_export.elapsed();
        println!("[Benchmark] 10,000 条记录全量 Markdown 导出耗时: {:?}, 导出尺寸: {} KB", dur_export, md_out.len() / 1024);
        assert!(dur_export.as_millis() < 500); // 10,000 条导出必须在 500ms 内完成
    }

    #[test]
    fn test_composite_cursor_pagination_51_records_same_millisecond() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_id = "doc_ms_51";
        let fixed_time = 1700000000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/doc.pdf', 'doc.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, fixed_time],
        ).unwrap();

        // 插入 51 条同毫秒记录，卡片 ID 格式为 crd_00 到 crd_50
        for i in 0..51 {
            let card_id = format!("crd_{:02}", i);
            conn.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'Ask', 'quick', 'completed', 'Q', 'A', 'model', ?3, ?3)",
                params![card_id, doc_id, fixed_time],
            ).unwrap();
        }

        // 第 1 页：请求 limit = 50
        let p1 = get_cards_internal(
            &conn,
            doc_id,
            50,
            0,
            Some("all"),
            None,
            None,
        ).unwrap();

        assert_eq!(p1.items.len(), 50);
        assert!(p1.has_more, "第 1 页后应还有更多记录");
        assert_eq!(p1.total, 51);

        let last_item = &p1.items[49];
        assert_eq!(last_item.created_at, fixed_time);

        // 第 2 页：使用复合游标 (created_at, card_id) 翻页
        let p2 = get_cards_internal(
            &conn,
            doc_id,
            50,
            0,
            Some("all"),
            Some(last_item.created_at),
            Some(&last_item.card_id),
        ).unwrap();

        assert_eq!(p2.items.len(), 1, "第 2 页应正好返回剩余的 1 条记录");
        assert!(!p2.has_more, "第 2 页已无更多记录");

        // 校验 51 条卡片无遗漏、无重复
        let mut all_ids: Vec<String> = p1.items.into_iter().map(|c| c.card_id).collect();
        all_ids.extend(p2.items.into_iter().map(|c| c.card_id));
        assert_eq!(all_ids.len(), 51);

        let mut unique_ids = all_ids.clone();
        unique_ids.sort();
        unique_ids.dedup();
        assert_eq!(unique_ids.len(), 51, "所有 51 条卡片 ID 必须完全唯一且无遗漏");
    }

    #[test]
    fn test_db_filter_action_cards_when_latest_50_are_ask() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_id = "doc_filter_test";
        let base_time = 1000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/doc.pdf', 'doc.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, base_time],
        ).unwrap();

        // 插入 5 条较早的指令卡片 (action = 'explain', time = base_time + 0..5)
        for i in 0..5 {
            let card_id = format!("action_card_{}", i);
            conn.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'explain', 'quick', 'completed', 'Q', 'Explanation', 'model', ?3, ?3)",
                params![card_id, doc_id, base_time + i as i64],
            ).unwrap();
        }

        // 插入 50 条更新的提问卡片 (action = 'Ask', time = base_time + 100..150)
        for i in 0..50 {
            let card_id = format!("ask_card_{}", i);
            conn.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'Ask', 'quick', 'completed', 'Ask prompt', 'Answer', 'model', ?3, ?3)",
                params![card_id, doc_id, base_time + 100 + i as i64],
            ).unwrap();
        }

        // 筛选 "actions"（非 Ask 的所有指令卡片）
        let action_res = get_cards_internal(
            &conn,
            doc_id,
            50,
            0,
            Some("actions"),
            None,
            None,
        ).unwrap();

        // 验证数据库级筛选：虽然最新的 50 条全是 Ask，但仍能正确命中并返回全部 5 条旧指令卡片
        assert_eq!(action_res.total, 5, "数据库总数统计必须严格为 5");
        assert_eq!(action_res.items.len(), 5, "必须正确返回 5 条指令卡片");
        assert!(action_res.items.iter().all(|c| c.action == "explain"));
        assert!(!action_res.has_more);

        // 筛选 "qa"（Ask 卡片）
        let qa_res = get_cards_internal(
            &conn,
            doc_id,
            50,
            0,
            Some("qa"),
            None,
            None,
        ).unwrap();
        assert_eq!(qa_res.total, 50);
        assert_eq!(qa_res.items.len(), 50);
        assert!(qa_res.items.iter().all(|c| c.action == "Ask"));
    }

    #[test]
    fn test_cards_by_anchor_ids_returns_all_matching_cards_beyond_limit() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_id = "doc_anchor_batch_test";
        let base_time = 2000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/book.pdf', 'book.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, base_time],
        ).unwrap();

        // 插入锚点
        let anchor_old = "anchor_old_visible";
        conn.execute(
            "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
             VALUES (?1, ?2, 'v1', 'pdf_text', 'Excerpt', '{}', ?3)",
            params![anchor_old, doc_id, base_time],
        ).unwrap();

        // 插入 120 张卡片，其中第 5 张（很旧）绑定了 anchor_old
        for i in 0..120 {
            let card_id = format!("card_batch_{}", i);
            let anc = if i == 5 { Some(anchor_old) } else { None };
            conn.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'Ask', 'quick', 'completed', 'Q', 'Ans', 'model', ?4, ?4)",
                params![card_id, doc_id, anc, base_time + i as i64],
            ).unwrap();
        }

        // 普通分页列表只取最新 100 张
        let p_list = get_cards_internal(&conn, doc_id, 100, 0, Some("all"), None, None).unwrap();
        assert_eq!(p_list.items.len(), 100);
        assert!(!p_list.items.iter().any(|c| c.card_id == "card_batch_5"), "第 5 张属于更旧的记录，不在首 100 条列表中");

        // 跟随视图按可见锚点查询：必须能直接查到第 5 张卡片
        let anchor_cards = get_cards_by_anchor_ids_internal(&conn, doc_id, &[anchor_old.to_string()]).unwrap();
        assert_eq!(anchor_cards.len(), 1, "跟随视图必须查出该可见锚点的全部卡片");
        assert_eq!(anchor_cards[0].card_id, "card_batch_5");
    }

    #[test]
    fn test_card_detail_full_ai_response_over_600_chars_vs_preview() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_id = "doc_full_text_test";
        let card_id = "card_long_response";
        let now = 3000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/book.pdf', 'book.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, now],
        ).unwrap();

        // 生成超过 800 字的详细回答
        let long_ai_response = "长篇学术解析：".to_string() + &"这是一段详尽的哲学思辨与深度阅读分析。".repeat(40);
        assert!(long_ai_response.chars().count() > 600, "测试回答字数必须超过 600 字");

        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES (?1, ?2, NULL, 'Ask', 'deep', 'completed', '请深度阐述概念', ?3, 'model', ?4, ?4)",
            params![card_id, doc_id, long_ai_response, now],
        ).unwrap();

        // 1. 列表查询：ai_response 为空，preview 为前 400 字符截断
        let list_res = get_cards_internal(&conn, doc_id, 10, 0, Some("all"), None, None).unwrap();
        let card_in_list = &list_res.items[0];
        assert_eq!(card_in_list.card_id, card_id);
        assert!(card_in_list.ai_response.is_empty(), "列表查询中完整 ai_response 必须为空，分离传输带宽");
        assert_eq!(card_in_list.preview.chars().count(), 400, "preview 必须被截断为 400 字符摘要");

        // 2. 详情查询：返回 100% 完整长文
        let detail = get_card_detail_internal(&conn, card_id).unwrap();
        assert_eq!(detail.card.ai_response, long_ai_response, "详情查询必须完整保留 600+ 字以上全文，用于大窗、复制与追问");
    }

    #[test]
    fn test_two_running_one_queued_cancelled_on_switch() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_a = "doc_switch_a";
        let now = 4000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/book_a.pdf', 'book_a.pdf', 100, 'v1', ?2, ?2)",
            params![doc_a, now],
        ).unwrap();

        // 任务 1: 正在生成
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES ('card_run_1', ?1, NULL, 'Ask', 'quick', 'generating', 'Q1', 'Partial 1', 'model', ?2, ?2)",
            params![doc_a, now],
        ).unwrap();

        // 任务 2: 正在生成
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES ('card_run_2', ?1, NULL, 'explain', 'quick', 'generating', 'Q2', 'Partial 2', 'model', ?2 + 1, ?2 + 1)",
            params![doc_a, now],
        ).unwrap();

        // 任务 3: 排队等待
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES ('card_queued_3', ?1, NULL, 'translate', 'quick', 'queued', 'Q3', '', 'model', ?2 + 2, ?2 + 2)",
            params![doc_a, now],
        ).unwrap();

        // 任务 4: 追问排队等待
        conn.execute(
            "INSERT INTO card_turns (turn_id, card_id, user_prompt, ai_response, status, created_at)
             VALUES ('turn_queued_4', 'card_run_1', 'Follow-up Q', '', 'queued', ?1)",
            params![now + 3],
        ).unwrap();

        // 模拟切书时全部取消结算：
        // 运行中任务保留 partial text 并置为 interrupted
        conn.execute(
            "UPDATE cards SET status = 'interrupted', ai_response = 'Partial 1', updated_at = ?2 WHERE card_id = 'card_run_1'",
            params![now + 10, now + 10],
        ).unwrap();
        conn.execute(
            "UPDATE cards SET status = 'interrupted', ai_response = 'Partial 2', updated_at = ?2 WHERE card_id = 'card_run_2'",
            params![now + 10, now + 10],
        ).unwrap();
        // 排队等待任务结算为 interrupted
        conn.execute(
            "UPDATE cards SET status = 'interrupted', updated_at = ?2 WHERE card_id = 'card_queued_3'",
            params![now + 10, now + 10],
        ).unwrap();
        conn.execute(
            "UPDATE card_turns SET status = 'interrupted' WHERE turn_id = 'turn_queued_4'",
            [],
        ).unwrap();

        // 验证数据库内所有任务均处于 interrupted 状态，无遗留 queued 或 generating
        let unfinished_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE document_id = ?1 AND status IN ('queued', 'generating')",
            params![doc_a],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(unfinished_count, 0, "切书后不允许存在未结算的 queued 或 generating 卡片");

        let unfinished_turns: i64 = conn.query_row(
            "SELECT COUNT(*) FROM card_turns WHERE card_id = 'card_run_1' AND status IN ('queued', 'generating')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(unfinished_turns, 0, "切书后不允许存在未结算的 queued 追问轮次");

        // 验证卡片状态与已有生成内容完整保留
        let detail_1 = get_card_detail_internal(&conn, "card_run_1").unwrap();
        assert_eq!(detail_1.card.status, "interrupted");
        assert_eq!(detail_1.card.ai_response, "Partial 1");
        assert_eq!(detail_1.turns[0].status, "interrupted");

        let detail_3 = get_card_detail_internal(&conn, "card_queued_3").unwrap();
        assert_eq!(detail_3.card.status, "interrupted");
    }

    #[test]
    fn test_same_anchor_all_historical_and_new_cards() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let doc_id = "doc_multi_cards_anchor";
        let anchor_id = "anchor_shared_target";
        let base_time = 5000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/book.pdf', 'book.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, base_time],
        ).unwrap();

        conn.execute(
            "INSERT INTO source_anchors (anchor_id, document_id, document_revision, source_type, excerpt, location_json, created_at)
             VALUES (?1, ?2, 'v1', 'pdf_text', 'Shared Excerpt', '{}', ?3)",
            params![anchor_id, doc_id, base_time],
        ).unwrap();

        // 插入 1 张历史很早的卡片
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES ('card_ancient', ?1, ?2, 'explain', 'quick', 'completed', 'Q old', 'A old', 'm', ?3, ?3)",
            params![doc_id, anchor_id, base_time + 10],
        ).unwrap();

        // 插入 150 张其他无关卡片
        for i in 0..150 {
            let cid = format!("card_other_{}", i);
            conn.execute(
                "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'Ask', 'quick', 'completed', 'Q', 'A', 'm', ?3, ?3)",
                params![cid, doc_id, base_time + 100 + i as i64],
            ).unwrap();
        }

        // 插入 1 张同锚点的最新卡片
        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES ('card_newest', ?1, ?2, 'translate', 'deep', 'completed', 'Q new', 'A new', 'm', ?3, ?3)",
            params![doc_id, anchor_id, base_time + 500],
        ).unwrap();

        // 验证按 anchor_id 批量查询能完整查出新旧 2 张卡片，且按时间倒序
        let cards = get_cards_by_anchor_ids_internal(&conn, doc_id, &[anchor_id.to_string()]).unwrap();
        assert_eq!(cards.len(), 2, "同一来源的新旧卡片必须完整返回，不能被最新100条限制遗漏");
        assert_eq!(cards[0].card_id, "card_newest");
        assert_eq!(cards[1].card_id, "card_ancient");
    }

    #[test]
    fn test_function_results_versioning_prevents_stale_overwrite() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let doc_id = "doc_ver_test";
        let card_id_1 = "card_v_1";
        let card_id_2 = "card_v_2";
        let now = 6000000i64;

        conn.execute(
            "INSERT INTO documents (id, file_path, display_name, file_size, revision, created_at, updated_at)
             VALUES (?1, 'C:/test/book.pdf', 'book.pdf', 100, 'v1', ?2, ?2)",
            params![doc_id, now],
        ).unwrap();

        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES (?1, ?2, NULL, 'translate', 'quick', 'completed', 'Q1', 'A1', 'm', ?3, ?3)",
            params![card_id_1, doc_id, now],
        ).unwrap();

        conn.execute(
            "INSERT INTO cards (card_id, document_id, anchor_id, action, depth, status, user_prompt, ai_response, model_name, created_at, updated_at)
             VALUES (?1, ?2, NULL, 'translate', 'quick', 'completed', 'Q2', 'A2', 'm', ?3, ?3)",
            params![card_id_2, doc_id, now],
        ).unwrap();

        // 1. 卡片1 启动请求 1 (慢请求)，分配版本 1
        let v1 = allocate_function_version_internal(&conn, card_id_1, "translate:zh").unwrap();
        assert_eq!(v1, 1);

        // 2. 卡片1 启动请求 2 (快请求/重新生成)，分配版本 2
        let v2 = allocate_function_version_internal(&conn, card_id_1, "translate:zh").unwrap();
        assert_eq!(v2, 2);

        // 3. 快请求 2 先完成，成功写入数据库（版本 2）
        let res2 = save_function_result_internal(
            &conn,
            card_id_1,
            "translate:zh",
            "新结果 (快)",
            Some("sig_v2"),
            Some(v2),
        ).unwrap();
        assert_ne!(res2, "superseded");

        // 4. 慢请求 1 迟到完成，尝试提交旧结果（版本 1）
        let res1 = save_function_result_internal(
            &conn,
            card_id_1,
            "translate:zh",
            "旧结果 (慢)",
            Some("sig_v1"),
            Some(v1),
        ).unwrap();
        assert_eq!(res1, "superseded", "旧版本 1 必须被判定为已失效并拒绝写入");

        // 5. 校验卡片1的最终数据库结果仍然是“新结果 (快)”
        let detail_1 = get_card_detail_internal(&conn, card_id_1).unwrap();
        assert_eq!(detail_1.function_results.len(), 1);
        assert_eq!(detail_1.function_results[0].result_content, "新结果 (快)");
        assert_eq!(detail_1.function_results[0].version, 2);
        assert_eq!(detail_1.function_results[0].config_signature.as_deref(), Some("sig_v2"));

        // 6. 验证卡片2写回自身结果完全独立不受影响
        let res_c2 = save_function_result_internal(
            &conn,
            card_id_2,
            "translate:zh",
            "卡片2专属翻译",
            Some("sig_c2"),
            Some(1),
        ).unwrap();
        assert_ne!(res_c2, "superseded");

        let detail_2 = get_card_detail_internal(&conn, card_id_2).unwrap();
        assert_eq!(detail_2.function_results.len(), 1);
        assert_eq!(detail_2.function_results[0].result_content, "卡片2专属翻译");
    }

    #[test]
    fn test_parse_job_checkpoint_columns_migrate_existing_database() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟上一版本已经创建、但没有检查点列的数据库
        conn.execute_batch(
            "CREATE TABLE parse_jobs (
                job_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                source_path TEXT NOT NULL,
                document_name TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                source_revision TEXT NOT NULL,
                provider TEXT NOT NULL,
                config_signature TEXT NOT NULL,
                status TEXT NOT NULL,
                progress_percent INTEGER,
                completed_pages INTEGER,
                total_pages INTEGER,
                remote_id TEXT,
                remote_meta_json TEXT,
                version_id TEXT,
                activated INTEGER NOT NULL DEFAULT 0,
                can_cancel INTEGER NOT NULL DEFAULT 0,
                can_resume INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                error_message TEXT,
                update_seq INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        // 迁移必须幂等补齐检查点列（不丢旧数据）
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(parse_jobs)").unwrap();
        let columns: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .flatten()
            .collect();
        for expected in [
            "snapshot_rel_path",
            "remote_submitted",
            "upload_completed",
            "artifacts_downloaded",
            "normalized_ready",
            "activation_baseline_version_id",
            "submit_attempted",
        ] {
            assert!(columns.iter().any(|c| c == expected), "缺少列 {}", expected);
        }
    }
}
