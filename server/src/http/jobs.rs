//! Synth + resynth triggers and job polling handlers (T9 + T10).
//!
//! - `POST /api/books/{id}/synth` — validates the book + voice cheaply, kicks
//!   off the background synth via [`run_synth_job`], returns `202 {jobId}`
//!   immediately. The client polls `GET /api/jobs/:id` for completion.
//! - `POST /api/books/{id}/resynth` — re-voices a book (text-only or full)
//!   under a required `voice` via [`run_resynth_job`]; same `202 {jobId}` +
//!   polling contract. Old-voice audio is discarded (worker replaces, not
//!   merges) — matches the desktop `resynth`.
//! - `GET /api/jobs/{id}` — one job's status (camelCase JSON), or `404`.
//! - `GET /api/jobs` — recent jobs (newest-updated first), capped at 50.
//!
//! All four are authed (they live on the protected sub-router in
//! [`crate::http`], so they inherit [`crate::http::auth::require_bearer`]).
//!
//! # Status mapping
//!
//! [`SynthTriggerError`] maps: `BookNotFound → 404`, `AlreadyFull → 409`,
//! `BadVoice → 400`, `MissingVoice → 400` (resynth only — voice required),
//! `Internal → 500`. Background synth failures never reach here — they flip
//! the job row to `failed`, surfaced via `GET /api/jobs/:id`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::fmt::Display;

use crate::db::{JobKind, JobRow, JobStatus};
use crate::http::AppState;
use crate::synth::{run_resynth_job, run_synth_job, SynthContext, SynthTriggerError};

/// `POST /api/books/{id}/synth` request body. All fields optional: `voice`
/// defaults to the server default voice; `voicePath` overrides the curated
/// catalog lookup; `jobs` overrides the configured worker count.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SynthReq {
    /// Curated voice id (e.g. `en_US-hfc_female-medium`).
    voice: Option<String>,
    /// Direct path to a `.onnx` voice model (skips catalog + download).
    voice_path: Option<std::path::PathBuf>,
    /// Parallel synth worker count.
    jobs: Option<usize>,
}

/// `202` response: `{ "jobId": "…" }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SynthAccepted {
    job_id: String,
}

/// camelCase JSON view of a [`JobRow`] — the public wire shape. `kind`/`status`
/// serialize to lowercase strings via their enum `serde` impls.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobDto {
    id: String,
    book_id: String,
    kind: JobKind,
    voice: String,
    status: JobStatus,
    done: i64,
    total: i64,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl From<JobRow> for JobDto {
    fn from(row: JobRow) -> Self {
        Self {
            id: row.id,
            book_id: row.book_id,
            kind: row.kind,
            voice: row.voice,
            status: row.status,
            done: row.done,
            total: row.total,
            error: row.error,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `POST /api/books/{id}/synth` → `202 {jobId}`.
///
/// Builds a [`SynthContext`] from the shared state + the configured backend,
/// delegates to [`run_synth_job`], and maps the trigger error to a status.
pub async fn trigger_synth(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    Json(req): Json<SynthReq>,
) -> Result<(StatusCode, Json<SynthAccepted>), (StatusCode, String)> {
    let ctx = SynthContext {
        db: state.db.clone(),
        data_dir: state.data_dir.clone(),
        voices_cache_dir: state.settings.voices_cache_dir.clone(),
        default_jobs: state.settings.jobs,
        backend: (*state.synth).clone(),
    };
    let job_id =
        run_synth_job(ctx, book_id, req.voice, req.voice_path, req.jobs)
            .await
            .map_err(trigger_status)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(SynthAccepted { job_id }),
    ))
}

/// `POST /api/books/{id}/resynth` request body. `voice` is required — the
/// whole point of resynth is a voice swap. Declared `Option` here (not `String`)
/// so a missing/empty field is rejected by the handler as `400 MissingVoice`
/// rather than axum's default `422` (the task spec wants `400`). `voicePath`/
/// `jobs` are optional overrides, mirroring [`SynthReq`].
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResynthReq {
    /// New curated voice id to re-voice under (required; empty/missing → 400).
    voice: Option<String>,
    /// Direct path to a `.onnx` voice model (skips catalog + download).
    voice_path: Option<std::path::PathBuf>,
    /// Parallel synth worker count.
    jobs: Option<usize>,
}

/// `POST /api/books/{id}/resynth` → `202 {jobId}`.
///
/// Re-voices the book under `req.voice`. Unlike [`trigger_synth`]: `voice` is
/// required (→ `400` when empty); the book may be text-only OR full (no
/// `409`); the background run rewrites `manifest.book.voiceId` to the new voice
/// and discards all old-voice audio (worker replaces, not merges — matches the
/// desktop `resynth`).
pub async fn trigger_resynth(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    Json(req): Json<ResynthReq>,
) -> Result<(StatusCode, Json<SynthAccepted>), (StatusCode, String)> {
    let ctx = SynthContext {
        db: state.db.clone(),
        data_dir: state.data_dir.clone(),
        voices_cache_dir: state.settings.voices_cache_dir.clone(),
        default_jobs: state.settings.jobs,
        backend: (*state.synth).clone(),
    };
    // Missing/empty voice → None → run_resynth_job returns MissingVoice (400).
    let voice = req.voice.filter(|s| !s.is_empty());
    let job_id =
        run_resynth_job(ctx, book_id, voice, req.voice_path, req.jobs)
            .await
            .map_err(trigger_status)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(SynthAccepted { job_id }),
    ))
}

