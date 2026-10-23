use super::*;
use crate::parse_providers;
use crate::parse_providers::mineru::MinerUClient;
use rusqlite::Connection;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(prefix: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("{}_{}", prefix, uuid::Uuid::new_v4().simple()));
        let _ = fs::create_dir_all(&path);
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn setup_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    conn
}

fn base_job(conn: &Connection, path: &str, hash: &str, status: &str) -> ParseJobRecord {
    let doc = db::get_or_create_document_internal(conn, path, "doc.pdf", 1024, Some("1024-100"))
        .unwrap();
    ParseJobRecord {
        job_id: format!("job_{}", uuid::Uuid::new_v4().simple()),
        document_id: doc.id,
        source_path: path.to_string(),
        document_name: "doc.pdf".to_string(),
        source_hash: hash.to_string(),
        source_revision: "1024-100".to_string(),
        provider: "mineru".to_string(),
        config_signature: "mineru:test".to_string(),
        status: status.to_string(),
        progress_percent: None,
        completed_pages: None,
        total_pages: None,
        remote_id: None,
        remote_meta_json: None,
        version_id: None,
        activated: 0,
        can_cancel: 1,
        can_resume: 0,
        error_code: None,
        error_message: None,
        update_seq: 1,
        created_at: db::now_ms(),
        updated_at: db::now_ms(),
        snapshot_rel_path: None,
        remote_submitted: 0,
        upload_completed: 0,
        artifacts_downloaded: 0,
        normalized_ready: 0,
        activation_baseline_version_id: None,
        submit_attempted: 0,
    }
}

/// 隔离共享健康状态的串行锁，避免并行单元测试相互干扰调度器单例
static HEALTH_TEST_SERIAL: Mutex<()> = Mutex::new(());

// ================= Mock HTTP server =================

#[derive(Clone)]
struct MockResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    extra_headers: Vec<String>,
}

impl MockResponse {
    fn json(body: serde_json::Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: body.to_string().into_bytes(),
            extra_headers: Vec::new(),
        }
    }

    fn bytes(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            content_type,
            body,
            extra_headers: Vec::new(),
        }
    }

    fn redirect(location: String) -> Self {
        Self {
            status: 302,
            content_type: "text/plain",
            body: Vec::new(),
            extra_headers: vec![format!("Location: {}", location)],
        }
    }
}

type MockHandler = Box<dyn Fn(&str, u16, &[String]) -> Option<MockResponse> + Send + Sync>;

struct MockServer {
    port: u16,
    log: Arc<Mutex<Vec<(String, Vec<String>)>>>,
    shutdown: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl MockServer {
    fn start(handler: MockHandler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));

        let log_clone = log.clone();
        let shutdown_clone = shutdown.clone();
        let handler = Arc::new(handler);

        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if shutdown_clone.load(Ordering::Relaxed) {
                    break;
                }
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut reader = BufReader::new(&stream);
                let mut first_line = String::new();
                if reader.read_line(&mut first_line).is_err() {
                    continue;
                }
                let request_line = first_line.trim().to_string();
                let mut headers = Vec::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        break;
                    }
                    if line.trim().is_empty() {
                        break;
                    }
                    if line.to_ascii_lowercase().starts_with("content-length:") {
                        if let Some(val) = line.split(':').nth(1) {
                            content_length = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                    headers.push(line.trim().to_string());
                }
                if content_length > 0 {
                    let mut body = vec![0u8; content_length];
                    let _ = reader.read_exact(&mut body);
                }

                if let Ok(mut guard) = log_clone.lock() {
                    guard.push((request_line.clone(), headers.clone()));
                }

                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");
                let key = format!("{} {}", method, path);

                match handler(&key, port, &headers) {
                    Some(resp) => {
                        let mut head = format!(
                            "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                            resp.status,
                            resp.content_type,
                            resp.body.len()
                        );
                        for extra in &resp.extra_headers {
                            head.push_str(extra);
                            head.push_str("\r\n");
                        }
                        head.push_str("\r\n");
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&resp.body);
                    }
                    None => {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                }
                let _ = stream.flush();
            }
        });

        MockServer {
            port,
            log,
            shutdown,
            handle: Some(handle),
        }
    }

    fn count(&self, method_path: &str) -> usize {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(line, _)| line.starts_with(method_path))
            .count()
    }

    fn headers_for(&self, method_path: &str) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(line, _)| line.starts_with(method_path))
            .flat_map(|(_, headers)| headers.clone())
            .collect()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn mineru_zip_bytes() -> Vec<u8> {
    let mut zip_bytes = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut zip_bytes);
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("content_list.json", options).unwrap();
        zip.write_all(
            serde_json::json!([
                {
                    "type": "text",
                    "text": "Mock mineru text",
                    "page_idx": 0,
                    "bbox": [100, 100, 800, 200]
                }
            ])
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
    }
    zip_bytes
}

/// 构造一个已具备完整检查点、只差轮询/下载/入库的任务
fn prepared_resume_job(
    conn: &Connection,
    workspace_dir: &Path,
    upload_url: String,
    provider: &str,
) -> ParseJobRecord {
    let mut job = base_job(conn, "C:/docs/resume.pdf", "placeholder", "queued");
    job.provider = provider.to_string();
    job.remote_id = Some("batch_resume".to_string());
    job.remote_meta_json = Some(upload_url);
    job.remote_submitted = 1;
    job.upload_completed = 1;

    let job_dir = workspace_dir.join("jobs").join(&job.job_id);
    fs::create_dir_all(job_dir.join("input")).unwrap();
    let snapshot = job_dir.join("input").join("source.pdf");
    fs::write(&snapshot, b"%PDF-1.4 cached snapshot").unwrap();
    job.source_hash = compute_file_sha256(&snapshot).unwrap();
    job.snapshot_rel_path = Some("input/source.pdf".to_string());

    db::insert_parse_job(conn, &job).unwrap();
    job
}

// ================= 状态机与事务 =================

#[test]
fn test_parse_job_db_crud_and_cursor_pagination() {
    let conn = setup_test_db();
    let doc = db::get_or_create_document_internal(
        &conn,
        "C:/docs/test.pdf",
        "test.pdf",
        1024,
        Some("1024-100"),
    )
    .unwrap();

    let mut job_1 = base_job(&conn, "C:/docs/test.pdf", "hash_abc", "queued");
    job_1.job_id = "job_1".to_string();
    job_1.document_id = doc.id.clone();
    job_1.created_at = 1000;
    db::insert_parse_job(&conn, &job_1).unwrap();

    let mut job_2 = job_1.clone();
    job_2.job_id = "job_2".to_string();
    job_2.created_at = 2000;
    db::insert_parse_job(&conn, &job_2).unwrap();

    let (page, cursor) = db::list_parse_jobs_internal(&conn, Some(&doc.id), false, 1, None).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].job_id, "job_2");
    assert!(cursor.is_some());

    let (page2, _) =
        db::list_parse_jobs_internal(&conn, Some(&doc.id), false, 1, cursor.as_deref()).unwrap();
    assert_eq!(page2[0].job_id, "job_1");

    // 阶段推进只能在任务未取消/未入库时发生
    assert!(db::transition_parse_job_status(&conn, "job_1", "preparing", 1, 0, None, None).unwrap());
    let cancelled = db::cancel_parse_job_cas(&conn, "job_1").unwrap();
    assert!(matches!(cancelled, db::CancelOutcome::Cancelled(_)));
    assert!(!db::transition_parse_job_status(&conn, "job_1", "processing", 1, 0, None, None).unwrap());
    assert_eq!(
        db::get_parse_job(&conn, "job_1").unwrap().unwrap().status,
        "cancelled"
    );
}

