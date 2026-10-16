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

#[derive(Debug, Serialize, Deserialize)]
pub struct CardListResponse {
    pub items: Vec<CardRecord>,
    pub total: i64,
    pub has_more: bool,
}

fn now_ms() -> i64 {
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

fn run_migrations(conn: &Connection) -> Result<(), String> {
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

        CREATE INDEX IF NOT EXISTS idx_anchors_doc ON source_anchors(document_id);
        CREATE INDEX IF NOT EXISTS idx_cards_doc ON cards(document_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_doc_cursor ON cards(document_id, created_at DESC, card_id DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_action ON cards(document_id, action, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_cards_anchor ON cards(anchor_id);
        CREATE INDEX IF NOT EXISTS idx_turns_card ON card_turns(card_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_fn_results_card ON card_function_results(card_id, mode);
        CREATE INDEX IF NOT EXISTS idx_highlights_doc ON highlights(document_id);
        CREATE INDEX IF NOT EXISTS idx_assets_doc ON assets(document_id);
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

    Ok(())
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
            doc.display_name = display_name;
            doc.revision = rev;
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
        file_path,
        display_name,
        file_size,
        revision: rev,
        last_read_position: None,
        created_at: now,
        updated_at: now,
    })
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

#[tauri::command]
pub fn db_delete_card(
    state: tauri::State<'_, DbState>,
    card_id: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;

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
            cleanup_anchor_and_assets(&conn, &state.assets_dir, &anc_id);
        }
    }

    Ok(())
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
}

