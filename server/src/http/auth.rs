//! Token auth middleware (single-user model, ADR-0013).
//!
//! [`require_auth`] is mounted around every protected route — both the JSON
//! `/api/*` surface and the `/` + `/ui/*` operator panel (T11). A request is
//! accepted if it carries EITHER:
//!
//! 1. an `Authorization: Bearer <token>` header (the API path — programmatic
//!    clients), OR
//! 2. a `taletrek_token=<token>` cookie set by the login flow ([`login`]) — the
//!    browser/UI path, since plain HTML `<form>` submits cannot attach a bearer
//!    header.
//!
//! On failure, `/api/*` requests get `401` (the existing API contract); every
//! other path (the SPA at `/` + its client routes/assets, the `/ui/*` panel)
//! gets a `302` redirect to `/ui/login` so a browser lands on the login form
//! instead of a bare 401.
//!
//! # The browser-auth tradeoff (T11)
//!
//! GOTCHA: bearer tokens + browser forms are awkward — forms can't send custom
//! headers. v1 resolves it with a **cookie set by an explicit login form**
//! (`GET/POST /ui/login`, unauthenticated; the POST compares the submitted
//! token with [`constant_time_eq`] and sets `taletrek_token` on success). The
//! cookie is `HttpOnly` + `SameSite=Lax` + `Path=/`: HttpOnly blocks JS theft
//! (XSS), and SameSite=Lax blocks cross-site POSTs (CSRF) while still sending
//! on same-origin form submits. The API bearer path is unchanged, so
//! programmatic clients are unaffected. `?token=` query auth was rejected as
//! insecure (token leaks into logs / history / Referer).
//!
//! # Security — the auth exclusion list
//!
//! GOTCHA: `GET /api/health`, `GET /ui/login`, and `POST /ui/login` are the
//! **only** unauthenticated routes. Every other route sits behind
//! [`require_auth`] by default — new routes must be mounted on the protected
//! sub-router in [`crate::http::router`], where they inherit the layer
//! automatically. A route accidentally mounted on the outer router (outside
//! the layer) is a **security bug**. There are no users, no ACLs (ADR-0013);
//! the token is the entire auth surface, so operate only over a trusted LAN or
//! behind a TLS terminator.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Form;
use serde::Deserialize;

use crate::http::AppState;

/// The required `Authorization` scheme + trailing space, as it appears in the
/// header before the token bytes.
const BEARER_PREFIX: &str = "Bearer ";

/// The cookie name carrying the operator token after a successful
/// [`login`] (the browser/UI auth path).
pub(crate) const TOKEN_COOKIE: &str = "taletrek_token";

/// Cookie lifetime in seconds (30 days). Generous for a single-user operator
/// panel so reopening the browser doesn't force a re-login every session.
const COOKIE_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;

/// Failed `POST /ui/login` attempts per client IP that trigger throttling.
const LOGIN_MAX_FAILURES: usize = 10;

/// The window failed attempts are counted within.
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Cap on distinct tracked IPs: the failure map is memory an *unauthenticated*
/// caller can grow, so it is hard-bounded. Clearing it wholesale only resets
/// attackers' windows (each real source IP requires a completed TCP handshake,
/// so flooding 4096 distinct sources is already a bigger problem than this map).
const LOGIN_TRACKED_IPS_CAP: usize = 4096;

/// In-memory throttle for `POST /ui/login` — the one unauthenticated surface
/// where the token can be brute-forced. Counts *failed* attempts per client IP
/// inside a rolling [`LOGIN_WINDOW`]; at [`LOGIN_MAX_FAILURES`] the IP gets
/// `429` before the token comparison runs. A successful login clears the IP's
/// history (legitimate typos never lock the operator out). Process-local and
/// best-effort by design: restart resets it, which is acceptable — the window
/// bounds guessing speed, it doesn't promise lockout.
#[derive(Clone, Default)]
pub struct LoginLimiter {
    failures: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
}

impl LoginLimiter {
    /// Is `ip` currently throttled (window failure count reached)?
    pub(crate) fn is_throttled(&self, ip: IpAddr) -> bool {
        let mut map = self.lock();
        Self::prune(&mut map);
        map.get(&ip)
            .is_some_and(|ts| ts.len() >= LOGIN_MAX_FAILURES)
    }

    /// Record a failed attempt for `ip`.
    pub(crate) fn record_failure(&self, ip: IpAddr) {
        let mut map = self.lock();
        Self::prune(&mut map);
        if map.len() >= LOGIN_TRACKED_IPS_CAP {
            map.clear();
        }
        map.entry(ip).or_default().push_back(Instant::now());
    }