#[test]
fn test_cancel_before_import_wins() {
    let conn = setup_test_db();
    let job = base_job(&conn, "C:/docs/a.pdf", "hash_cancel", "normalizing");
    db::insert_parse_job(&conn, &job).unwrap();

    match db::cancel_parse_job_cas(&conn, &job.job_id).unwrap() {
        db::CancelOutcome::Cancelled(record) => assert_eq!(record.status, "cancelled"),
        other => panic!("预期取消成功，实际 {:?}", other),
    }

    // 随后 worker 想取得入库执行权必须失败
    assert!(!db::try_begin_parse_import(&conn, &job.job_id).unwrap());
    assert_eq!(
        db::get_parse_job(&conn, &job.job_id).unwrap().unwrap().status,
        "cancelled"
    );

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "取消成功后不得产生任何版本");
}

#[test]
fn test_import_wins_then_cancel_is_rejected() {
    let conn = setup_test_db();
    let job = base_job(&conn, "C:/docs/a.pdf", "hash_import", "normalizing");
    db::insert_parse_job(&conn, &job).unwrap();

    assert!(db::try_begin_parse_import(&conn, &job.job_id).unwrap());
    assert_eq!(
        db::get_parse_job(&conn, &job.job_id).unwrap().unwrap().status,
        "importing"
    );

    match db::cancel_parse_job_cas(&conn, &job.job_id).unwrap() {
        db::CancelOutcome::Rejected(record) => {
            assert_eq!(record.status, "importing");
            assert_eq!(record.can_cancel, 0);
        }
        other => panic!("预期取消被拒绝，实际 {:?}", other),
    }
}

#[test]
fn test_import_transaction_rolls_back_when_job_status_changed() {
    let temp = TestTempDir::new("import_tx");
    let mut conn = setup_test_db();
    let workspace = temp.path().join("parsed_workspace");

    let doc = db::get_or_create_document_internal(
        &conn,
        "C:/docs/tx.pdf",
        "tx.pdf",
        10,
        Some("1024-100"),
    )
    .unwrap();

    let normalized = temp.path().join("normalized");
    fs::create_dir_all(normalized.join("assets")).unwrap();
    fs::write(
        normalized.join("blocks.json"),
        serde_json::json!([{ "id": "b1", "type": "paragraph", "content": "hello" }]).to_string(),
    )
    .unwrap();
    fs::write(normalized.join("content.md"), "hello").unwrap();

    // 任务在入库前已被取消：事务中的任务条件更新必然失败 → 版本不得登记
    let mut job = base_job(&conn, "C:/docs/tx.pdf", "hash_tx", "cancelled");
    job.document_id = doc.id.clone();
    db::insert_parse_job(&conn, &job).unwrap();

    let result = crate::parsed_workspace::import_normalized_dir_with_options(
        &workspace,
        &mut conn,
        &doc.id,
        "1024-100",
        "mineru",
        "mineru:test",
        &normalized,
        crate::parsed_workspace::ParsedImportOptions {
            expected_active_version_id: None,
            activate: true,
            job_id: Some(&job.job_id),
            version_id_override: Some(&format!("ver_{}", job.job_id)),
        },
    );

    assert!(result.is_err(), "任务状态变化后入库必须失败并回滚");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "回滚后不得留下版本记录");

    let version_dir = workspace
        .join("documents")
        .join(&doc.id)
        .join("versions")
        .join(format!("ver_{}", job.job_id));
    assert!(!version_dir.exists(), "失败后必须清理已发布的版本目录");
}

#[test]
fn test_recover_interrupted_jobs_marks_paused() {
    let conn = setup_test_db();
    // 正常的新任务：已提交并拿到远端 ID，中途退出应转为可继续
    let mut processing = base_job(&conn, "C:/docs/p.pdf", "h1", "processing");
    processing.submit_attempted = 1;
    processing.remote_submitted = 1;
    processing.remote_id = Some("batch_p".to_string());
    let mut importing = base_job(&conn, "C:/docs/i.pdf", "h2", "importing");
    importing.submit_attempted = 1;
    importing.remote_submitted = 1;
    importing.remote_id = Some("batch_i".to_string());
    let succeeded = base_job(&conn, "C:/docs/s.pdf", "h3", "succeeded");
    db::insert_parse_job(&conn, &processing).unwrap();
    db::insert_parse_job(&conn, &importing).unwrap();
    db::insert_parse_job(&conn, &succeeded).unwrap();

    let changed = db::recover_interrupted_parse_jobs(&conn).unwrap();
    assert_eq!(changed, 2);

    for id in [&processing.job_id, &importing.job_id] {
        let rec = db::get_parse_job(&conn, id).unwrap().unwrap();
        assert_eq!(rec.status, "paused");
        assert_eq!(rec.can_resume, 1);
        assert_eq!(rec.error_code.as_deref(), Some(ERR_INTERRUPTED));
    }
    assert_eq!(
        db::get_parse_job(&conn, &succeeded.job_id).unwrap().unwrap().status,
        "succeeded"
    );
}

#[test]
fn test_dedupe_isolated_by_document_identity() {
    let conn = setup_test_db();
    let hash = "same-bytes-different-path";

    let mut job_a = base_job(&conn, "C:/docs/a.pdf", hash, "processing");
    job_a.document_id =
        db::get_or_create_document_internal(&conn, "C:/docs/a.pdf", "a.pdf", 1, Some("1-1"))
            .unwrap()
            .id;
    db::insert_parse_job(&conn, &job_a).unwrap();

    let doc_b =
        db::get_or_create_document_internal(&conn, "C:/docs/b.pdf", "b.pdf", 1, Some("1-1"))
            .unwrap();

    let reused = db::find_active_parse_job(
        &conn,
        &doc_b.id,
        "C:/docs/b.pdf",
        hash,
        "mineru",
        &job_a.config_signature,
    )
    .unwrap();
    assert!(reused.is_none(), "不同路径文档不得直接复用另一本文档的任务");

    let own = db::find_active_parse_job(
        &conn,
        &job_a.document_id,
        "C:/docs/a.pdf",
        hash,
        "mineru",
        &job_a.config_signature,
    )
    .unwrap();
    assert_eq!(own.map(|j| j.job_id), Some(job_a.job_id.clone()));
}

#[test]
fn test_resume_decision_rules() {
    let conn = setup_test_db();

    let paused = base_job(&conn, "C:/docs/r1.pdf", "h1", "paused");
    assert!(resume_decision(&paused).is_ok());

    // 状态待确认且没有可靠远端 ID：普通继续必须拒绝，不能重新 POST
    let mut unknown = base_job(&conn, "C:/docs/r2.pdf", "h2", "submission_unknown");
    unknown.remote_submitted = 0;
    unknown.remote_id = None;
    let err = resume_decision(&unknown).unwrap_err();
    assert!(err.contains("不会重新提交"), "错误提示需明确说明不会重新提交");

    // 无可靠远端 ID：不能提供“继续”，只能由用户显式重新解析
    assert!(!submission_unknown_can_resume(&unknown));

    let mut unknown_with_id = unknown.clone();
    unknown_with_id.remote_id = Some("batch_x".to_string());
    unknown_with_id.remote_submitted = 1;
    assert!(submission_unknown_can_resume(&unknown_with_id));
    assert!(resume_decision(&unknown_with_id).is_ok());

    let cancelled = base_job(&conn, "C:/docs/r3.pdf", "h3", "cancelled");
    assert!(resume_decision(&cancelled).is_err());
}

