//! Book library handlers — the full CRUD vertical.
//!
//! Read endpoints (`GET /api/books`, `GET /api/books/{id}`) pull metadata
//! straight from the SQLite index. Write endpoints (T8):
//! - `POST /api/books` — multipart upload of one `.taletrek` / `.taletrek-lib`,
//!   ingested via [`crate::store::ingest`], with each book's [`BookRow`]
//!   upserted into the index.
//! - `GET /api/books/{id}/bundle` — streams the stored bundle bytes back
//!   (byte-identical to what was uploaded).
//! - `DELETE /api/books/{id}` — removes the bundle file + its index row
//!   (idempotent: `204` whether or not the book existed).
//!
//! Every `store`/`Db` call runs inside `tokio::task::spawn_blocking` (rusqlite
//! + file I/O are blocking) — see [`spawn_blocking_ok`].
//!
//! # Wire format — camelCase
//!
//! [`BookDto`] serializes in `camelCase` to match the bundle format + the SPA
//! (`sourceFormat`, `voiceId`, `audioPresent`, …). The SQLite row ([`BookRow`])
//! keeps snake_case field names; the DTO is the JSON boundary.
//!
//! # Idempotent upsert by book id
//!
//! GOTCHA: the server stores each book keyed by the bundle's own `book.id`
//! (the canonical-library policy — see [`crate::store`]). A re-upload of the
//! same id is an **upsert**, not a new book: the bundle file is overwritten in
//! place and the index row is updated, with `created_at` preserved from the
//! existing row (so a re-ingest does not reset the book's library-add time).
//! This is a deliberate divergence from the SPA's allocate-new-id-on-collision
//! (effort 3); do not "fix" it.

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Serialize;

use crate::db::{now_ms, BookRow, DbError};
use crate::http::AppState;
use crate::store::{self, IngestedBook, StoreError};

/// camelCase JSON view of a [`BookRow`] — the public wire shape.
///
/// `BookRow` itself stays snake_case (mirrors the SQL columns); this DTO is the
/// boundary that flips `source_format` → `sourceFormat` etc. so the API matches
/// the bundle manifest + the SPA exactly.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookDto {
    id: String,
    title: String,
    author: Option<String>,
    source_format: String,
    voice_id: String,
    audio_present: bool,
    chapter_count: i64,
    created_at: i64,
    updated_at: i64,
}