    /// Clear `ip`'s failure history (successful login).
    pub(crate) fn clear(&self, ip: IpAddr) {
        self.lock().remove(&ip);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<IpAddr, VecDeque<Instant>>> {
        self.failures.lock().expect("login-limiter mutex poisoned")
    }

    /// Drop timestamps outside the window + entries left empty by that.
    fn prune(map: &mut HashMap<IpAddr, VecDeque<Instant>>) {
        let cutoff = Instant::now()
            .checked_sub(LOGIN_WINDOW)
            .unwrap_or_else(Instant::now);
        for ts in map.values_mut() {
            ts.retain(|t| *t > cutoff);
        }
        map.retain(|_, ts| !ts.is_empty());
    }
}

/// Reject any protected request that carries neither a matching
/// `Authorization: Bearer <token>` header nor a matching `taletrek_token`
/// cookie.
///
/// Mounted as an `axum::middleware::from_fn` layer around the protected routes
/// in [`crate::http::router`]. `/api/health` + `/ui/login` sit outside this
/// layer. On failure, `/api/*` → `401`; every non-API path → `302 /ui/login`.
///
/// # Constant-time compare
///
/// Both the header and the cookie token are compared with [`constant_time_eq`]
/// so the comparison time does not depend on which byte first differs (avoids a
/// timing oracle). Token length is not treated as secret — a length mismatch
/// returns early, which is acceptable because the header/cookie (including its
/// length) is sent by the client anyway.
pub async fn require_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, Response> {
    let expected = state.settings.token.as_bytes();
    let authorized = bearer_token(&request)
        .map(|t| constant_time_eq(t, expected))
        .unwrap_or(false)
        || cookie_token(&request, TOKEN_COOKIE)
            .map(|t| constant_time_eq(t.as_bytes(), expected))
            .unwrap_or(false);

    if authorized {
        return Ok(next.run(request).await);
    }
    // API → 401; UI → redirect to login so a browser lands on the form.
    if is_ui_path(request.uri().path()) {
        Err(Redirect::to("/ui/login").into_response())
    } else {
        Err(StatusCode::UNAUTHORIZED.into_response())
    }
}

/// `GET /ui/login` — render the login form. If the request already carries a
/// valid token (header or cookie), short-circuit to `/` so a logged-in operator
/// isn't shown the form again.
pub async fn login_form(State(state): State<AppState>, request: Request) -> Response {
    let expected = state.settings.token.as_bytes();
    let already = bearer_token(&request)
        .map(|t| constant_time_eq(t, expected))
        .unwrap_or(false)
        || cookie_token(&request, TOKEN_COOKIE)
            .map(|t| constant_time_eq(t.as_bytes(), expected))
            .unwrap_or(false);
    if already {
        return Redirect::to("/").into_response();
    }
    crate::http::ui::login_page(None).into_response()
}

/// `POST /ui/login` — validate the submitted token, set the cookie, redirect.
///
/// Form field: `token`. On match → `Set-Cookie` + `303 /`. On mismatch →
/// re-render the login page with an error message (no cookie set). Throttled
/// client IPs get `429` before the comparison runs (see [`LoginLimiter`]).
pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Form(form): Form<LoginForm>,
) -> Response {
    if state.login_limiter.is_throttled(ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "too many failed login attempts; wait 15 minutes and try again",
        )
            .into_response();
    }
    let expected = state.settings.token.as_bytes();
    if constant_time_eq(form.token.as_bytes(), expected) {
        state.login_limiter.clear(ip);
        let cookie = format!(
            "{TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_MAX_AGE_SECS}",
            url_encode_cookie(&state.settings.token),
        );
        let mut resp = Redirect::to("/").into_response();
        if let Ok(val) = HeaderValue::from_str(&cookie) {
            resp.headers_mut().append(header::SET_COOKIE, val);
        }
        *resp.status_mut() = StatusCode::SEE_OTHER; // 303 — PRG after a POST
        resp
    } else {
        state.login_limiter.record_failure(ip);
        crate::http::ui::login_page(Some("invalid token")).into_response()
    }
}

/// The client IP for throttling, read from the connection info the listener
/// injects (`main` serves via `into_make_service_with_connect_info`). Falls
/// back to the unspecified address when no connection info exists (handler
/// unit-test requests), bucketing those together — infallible so the login
/// handler never rejects on extraction.
pub(crate) struct ClientIp(IpAddr);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        Ok(ClientIp(ip))
    }
}

/// The login form body (urlencoded `token` field).
#[derive(Debug, Deserialize)]
pub(crate) struct LoginForm {
    token: String,
}

/// Extract the bearer token bytes from `Authorization: Bearer <token>`, or None.
fn bearer_token(request: &Request) -> Option<&[u8]> {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix(BEARER_PREFIX).map(str::as_bytes))
}

/// Is `path` a browser/UI surface (vs a JSON `/api` route)? Used to decide 401
/// vs redirect-to-login on auth failure. Since T8 the SPA owns every non-API
/// path (`/`, client routes, assets) alongside the panel — anything outside
/// `/api/*` redirects so a deep-linked browser lands on the login form.
/// `/api/health` is excluded from this (it's unauthenticated anyway, so the
/// question never arises for it).
fn is_ui_path(path: &str) -> bool {
    !path.starts_with("/api")
}

/// Read a named cookie's value off the `Cookie` header. Returns `None` when the
/// header or the cookie is absent. Hand-rolled (no `cookie` crate dep) — the
/// only cookie this server reads is its own simple `name=value` pair, so the
/// minimal `; `-split + `=`-split parse is sufficient and avoids pulling a
/// cookie-parsing dependency for one call site.
fn cookie_token(request: &Request, name: &str) -> Option<String> {
    let header = request.headers().get(header::COOKIE)?.to_str().ok()?;
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some(rest) = pair.strip_prefix(&format!("{name}=")) {
            return Some(cookie_decode(rest));
        }
    }
    None
}