// ================= 端到端（本地模拟 HTTP） =================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_pipeline_resume_skips_submit_and_upload() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_test_token").unwrap();

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "GET /api/v4/extract-results/batch/batch_resume" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "full_zip_url": format!("http://127.0.0.1:{}/result.zip", port)
                }]}
            })))
        }
        "GET /result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));

    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("resume_pipeline");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        prepared_resume_job(
            &guard,
            &workspace,
            format!("http://127.0.0.1:{}/upload", server.port),
            "mineru",
        )
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };

    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    assert_eq!(job.status, "succeeded", "恢复任务应完成: {:?}", job.error_message);
    assert!(job.version_id.is_some());
    assert_eq!(
        server.count("POST /api/v4/file-urls/batch"),
        0,
        "已有远端任务时不得重新提交"
    );
    assert_eq!(server.count("PUT /upload"), 0, "已上传任务不得重复上传");
    assert!(server.count("GET /api/v4/extract-results/batch/batch_resume") >= 1);

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_pipeline_cancel_before_import_does_not_create_version() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_test_token").unwrap();

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "GET /api/v4/extract-results/batch/batch_resume" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "full_zip_url": format!("http://127.0.0.1:{}/result.zip", port)
                }]}
            })))
        }
        "GET /result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));

    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("cancel_pipeline");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        prepared_resume_job(
            &guard,
            &workspace,
            format!("http://127.0.0.1:{}/upload", server.port),
            "mineru",
        )
    };

    // 模拟“归一化完成前用户点击停止”：取消信号已置位
    let (tx, rx) = watch::channel(true);
    drop(tx);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };

    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    let guard = conn.lock().unwrap();
    let count: i64 = guard
        .query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "取消后不得入库");

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_cross_origin_redirect_does_not_forward_credentials() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let target = MockServer::start(Box::new(|key, _port, _headers| match key {
        "POST /steal" => Some(MockResponse::json(serde_json::json!({ "code": 0 }))),
        _ => None,
    }));

    let target_port = target.port;
    let api = MockServer::start(Box::new(move |key, _port, _headers| match key {
        "POST /api/v4/file-urls/batch" => Some(MockResponse::redirect(format!(
            "http://127.0.0.1:{}/steal",
            target_port
        ))),
        _ => None,
    }));

    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        api.port
    )));

    let temp = TestTempDir::new("redirect");
    let pdf = temp.path().join("a.pdf");
    fs::write(&pdf, b"%PDF-1.4").unwrap();

    let client = MinerUClient::new("fake_secret_token".to_string());
    let err = client.create_batch(&pdf, "case", None).await.unwrap_err();
    assert!(
        err.to_ascii_lowercase().contains("redirect") || err.contains("重定向"),
        "跨域重定向必须被拒绝: {}",
        err
    );
    assert_eq!(
        target.count("POST /steal"),
        0,
        "跨域重定向目标不得收到任何请求"
    );

    // 原始请求确实带了凭据头，说明拦截发生在重定向环节
    let headers = api.headers_for("POST /api/v4/file-urls/batch");
    assert!(
        headers
            .iter()
            .any(|h| h.to_ascii_lowercase().starts_with("authorization:")),
        "首次请求应携带 Authorization"
    );

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_mineru_mock_http_flow() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "POST /api/v4/file-urls/batch" => Some(MockResponse::json(serde_json::json!({
            "code": 0,
            "data": {
                "batch_id": "test_batch_1",
                "file_urls": [format!("http://127.0.0.1:{}/mock_s3_upload", port)]
            }
        }))),
        "PUT /mock_s3_upload" => Some(MockResponse::bytes("text/plain", Vec::new())),
        "GET /api/v4/extract-results/batch/test_batch_1" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "full_zip_url": format!("http://127.0.0.1:{}/mock_result.zip", port)
                }]}
            })))
        }
        "GET /mock_result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));

    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("mineru_mock");
    let pdf = temp.path().join("source.pdf");
    fs::write(&pdf, b"%PDF-1.4 mock binary content").unwrap();

    let client = MinerUClient::new("test_mineru_token".to_string());
    let batch = client.create_batch(&pdf, "case_1", None).await.unwrap();
    assert_eq!(batch.batch_id, "test_batch_1");

    client.upload_file(&batch.upload_url, &pdf).await.unwrap();

    // 上传到预签名地址时不得携带厂商凭据
    let upload_headers = server.headers_for("PUT /mock_s3_upload");
    assert!(
        !upload_headers
            .iter()
            .any(|h| h.to_ascii_lowercase().starts_with("authorization:")),
        "上传至预签名地址时严禁携带 API Token"
    );

    let status = client.check_batch_status(&batch.batch_id).await.unwrap();
    assert_eq!(status.status, "done");

    let zip_dest = temp.path().join("downloaded.zip");
    let bytes = client
        .download_zip(&status.full_zip_url.unwrap(), &zip_dest)
        .await
        .unwrap();
    assert!(bytes > 0);
    assert!(zip_dest.is_file());

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_datalab_external_result_without_credentials_and_null_markdown() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    use crate::parse_providers::datalab::DatalabClient;

    // 外部产物服务器（不同 origin，绝不能收到 X-API-Key）
    let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let png_clone = png.clone();
    let storage = MockServer::start(Box::new(move |key, port, _headers| match key {
        "GET /external.json" => Some(MockResponse::json(serde_json::json!({
            "metadata": { "failed_pages": [], "page_count": 1 },
            "children": [{
                "block_type": "Page",
                "bbox": [0, 0, 1000, 1000],
                "children": [
                    {
                        "block_type": "Text",
                        "html": "<p>External result paragraph with <math>V_g</math>.</p>",
                        "markdown": null,
                        "bbox": [10, 10, 900, 100],
                        "images": {}
                    },
                    {
                        "block_type": "Figure",
                        "html": "<img src=\"fig.png\"/>",
                        "markdown": null,
                        "bbox": [100, 200, 800, 600],
                        "images": { "fig.png": format!("http://127.0.0.1:{}/fig.png", port) }
                    }
                ]
            }]
        }))),
        "GET /fig.png" => Some(MockResponse::bytes("image/png", png_clone.clone())),
        _ => None,
    }));

    let storage_port = storage.port;
    let api = MockServer::start(Box::new(move |key, port, _headers| match key {
        "POST /api/v1/convert" => Some(MockResponse::json(serde_json::json!({
            "request_id": "req_ext",
            "request_check_url": format!("http://127.0.0.1:{}/api/v1/convert/req_ext", port)
        }))),
        "GET /api/v1/convert/req_ext" => Some(MockResponse::json(serde_json::json!({
            "status": "complete",
            "success": true,
            "markdown": null,
            "json": null,
            "result_url": format!("http://127.0.0.1:{}/external.json", storage_port)
        }))),
        _ => None,
    }));

    parse_providers::set_test_datalab_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v1",
        api.port
    )));

    let temp = TestTempDir::new("datalab_external");
    let pdf = temp.path().join("source.pdf");
    fs::write(&pdf, b"%PDF-1.4 external").unwrap();

    let client = DatalabClient::new("fake_datalab_key".to_string());
    let submit = client.submit_document(&pdf).await.unwrap();
    let status = client.check_status(&submit.request_check_url).await.unwrap();
    assert_eq!(status.status, "done");

    let raw_dir = temp.path().join("raw");
    let warnings = client.save_results(&status, &raw_dir).await.unwrap();
    assert!(warnings.is_empty(), "不应有下载告警: {:?}", warnings);

    // 外部结果下载不得携带厂家凭据
    for header in storage.headers_for("GET /external.json") {
        assert!(
            !header.to_ascii_lowercase().starts_with("x-api-key:"),
            "对象存储请求不得携带 X-API-Key: {}",
            header
        );
    }

    // 归一化：markdown 为 null，必须使用 html
    let normalized = temp.path().join("normalized");
    crate::parse_normalize::normalize_datalab_results(&raw_dir, &normalized).unwrap();
    let blocks_text = fs::read_to_string(normalized.join("blocks.json")).unwrap();
    let blocks: Vec<crate::parse_normalize::ParsedBlock> =
        serde_json::from_str(&blocks_text).unwrap();

    let text = blocks
        .iter()
        .find(|b| b.r#type == "paragraph")
        .expect("外部结果正文缺失");
    assert!(text.content.contains("External result paragraph"));
    assert!(text.content.contains("$V_g$"));

    let image = blocks
        .iter()
        .find(|b| b.r#type == "image")
        .expect("外部结果图片缺失");
    let asset = image.asset_ref.clone().unwrap();
    assert_eq!(
        fs::read(normalized.join("assets").join(&asset)).unwrap(),
        png,
        "外置图片必须落盘为正确字节"
    );

    // 诊断元数据保留
    let diagnostics = fs::read_to_string(normalized.join("diagnostics.json")).unwrap();
    let diag: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
    assert!(diag["failed_pages"].as_array().unwrap().is_empty());

    parse_providers::set_test_datalab_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_datalab_required_image_failure_is_reported() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    use crate::parse_providers::datalab::DatalabClient;

    let api = MockServer::start(Box::new(move |key, port, _headers| match key {
        "POST /api/v1/convert" => Some(MockResponse::json(serde_json::json!({
            "request_id": "req_missing",
            "request_check_url": format!("http://127.0.0.1:{}/api/v1/convert/req_missing", port)
        }))),
        "GET /api/v1/convert/req_missing" => Some(MockResponse::json(serde_json::json!({
            "status": "complete",
            "success": true,
            "markdown": "text",
            "result_url": null,
            "children": [{
                "block_type": "Page",
                "bbox": [0, 0, 100, 100],
                "children": [{
                    "block_type": "Figure",
                    "html": "<img src=\"fig.png\"/>",
                    "markdown": null,
                    "bbox": [0, 0, 50, 50],
                    "images": { "fig.png": format!("http://127.0.0.1:{}/missing.png", port) }
                }]
            }],
            "metadata": { "failed_pages": [] }
        }))),
        _ => None,
    }));

    parse_providers::set_test_datalab_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v1",
        api.port
    )));

    let temp = TestTempDir::new("datalab_missing_img");
    let pdf = temp.path().join("source.pdf");
    fs::write(&pdf, b"%PDF-1.4 missing").unwrap();

    let client = DatalabClient::new("fake_key".to_string());
    let submit = client.submit_document(&pdf).await.unwrap();
    let status = client.check_status(&submit.request_check_url).await.unwrap();
    let raw_dir = temp.path().join("raw");
    let warnings = client.save_results(&status, &raw_dir).await.unwrap();
    assert!(
        warnings.iter().any(|w| w.contains("fig.png")),
        "必需图片下载失败必须产生诊断: {:?}",
        warnings
    );

    let normalized = temp.path().join("normalized");
    let err = crate::parse_normalize::normalize_datalab_results(&raw_dir, &normalized).unwrap_err();
    assert!(
        err.contains("缺少必需的本地图片资产") || err.contains("图片引用"),
        "缺失必需资产必须明确失败: {}",
        err
    );

    parse_providers::set_test_datalab_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_cancel_during_normalization_barrier_prevents_import() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_test_token").unwrap();

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "GET /api/v4/extract-results/batch/batch_resume" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "full_zip_url": format!("http://127.0.0.1:{}/result.zip", port)
                }]}
            })))
        }
        "GET /result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));
    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("cancel_barrier");
    let workspace = temp.path().join("parsed_workspace");
    let db_path = temp.path().join("flowread.db");
    let conn = Mutex::new(Connection::open(&db_path).unwrap());
    db::run_migrations(&conn.lock().unwrap()).unwrap();

    let mut job = {
        let guard = conn.lock().unwrap();
        prepared_resume_job(
            &guard,
            &workspace,
            format!("http://127.0.0.1:{}/upload", server.port),
            "mineru",
        )
    };

    // 归一化完成、即将入库时，模拟用户在另一个连接上点击停止
    let barrier_db = db_path.clone();
    *TEST_BEFORE_IMPORT_BARRIER
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(Box::new(move |job_id: &str| {
        if let Ok(other) = Connection::open(&barrier_db) {
            let _ = db::cancel_parse_job_cas(&other, job_id);
        }
    }));

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    *TEST_BEFORE_IMPORT_BARRIER
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;

    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job.job_id).unwrap().unwrap();
    assert_eq!(record.status, "cancelled", "取消先成功后不得被 worker 覆盖");
    let count: i64 = guard
        .query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "归一化期间取消成功后绝不允许入库");

    parse_providers::set_test_mineru_base_url(None);
}

