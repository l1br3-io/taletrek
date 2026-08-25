//! HTTP layer: router composition, shared [`AppState`], and handlers.
//!
//! [`router`] is the single entry point wired by `main`. It mounts two
//! unauthenticated routes on the outer router — `GET /api/health`, `GET/POST
//! /ui/login` — plus a catch-all `404` for unknown `/api/*` paths. Everything
//! else lives on a protected sub-router that carries [`auth::require_auth`]:
//! the data-bearing `/api/*` routes, the operator panel (`/ui/admin/*`, T11 —
//! interim home until T16 deletes it), and — as the outer router's fallback
//! service — the static SPA hosting at `/` (T8, [`spa`]). New routes merge
//! into the protected sub-router and inherit the auth layer automatically.
//!
//! # Security-header split (T8)
//!
//! The outer router stamps nosniff + frame denial + no-referrer on **every**
//! response (outermost layers). The CSP is split per surface:
//!
//! - `/api/*` + `/ui/*` (panel, login): strict no-JS policy
//!   (`default-src 'none'` …) — the askama panel runs zero client JS and a
//!   future escaping regression must not become script execution.
//! - SPA-hosted paths (`/`, client routes, assets): [`spa::SPA_CSP`] — a
//!   JS-app policy stamped only on `text/html` responses (see [`spa`] for why
//!   assets must stay CSP-free).
//!
//! # Auth boundary
//!
//! GOTCHA: `GET /api/health`, `GET /ui/login`, and `POST /ui/login` are the
//! **only** unauthenticated routes. Every other path — API, panel, *and the
//! SPA's static files* — sits behind [`auth::require_auth`] (bearer header
//! for the API, cookie for browsers). A new route mounted on the outer router
//! (outside the auth layer) is a security bug.

mod auth;
mod books;
mod chapters;
mod health;
mod jobs;
mod session;
mod spa;
mod ui;
mod voices;

pub(crate) use auth::LoginLimiter;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::header;
use axum::middleware::from_fn_with_state;
use axum::routing::{any, get, post};
use axum::Router;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::config::Settings;
use crate::db::Db;
use crate::synth::{InFlightBooks, SynthBackend};

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
    /// Library root (`<data_dir>/library/<book-id>/…`). Consumed by the
    /// upload/download/delete handlers + the synth runner (it writes full
    /// bundles back here on a successful synth).
    pub data_dir: PathBuf,
    /// Resolved boot settings. `settings.token` is the bearer compared by
    /// [`auth::require_bearer`]; `settings.voices_cache_dir` / `jobs` feed the
    /// synth runner.
    pub settings: Arc<Settings>,
    /// The configured synth backend (runner factory + encoder). Built once at
    /// boot from `Settings` (subprocess piper + ffmpeg Opus); tests inject a
    /// stub backend via [`test_support`]. Cloned cheaply (two `Arc`s) into each
    /// synth job.
    pub synth: Arc<SynthBackend>,
    /// Book ids with a running synth/resynth job — the trigger + delete paths
    /// consult it to enforce one job per book and no delete-under-a-job
    /// (see [`crate::synth::InFlightBooks`]).
    pub in_flight: InFlightBooks,
    /// Failed-login throttle for `POST /ui/login` (see [`auth::LoginLimiter`]).
    pub login_limiter: LoginLimiter,
}

/// The strict no-JS CSP for the askama panel + login + API responses: the
/// panel runs zero client JS (inline `<style>` + same-origin form posts
/// only), so scripts are forbidden outright. Defense-in-depth behind askama's
/// auto-escaping: an escaping regression must not become script execution.
pub(crate) const STRICT_CSP: &str =
    "default-src 'none'; base-uri 'none'; form-action 'self'; style-src 'unsafe-inline'";

