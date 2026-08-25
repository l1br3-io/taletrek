//! Chapters endpoint — `GET /api/books/{id}/chapters` (T9).
//!
//! The reading API: the hosted SPA needs chapter/paragraph text without
//! downloading the whole bundle. The bundle's `text.json` is exploded **lazily**
//! into the `chapters` SQLite table on the first request per book, then served
//! from SQLite — effort-4-era libraries work with no boot sweep.
//!
//! # Freshness — compare-on-request, no coupling
//!
//! [`BookRow::exploded_at`] records the `books.updated_at` the rows were
//! exploded from. Every request compares: a re-ingest or a post-synth bundle
//! rewrite upserts the book row fresh (`exploded_at = NULL`) with a bumped
//! `updated_at`, so the next fetch re-explodes. Nothing hooks the synth
//! runner — invalidation falls out of the row-upsert both paths already do.
//!
//! # Wire shape
//!
//! `200` camelCase `[{ id, bookId, idx, title, paragraphs }]`. `id` is the
//! stable derived form `ch_<bookId>_<idx>` (chapter rows are keyed by book+idx;
//! the bundle's own `ChapterText` scheme — the SPA can treat it as `ChapterId`).
//! Optional `headings` are dropped: rows carry the reading surface, not the
//! outline surface.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::db::{ChapterRow, DbError};
use crate::http::AppState;
use crate::store::{self, StoreError};
use taletrek_synth::{read_book_bundle, BundleError};

/// camelCase JSON view of one exploded chapter — the public wire shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterDto {
    id: String,
    book_id: String,
    idx: i64,
    title: String,
    paragraphs: Vec<String>,
}

impl ChapterDto {
    fn from_row(book_id: &str, row: ChapterRow) -> Self {
        Self {
            id: format!("ch_{book_id}_{}", row.idx),
            book_id: book_id.to_string(),
            idx: row.idx,
            title: row.title,
            paragraphs: row.paragraphs,
        }
    }
}

/// A blocking chapters op that touches `store` + `Db`, unified for one
/// `spawn_blocking` closure.
enum ChaptersError {
    /// Unknown book (no index row, or the bundle file is gone) → `404`.
    NotFound,
    /// The stored bundle failed to parse → `500` (disk state is corrupt; the
    /// upload path validated it once, so this is never client-caused).
    Bundle(BundleError),
    /// Store I/O (other than absent) → `500`.
    Store(StoreError),
    /// SQLite → `500`.
    Db(DbError),
}

impl From<BundleError> for ChaptersError {
    fn from(e: BundleError) -> Self {
        Self::Bundle(e)
    }
}
impl From<StoreError> for ChaptersError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound(_) => Self::NotFound,
            other => Self::Store(other),
        }
    }
}
impl From<DbError> for ChaptersError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}