impl From<BookRow> for BookDto {
    fn from(row: BookRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            author: row.author,
            source_format: row.source_format,
            voice_id: row.voice_id,
            audio_present: row.audio_present,
            chapter_count: row.chapter_count,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `GET /api/books` → `200` JSON array of every book's metadata (newest-first
/// by `created_at`, per [`Db::list_books`]). Empty library → `200 []`.
pub async fn list_books(
    State(state): State<AppState>,
) -> Result<Json<Vec<BookDto>>, (StatusCode, String)> {
    let db = state.db.clone();
    let rows = tokio::task::spawn_blocking(move || db.list_books())
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    Ok(Json(rows.into_iter().map(BookDto::from).collect()))
}

/// `GET /api/books/{id}` → `200` single book, or `404` when the id is absent.
pub async fn get_book(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BookDto>, (StatusCode, String)> {
    let db = state.db.clone();
    let row = tokio::task::spawn_blocking(move || db.get_book(&id))
        .await
        .map_err(internal_error)?
        .map_err(internal_error)?;
    match row {
        Some(row) => Ok(Json(BookDto::from(row))),
        None => Err((StatusCode::NOT_FOUND, "book not found".to_string())),
    }
}

/// `POST /api/books` — multipart upload of one `.taletrek` / `.taletrek-lib`.
///
/// Reads the `bundle` field, ingests it via [`store::ingest`] (handles both
/// bundle kinds + dedup by book id), and upserts each [`IngestedBook`] into the
/// SQLite index via [`Db::upsert_book`]. Returns `201` with the array of
/// ingested book metadata (camelCase JSON). Malformed/non-bundle upload → `400`
/// with the [`StoreError`] rendered.
///
/// # Body size limit
///
/// GOTCHA: the request body is capped at `settings.max_bundle_bytes`
/// (default 256 MiB; configurable via `TALETREK_MAX_BUNDLE_BYTES`). Oversized
/// uploads are rejected with `413` by axum's `DefaultBodyLimit` (mounted on the
/// protected sub-router). Full bundles with audio can be tens of MiB; a library
/// bundle of many full books can exceed this — raise the limit in `config.toml`
/// or via the env var if you curate large libraries.
pub async fn upload_book(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Vec<BookDto>>), (StatusCode, String)> {
    let bytes = read_bundle_field(&mut multipart).await?;
    let rows = ingest_bundle_bytes(&state, bytes).await?;
    let dtos = rows.into_iter().map(BookDto::from).collect();
    Ok((StatusCode::CREATED, Json(dtos)))
}

/// Ingest uploaded bundle bytes + upsert every book into the index. Shared by
/// the JSON upload handler ([`upload_book`]) and the UI upload form
/// (`ui::upload_book`) so the two paths can't diverge. All blocking work
/// (`store::ingest` + `Db`) runs in one `spawn_blocking`.
pub(crate) async fn ingest_bundle_bytes(
    state: &AppState,
    bytes: Vec<u8>,
) -> Result<Vec<BookRow>, (StatusCode, String)> {
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    match tokio::task::spawn_blocking(move || -> Result<Vec<BookRow>, OpError> {
        let ingested = store::ingest(&data_dir, &bytes)?;
        let mut rows = Vec::with_capacity(ingested.len());
        for book in ingested {
            // created_at preserved on re-ingest; updated_at bumped to now.
            let existing = db.get_book(&book.meta.id)?;
            let row = row_from_ingested(book, existing.as_ref());
            db.upsert_book(row.clone())?;
            rows.push(row);
        }
        Ok(rows)
    })
    .await
    {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(OpError::Store(e))) => Err((store_status(&e), e.to_string())),
        Ok(Err(OpError::Db(e))) => Err(internal_error(e)),
        Err(e) => Err(internal_error(e)),
    }
}

/// `GET /api/books/{id}/bundle` — returns the stored bundle bytes (buffered in
/// memory — v1 does not chunk-stream; the size is bounded by the same
/// `max_bundle_bytes` cap that gated the upload) with
/// `Content-Type: application/zip` and a `Content-Disposition` attachment
/// header (`<id>.taletrek`). Unknown id → `404`. The bytes are byte-identical
/// to what was uploaded ([`store::put_bundle`] writes verbatim, no re-encode).
pub async fn download_bundle(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let data_dir = state.data_dir.clone();
    let id_for_fetch = id.clone();
    let bytes = match tokio::task::spawn_blocking(move || {
        store::get_bundle(&data_dir, &id_for_fetch)
    })
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(store_not_found_or_internal(&e)),
        Err(e) => return Err(internal_error(e)),
    };

    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    // `<id>` is a validated single path component (store::validate_book_id),
    // so it is safe to embed in the disposition filename — unless it carries
    // quoting-hostile bytes (`"`), which path validation alone permits. Real
    // ids (SPA/desktop-generated hex) never do; anything else goes through the
    // RFC 5987 `filename*` percent-encoded form so the header can't be broken.
    let cd = if id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        format!("attachment; filename=\"{id}.taletrek\"")
    } else {
        let pct: String = id.bytes().map(|b| format!("%{b:02X}")).collect();
        format!("attachment; filename*=UTF-8''{pct}.taletrek")
    };
    if let Ok(val) = HeaderValue::from_str(&cd) {
        h.insert(header::CONTENT_DISPOSITION, val);
    }
    Ok(resp)
}

/// `DELETE /api/books/{id}` — removes the bundle file + its index row.
///
/// Idempotent: returns `204` whether or not the book existed (a missing book is
/// not an error). Both [`store::delete_bundle`] and [`Db::delete_book`] treat
/// "absent" as success. A path-unsafe id → `400`; any other store/db error →
/// `500`.
pub async fn delete_book(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    delete_book_id(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a book's bundle file + index row. Shared by the JSON delete handler
/// ([`delete_book`]) and the UI delete form (`ui::delete_book`). Idempotent —
/// both `store::delete_bundle` and `Db::delete_book` treat "absent" as success.
///
/// Refused with `409` while a synth/resynth job runs for the book: the job's
/// completion would re-write the bundle + re-upsert the row, resurrecting the
/// "deleted" book. Retry after the job finishes (poll `GET /api/jobs`).
pub(crate) async fn delete_book_id(state: &AppState, id: &str) -> Result<(), (StatusCode, String)> {
    if state.in_flight.contains(id) {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "a synth job is currently running for book {id}; wait for it to finish \
                 (GET /api/jobs) before deleting"
            ),
        ));
    }
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    let id = id.to_string();
    match tokio::task::spawn_blocking(move || -> Result<(), OpError> {
        store::delete_bundle(&data_dir, &id)?;
        db.delete_book(&id)?;
        Ok(())
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(OpError::Store(e))) => Err((store_status(&e), e.to_string())),
        Ok(Err(OpError::Db(e))) => Err(internal_error(e)),
        Err(e) => Err(internal_error(e)),
    }
}