/// Build the application router.
///
/// `/api/health` + `GET/POST /ui/login` + the unknown-API `404` sit on the
/// outer router (no auth); every `/api/*` data route + the operator panel
/// (`/ui/admin/*`) lives on the protected sub-router and inherits
/// [`auth::require_auth`] as well as the upload body-size limit
/// ([`DefaultBodyLimit`] = `max_bundle_bytes`). The SPA static hosting
/// ([`spa::spa_router`]) is the outer router's fallback service — it owns `/`
/// and every client route, behind the same auth. The panel POST routes
/// (`/ui/admin/books/{id}/synth`, …) wrap the same cores as the JSON API and
/// return `303` redirects (Post/Redirect/Get) so plain browser forms work
/// with no client JS.
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
        .route("/api/books/{id}/chapters", get(chapters::get_chapters))
        .route("/api/books/{id}/synth", post(jobs::trigger_synth))
        .route("/api/books/{id}/resynth", post(jobs::trigger_resynth))
        .route("/api/jobs", get(jobs::list_jobs))
        .route("/api/jobs/{id}", get(jobs::get_job))
        .route("/api/session", get(session::session))
        .route("/api/voices", get(voices::list_voices))
        .route("/api/voices/{id}/fetch", post(voices::fetch_voice))
        // ----- operator UI (T11) — interim home under /ui/admin until T16 ----
        .route("/ui/admin", get(ui::index).post(ui::upload_book))
        .route("/ui/admin/", get(ui::index))
        .route("/ui/admin/books/{id}", get(ui::book_detail))
        .route("/ui/admin/books/{id}/synth", post(ui::synth_book))
        .route("/ui/admin/books/{id}/resynth", post(ui::resynth_book))
        .route("/ui/admin/books/{id}/delete", post(ui::delete_book))
        .route("/ui/admin/jobs", get(ui::jobs))
        .layer(from_fn_with_state(state.clone(), auth::require_auth))
        .layer(DefaultBodyLimit::max(state.settings.max_bundle_bytes))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            axum::http::HeaderValue::from_static(STRICT_CSP),
        ));

    Router::new()
        .route("/api/health", get(health::health))
        .route("/ui/login", get(auth::login_form).post(auth::login))
        // Unknown API paths 404 as an API — without this the SPA fallback
        // would answer them with `index.html` (200 HTML for a typo'd endpoint).
        .route("/api/{*rest}", any(spa::api_not_found))
        .route_layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            axum::http::HeaderValue::from_static(STRICT_CSP),
        ))
        .merge(protected)
        .fallback_service(spa::spa_router(state.clone()))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        // Security headers on every response (outermost layers). The CSP is
        // stamped per-surface above (strict for /api + /ui, JS-app for the
        // SPA's HTML); nosniff + frame denial close content-type confusion +
        // clickjacking on the destructive forms and the SPA alike.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            axum::http::HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            axum::http::HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            axum::http::HeaderValue::from_static("no-referrer"),
        ))
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

    /// Every response — API and UI, authed or not — carries the security
    /// headers. Pinned so a future layer reshuffle can't silently drop them.
    #[tokio::test]
    async fn responses_carry_security_headers() {
        let app = router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let h = resp.headers();
        let csp = h
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            csp.contains("default-src 'none'") && csp.contains("form-action 'self'"),
            "CSP: {csp}"
        );
        assert_eq!(
            h.get(header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        assert_eq!(
            h.get(header::X_FRAME_OPTIONS).and_then(|v| v.to_str().ok()),
            Some("DENY")
        );
        assert_eq!(
            h.get(header::REFERRER_POLICY).and_then(|v| v.to_str().ok()),
            Some("no-referrer")
        );
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
    use crate::db::{test_utils::StubDb, Db};

    /// An [`AppState`] with an empty stub db + a test token.
    pub(crate) fn app_state(token: &str) -> AppState {
        app_state_with_db(Arc::new(StubDb::new()), token)
    }

    /// An [`AppState`] with a caller-supplied db (for pre-seeding).
    pub(crate) fn app_state_with_db(db: Arc<dyn Db>, token: &str) -> AppState {
        data_dir_app_state(
            db,
            PathBuf::from("/nonexistent-taletrek-test"),
            token,
            crate::synth::test_support::stub_backend(),
            crate::config::DEFAULT_MAX_BUNDLE_BYTES,
            false,
        )
    }

    /// An [`AppState`] with a caller-supplied db + a real `data_dir` (a
    /// [`tempfile::tempdir`]'s path). The T8 upload/download/delete tests +
    /// the T9 synth tests (which write bundles + pre-seed the voice cache under
    /// `<data_dir>/voices`) use this.
    pub(crate) fn app_state_with_data_dir(
        db: Arc<dyn Db>,
        data_dir: PathBuf,
        token: &str,
    ) -> AppState {
        data_dir_app_state(
            db,
            data_dir,
            token,
            crate::synth::test_support::stub_backend(),
            crate::config::DEFAULT_MAX_BUNDLE_BYTES,
            true,
        )
    }

    /// Like [`app_state_with_data_dir`] but with a caller-supplied synth
    /// backend — the in-flight-guard tests use a gated backend to hold a job
    /// deterministically in `running`.
    pub(crate) fn app_state_with_data_dir_and_backend(
        db: Arc<dyn Db>,
        data_dir: PathBuf,
        token: &str,
        backend: crate::synth::SynthBackend,
    ) -> AppState {
        data_dir_app_state(
            db,
            data_dir,
            token,
            backend,
            crate::config::DEFAULT_MAX_BUNDLE_BYTES,
            true,
        )
    }

    /// Like [`app_state_with_data_dir`] but with a tiny `max_bundle_bytes` —
    /// pins the `413` body-limit plumbing (a regression that drops or
    /// misconfigures the layer must not silently accept unbounded bodies).
    pub(crate) fn app_state_with_data_dir_and_max_bytes(
        db: Arc<dyn Db>,
        data_dir: PathBuf,
        token: &str,
        max_bundle_bytes: usize,
    ) -> AppState {
        data_dir_app_state(
            db,
            data_dir,
            token,
            crate::synth::test_support::stub_backend(),
            max_bundle_bytes,
            true,
        )
    }

    /// The one builder every variant delegates to: wires the voice cache under
    /// the data dir (`settings.data_dir` is only pointed at a real path when
    /// `real_data_dir` — non-synth tests keep the throwaway nonexistent dir).
    fn data_dir_app_state(
        db: Arc<dyn Db>,
        data_dir: PathBuf,
        token: &str,
        backend: crate::synth::SynthBackend,
        max_bundle_bytes: usize,
        real_data_dir: bool,
    ) -> AppState {
        let mut settings = test_settings(token);
        settings.max_bundle_bytes = max_bundle_bytes;
        if real_data_dir {
            // The voice cache lives under the data dir so synth tests can
            // pre-seed it with a tempdir they already own.
            settings.data_dir = data_dir.clone();
            settings.voices_cache_dir = data_dir.join("voices");
        }
        AppState {
            db,
            data_dir,
            settings: Arc::new(settings),
            synth: Arc::new(backend),
            in_flight: crate::synth::InFlightBooks::default(),
            login_limiter: LoginLimiter::default(),
        }
    }

    /// Minimal [`Settings`] for handler tests — only `token` is meaningful; the
    /// rest are throwaway defaults that no read handler inspects.
    fn test_settings(token: &str) -> Settings {
        Settings {
            data_dir: PathBuf::from("/nonexistent-taletrek-test"),
            bind: "127.0.0.1:0".parse().expect("valid loopback socket addr"),
            token: token.to_string(),
            voices_cache_dir: PathBuf::from("/nonexistent-taletrek-test"),
            jobs: 1,
            piper: "piper".to_string(),
            ffmpeg: "ffmpeg".to_string(),
            max_bundle_bytes: crate::config::DEFAULT_MAX_BUNDLE_BYTES,
            static_dir: PathBuf::from("/nonexistent-taletrek-test"),
        }
    }

    /// An [`AppState`] whose `settings.static_dir` points at a caller-owned
    /// directory — the SPA-hosting tests plant a fake `index.html` + assets
    /// there (usually a [`tempfile::tempdir`]).
    #[cfg(test)]
    pub(crate) fn app_state_with_static_dir(
        db: Arc<dyn Db>,
        static_dir: PathBuf,
        token: &str,
    ) -> AppState {
        let mut state = app_state_with_db(db, token);
        let mut settings = (*state.settings).clone();
        settings.static_dir = static_dir;
        state.settings = Arc::new(settings);
        state
    }
}