#[test]
fn test_import_retry_reuses_fixed_version_id_without_duplicates() {
    let temp = TestTempDir::new("import_retry");
    let mut conn = setup_test_db();
    let workspace = temp.path().join("parsed_workspace");

    let doc = db::get_or_create_document_internal(
        &conn,
        "C:/docs/retry.pdf",
        "retry.pdf",
        10,
        Some("1024-100"),
    )
    .unwrap();

    let normalized = temp.path().join("normalized");
    fs::create_dir_all(normalized.join("assets")).unwrap();
    fs::write(
        normalized.join("blocks.json"),
        serde_json::json!([{ "id": "b1", "type": "paragraph", "content": "retry content" }])
            .to_string(),
    )
    .unwrap();

    let mut job = base_job(&conn, "C:/docs/retry.pdf", "hash_retry", "importing");
    job.document_id = doc.id.clone();
    db::insert_parse_job(&conn, &job).unwrap();

    let version_id = format!("ver_{}", job.job_id);

    // 模拟上次崩溃：版本目录已发布但数据库未登记（内容为垃圾）
    let stale_dir = workspace
        .join("documents")
        .join(&doc.id)
        .join("versions")
        .join(&version_id);
    fs::create_dir_all(stale_dir.join("assets")).unwrap();
    fs::write(stale_dir.join("blocks.json"), b"stale-garbage").unwrap();

    let result = crate::parsed_workspace::import_normalized_dir_with_options(
        &workspace,
        &mut conn,
        &doc.id,
        "1024-100",
        "mineru",
        "mineru:test",
        &normalized,
        crate::parsed_workspace::ParsedImportOptions {
            expected_active_version_id: None,
            activate: true,
            job_id: Some(&job.job_id),
            version_id_override: Some(&version_id),
        },
    );
    assert!(result.is_ok(), "固定版本号重试必须成功: {:?}", result.err());

    // 只有一个版本记录、一个版本目录，且内容是新结果而不是崩溃残留
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let blocks = fs::read_to_string(stale_dir.join("blocks.json")).unwrap();
    assert!(blocks.contains("retry content"));
}

#[test]
fn test_stale_job_does_not_override_newer_active_version() {
    let temp = TestTempDir::new("stale_activation");
    let mut conn = setup_test_db();
    let workspace = temp.path().join("parsed_workspace");

    let doc = db::get_or_create_document_internal(
        &conn,
        "C:/docs/activation.pdf",
        "activation.pdf",
        10,
        Some("1024-100"),
    )
    .unwrap();

    let normalized = temp.path().join("normalized");
    fs::create_dir_all(normalized.join("assets")).unwrap();
    fs::write(
        normalized.join("blocks.json"),
        serde_json::json!([{ "id": "b1", "type": "paragraph", "content": "content" }]).to_string(),
    )
    .unwrap();

    // 用户后来手动选择的版本（先激活）
    let (new_version, _, _, _, activated_new) =
        crate::parsed_workspace::import_normalized_dir_with_options(
            &workspace,
            &mut conn,
            &doc.id,
            "1024-100",
            "mineru",
            "mineru:test",
            &normalized,
            crate::parsed_workspace::ParsedImportOptions::default(),
        )
        .unwrap();
    assert!(activated_new);

    // 旧任务：创建时没有任何激活版本，因此基准为 None
    let mut job = base_job(&conn, "C:/docs/activation.pdf", "hash_act", "importing");
    job.document_id = doc.id.clone();
    job.activation_baseline_version_id = None;
    db::insert_parse_job(&conn, &job).unwrap();

    let (job_version, _, _, _, activated) =
        crate::parsed_workspace::import_normalized_dir_with_options(
            &workspace,
            &mut conn,
            &doc.id,
            "1024-100",
            "mineru",
            "mineru:test",
            &normalized,
            crate::parsed_workspace::ParsedImportOptions {
                expected_active_version_id: job.activation_baseline_version_id.as_deref(),
                activate: true,
                job_id: Some(&job.job_id),
                version_id_override: Some(&format!("ver_{}", job.job_id)),
            },
        )
        .unwrap();

    assert!(!activated, "旧任务不得覆盖后来手动选择的版本");
    let active = db::get_active_parsed_version(&conn, &doc.id).unwrap().unwrap();
    assert_eq!(active.version_id, new_version);
    assert_ne!(active.version_id, job_version);
}

