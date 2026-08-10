//! Bearer-token auth middleware (single-user model, ADR-0013).
//!
//! [`require_bearer`] is mounted around every `/api/*` route **except**
//! `/api/health` (see [`crate::http::router`]). A request without a matching
//! `Authorization: Bearer <token>` header is rejected with `401 Unauthorized`
//! before the handler runs.
//!
//! # Security — the auth exclusion list
//!
//! GOTCHA: `GET /api/health` is the **only** unauthenticated route. Every other
//! route sits behind [`require_bearer`] by default — new routes must be mounted
//! on the protected sub-router in [`crate::http::router`], where they inherit
//! the layer automatically. A route accidentally mounted on the outer router
//! (outside the layer) is a **security bug**. There are no users, no ACLs
//! (ADR-0013); the bearer token is the entire auth surface, so operate only
//! over a trusted LAN or behind a TLS terminator.

use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;

use crate::http::AppState;

/// The required `Authorization` scheme + trailing space, as it appears in the
/// header before the token bytes.
const BEARER_PREFIX: &str = "Bearer ";

/// Reject any protected request whose `Authorization` header is not exactly
/// `Bearer <SETTINGS.TOKEN>`.
///
/// Mounted as an `axum::middleware::from_fn` layer around the protected
/// `/api/*` routes in [`crate::http::router`]. `/api/health` sits outside this
/// layer so docker / load-balancer probes don't need the token.
///
/// # Constant-time compare
///
/// The token is compared with [`constant_time_eq`] so the comparison time does
/// not depend on which byte first differs (avoids a timing oracle). Token
/// length is not treated as secret — a length mismatch returns early, which is
/// acceptable because the header (including its length) is sent by the client
/// anyway. A plain `==` would also be acceptable for v1 single-user (per the
/// task), but the helper is short and dependency-free.
pub async fn require_bearer(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let expected = state.settings.token.as_bytes();
    let provided = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix(BEARER_PREFIX).map(str::as_bytes));

    match provided {
        Some(given) if constant_time_eq(given, expected) => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Byte-wise constant-time equality.
///
/// Accumulates a running XOR over the (equal-length) inputs with no early exit
/// on the first differing byte. Length mismatch returns immediately — see the
/// [`require_bearer`] docs on why length is not treated as secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().copied().zip(b.iter().copied()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::router;
    use crate::http::test_support::app_state;

    use axum::body::Body;
    use tower::ServiceExt;

    /// Run a `GET` through the real router with an optional bearer token,
    /// returning the resulting status code.
    async fn status(uri: &str, auth: Option<&str>) -> StatusCode {
        let app = router(app_state("sekrit"));
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(token) = auth {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).expect("valid request"))
            .await
            .expect("router serves");
        resp.status()
    }

    #[tokio::test]
    async fn missing_authorization_header_is_401() {
        assert_eq!(status("/api/books", None).await, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_token_is_401() {
        assert_eq!(
            status("/api/books", Some("nope")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn correct_token_passes_through() {
        // /api/books is empty [] → 200, proving the middleware let it through
        // rather than short-circuiting to 401.
        assert_eq!(status("/api/books", Some("sekrit")).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn wrong_scheme_is_401() {
        // "Basic …" is a valid auth header but the wrong scheme.
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/books")
            .header(header::AUTHORIZATION, "Basic sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn bare_scheme_with_no_token_is_401() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/api/books")
            .header(header::AUTHORIZATION, "Bearer")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ---- constant_time_eq unit cases ----

    #[test]
    fn ct_eq_equal_inputs_match() {
        assert!(constant_time_eq(b"abc", b"abc"));
    }

    #[test]
    fn ct_eq_different_lengths_dont_match() {
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
    }

    #[test]
    fn ct_eq_same_length_different_bytes_dont_match() {
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"\xff", b"\x00"));
    }

    #[test]
    fn ct_eq_empty_inputs_match() {
        assert!(constant_time_eq(b"", b""));
    }
}
