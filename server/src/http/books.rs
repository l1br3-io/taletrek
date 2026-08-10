//! Read-only book handlers (`GET /api/books`, `GET /api/books/{id}`).
//!
//! Write handlers (upload/download/delete) land in T8; these two read endpoints
//! pull metadata straight from the SQLite index via [`Db::list_books`] /
//! [`Db::get_book`] — no bundle parsing. Each db call runs inside
//! `spawn_blocking` (rusqlite is sync; see [`crate::db`]).
//!
//! # Wire format — camelCase
//!
//! [`BookDto`] serializes in `camelCase` to match the bundle format + the SPA
//! (`sourceFormat`, `voiceId`, `audioPresent`, …). The SQLite row ([`BookRow`])
//! keeps snake_case field names; the DTO is the JSON boundary.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;

use crate::db::BookRow;
use crate::http::AppState;

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

/// Map any join/db error to a `500` body. `404`s are produced explicitly in the
/// handlers, never here — a missing book is not a server error.
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, test_utils::StubDb};
    use crate::http::router;
    use crate::http::test_support::app_state_with_db;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
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
        let b1 = arr
            .iter()
            .find(|v| v["id"] == "b1")
            .expect("b1 in array");
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
}