// ================= 生命周期修复：复现测试辅助 =================

/// 建立带已校验私有快照的任务（不含远端状态）
fn job_with_snapshot(
    conn: &Connection,
    workspace_dir: &Path,
    provider: &str,
    status: &str,
) -> ParseJobRecord {
    let mut job = base_job(conn, "C:/docs/lifecycle.pdf", "placeholder", status);
    job.provider = provider.to_string();

    let job_dir = workspace_dir.join("jobs").join(&job.job_id);
    fs::create_dir_all(job_dir.join("input")).unwrap();
    let snapshot = job_dir.join("input").join("source.pdf");
    fs::write(&snapshot, b"%PDF-1.4 lifecycle snapshot").unwrap();
    job.source_hash = compute_file_sha256(&snapshot).unwrap();
    job.snapshot_rel_path = Some("input/source.pdf".to_string());

    db::insert_parse_job(conn, &job).unwrap();
    job
}

/// 构造完整的归一化产物（含一张被引用的图片资产）
fn write_normalized_artifacts(workspace_dir: &Path, job_id: &str, text: &str) -> PathBuf {
    let dir = workspace_dir.join("jobs").join(job_id).join("normalized");
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(dir.join("assets").join("img.png"), b"PNG-BYTES").unwrap();
    fs::write(
        dir.join("blocks.json"),
        serde_json::json!([
            {
                "id": "b1",
                "type": "paragraph",
                "content": text,
                "asset_ref": "img.png"
            }
        ])
        .to_string(),
    )
    .unwrap();
    fs::write(dir.join("content.md"), text).unwrap();
    dir
}

fn version_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM parsed_document_versions", [], |r| r.get(0))
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_resume_after_attempted_submission_never_reposts() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_token").unwrap();

    // 服务商已经受理过一次，但本地没保存远端 ID；若再次提交，计数会暴露
    let server = MockServer::start(Box::new(|key, _port, _headers| match key {
        "POST /api/v4/file-urls/batch" => Some(MockResponse::json(serde_json::json!({
            "code": 0,
            "data": { "batch_id": "unexpected_batch", "file_urls": ["http://127.0.0.1:1/upload"] }
        }))),
        _ => None,
    }));
    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("resume_attempted");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        let mut job = job_with_snapshot(&guard, &workspace, "mineru", "queued");
        // 模拟“提交请求已发出、应用在保存远端 ID 前退出”，恢复后为 queued
        job.submit_attempted = 1;
        job.remote_submitted = 0;
        job.remote_id = None;
        guard
            .execute(
                "UPDATE parse_jobs SET submit_attempted = 1, status = 'queued' WHERE job_id = ?1",
                rusqlite::params![job.job_id],
            )
            .unwrap();
        job
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    assert_eq!(
        server.count("POST /api/v4/file-urls/batch"),
        0,
        "已发出过提交请求但未保存远端 ID 的任务，普通继续绝不能再 POST"
    );
    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job.job_id).unwrap().unwrap();
    assert_eq!(record.status, "submission_unknown");
    assert_eq!(record.can_resume, 0, "无可靠远端 ID 时不能提供普通继续");
    assert_eq!(version_count(&guard), 0);

    parse_providers::set_test_mineru_base_url(None);
}