// ----- helpers -----

/// Read the `bundle` field out of a multipart body. Returns `400` (via
/// [`multipart_err`]) on any parse failure, including a body that overflows the
/// limit (`413`). Returns `400` if no field named `bundle` is present.
///
/// `pub(crate)` so the UI upload form (`ui::upload_book`) reads the same field
/// shape — the JSON + UI upload paths stay byte-for-byte identical here.
pub(crate) async fn read_bundle_field(
    multipart: &mut Multipart,
) -> Result<Vec<u8>, (StatusCode, String)> {
    while let Some(field) = multipart.next_field().await.map_err(multipart_err)? {
        if field.name() == Some("bundle") {
            let bytes = field.bytes().await.map_err(multipart_err)?;
            return Ok(bytes.to_vec());
        }
    }
    Err((
        StatusCode::BAD_REQUEST,
        "multipart upload missing 'bundle' field".to_string(),
    ))
}

/// Map an axum [`MultipartError`] to its proper status (`400` malformed,
/// `413` too large, `500` internal) + body text.
fn multipart_err(e: axum::extract::multipart::MultipartError) -> (StatusCode, String) {
    (e.status(), e.body_text())
}

/// Build a [`BookRow`] from an ingested bundle book, preserving the existing
/// row's `created_at` on re-ingest (idempotent upsert); `updated_at` is bumped
/// to now. The bundle's own `created_at` seeds a first-time ingest.
fn row_from_ingested(book: IngestedBook, existing: Option<&BookRow>) -> BookRow {
    BookRow {
        created_at: existing
            .map(|e| e.created_at)
            .unwrap_or(book.meta.created_at as i64),
        updated_at: now_ms(),
        id: book.meta.id,
        title: book.meta.title,
        author: book.meta.author,
        source_format: book.meta.source_format,
        voice_id: book.meta.voice_id,
        audio_present: book.audio_present,
        chapter_count: book.meta.chapter_count as i64,
    }
}