/// %-decode a cookie value (login writes it via [`url_encode_cookie`]). Only
/// handles the percent-encoding the login side emits; `+` is left as-is (the
/// token is written verbatim except for reserved chars).
fn cookie_decode(v: &str) -> String {
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// Percent-encode just the characters that are illegal in a cookie value
/// (`,` `;` space and anything non-printable). Leaves the common case
/// (alphanumeric tokens) untouched so the wire value matches `settings.token`.
pub(crate) fn url_encode_cookie(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b == b'%' || b == b',' || b == b';' || b.is_ascii_whitespace() || !b.is_ascii_graphic() {
            out.push_str(&format!("%{b:02X}"));
        } else {
            out.push(b as char);
        }
    }
    out
}

/// Byte-wise constant-time equality.
///
/// Accumulates a running XOR over the (equal-length) inputs with no early exit
/// on the first differing byte. Length mismatch returns immediately — see the
/// [`require_auth`] docs on why length is not treated as secret.
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

    /// Run a request through the real router with optional bearer + cookie,
    /// returning the resulting status code.
    async fn status_with(uri: &str, auth: Option<&str>, cookie: Option<&str>) -> StatusCode {
        let app = router(app_state("sekrit"));
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(token) = auth {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(c) = cookie {
            builder = builder.header(header::COOKIE, format!("{TOKEN_COOKIE}={c}"));
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).expect("valid request"))
            .await
            .expect("router serves");
        resp.status()
    }

    #[tokio::test]
    async fn missing_authorization_header_is_401() {
        assert_eq!(
            status_with("/api/books", None, None).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn wrong_token_is_401() {
        assert_eq!(
            status_with("/api/books", Some("nope"), None).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn correct_token_passes_through() {
        // /api/books is empty [] → 200, proving the middleware let it through.
        assert_eq!(
            status_with("/api/books", Some("sekrit"), None).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn correct_cookie_passes_through() {
        // No bearer header — a valid cookie authorizes the request.
        assert_eq!(
            status_with("/api/books", None, Some("sekrit")).await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn wrong_cookie_is_401() {
        assert_eq!(
            status_with("/api/books", None, Some("nope")).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn ui_path_without_auth_redirects_to_login() {
        // `/` is a UI path → 302 to /ui/login, not 401.
        let s = status_with("/", None, None).await;
        assert!(
            s == StatusCode::FOUND || s == StatusCode::SEE_OTHER,
            "UI path without auth redirects: got {s}"
        );
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

    // ---- login throttling ----

    /// POST a token to `/ui/login` through the real router, returning the
    /// status. (oneshot requests carry no ConnectInfo, so attempts land in the
    /// shared "unknown source" bucket — exactly what these tests need.)
    async fn login_status(app: axum::Router, token: &str) -> StatusCode {
        let req = Request::builder()
            .method("POST")
            .uri("/ui/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(format!("token={token}")))
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        resp.status()
    }

    #[tokio::test]
    async fn too_many_failed_logins_gets_429_even_with_the_correct_token() {
        let app = router(app_state("sekrit"));
        // Failures up to the limit: all re-render (200).
        for _ in 0..10 {
            assert_eq!(login_status(app.clone(), "nope").await, StatusCode::OK);
        }
        // Every subsequent attempt — including the CORRECT token — is refused
        // before the comparison runs.
        assert_eq!(
            login_status(app.clone(), "sekrit").await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn successful_login_clears_the_failure_count() {
        let app = router(app_state("sekrit"));
        // Failures just under the limit, then succeed (303) — the operator's
        // own typos must not lock them out.
        for _ in 0..9 {
            assert_eq!(login_status(app.clone(), "nope").await, StatusCode::OK);
        }
        assert_eq!(
            login_status(app.clone(), "sekrit").await,
            StatusCode::SEE_OTHER
        );
        // History cleared: another failure is tolerated rather than 429'd.
        assert_eq!(login_status(app, "nope").await, StatusCode::OK);
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

    // ---- cookie round-trip ----

    #[test]
    fn cookie_encode_decode_round_trips() {
        // For plain-alphanumeric tokens the encoding is a no-op (no special
        // chars to escape); for tokens with reserved chars it changes. Either
        // way, decode must recover the original — that's the load-bearing check.
        for raw in ["sekrit", "plain", "tok with space", "a,b;c", "%pct%"] {
            let enc = url_encode_cookie(raw);
            let dec = cookie_decode(&enc);
            assert_eq!(dec, raw, "round-trip: {raw} (enc={enc})");
        }
        // Reserved chars are actually escaped (not passed through verbatim).
        assert!(
            url_encode_cookie("a,b;c").contains("%"),
            "reserved chars escaped"
        );
        assert_eq!(
            url_encode_cookie("sekrit"),
            "sekrit",
            "plain token unchanged"
        );
    }
}