#[test]
fn test_recovery_marks_attempted_submission_as_unknown() {
    let conn = setup_test_db();
    let mut attempted = base_job(&conn, "C:/docs/attempted.pdf", "h1", "submitting");
    attempted.submit_attempted = 1;
    attempted.remote_submitted = 0;
    attempted.remote_id = None;
    db::insert_parse_job(&conn, &attempted).unwrap();

    // 迁移前的旧记录：状态在提交之后但没有远端 ID，且没有 submit_attempted 标记
    let mut legacy = base_job(&conn, "C:/docs/legacy.pdf", "h2", "uploading");
    legacy.submit_attempted = 0;
    legacy.remote_submitted = 0;
    legacy.remote_id = None;
    db::insert_parse_job(&conn, &legacy).unwrap();

    // 提交前就因缺少凭据暂停的记录：不属于“可能已受理”
    let mut token_paused = base_job(&conn, "C:/docs/token.pdf", "h3", "paused");
    token_paused.error_code = Some(ERR_AUTH_REJECTED.to_string());
    token_paused.submit_attempted = 0;
    token_paused.can_resume = 1;
    token_paused.can_cancel = 1;
    db::insert_parse_job(&conn, &token_paused).unwrap();

    db::recover_interrupted_parse_jobs(&conn).unwrap();

    let attempted_rec = db::get_parse_job(&conn, &attempted.job_id).unwrap().unwrap();
    assert_eq!(attempted_rec.status, "submission_unknown");
    assert_eq!(attempted_rec.can_resume, 0);

    let legacy_rec = db::get_parse_job(&conn, &legacy.job_id).unwrap().unwrap();
    assert_eq!(legacy_rec.status, "submission_unknown", "旧记录必须保守处理");
    assert_eq!(legacy_rec.submit_attempted, 1);

    let paused_rec = db::get_parse_job(&conn, &token_paused.job_id).unwrap().unwrap();
    assert_eq!(paused_rec.status, "paused", "提交前暂停的记录仍可继续");
    assert_eq!(paused_rec.can_resume, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_checkpoint_write_does_not_overwrite_cancellation() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_token").unwrap();

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "GET /api/v4/extract-results/batch/batch_resume" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "full_zip_url": format!("http://127.0.0.1:{}/result.zip", port)
                }]}
            })))
        }
        "GET /result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));
    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("cancel_checkpoint");
    let workspace = temp.path().join("parsed_workspace");
    let db_path = temp.path().join("flowread.db");
    let conn = Mutex::new(Connection::open(&db_path).unwrap());
    db::run_migrations(&conn.lock().unwrap()).unwrap();

    let mut job = {
        let guard = conn.lock().unwrap();
        let mut job = job_with_snapshot(&guard, &workspace, "mineru", "queued");
        job.remote_id = Some("batch_resume".to_string());
        job.remote_meta_json = Some(format!("http://127.0.0.1:{}/upload", server.port));
        job.remote_submitted = 1;
        job.upload_completed = 1;
        guard
            .execute(
                "UPDATE parse_jobs SET remote_id = ?1, remote_meta_json = ?2, remote_submitted = 1, upload_completed = 1 WHERE job_id = ?3",
                rusqlite::params![job.remote_id, job.remote_meta_json, job.job_id],
            )
            .unwrap();
        job
    };

    // 归一化完成、检查点尚未写入时，用户通过真实取消流程写入 cancelled
    let barrier_db = db_path.clone();
    *TEST_BEFORE_NORMALIZED_CHECKPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(Box::new(move |job_id: &str| {
        if let Ok(other) = Connection::open(&barrier_db) {
            let _ = db::cancel_parse_job_cas(&other, job_id);
        }
    }));

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    let result = run_job_pipeline(&mut runtime, &mut job).await;

    *TEST_BEFORE_NORMALIZED_CHECKPOINT
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;

    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job.job_id).unwrap().unwrap();
    assert_eq!(
        record.status, "cancelled",
        "检查点写入绝不能把 cancelled 覆盖成 normalizing/failed/succeeded（pipeline 返回 {:?}）",
        result
    );
    assert_eq!(version_count(&guard), 0, "取消成功后不得入库或激活");

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_resume_from_normalized_checkpoint_without_network_or_credentials() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // 空的测试凭据库：如果流水线去读凭据，会得到“未配置”
    let _cred = crate::parse_settings::test_credential_store();

    let server = MockServer::start(Box::new(|_key, _port, _headers| None));
    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let temp = TestTempDir::new("normalized_resume");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        // 关键：没有任何私有快照，源 PDF 也不存在；只有完整归一化产物
        let mut job = base_job(&guard, "C:/docs/gone.pdf", "hash_gone", "processing");
        job.normalized_ready = 1;
        db::insert_parse_job(&guard, &job).unwrap();
        write_normalized_artifacts(&workspace, &job.job_id, "resumed normalized content");
        guard
            .execute(
                "UPDATE parse_jobs SET normalized_ready = 1, status = 'processing' WHERE job_id = ?1",
                rusqlite::params![job.job_id],
            )
            .unwrap();
        job
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    assert_eq!(
        job.status, "succeeded",
        "已有完整归一化产物时应直接入库: {:?}",
        job.error_message
    );
    let guard = conn.lock().unwrap();
    assert_eq!(version_count(&guard), 1);
    assert_eq!(
        server.count("GET /api/v4/extract-results/batch/"),
        0,
        "纯本地恢复不得访问云端"
    );

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_resume_from_raw_artifacts_without_remote() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();

    let server = MockServer::start(Box::new(|_key, _port, _headers| None));
    parse_providers::set_test_datalab_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v1",
        server.port
    )));

    let temp = TestTempDir::new("raw_resume");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        let mut job = job_with_snapshot(&guard, &workspace, "datalab", "queued");
        job.artifacts_downloaded = 1;

        let raw_dir = workspace.join("jobs").join(&job.job_id).join("raw");
        fs::create_dir_all(&raw_dir).unwrap();
        fs::write(
            raw_dir.join("result.json"),
            serde_json::json!({
                "metadata": { "failed_pages": [] },
                "children": [{
                    "block_type": "Page",
                    "bbox": [0, 0, 100, 100],
                    "children": [{
                        "block_type": "Text",
                        "html": "<p>raw resume paragraph</p>",
                        "markdown": null,
                        "bbox": [0, 0, 50, 50],
                        "images": {}
                    }]
                }]
            })
            .to_string(),
        )
        .unwrap();

        guard
            .execute(
                "UPDATE parse_jobs SET artifacts_downloaded = 1, status = 'queued' WHERE job_id = ?1",
                rusqlite::params![job.job_id],
            )
            .unwrap();
        job
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    assert_eq!(
        job.status, "succeeded",
        "raw 产物完整时应直接归一化并入库: {:?}",
        job.error_message
    );
    assert_eq!(version_count(&conn.lock().unwrap()), 1);

    parse_providers::set_test_datalab_base_url(None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_resume_after_import_crash_keeps_single_version() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();

    let temp = TestTempDir::new("import_crash_resume");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        let mut job = base_job(&guard, "C:/docs/crash.pdf", "hash_crash", "paused");
        job.normalized_ready = 1;
        job.can_resume = 1;
        db::insert_parse_job(&guard, &job).unwrap();

        // 模拟上次入库在“版本目录已发布、事务未提交”时崩溃
        let stale = workspace
            .join("documents")
            .join(&job.document_id)
            .join("versions")
            .join(format!("ver_{}", job.job_id));
        fs::create_dir_all(stale.join("assets")).unwrap();
        fs::write(stale.join("blocks.json"), b"stale").unwrap();

        write_normalized_artifacts(&workspace, &job.job_id, "post-crash content");
        guard
            .execute(
                "UPDATE parse_jobs SET normalized_ready = 1, can_resume = 1 WHERE job_id = ?1",
                rusqlite::params![job.job_id],
            )
            .unwrap();
        job
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    assert_eq!(job.status, "succeeded", "崩溃后继续应完成入库: {:?}", job.error_message);
    let guard = conn.lock().unwrap();
    assert_eq!(version_count(&guard), 1, "重试不得产生重复版本");
    let version_dir = workspace
        .join("documents")
        .join(&job.document_id)
        .join("versions")
        .join(format!("ver_{}", job.job_id));
    let blocks = fs::read_to_string(version_dir.join("blocks.json")).unwrap();
    assert!(blocks.contains("post-crash content"));

    parse_providers::set_test_mineru_base_url(None);
}

