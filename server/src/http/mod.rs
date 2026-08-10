//! HTTP layer: router composition, shared [`AppState`], and handlers.
//!
//! [`router`] is the single entry point wired by `main`. It mounts the
//! unauthenticated `GET /api/health` on the outer router and every data-bearing
//! `/api/*` route on a protected sub-router that carries [`auth::require_bearer`].
//! Later tasks (T8+) add more routes by merging into the protected sub-router —
//! they inherit the auth layer automatically.
//!
//! # Auth boundary
//!
//! GOTCHA: `GET /api/health` is the **only** unauthenticated route. Every other
//! route sits behind [`auth::require_bearer`]. A new route mounted on the outer
//! router (outside the layer) is a security bug — see [`auth`] for the
//! single-user bearer model (ADR-0013).

mod auth;
mod books;
mod health;

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use tower_http::trace::TraceLayer;

use crate::config::Settings;
use crate::db::Db;

/// Shared state injected into every handler + middleware via axum's `State`.
///
/// Held behind `Arc`s so the whole struct is `Clone` (axum requires state to be
/// `Clone + Send + Sync`). `db` is `Arc<dyn Db>` so handlers depend on the
/// trait seam, not SQLite — tests inject the in-memory [`StubDb`](crate::db).
#[derive(Clone)]
pub struct AppState {
    /// SQLite index (trait seam). rusqlite is sync, so handlers wrap every call
    /// in `tokio::task::spawn_blocking` at the call site.
    pub db: Arc<dyn Db>,
    /// Library root (`<data_dir>/library/<book-id>/…`). Consumed by T8's
    /// upload/download/delete handlers; carried here so the state shape is
    /// stable across tasks (no `AppState` reshuffles between T7 and T8).
    #[allow(dead_code)] // read from T8 on; proven stable here.
    pub data_dir: PathBuf,
    /// Resolved boot settings. `settings.token` is the bearer compared by
    /// [`auth::require_bearer`].
    pub settings: Arc<Settings>,
}

/// Build the application router.
///
/// `/api/health` is mounted on the outer router (no auth); every `/api/books`
/// route lives on the protected sub-router and inherits [`auth::require_bearer`]
/// as well as the upload body-size limit ([`DefaultBodyLimit`] =
/// `max_bundle_bytes`). Later tasks (T9/T10) `.route()` further handlers onto
/// `protected` so they pick up auth for free.
///
/// [`State<AppState>`]: axum::extract::State
pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route(
            "/api/books",
            get(books::list_books).post(books::upload_book),
        )
        .route(
            "/api/books/{id}",
            get(books::get_book).delete(books::delete_book),
        )
        .route("/api/books/{id}/bundle", get(books::download_bundle))
        .layer(from_fn_with_state(state.clone(), auth::require_bearer))
        .layer(DefaultBodyLimit::max(state.settings.max_bundle_bytes));

    Router::new()
        .route("/api/health", get(health::health))
        .merge(protected)
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_is_reachable_without_auth() {
        // No Authorization header — health must still answer 200.
        let app = router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/health")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
    }
}

/// Test-only helpers shared by `auth`/`books` handler tests.
///
/// Builds an [`AppState`] backed by the in-memory [`StubDb`](crate::db) +
/// throwaway [`Settings`] so HTTP tests never touch SQLite or the filesystem.
#[cfg(test)]
mod test_support {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;
    use crate::db::{Db, test_utils::StubDb};

    /// An [`AppState`] with an empty stub db + a test token.
    pub(crate) fn app_state(token: &str) -> AppState {
        app_state_with_db(Arc::new(StubDb::new()), token)
    }

    /// An [`AppState`] with a caller-supplied db (for pre-seeding).
    pub(crate) fn app_state_with_db(db: Arc<dyn Db>, token: &str) -> AppState {
        AppState {
            db,
            data_dir: PathBuf::from("/nonexistent-taletrek-test"),
            settings: Arc::new(test_settings(token)),
        }
    }

    /// An [`AppState`] with a caller-supplied db + a real `data_dir` (a
    /// [`tempfile::tempdir`]'s path). For the T8 upload/download/delete tests,
    /// which exercise the real [`crate::store`] against a throwaway dir.
    pub(crate) fn app_state_with_data_dir(
        db: Arc<dyn Db>,
        data_dir: PathBuf,
        token: &str,
    ) -> AppState {
        AppState {
            db,
            data_dir,
            settings: Arc::new(test_settings(token)),
        }
    }

    /// Minimal [`Settings`] for handler tests — only `token` is meaningful; the
    /// rest are throwaway defaults that no read handler inspects.
    fn test_settings(token: &str) -> Settings {
        Settings {
            data_dir: PathBuf::from("/nonexistent-taletrek-test"),
            bind: "127.0.0.1:0"
                .parse()
                .expect("valid loopback socket addr"),
            token: token.to_string(),
            voices_cache_dir: PathBuf::from("/nonexistent-taletrek-test"),
            jobs: 1,
            piper: "piper".to_string(),
            ffmpeg: "ffmpeg".to_string(),
            max_bundle_bytes: crate::config::DEFAULT_MAX_BUNDLE_BYTES,
        }
    }
}