/// `GET /api/jobs/{id}` → `200` single job, or `404` when absent.
pub async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<JobDto>, (StatusCode, String)> {
    let db = state.db.clone();
    let row = tokio::task::spawn_blocking(move || db.get_job(&id))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    match row {
        Some(r) => Ok(Json(JobDto::from(r))),
        None => Err((StatusCode::NOT_FOUND, "job not found".to_string())),
    }
}

/// `GET /api/jobs` → `200` array of the 50 most-recently-updated jobs.
pub async fn list_jobs(
    State(state): State<AppState>,
) -> Result<Json<Vec<JobDto>>, (StatusCode, String)> {
    let db = state.db.clone();
    let rows = tokio::task::spawn_blocking(move || db.list_recent_jobs(JOBS_LIST_LIMIT))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    Ok(Json(rows.into_iter().map(JobDto::from).collect()))
}

/// Cap on the number of rows `GET /api/jobs` returns. Generous for a single-user
/// server; pagination is a follow-on.
const JOBS_LIST_LIMIT: usize = 50;

// ----- helpers -----

/// Map a [`SynthTriggerError`] to its HTTP status + body text.
fn trigger_status(e: SynthTriggerError) -> (StatusCode, String) {
    match &e {
        SynthTriggerError::BookNotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
        SynthTriggerError::AlreadyFull { .. } => (StatusCode::CONFLICT, e.to_string()),
        SynthTriggerError::BadVoice(_) | SynthTriggerError::MissingVoice => {
            (StatusCode::BAD_REQUEST, e.to_string())
        }
        SynthTriggerError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Map any join/db error to a `500` body.
fn internal_error<E: Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::db::{Db, test_utils::StubDb};
    use crate::http::router;
    use crate::http::test_support::app_state_with_data_dir;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    /// The curated voice the synth tests request. Pre-seeding the cache with
    /// dummy `<id>.onnx` + `<id>.json` makes `resolve_voice` short-circuit (no
    /// network) — the stub runner ignores the model bytes.
    const TEST_VOICE: &str = "en_US-hfc_female-medium";

    // Fixtures from crates/synth (effort 1). Three `..` reaches the repo root.
    const BOOK_TEXT_ONLY_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-text-only.taletrek");
    const BOOK_FULL_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-full.taletrek");

    // ---- shared helpers ----

    /// Pre-seed `<cache>/<id>.onnx` + `.json` so voice resolution is a cache
    /// hit (no network) during the stubbed synth run.
    fn seed_voice_cache(cache_dir: &Path) {
        seed_voice(cache_dir, TEST_VOICE);
    }

    /// Seed a single voice id into the cache (one model + its `.json` sibling).
    /// Synth/resynth tests call this for every voice they exercise so the stub
    /// runner never needs network.
    fn seed_voice(cache_dir: &Path, id: &str) {
        std::fs::create_dir_all(cache_dir).expect("create voice cache dir");
        std::fs::write(cache_dir.join(format!("{id}.onnx")), b"stub-model-bytes")
            .expect("seed onnx");
        std::fs::write(cache_dir.join(format!("{id}.json")), b"{}").expect("seed json");
    }

    /// A fresh router backed by an empty [`StubDb`] + a real tempdir `data_dir`
    /// (which also hosts the voices cache). The [`tempfile::TempDir`] is
    /// returned alongside so the test keeps it alive.
    fn synth_router() -> (axum::Router, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        seed_voice_cache(&tmp.path().join("voices"));
        let db: Arc<dyn Db> = Arc::new(StubDb::new());
        let r = router(app_state_with_data_dir(db, tmp.path().to_path_buf(), "sekrit"));
        (r, tmp)
    }

    /// `POST /api/books/{id}/synth` with the bearer token + a JSON body.
    async fn trigger_synth_req(
        router: axum::Router,
        book_id: &str,
        body: &serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/books/{book_id}/synth"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        // Error responses use axum's `(StatusCode, String)` tuple → plain-text
        // bodies (not JSON). Wrap those as a JSON string so callers can still
        // assert on the message text; valid JSON parses normally.
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// `POST /api/books/{id}/resynth` with the bearer + a JSON body.
    async fn trigger_resynth_req(
        router: axum::Router,
        book_id: &str,
        body: &serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/books/{book_id}/resynth"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// Authed `GET` returning `(status, parsed-json)` (plain-text error bodies
    /// are wrapped as a JSON string so callers can assert on the message).
    async fn get_json(router: axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method("GET")
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// Upload a bundle via `POST /api/books` (multipart) + return its id.
    async fn upload(router: axum::Router, bytes: &[u8]) -> String {
        let boundary = "TESTBOUNDARY";
        let mut body = Vec::with_capacity(bytes.len() + 256);
        body.extend_from_slice(b"--");
        body.extend_from_slice(boundary.as_bytes());
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"bundle\"; filename=\"bundle.taletrek\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: application/zip\r\n\r\n");
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--");
        body.extend_from_slice(boundary.as_bytes());
        body.extend_from_slice(b"--\r\n");

        let req = Request::builder()
            .method("POST")
            .uri("/api/books")
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        json.as_array()
            .expect("array")
            .first()
            .expect("one book")["id"]
            .as_str()
            .expect("id string")
            .to_string()
    }

    /// Poll `GET /api/jobs/{id}` until `status` is terminal (`succeeded` /
    /// `failed`), returning the final job JSON. Panics after `timeout`.
    async fn poll_until_terminal(router: axum::Router, job_id: &str, timeout: Duration) -> serde_json::Value {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let (_, json) = get_json(router.clone(), &format!("/api/jobs/{job_id}")).await;
            match json["status"].as_str() {
                Some("succeeded") | Some("failed") => return json,
                _ => {}
            }
            if std::time::Instant::now() > deadline {
                panic!("job {job_id} did not reach terminal status within {timeout:?}: {json}");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Build a single-chapter text-only bundle whose only paragraph normalizes
    /// to empty (`   \n   `), serialized to `.taletrek` bytes. Used by the
    /// failure-path test.
    fn empty_paragraph_bundle() -> Vec<u8> {
        use std::io::Cursor;
        use taletrek_synth::{
            write_book_bundle, AudioCodec, AudioMeta, BookBundle, BookMeta, ChapterText, Generator,
            Manifest, ManifestKind, NORM_VERSION,
        };
        let bundle = BookBundle {
            manifest: Manifest {
                schema_version: 1,
                kind: ManifestKind::Book,
                book: BookMeta {
                    id: "bk_empty_para".into(),
                    title: "Empty".into(),
                    author: None,
                    source_format: "txt".into(),
                    chapter_count: 1,
                    voice_id: TEST_VOICE.into(),
                    created_at: 0,
                    updated_at: 0,
                    progress_fraction: None,
                },
                audio: AudioMeta {
                    present: false,
                    codec: AudioCodec::Opus,
                    norm_version: NORM_VERSION.parse().unwrap(),
                    segment_count: 0,
                },
                generator: Generator {
                    app: "taletrek-test".into(),
                    version: "0.0.0".into(),
                },
            },
            chapters: vec![ChapterText::new(
                "bk_empty_para",
                0,
                "Ch",
                vec!["   \n   ".into()],
            )],
            audio: HashMap::new(),
        };
        let mut buf = Cursor::new(Vec::new());
        write_book_bundle(&bundle, &mut buf).expect("serialize");
        buf.into_inner()
    }

    // ===== happy path: trigger → poll → succeeded =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_text_only_book_succeeds_and_produces_audio() {
        let (router, _tmp) = synth_router();

        // Upload a text-only book.
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;

        // Trigger synth → 202 with a jobId.
        let (status, json) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = json["jobId"]
            .as_str()
            .expect("jobId present")
            .to_string();

        // Poll until terminal. The stub runner is fast; 10s is plenty.
        let job = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;
        assert_eq!(
            job["status"].as_str(),
            Some("succeeded"),
            "job should succeed; got: {job}"
        );
        assert!(
            job.get("error").map(|e| e.is_null()).unwrap_or(true),
            "no error on success: {job}"
        );

        // The job's done/total reflect paragraph progress.
        let total = job["total"].as_i64().expect("total present");
        assert!(total > 0, "fixture has paragraphs; got total={total}");
        assert_eq!(
            job["done"].as_i64(),
            Some(total),
            "done reaches total: {job}"
        );

        // The book row now shows audioPresent=true.
        let (_, book) = get_json(router.clone(), &format!("/api/books/{id}")).await;
        assert_eq!(book["audioPresent"].as_bool(), Some(true));

        // The stored bundle carries audio + the server producer string.
        let bundle_bytes = {
            let req = Request::builder()
                .method("GET")
                .uri(format!("/api/books/{id}/bundle"))
                .header(header::AUTHORIZATION, "Bearer sekrit")
                .body(Body::empty())
                .expect("valid request");
            let resp = router.oneshot(req).await.expect("router serves");
            assert_eq!(resp.status(), StatusCode::OK);
            axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .expect("body bytes")
                .to_vec()
        };
        let parsed = taletrek_synth::read_book_bundle(&bundle_bytes).expect("parses");
        assert!(parsed.manifest.audio.present, "audio.present==true");
        assert_eq!(parsed.manifest.generator.app, "taletrek-server");
        assert!(!parsed.audio.is_empty(), "audio map populated");
    }

    // ===== progress advances during a multi-paragraph synth =====

    #[tokio::test(flavor = "multi_thread")]
    async fn job_total_is_positive_and_done_reaches_total() {
        // Covered by the happy-path assertions, but this test makes the
        // progress contract explicit + independent of the audio checks.
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (_, json) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        let job_id = json["jobId"].as_str().unwrap().to_string();
        let job = poll_until_terminal(router, &job_id, Duration::from_secs(10)).await;
        assert!(job["total"].as_i64().unwrap() > 0);
        assert_eq!(job["done"].as_i64(), job["total"].as_i64());
    }

    // ===== already-full book → 409 =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_on_full_book_is_409() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_FULL_FIX).await;
        let (status, json) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        assert_eq!(status, StatusCode::CONFLICT);
        // The body points the user at resynth.
        let body = serde_json::to_string(&json).unwrap_or_default();
        assert!(
            body.contains("resynth") || json.as_str().map(|s| s.contains("resynth")).unwrap_or(false),
            "409 body should hint at resynth: {json}"
        );
    }

    // ===== unknown book → 404 =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_on_unknown_book_is_404() {
        let (router, _tmp) = synth_router();
        let (status, _) =
            trigger_synth_req(router, "definitely-absent", &serde_json::json!({})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // ===== unknown voice id → 400 =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_with_unknown_voice_is_400() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (status, _) = trigger_synth_req(
            router,
            &id,
            &serde_json::json!({ "voice": "en_US-bogus-high" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // ===== empty-paragraph synth → job failed =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_on_empty_paragraph_records_failed_with_error() {
        let (router, _tmp) = synth_router();
        let bytes = empty_paragraph_bundle();
        let id = upload(router.clone(), &bytes).await;

        let (status, json) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = json["jobId"].as_str().unwrap().to_string();

        let job = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;
        assert_eq!(job["status"].as_str(), Some("failed"));
        let error = job["error"].as_str().expect("error set");
        assert!(!error.is_empty(), "error message non-empty: {job}");

        // The stored bundle is unchanged (still text-only).
        let (_, book) = get_json(router, &format!("/api/books/{id}")).await;
        assert_eq!(
            book["audioPresent"].as_bool(),
            Some(false),
            "failed synth must not flip audioPresent"
        );
    }

    // ===== GET /api/jobs/:id + GET /api/jobs =====

    #[tokio::test(flavor = "multi_thread")]
    async fn get_job_returns_camelcase_dto_or_404() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (_, trig) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        let job_id = trig["jobId"].as_str().unwrap().to_string();

        // Wait for the row to exist (the trigger creates it synchronously, but
        // poll anyway to also exercise the running/succeeded transitions).
        let job = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;

        // camelCase keys present; no snake_case leak.
        assert_eq!(job["id"], job_id);
        assert!(job.get("bookId").is_some(), "camelCase bookId");
        assert!(job.get("book_id").is_none(), "no snake_case leak");
        assert!(job.get("createdAt").is_some());
        assert!(job.get("updatedAt").is_some());
        assert_eq!(job["kind"].as_str(), Some("synth"));

        // Unknown job → 404.
        let (status, _) = get_json(router, "/api/jobs/never-existed").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn list_jobs_returns_recent_jobs() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (_, trig) =
            trigger_synth_req(router.clone(), &id, &serde_json::json!({})).await;
        let job_id = trig["jobId"].as_str().unwrap().to_string();
        // Let it finish so the row is stable.
        let _ = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;

        let (status, list) = get_json(router, "/api/jobs").await;
        assert_eq!(status, StatusCode::OK);
        let arr = list.as_array().expect("array");
        assert!(!arr.is_empty(), "at least the one job");
        assert!(
            arr.iter().any(|j| j["id"] == job_id),
            "our job is listed: {list}"
        );
    }

    // ===== resynth: re-voice a full book under a new voice =====

    /// The target voice resynth re-voices under. Distinct from [`TEST_VOICE`]
    /// so the test proves the manifest + segment keys actually move.
    const RESYNTH_VOICE: &str = "en_US-ryan-medium";

    /// Fetch the stored bundle bytes for `id` via the download endpoint.
    async fn download_bundle(router: axum::Router, id: &str) -> Vec<u8> {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/books/{id}/bundle"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes")
            .to_vec()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_full_book_rekeys_segments_under_new_voice() {
        let (router, tmp) = synth_router();
        // Seed the target voice so resolution is a cache hit (no network).
        seed_voice(&tmp.path().join("voices"), RESYNTH_VOICE);

        // Start from a full book (already has audio under its fixture voice).
        let id = upload(router.clone(), BOOK_FULL_FIX).await;
        let (status, json) = trigger_resynth_req(
            router.clone(),
            &id,
            &serde_json::json!({ "voice": RESYNTH_VOICE }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let job_id = json["jobId"].as_str().unwrap().to_string();

        let job = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;
        assert_eq!(job["status"].as_str(), Some("succeeded"), "job: {job}");
        assert_eq!(job["kind"].as_str(), Some("resynth"), "kind is resynth: {job}");

        // The manifest now carries the new voice; audio stays present.
        let bytes = download_bundle(router.clone(), &id).await;
        let parsed = taletrek_synth::read_book_bundle(&bytes).expect("parses");
        assert_eq!(parsed.manifest.book.voice_id, RESYNTH_VOICE);
        assert!(parsed.manifest.audio.present, "audio stays present after resynth");
        assert!(!parsed.audio.is_empty(), "audio map populated");

        // Every segment is keyed under the new voice. cache_key = `${voice}:${ver}:${hash}`,
        // so the voice id is the component before the first `:`.
        for key in parsed.audio.keys() {
            let voice = key.split(':').next().unwrap_or("");
            assert_eq!(
                voice, RESYNTH_VOICE,
                "segment keyed under new voice; got key {key}"
            );
        }
        // And the cache_keys reconstructed from the bundle's own paragraphs are
        // all present (proves the re-key is content-addressed, not just renamed).
        for ch in &parsed.chapters {
            for para in &ch.paragraphs {
                assert!(
                    parsed.audio.contains_key(&taletrek_synth::cache_key(RESYNTH_VOICE, para)),
                    "segment for paragraph missing under new voice key"
                );
            }
        }

        // The book row reflects the new voice + still-present audio.
        let (_, book) = get_json(router, &format!("/api/books/{id}")).await;
        assert_eq!(book["audioPresent"].as_bool(), Some(true));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_text_only_book_produces_full_bundle_under_new_voice() {
        let (router, tmp) = synth_router();
        seed_voice(&tmp.path().join("voices"), RESYNTH_VOICE);

        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (status, _) = trigger_resynth_req(
            router.clone(),
            &id,
            &serde_json::json!({ "voice": RESYNTH_VOICE }),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);

        // Poll the jobs list for this book's terminal row (the 202 returned no
        // jobId in this test's wiring — the body parser path above already
        // covered that; here we just wait on the book's latest job).
        let job = loop {
            let (_, list) = get_json(router.clone(), "/api/jobs").await;
            let arr = list.as_array().expect("array");
            if let Some(j) = arr.iter().find(|j| j["bookId"] == id) {
                if matches!(j["status"].as_str(), Some("succeeded") | Some("failed")) {
                    break j.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(job["status"].as_str(), Some("succeeded"), "job: {job}");

        let bytes = download_bundle(router.clone(), &id).await;
        let parsed = taletrek_synth::read_book_bundle(&bytes).expect("parses");
        assert_eq!(parsed.manifest.book.voice_id, RESYNTH_VOICE);
        assert!(parsed.manifest.audio.present, "text-only → full under new voice");
        assert!(!parsed.audio.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_unknown_book_is_404() {
        let (router, _tmp) = synth_router();
        let (status, _) = trigger_resynth_req(
            router,
            "definitely-absent",
            &serde_json::json!({ "voice": RESYNTH_VOICE }),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_without_voice_is_400() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        // Missing voice field → deserializes to default ("") → treated as None → 400.
        let (status, _) =
            trigger_resynth_req(router, &id, &serde_json::json!({})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_with_unknown_voice_is_400() {
        let (router, _tmp) = synth_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let (status, _) = trigger_resynth_req(
            router,
            &id,
            &serde_json::json!({ "voice": "en_US-bogus-high" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resynth_without_auth_is_401() {
        let (router, _tmp) = synth_router();
        let req = Request::builder()
            .method("POST")
            .uri("/api/books/whatever/resynth")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{\"voice\":\"en_US-ryan-medium\"}"))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ===== auth still required =====

    #[tokio::test(flavor = "multi_thread")]
    async fn synth_without_auth_is_401() {
        let (router, _tmp) = synth_router();
        let req = Request::builder()
            .method("POST")
            .uri("/api/books/whatever/synth")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn jobs_without_auth_is_401() {
        let (router, _tmp) = synth_router();
        let req = Request::builder()
            .method("GET")
            .uri("/api/jobs")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