#[test]
fn test_pipeline_failure_marks_unconfirmed_submission_unknown() {
    let conn = Mutex::new(setup_test_db());
    let job = {
        let guard = conn.lock().unwrap();
        let mut job = base_job(&guard, "C:/docs/uncertain.pdf", "h9", "submitting");
        job.submit_attempted = 1;
        job.remote_submitted = 0;
        db::insert_parse_job(&guard, &job).unwrap();
        job
    };
    let (_tx, rx) = watch::channel(false);
    let runtime = JobRuntime {
        workspace_dir: std::env::temp_dir().join("flowread_failure_helper"),
        conn: &conn,
        cancel: rx,
    };

    handle_pipeline_failure(&runtime, &job.job_id, "关键检查点写库失败").unwrap();

    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job.job_id).unwrap().unwrap();
    assert_eq!(
        record.status, "submission_unknown",
        "不确定提交不能被打包成普通可恢复 paused"
    );
    assert_eq!(record.can_resume, 0);
    assert!(record
        .error_message
        .as_deref()
        .unwrap_or("")
        .contains("无法确认提交结果"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_missing_normalized_artifact_reports_explicit_state() {
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // 空凭据：若检查点回退后仍需凭据，会暂停而不是静默停在 processing
    let _cred = crate::parse_settings::test_credential_store();

    let temp = TestTempDir::new("missing_normalized");
    let workspace = temp.path().join("parsed_workspace");
    let conn = Mutex::new(setup_test_db());

    let mut job = {
        let guard = conn.lock().unwrap();
        let mut job = job_with_snapshot(&guard, &workspace, "mineru", "processing");
        job.normalized_ready = 1;
        job.artifacts_downloaded = 0;

        // 只有空目录，blocks.json 缺失（检查点为真但文件不可用）
        let normalized = workspace.join("jobs").join(&job.job_id).join("normalized");
        fs::create_dir_all(&normalized).unwrap();

        guard
            .execute(
                "UPDATE parse_jobs SET normalized_ready = 1, status = 'processing' WHERE job_id = ?1",
                rusqlite::params![job.job_id],
            )
            .unwrap();
        job
    };

    let (_tx, rx) = watch::channel(false);
    let mut runtime = JobRuntime {
        workspace_dir: workspace.clone(),
        conn: &conn,
        cancel: rx,
    };
    run_job_pipeline(&mut runtime, &mut job).await.unwrap();

    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job.job_id).unwrap().unwrap();
    assert_ne!(
        record.status, "processing",
        "检查点无效时不得永久停留在 processing"
    );
    assert_eq!(record.status, "paused");
    assert_eq!(record.normalized_ready, 0, "无效检查点必须被清除");
    let message = record.error_message.unwrap_or_default();
    assert!(
        message.contains("归一化检查点无效"),
        "必须给出明确诊断，实际: {}",
        message
    );
}

// ================= 队列入口与调度单步回归测试 =================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_queued_job_e2e_from_queue_to_import() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _guard = parse_providers::TEST_PROVIDER_MUTEX
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _cred = crate::parse_settings::test_credential_store();
    crate::parse_settings::set_provider_token("mineru", "fake_test_token").unwrap();

    let temp = TestTempDir::new("queue_e2e");
    let workspace = temp.path().join("parsed_workspace");
    let pdf_source = temp.path().join("sample.pdf");
    fs::write(&pdf_source, b"%PDF-1.4 mock pdf content for queue e2e").unwrap();

    let conn = Mutex::new(setup_test_db());
    let job_id = {
        let guard = conn.lock().unwrap();
        let hash = compute_file_sha256(&pdf_source).unwrap();
        let revision = file_revision(&pdf_source).unwrap();
        let mut job = base_job(
            &guard,
            pdf_source.to_str().unwrap(),
            &hash,
            "queued",
        );
        job.source_revision = revision;
        job.provider = "mineru".to_string();
        job.submit_attempted = 0;
        job.remote_submitted = 0;
        job.upload_completed = 0;
        job.artifacts_downloaded = 0;
        job.normalized_ready = 0;
        db::insert_parse_job(&guard, &job).unwrap();
        job.job_id
    };

    let zip_bytes = mineru_zip_bytes();
    let server = MockServer::start(Box::new(move |key, port, _headers| match key {
        "POST /api/v4/file-urls/batch" => Some(MockResponse::json(serde_json::json!({
            "code": 0,
            "data": {
                "batch_id": "batch_queue_e2e",
                "file_urls": [format!("http://127.0.0.1:{}/upload", port)]
            }
        }))),
        "PUT /upload" => Some(MockResponse {
            status: 200,
            content_type: "text/plain",
            body: Vec::new(),
            extra_headers: Vec::new(),
        }),
        "GET /api/v4/extract-results/batch/batch_queue_e2e" => {
            Some(MockResponse::json(serde_json::json!({
                "code": 0,
                "data": { "extract_result": [{
                    "state": "done",
                    "extract_progress": { "extracted_pages": 5, "total_pages": 5 },
                    "full_zip_url": format!("http://127.0.0.1:{}/result.zip", port)
                }]}
            })))
        }
        "GET /result.zip" => Some(MockResponse::bytes("application/zip", zip_bytes.clone())),
        _ => None,
    }));

    parse_providers::set_test_mineru_base_url(Some(format!(
        "http://127.0.0.1:{}/api/v4",
        server.port
    )));

    let cancel_senders = Arc::new(Mutex::new(HashMap::new()));
    // 通过实际调度入口取出任务并执行，而非直接传参给 run_job_pipeline
    let outcome = schedule_next_job_once(&conn, &workspace, &cancel_senders).await;
    assert_eq!(
        outcome,
        ScheduleStepOutcome::Executed {
            job_id: job_id.clone(),
            success: true,
        },
        "队列任务必须被成功出队并执行完毕"
    );

    let guard = conn.lock().unwrap();
    let record = db::get_parse_job(&guard, &job_id).unwrap().unwrap();
    assert_eq!(
        record.status,
        "succeeded",
        "record failed: code={:?}, message={:?}",
        record.error_code,
        record.error_message
    );
    assert!(record.version_id.is_some(), "入库后必须生成有效 version_id");
    assert_eq!(record.submit_attempted, 1);
    assert_eq!(record.remote_submitted, 1);
    assert_eq!(record.upload_completed, 1);
    assert_eq!(record.artifacts_downloaded, 1);
    assert_eq!(record.normalized_ready, 1);
    assert_eq!(record.completed_pages, Some(5));
    assert_eq!(record.total_pages, Some(5));
    assert_eq!(record.error_code, None);
    assert_eq!(record.error_message, None);

    assert_eq!(server.count("POST /api/v4/file-urls/batch"), 1);
    assert_eq!(server.count("PUT /upload"), 1);
    assert!(server.count("GET /api/v4/extract-results/batch/batch_queue_e2e") >= 1);
    assert_eq!(server.count("GET /result.zip"), 1);

    parse_providers::set_test_mineru_base_url(None);
}

#[tokio::test]
async fn test_empty_queue_returns_none_and_idle() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let conn = Mutex::new(setup_test_db());
    {
        let guard = conn.lock().unwrap();
        let queued = db::get_next_queued_job(&guard).unwrap();
        assert!(queued.is_none(), "空队列查询必须返回 Ok(None)");
    }

    let cancel_senders = Arc::new(Mutex::new(HashMap::new()));
    let temp = TestTempDir::new("empty_queue");
    let outcome = schedule_next_job_once(&conn, temp.path(), &cancel_senders).await;
    assert_eq!(outcome, ScheduleStepOutcome::Idle);

    let health = get_service_health();
    assert_eq!(health.scheduler_status, "idle");
    assert_eq!(health.current_job_id, None);
    assert_eq!(health.last_scheduler_error, None);
}

#[tokio::test]
async fn test_queue_query_error_captured_in_diagnostics() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let conn = Mutex::new(setup_test_db());
    // 破坏表结构模拟 SQL 查询异常
    {
        let guard = conn.lock().unwrap();
        guard.execute_batch("DROP TABLE parse_jobs;").unwrap();
    }

    let cancel_senders = Arc::new(Mutex::new(HashMap::new()));
    let temp = TestTempDir::new("query_error");
    let outcome = schedule_next_job_once(&conn, temp.path(), &cancel_senders).await;
    match outcome {
        ScheduleStepOutcome::QueueError(e) => {
            assert!(e.contains("no such table"), "必须向上传播明确错误: {}", e);
        }
        other => panic!("预期 QueueError，实际返回 {:?}", other),
    }

    let health = get_service_health();
    assert_eq!(health.scheduler_status, "error");
    assert!(health.last_scheduler_error.as_deref().unwrap_or("").contains("no such table"));
    assert!(health.last_scheduler_error_at.is_some());
}

#[test]
fn test_all_checkpoint_fields_roundtrip_consistency() {
    let conn = setup_test_db();
    let mut original = base_job(&conn, "C:/docs/roundtrip.pdf", "hash_full_fields", "queued");
    original.progress_percent = Some(88);
    original.completed_pages = Some(12);
    original.total_pages = Some(24);
    original.remote_id = Some("remote_12345".to_string());
    original.remote_meta_json = Some(r#"{"upload_url":"http://test"}"#.to_string());
    original.version_id = Some("ver_test".to_string());
    original.activated = 1;
    original.can_cancel = 0;
    original.can_resume = 1;
    original.error_code = Some("ERR_SAMPLE".to_string());
    original.error_message = Some("Sample failure message".to_string());
    original.update_seq = 42;
    original.snapshot_rel_path = Some("jobs/x/input/source.pdf".to_string());
    original.remote_submitted = 1;
    original.upload_completed = 1;
    original.artifacts_downloaded = 1;
    original.normalized_ready = 1;
    original.activation_baseline_version_id = Some("base_ver_abc".to_string());
    original.submit_attempted = 1;

    db::insert_parse_job(&conn, &original).unwrap();

    let fetched = db::get_parse_job(&conn, &original.job_id).unwrap().expect("通过 job_id 获取失败");
    assert_eq!(fetched, original, "db::get_parse_job 必须与插入完全一致");

    let dequeued = db::get_next_queued_job(&conn).unwrap().expect("通过 get_next_queued_job 获取失败");
    assert_eq!(dequeued, original, "db::get_next_queued_job 必须与插入完全一致，不能漏掉 submit_attempted 等字段");
}

#[tokio::test]
async fn test_cancelled_and_failed_jobs_not_dequeued() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let conn = Mutex::new(setup_test_db());
    {
        let guard = conn.lock().unwrap();
        let j1 = base_job(&guard, "C:/docs/cancel.pdf", "hc", "cancelled");
        let j2 = base_job(&guard, "C:/docs/fail.pdf", "hf", "failed");
        let j3 = base_job(&guard, "C:/docs/pause.pdf", "hp", "paused");
        let j4 = base_job(&guard, "C:/docs/succ.pdf", "hs", "succeeded");
        db::insert_parse_job(&guard, &j1).unwrap();
        db::insert_parse_job(&guard, &j2).unwrap();
        db::insert_parse_job(&guard, &j3).unwrap();
        db::insert_parse_job(&guard, &j4).unwrap();

        let queued = db::get_next_queued_job(&guard).unwrap();
        assert!(queued.is_none(), "非 queued 状态绝不能被出队查询取出");
    }

    let cancel_senders = Arc::new(Mutex::new(HashMap::new()));
    let temp = TestTempDir::new("not_dequeued");
    let outcome = schedule_next_job_once(&conn, temp.path(), &cancel_senders).await;
    assert_eq!(outcome, ScheduleStepOutcome::Idle);
}

