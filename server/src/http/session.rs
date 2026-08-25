//! Boot probe for the hosted SPA (ADR-0014, Effort 5 · T7).
//!
//! `GET /api/session` is the request the SPA fires at boot to decide its
//! mode (T13): authed `200` → server mode; `401` → the SPA redirects to
//! `/ui/login` itself. Deliberately minimal — `{ "ok": true }`, no
//! capabilities envelope in v1 (voices already live at `GET /api/voices`).

use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct SessionDto {
    ok: bool,
}

/// `GET /api/session` → `200 {"ok":true}`.
///
/// Sits on the protected sub-router — auth is enforced by
/// [`crate::http::auth::require_auth`]; this handler only runs when
/// credentialed (bearer or cookie).
pub async fn session() -> Json<SessionDto> {
    Json(SessionDto { ok: true })
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use tower::ServiceExt;

    use crate::http::test_support;

    #[tokio::test]
    async fn session_with_bearer_token_is_200_ok_json() {
        let app = crate::http::router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/session")
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or(v)),
            Some("application/json")
        );
        let bytes = axum::body::to_bytes(resp.into_body(), 64)
            .await
            .expect("body readable");
        assert_eq!(bytes.as_ref(), br#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn session_with_cookie_is_200() {
        let app = crate::http::router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/session")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn session_without_credentials_is_401_not_redirect() {
        let app = crate::http::router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/session")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        // The SPA redirects itself — the API must answer 401, never 302.
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(resp.headers().get(header::LOCATION).is_none());
    }

    #[tokio::test]
    async fn session_with_wrong_token_is_401() {
        let app = crate::http::router(test_support::app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/session")
            .header(header::AUTHORIZATION, "Bearer wrong")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