/// HTTP status for a [`StoreError`]. Client-caused (bad bytes, unsafe id, not a
/// bundle) → `400`; server faults (io) → `500`. `NotFound` maps to `500` here —
/// the upload/delete handlers never rely on it (delete is idempotent; upload
/// never finds one), and the download handler maps it to `404` explicitly via
/// [`store_not_found_or_internal`].
fn store_status(e: &StoreError) -> StatusCode {
    match e {
        StoreError::Bundle(_)
        | StoreError::NotLibraryOrBook { .. }
        | StoreError::InvalidBookId(_) => StatusCode::BAD_REQUEST,
        StoreError::Io(_) | StoreError::NotFound(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Map a [`StoreError`] from `get_bundle` to `404` on [`StoreError::NotFound`],
/// else `500`.
fn store_not_found_or_internal(e: &StoreError) -> (StatusCode, String) {
    match e {
        StoreError::NotFound(id) => (StatusCode::NOT_FOUND, format!("book not found: {id}")),
        other => (store_status(other), other.to_string()),
    }
}

/// Map any join/db error to a `500` body. `404`s are produced explicitly in the
/// handlers, never here — a missing book is not a server error.
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// A blocking op that touches both `store` + `Db`, unified for one
/// `spawn_blocking` closure. [`OpError::Store`] maps to a client or server
/// status via [`store_status`]; [`OpError::Db`] always maps to `500`.
enum OpError {
    Store(StoreError),
    Db(DbError),
}

impl From<StoreError> for OpError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<DbError> for OpError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{test_utils::StubDb, Db};
    use crate::http::router;
    use crate::http::test_support::{app_state_with_data_dir, app_state_with_db};

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use std::sync::Arc;
    use tower::ServiceExt;

    // ---- fixtures ----

    fn book(id: &str, audio: bool) -> BookRow {
        BookRow {
            id: id.to_string(),
            title: format!("Title {id}"),
            author: Some(format!("Author {id}")),
            source_format: "epub".to_string(),
            voice_id: "en_US-lessac".to_string(),
            audio_present: audio,
            chapter_count: 12,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    /// A router backed by a stub db pre-seeded with b1 (audio=true) + b2.
    fn seeded_router() -> axum::Router {
        let db = StubDb::new();
        db.upsert_book(book("b1", true)).expect("seed b1");
        db.upsert_book(book("b2", false)).expect("seed b2");
        let db: Arc<dyn Db> = Arc::new(db);
        router(app_state_with_db(db, "sekrit"))
    }

    /// `GET` a path with the bearer token; return `(status, parsed-json)`.
    /// A non-JSON / empty body parses to `Value::Null`.
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
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    // ---- list ----

    #[tokio::test]
    async fn list_returns_seeded_books_in_camelcase() {
        let (status, json) = get_json(seeded_router(), "/api/books").await;
        assert_eq!(status, StatusCode::OK);

        let arr = json.as_array().expect("response is an array");
        assert_eq!(arr.len(), 2, "both seeded books present");

        // Both ids are present (order is not asserted — ties on created_at).
        let ids: Vec<&str> = arr
            .iter()
            .map(|v| v["id"].as_str().expect("id is string"))
            .collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b2"));

        // Spot-check b1's full camelCase shape — no snake_case leak.
        let b1 = arr.iter().find(|v| v["id"] == "b1").expect("b1 in array");
        assert_eq!(b1["title"], "Title b1");
        assert_eq!(b1["author"], "Author b1");
        assert_eq!(b1["sourceFormat"], "epub");
        assert_eq!(b1["voiceId"], "en_US-lessac");
        assert_eq!(b1["audioPresent"].as_bool(), Some(true));
        assert_eq!(b1["chapterCount"].as_i64(), Some(12));
        assert_eq!(b1["createdAt"].as_i64(), Some(1_700_000_000_000));
        assert_eq!(b1["updatedAt"].as_i64(), Some(1_700_000_000_000));

        // snake_case keys must NOT appear.
        assert!(b1.get("source_format").is_none(), "no snake_case leak");
        assert!(b1.get("voice_id").is_none());
        assert!(b1.get("audio_present").is_none());
        assert!(b1.get("chapter_count").is_none());
        assert!(b1.get("created_at").is_none());
        assert!(b1.get("updated_at").is_none());
    }

    // ---- get one ----

    #[tokio::test]
    async fn get_returns_one_book() {
        let (status, json) = get_json(seeded_router(), "/api/books/b1").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["id"], "b1");
        assert_eq!(json["sourceFormat"], "epub");
        assert_eq!(json["audioPresent"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn get_unknown_returns_404() {
        let (status, _json) = get_json(seeded_router(), "/api/books/missing").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // ===== T8: upload / download / delete =====

    // Fixtures from crates/synth (effort 1). Relative to server/src/http/books.rs:
    // three `..` reaches the repo root.
    const BOOK_TEXT_ONLY_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-text-only.taletrek");
    const BOOK_FULL_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-full.taletrek");
    const LIBRARY_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/library.taletrek-lib");

    /// Build a `multipart/form-data` body carrying one field named `bundle`.
    fn multipart_bundle_body(boundary: &str, bytes: &[u8]) -> Vec<u8> {
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
        body
    }

    /// A fresh router backed by an empty [`StubDb`] + a real tempdir `data_dir`.
    /// The [`tempfile::TempDir`] is returned alongside so the test keeps it
    /// alive for the duration of its `oneshot` calls.
    fn empty_router_with_tmp() -> (axum::Router, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db: Arc<dyn Db> = Arc::new(StubDb::new());
        let r = router(app_state_with_data_dir(
            db,
            tmp.path().to_path_buf(),
            "sekrit",
        ));
        (r, tmp)
    }

    /// `POST /api/books` with the bearer token + `bytes` as the `bundle` field.
    async fn upload(router: axum::Router, bytes: &[u8]) -> (StatusCode, serde_json::Value) {
        let boundary = "TESTBOUNDARY";
        let body = multipart_bundle_body(boundary, bytes);
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
        let status = resp.status();
        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value =
            serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// `GET /api/books/{id}/bundle` with the bearer token.
    async fn download(router: axum::Router, id: &str) -> (StatusCode, Vec<u8>) {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/books/{id}/bundle"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .map(|b| b.to_vec())
            .unwrap_or_default();
        (status, bytes)
    }

    /// `DELETE /api/books/{id}` with the bearer token.
    async fn delete(router: axum::Router, id: &str) -> StatusCode {
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/books/{id}"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        router.oneshot(req).await.expect("router serves").status()
    }

    /// Extract the single book id from a `POST /api/books` JSON response.
    fn one_id(json: &serde_json::Value) -> String {
        json.as_array()
            .expect("response is an array")
            .first()
            .expect("one book in response")["id"]
            .as_str()
            .expect("id is a string")
            .to_string()
    }

    // ---- round trip: upload → list → download → delete ----

    #[tokio::test]
    async fn text_only_round_trip_upload_list_download_delete() {
        let (router, _tmp) = empty_router_with_tmp();

        // Upload → 201, one book in the response (camelCase), audioPresent=false.
        let (status, json) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        assert_eq!(status, StatusCode::CREATED);
        let arr = json.as_array().expect("response is an array");
        assert_eq!(arr.len(), 1, "one book ingested");
        let id = one_id(&json);
        assert_eq!(arr[0]["audioPresent"].as_bool(), Some(false));
        assert!(arr[0].get("audio_present").is_none(), "camelCase only");

        // GET /api/books now lists it.
        let (status, list) = get_json(router.clone(), "/api/books").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["id"], id);

        // Download is byte-identical to the uploaded fixture.
        let (status, bytes) = download(router.clone(), &id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes.as_slice(), BOOK_TEXT_ONLY_FIX);

        // Delete → 204; GET /api/books is now empty.
        assert_eq!(delete(router.clone(), &id).await, StatusCode::NO_CONTENT);
        let (status, list) = get_json(router, "/api/books").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            list.as_array().unwrap().len(),
            0,
            "library empty after delete"
        );
    }

    // ---- full bundle sets audio_present=true ----

    #[tokio::test]
    async fn full_bundle_upload_reflects_audio_present_true() {
        let (router, _tmp) = empty_router_with_tmp();
        let (status, json) = upload(router.clone(), BOOK_FULL_FIX).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(json.as_array().unwrap().len(), 1);
        assert_eq!(
            json[0]["audioPresent"].as_bool(),
            Some(true),
            "full bundle carries audio"
        );
        // The index row (via GET) agrees.
        let id = one_id(&json);
        let (_, list) = get_json(router, "/api/books").await;
        let row = list
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .expect("book listed");
        assert_eq!(row["audioPresent"].as_bool(), Some(true));
    }

    // ---- library bundle → N books, each independently downloadable ----

    #[tokio::test]
    async fn library_upload_yields_each_book_each_downloadable() {
        let lib = taletrek_synth::read_library_bundle(LIBRARY_FIX).expect("lib parses");
        assert!(!lib.books.is_empty(), "fixture carries >=1 book");
        let expected: Vec<String> = lib
            .books
            .iter()
            .map(|b| b.manifest.book.id.clone())
            .collect();

        let (router, _tmp) = empty_router_with_tmp();
        let (status, json) = upload(router.clone(), LIBRARY_FIX).await;
        assert_eq!(status, StatusCode::CREATED);
        let arr = json.as_array().unwrap();
        assert_eq!(arr.len(), expected.len(), "one entry per nested book");
        let got: Vec<String> = arr
            .iter()
            .map(|v| v["id"].as_str().unwrap().to_string())
            .collect();
        for id in &expected {
            assert!(got.contains(id), "ingested id {id} present");
        }

        // Each is independently listable + downloadable as a book bundle.
        let (_, list) = get_json(router.clone(), "/api/books").await;
        assert_eq!(list.as_array().unwrap().len(), expected.len());
        for id in &expected {
            let (status, bytes) = download(router.clone(), id).await;
            assert_eq!(status, StatusCode::OK, "download {id}");
            // The downloaded bytes parse as a single-book bundle with this id.
            let reparsed = taletrek_synth::read_book_bundle(&bytes).expect("round-trips");
            assert_eq!(reparsed.manifest.book.id, *id);
        }
    }

    // ---- dedup: same book twice is an idempotent upsert ----

    #[tokio::test]
    async fn upload_same_book_twice_is_an_idempotent_upsert() {
        let (router, _tmp) = empty_router_with_tmp();

        let (s1, j1) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        assert_eq!(s1, StatusCode::CREATED);
        let id1 = one_id(&j1);
        let created1 = j1[0]["createdAt"].as_i64().expect("createdAt present");

        let (s2, j2) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        assert_eq!(s2, StatusCode::CREATED);
        let id2 = one_id(&j2);
        assert_eq!(id1, id2, "same id on re-upload");

        // Still exactly one book, with created_at preserved.
        let (_, list) = get_json(router, "/api/books").await;
        let arr = list.as_array().unwrap();
        assert_eq!(arr.len(), 1, "dedup: one row, not two");
        assert_eq!(arr[0]["id"], id1);
        assert_eq!(
            arr[0]["createdAt"].as_i64(),
            Some(created1),
            "createdAt preserved across re-ingest"
        );
        // updated_at bumped to >= the response of the second upload.
        let updated2 = j2[0]["updatedAt"].as_i64().expect("updatedAt present");
        assert!(
            arr[0]["updatedAt"].as_i64().unwrap() >= updated2,
            "updatedAt bumped on re-ingest"
        );
    }

    // ---- auth still required on the write paths ----

    #[tokio::test]
    async fn upload_without_auth_is_401() {
        let (router, _tmp) = empty_router_with_tmp();
        let boundary = "TESTBOUNDARY";
        let body = multipart_bundle_body(boundary, BOOK_TEXT_ONLY_FIX);
        let req = Request::builder()
            .method("POST")
            .uri("/api/books")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn delete_without_auth_is_401() {
        let (router, _tmp) = empty_router_with_tmp();
        let req = Request::builder()
            .method("DELETE")
            .uri("/api/books/anything")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ---- error paths ----

    #[tokio::test]
    async fn download_unknown_id_is_404() {
        let (router, _tmp) = empty_router_with_tmp();
        let (status, _bytes) = download(router, "definitely-absent").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn upload_garbage_bytes_is_400() {
        let (router, _tmp) = empty_router_with_tmp();
        let (status, json) = upload(router, b"definitely not a zip").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // The StoreError is rendered into the body.
        assert!(json != serde_json::Value::Null || status == StatusCode::BAD_REQUEST);
    }

    // ---- body-size limit: oversized uploads are 413 ----

    #[tokio::test]
    async fn upload_over_the_configured_body_limit_is_413() {
        // A max_bundle_bytes just below the fixture's (multipart-wrapped) size
        // must be refused by the DefaultBodyLimit plumbing — 413, nothing
        // written. Pins the layer against a config/regression that silently
        // drops it (unbounded request memory).
        let tmp = tempfile::tempdir().expect("tempdir");
        let db: Arc<dyn Db> = Arc::new(StubDb::new());
        let r = router(
            crate::http::test_support::app_state_with_data_dir_and_max_bytes(
                db,
                tmp.path().to_path_buf(),
                "sekrit",
                BOOK_TEXT_ONLY_FIX.len() - 1,
            ),
        );
        let (status, _) = upload(r, BOOK_TEXT_ONLY_FIX).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(
            !tmp.path().join("library").exists(),
            "oversized upload must not write anything"
        );
    }

    #[tokio::test]
    async fn delete_is_idempotent_returns_204_even_when_absent() {
        let (router, _tmp) = empty_router_with_tmp();
        // Absent book — still 204.
        assert_eq!(
            delete(router.clone(), "never-existed").await,
            StatusCode::NO_CONTENT
        );
        // Upload one, delete twice — both 204.
        let (_, json) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let id = one_id(&json);
        assert_eq!(delete(router.clone(), &id).await, StatusCode::NO_CONTENT);
        assert_eq!(delete(router, &id).await, StatusCode::NO_CONTENT);
    }
}