#[test]
fn test_progress_update_increments_seq_during_processing() {
    let conn = setup_test_db();
    let mut job = base_job(&conn, "C:/docs/progress.pdf", "hash_prog", "processing");
    job.update_seq = 1;
    db::insert_parse_job(&conn, &job).unwrap();

    // First progress: 1/20
    let result = db::update_parse_job_progress(&conn, &job.job_id, Some(1), Some(20)).unwrap();
    assert_eq!(result, db::ProgressUpdateOutcome::Updated(2));

    let updated = db::get_parse_job(&conn, &job.job_id).unwrap().unwrap();
    assert_eq!(updated.completed_pages, Some(1));
    assert_eq!(updated.total_pages, Some(20));
    assert_eq!(updated.update_seq, 2);

    // Second progress in same processing stage: 6/20
    let result2 = db::update_parse_job_progress(&conn, &job.job_id, Some(6), Some(20)).unwrap();
    assert_eq!(result2, db::ProgressUpdateOutcome::Updated(3));

    let updated2 = db::get_parse_job(&conn, &job.job_id).unwrap().unwrap();
    assert_eq!(updated2.completed_pages, Some(6));
    assert_eq!(updated2.total_pages, Some(20));
    assert_eq!(updated2.update_seq, 3);
}

#[test]
fn test_late_progress_after_cancel_does_not_pollute() {
    let conn = setup_test_db();
    let mut job = base_job(&conn, "C:/docs/late.pdf", "hash_cancel_prog", "processing");
    job.completed_pages = Some(5);
    job.total_pages = Some(20);
    job.update_seq = 3;
    db::insert_parse_job(&conn, &job).unwrap();

    // Cancel the job
    let cancel_result = db::cancel_parse_job_cas(&conn, &job.job_id).unwrap();
    assert!(matches!(cancel_result, db::CancelOutcome::Cancelled(_)));

    let cancelled = db::get_parse_job(&conn, &job.job_id).unwrap().unwrap();
    assert_eq!(cancelled.status, "cancelled");
    let cancel_seq = cancelled.update_seq;
    let cancel_updated_at = cancelled.updated_at;

    // Late progress arrives after cancellation
    let result = db::update_parse_job_progress(&conn, &job.job_id, Some(10), Some(20)).unwrap();
    assert_eq!(result, db::ProgressUpdateOutcome::NotProcessing);

    // Verify: terminal record is completely untouched
    let after = db::get_parse_job(&conn, &job.job_id).unwrap().unwrap();
    assert_eq!(after.status, "cancelled");
    assert_eq!(after.completed_pages, Some(5));
    assert_eq!(after.total_pages, Some(20));
    assert_eq!(after.update_seq, cancel_seq);
    assert_eq!(after.updated_at, cancel_updated_at);
}

#[test]
fn test_progress_no_change_returns_no_change() {
    let conn = setup_test_db();
    let mut job = base_job(&conn, "C:/docs/nochange.pdf", "hash_nochange", "processing");
    job.completed_pages = Some(3);
    job.total_pages = Some(10);
    job.update_seq = 2;
    db::insert_parse_job(&conn, &job).unwrap();

    // Same values: no write, no seq increment
    let result = db::update_parse_job_progress(&conn, &job.job_id, Some(3), Some(10)).unwrap();
    assert_eq!(result, db::ProgressUpdateOutcome::NoChange);

    let after = db::get_parse_job(&conn, &job.job_id).unwrap().unwrap();
    assert_eq!(after.update_seq, 2); // unchanged
}

#[test]
fn test_health_read_does_not_advance_heartbeat() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Reset global health to a known state
    {
        let mut lock = SCHEDULER_HEALTH.lock().unwrap();
        *lock = Some(ParseServiceHealthDto {
            scheduler_status: "idle".to_string(),
            current_job_id: None,
            current_job_stage: None,
            last_scheduler_error: None,
            last_scheduler_error_at: None,
            last_heartbeat_at: 1_000_000,
        });
    }

    let h1 = get_service_health();
    assert_eq!(h1.last_heartbeat_at, 1_000_000);

    std::thread::sleep(std::time::Duration::from_millis(50));

    let h2 = get_service_health();
    assert_eq!(h2.last_heartbeat_at, 1_000_000);

    // Cleanup: reset to None to avoid interfering with other tests
    {
        let mut lock = SCHEDULER_HEALTH.lock().unwrap();
        *lock = None;
    }
}

#[tokio::test]
async fn test_health_stage_syncs_with_pipeline_transitions() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Reset health state for isolation
    {
        let mut lock = SCHEDULER_HEALTH.lock().unwrap();
        *lock = None;
    }

    let conn = Connection::open_in_memory().unwrap();
    db::run_migrations(&conn).unwrap();
    let mut job = base_job(&conn, "C:/docs/health_sync.pdf", "hash_health_sync", "queued");
    db::insert_parse_job(&conn, &job).unwrap();

    let conn_mutex = Mutex::new(conn);

    // Simulate what schedule_next_job_once does at dequeue: record busy with initial status
    record_scheduler_busy(&job.job_id, Some("queued"));

    let h1 = get_service_health();
    assert_eq!(h1.scheduler_status, "busy");
    assert_eq!(h1.current_job_stage.as_deref(), Some("queued"));

    // Simulate a stage transition to "uploading"
    let (_, rx) = watch::channel(false);
    let rt = JobRuntime {
        workspace_dir: std::env::temp_dir(),
        conn: &conn_mutex,
        cancel: rx,
    };
    let result = transition(&rt, &mut job, "uploading", true, false, None);
    assert!(result.unwrap());

    let h2 = get_service_health();
    assert_eq!(h2.current_job_stage.as_deref(), Some("uploading"));
    assert!(h2.last_heartbeat_at > 0);

    // Simulate a stage transition to "processing"
    let result2 = transition(&rt, &mut job, "processing", true, false, None);
    assert!(result2.unwrap());

    let h3 = get_service_health();
    assert_eq!(h3.current_job_stage.as_deref(), Some("processing"));

    // Simulate job end
    record_scheduler_idle();
    let h4 = get_service_health();
    assert_eq!(h4.current_job_id, None);
    assert_eq!(h4.current_job_stage, None);

    // Cleanup
    {
        let mut lock = SCHEDULER_HEALTH.lock().unwrap();
        *lock = None;
    }
}

#[test]
fn test_uninitialized_health_returns_zero_heartbeat() {
    let _health_guard = HEALTH_TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Clear global health
    {
        let mut lock = SCHEDULER_HEALTH.lock().unwrap();
        *lock = None;
    }

    let h = get_service_health();
    assert_eq!(h.last_heartbeat_at, 0);
    assert_eq!(h.scheduler_status, "idle");
    assert!(h.current_job_id.is_none());
}

