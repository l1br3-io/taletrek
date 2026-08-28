//! Static SPA hosting at `/` (T8) — the server as the SPA's origin.
//!
//! [`spa_router`] serves `settings.static_dir` (the built `web/dist`) with SPA
//! history fallback (unknown paths → `index.html`, 200) behind the same
//! cookie/bearer [`auth::require_auth`] as everything else. It is mounted as
//! the outer router's fallback service, so it owns every path the API
//! (`/api/*`) and the askama panel (`/ui/*`) don't — including `/` and SPA
//! client routes like `/reader/:id`.
//!
//! # CSP split (T8)
//!
//! The SPA documents get a JS-app policy mirroring the one the standalone PWA
//! ships in its own `<meta>` tag ([`SPA_CSP`] — same token list as
//! `web/vite.config.ts`, the battle-tested standalone policy). It is stamped
//! **only on `text/html` responses**:
//!
//! GOTCHA: a CSP header on a worker script response becomes that worker's own
//! policy — `script-src 'self'` without `'wasm-unsafe-eval'`/`blob:` would
//! break Piper/ORT WASM compilation and the ffmpeg blob-core load *inside* the
//! worker. The standalone hosting model never stamps CSP on assets (meta-tag
//! CSP doesn't propagate into workers); we mirror exactly that: document-only
//! CSP, assets stay policy-free.
//!
//! `/ui/*` (askama panel) keeps the strict no-JS `default-src 'none'` policy —
//! see [`crate::http`].

use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{from_fn, Next};
use axum::response::Response;
use tower_http::services::{ServeDir, ServeFile};

use crate::http::auth;
use crate::http::AppState;

/// JS-app CSP for served HTML documents. Verbatim token list of the proven
/// standalone-PWA policy (`web/vite.config.ts` `CSP`): `connect-src https:` +
/// localhost cover the user-configured AI providers + self-hosted LLMs;
/// `worker-src blob:` + `media-src blob:` cover the ffmpeg blob-core fallback
/// engine and blob-URL audio playback; `style-src 'unsafe-inline'` covers
/// vConsole's runtime style injection (settings-toggleable, bundled in dist).
pub(crate) const SPA_CSP: &str = concat!(
    "default-src 'self'; ",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; ",
    "img-src 'self' data: blob:; ",
    "media-src 'self' blob:; ",
    "style-src 'self' 'unsafe-inline'; ",
    "script-src 'self'; ",
    "worker-src 'self' blob:; ",
    "object-src 'none'; ",
    "base-uri 'self'; ",
    "form-action 'self'",
);

/// Build the SPA-hosting router: static files at every path, SPA fallback to
/// `index.html`, auth-gated. Mounted as the outer router's fallback.
pub(crate) fn spa_router(state: AppState) -> axum::Router {
    let dir = state.settings.static_dir.clone();
    let serve = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
    axum::Router::new()
        .fallback_service(serve)
        .layer(axum::middleware::from_fn_with_state(
            state,
            auth::require_auth,
        ))
        .layer(from_fn(spa_html_csp))
}

/// Stamp [`SPA_CSP`] on HTML responses only (see module docs for why assets
/// must stay CSP-free). `if_not_present` semantics: never fights a header the
/// inner service already set.
async fn spa_html_csp(request: Request, next: Next) -> Response {
    let mut resp = next.run(request).await;
    let is_html = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/html"));
    if is_html && !resp.headers().contains_key(header::CONTENT_SECURITY_POLICY) {
        resp.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(SPA_CSP),
        );
    }
    resp
}