/// `GET /api/books/{id}/chapters` (protected).
///
/// Fresh (`exploded_at == updated_at`) → serve from SQLite. Otherwise read the
/// stored bundle from disk, parse `text.json`, upsert rows + stamp the marker
/// (idempotent — concurrent first-hits both write the same deterministic rows,
/// last writer wins), and return them. Unknown book → `404`; parse/store/db
/// faults → `500`.
pub async fn get_chapters(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<ChapterDto>>, (StatusCode, String)> {
    let data_dir = state.data_dir.clone();
    let db = state.db.clone();
    let book_id = id.clone();
    let rows = tokio::task::spawn_blocking(move || -> Result<Vec<ChapterRow>, ChaptersError> {
        let Some(book) = db.get_book(&book_id)? else {
            return Err(ChaptersError::NotFound);
        };
        if book.exploded_at == Some(book.updated_at) {
            return Ok(db.list_chapters(&book_id)?);
        }
        let bytes = store::get_bundle(&data_dir, &book_id)?;
        let bundle = read_book_bundle(&bytes)?;
        let rows: Vec<ChapterRow> = bundle
            .chapters
            .iter()
            .map(|c| ChapterRow {
                idx: c.index as i64,
                title: c.title.clone(),
                paragraphs: c.paragraphs.clone(),
            })
            .collect();
        db.replace_chapters(&book_id, rows.clone(), book.updated_at)?;
        Ok(rows)
    })
    .await
    .map_err(internal_error)?
    .map_err(|e| match e {
        ChaptersError::NotFound => (StatusCode::NOT_FOUND, format!("book not found: {id}")),
        ChaptersError::Bundle(e) => internal_error(e),
        ChaptersError::Store(e) => internal_error(e),
        ChaptersError::Db(e) => internal_error(e),
    })?;
    Ok(Json(
        rows.into_iter()
            .map(|r| ChapterDto::from_row(&id, r))
            .collect(),
    ))
}

/// Map a join error to a `500` body (same idiom as the books handlers).
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{test_utils::StubDb, Db};
    use crate::http::router;
    use crate::http::test_support::app_state_with_data_dir;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use std::io::Cursor;
    use std::sync::Arc;
    use tower::ServiceExt;

    const BOOK_TEXT_ONLY_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-text-only.taletrek");

    /// A fresh router backed by an empty [`StubDb`] + a real tempdir `data_dir`.
    fn router_with_tmp() -> (axum::Router, tempfile::TempDir, Arc<StubDb>) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = Arc::new(StubDb::new());
        let r = router(app_state_with_data_dir(
            db.clone() as Arc<dyn Db>,
            tmp.path().to_path_buf(),
            "sekrit",
        ));
        (r, tmp, db)
    }

    /// `POST /api/books` with the bearer token + `bytes` as the `bundle` field.
    async fn upload(router: axum::Router, bytes: &[u8]) -> (StatusCode, serde_json::Value) {
        let boundary = "TESTBOUNDARY";
        let mut body = Vec::with_capacity(bytes.len() + 256);
        body.extend_from_slice(b"--TESTBOUNDARY\r\n");
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"bundle\"; filename=\"b.taletrek\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: application/zip\r\n\r\n");
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--TESTBOUNDARY--\r\n");
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
        let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// `GET /api/books/{id}/chapters` with the bearer token.
    async fn get_chapters_req(router: axum::Router, id: &str) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/books/{id}/chapters"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&b).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn uploaded_id(json: &serde_json::Value) -> String {
        json.as_array().expect("array").first().expect("one book")["id"]
            .as_str()
            .expect("string")
            .to_string()
    }

    // ---- first call explodes + matches the fixture's text.json ----

    #[tokio::test]
    async fn first_call_explodes_and_matches_text_json() {
        let (router, _tmp, _db) = router_with_tmp();
        let (status, json) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        assert_eq!(status, StatusCode::CREATED);
        let id = uploaded_id(&json);

        let expected = read_book_bundle(BOOK_TEXT_ONLY_FIX).expect("fixture parses");
        let (status, body) = get_chapters_req(router, &id).await;
        assert_eq!(status, StatusCode::OK);

        let arr = body.as_array().expect("array");
        assert_eq!(arr.len(), expected.chapters.len());
        for (got, want) in arr.iter().zip(expected.chapters.iter()) {
            assert_eq!(got["id"], want.id, "derived id matches the bundle's own");
            assert_eq!(got["bookId"], want.book_id);
            assert_eq!(got["idx"], want.index);
            assert_eq!(got["title"], want.title);
            assert_eq!(
                got["paragraphs"],
                serde_json::to_value(&want.paragraphs).unwrap()
            );
            assert!(got.get("book_id").is_none(), "camelCase only");
        }
    }

    // ---- second call served from SQLite (no disk read) ----

    #[tokio::test]
    async fn second_call_is_served_from_sqlite_not_disk() {
        let (router, tmp, _db) = router_with_tmp();
        let (_, json) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let id = uploaded_id(&json);

        let (s1, first) = get_chapters_req(router.clone(), &id).await;
        assert_eq!(s1, StatusCode::OK);

        // Remove the bundle from disk — a re-read would 404/500; the SQLite
        // path must serve the identical JSON.
        std::fs::remove_file(tmp.path().join("library").join(&id).join("bundle.taletrek"))
            .expect("bundle removed");

        let (s2, second) = get_chapters_req(router, &id).await;
        assert_eq!(s2, StatusCode::OK, "served from SQLite");
        assert_eq!(first, second, "identical JSON across calls");
    }

    // ---- re-explode when the stored bundle moves (updated_at) ----

    #[tokio::test]
    async fn re_upload_with_new_text_re_explodes() {
        let (router, _tmp, _db) = router_with_tmp();
        let (_, json) = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;
        let id = uploaded_id(&json);

        let (_, first) = get_chapters_req(router.clone(), &id).await;
        assert_eq!(first[0]["title"], "Chapter One");

        // Same book id, changed chapter text — the rewrite bumps updated_at.
        let mut bundle = read_book_bundle(BOOK_TEXT_ONLY_FIX).unwrap();
        bundle.chapters[0].title = "Rewritten".into();
        bundle.chapters[0].paragraphs = vec!["Brand new text.".into()];
        let mut buf = Cursor::new(Vec::new());
        taletrek_synth::write_book_bundle(&bundle, &mut buf).unwrap();
        let (status, _) = upload(router.clone(), &buf.into_inner()).await;
        assert_eq!(status, StatusCode::CREATED);

        let (status, second) = get_chapters_req(router, &id).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            second[0]["title"], "Rewritten",
            "re-exploded from new bundle"
        );
        assert_eq!(second[0]["paragraphs"][0], "Brand new text.");
        // Untouched chapter survives the replace.
        assert_eq!(second[1]["title"], first[1]["title"]);
    }

    // ---- error paths ----

    #[tokio::test]
    async fn unknown_book_is_404() {
        let (router, _tmp, _db) = router_with_tmp();
        let (status, _) = get_chapters_req(router, "definitely-absent").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn chapters_requires_auth() {
        let (router, _tmp, _db) = router_with_tmp();
        let req = Request::builder()
            .method("GET")
            .uri("/api/books/any/chapters")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