/// `ANY /api/{*rest}` — unknown API paths must 404 like an API, not fall
/// through to the SPA's `index.html` (a 200-HTML answer to a typo'd endpoint
/// is miserable to debug from client JS).
pub(crate) async fn api_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// Unknown `/ui/*` paths 404 (T16): the server-rendered namespace is just
/// login/logout now — a stray `/ui/admin/…` (the deleted panel) must not
/// fall through to the SPA's history fallback and boot the whole app for a
/// dead URL. Same shape as [`api_not_found`].
pub(crate) async fn ui_not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_utils::StubDb;
    use crate::http::router;
    use crate::http::test_support::app_state_with_static_dir;

    use axum::body::Body;
    use tower::ServiceExt;

    const TOKEN: &str = "sekrit";
    const INDEX_HTML: &str = "<!doctype html><html><title>TaleTrek SPA</title>SPA-BOOT-MARKER</html>";

    /// A static dir shaped like a built SPA: `index.html` + one asset.
    fn spa_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("index.html"), INDEX_HTML).expect("write index");
        std::fs::create_dir(dir.path().join("assets")).expect("mkdir assets");
        std::fs::write(dir.path().join("assets/app.js"), "console.log('app')").expect("write js");
        dir
    }

    fn app(dir: &tempfile::TempDir) -> axum::Router {
        router(app_state_with_static_dir(
            std::sync::Arc::new(StubDb::new()),
            dir.path().to_path_buf(),
            TOKEN,
        ))
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        String::from_utf8(bytes.to_vec()).unwrap_or_default()
    }

    /// Unauthenticated `/` → `302 /ui/login` — the SPA is behind the same
    /// cookie/bearer auth as everything else.
    #[tokio::test]
    async fn root_without_auth_redirects_to_login() {
        let dir = spa_dir();
        let req = Request::builder()
            .uri("/")
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        let status = resp.status();
        assert!(
            status == StatusCode::FOUND || status == StatusCode::SEE_OTHER,
            "redirects: got {status}"
        );
        assert_eq!(
            resp.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()),
            Some("/ui/login")
        );
    }

    /// Authed `/` → 200 + the SPA's index.html + the JS-app CSP.
    #[tokio::test]
    async fn root_with_auth_serves_index_html_with_spa_csp() {
        let dir = spa_dir();
        let req = Request::builder()
            .uri("/")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            Some("text/html")
        );
        let csp = resp
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            csp.contains("script-src 'self'") && csp.contains("worker-src 'self' blob:"),
            "JS-app CSP on the document: {csp}"
        );
        let body = body_string(resp).await;
        assert!(body.contains("SPA-BOOT-MARKER"), "index served: {body}");
    }

    /// SPA history fallback: a client route (no such file) → 200 + index.html,
    /// so deep links like `/reader/bk_123` boot the app.
    #[tokio::test]
    async fn client_route_falls_back_to_index_html() {
        let dir = spa_dir();
        let req = Request::builder()
            .uri("/reader/bk_123")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert!(body.contains("SPA-BOOT-MARKER"), "fallback serves index: {body}");
    }

    /// Assets are served **without a CSP header** — a CSP on a worker script
    /// response becomes that worker's policy and would break WASM/blob
    /// (Piper, ORT, ffmpeg core). Mirrors the standalone hosting model.
    #[tokio::test]
    async fn assets_serve_without_csp() {
        let dir = spa_dir();
        let req = Request::builder()
            .uri("/assets/app.js")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            resp.headers().get(header::CONTENT_SECURITY_POLICY).is_none(),
            "no CSP stamped on non-HTML assets"
        );
        // Outer hardening layers still apply to fallback-service responses.
        assert_eq!(
            resp.headers().get(header::X_CONTENT_TYPE_OPTIONS).and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        let body = body_string(resp).await;
        assert!(body.contains("console.log"), "asset bytes: {body}");
    }

    /// Missing static dir: `/` 404s (no crash) while the login page + API
    /// stay up — the server is still useful headless.
    #[tokio::test]
    async fn missing_static_dir_keeps_api_and_login_alive() {
        let state = crate::http::test_support::app_state(TOKEN);
        let app = router(state);
        let req = Request::builder()
            .uri("/")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app.clone().oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let req = Request::builder()
            .uri("/ui/login")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.clone().oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert!(body.contains("Sign in"), "login page still renders: {body}");
    }

    /// The old `POST /` panel upload is gone: POSTs to `/` hit the static
    /// service, which only speaks GET/HEAD (405), never the panel.
    #[tokio::test]
    async fn post_root_is_not_the_panel() {
        let dir = spa_dir();
        let req = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// Unknown API paths 404 as API, not as the SPA's index.html.
    #[tokio::test]
    async fn unknown_api_path_is_404_not_spa() {
        let dir = spa_dir();
        let req = Request::builder()
            .uri("/api/nope")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app(&dir).oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let body = body_string(resp).await;
        assert!(!body.contains("SPA-BOOT-MARKER"), "no HTML for API paths: {body}");
    }

    /// The CSP split (T16: the strict-CSP surface is now just `/ui/*` —
    /// login/logout): the login page carries the strict no-JS policy, the
    /// SPA document carries the JS-app policy.
    #[tokio::test]
    async fn ui_pages_keep_strict_csp_spa_gets_js_csp() {
        let dir = spa_dir();
        let app = app(&dir);
        let req = Request::builder().uri("/ui/login").body(Body::empty()).expect("valid request");
        let resp = app.clone().oneshot(req).await.expect("router serves");
        let csp = resp
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            csp.contains("default-src 'none'") && !csp.contains("script-src 'self'"),
            "strict no-JS policy on the login page: {csp}"
        );

        let req = Request::builder()
            .uri("/")
            .header(header::COOKIE, format!("taletrek_token={TOKEN}"))
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        let csp = resp
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(csp.contains("script-src 'self'"), "JS policy on the SPA: {csp}");
    }
}
