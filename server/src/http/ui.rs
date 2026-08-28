//! The login page — the only server-rendered surface left (T16 deleted the
//! interim askama operator panel; the hosted SPA is the server's UI).
//!
//! Kept as a compiled [`askama`] template (typed — a syntax error fails the
//! build) with zero client JS and no external assets (inline `<style>`), so
//! the cookie gate works before the SPA loads and on any browser. The
//! handlers live in [`crate::http::auth`]; this module only renders.

use askama::Template;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};

// ===== IntoResponse wrapper =====

/// Thin `IntoResponse` wrapper around an askama `Template`. Renders to a String
/// and returns it as `text/html; charset=utf-8` (auto-escaped by askama).
/// Implemented locally (rather than via the `askama_axum` crate) because the
/// published `askama_axum` 0.4 pins `axum-core 0.4`, which conflicts with this
/// crate's `axum 0.8` (`axum-core 0.5`) — the two produce distinct `Body` types.
/// The helper is trivial enough to inline.
struct Html<T: Template>(T);

impl<T: Template> IntoResponse for Html<T> {
    fn into_response(self) -> Response {
        match self.0.render() {
            Ok(body) => (
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                )],
                body,
            )
                .into_response(),
            Err(e) => {
                tracing::error!(error = ?e, "askama template render failed");
                axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

// ===== template =====

#[derive(Template)]
#[template(path = "login.html")]
struct LoginTemplate {
    error: Option<String>,
}

/// Render the login page (used by [`crate::http::auth::login_form`] +
/// [`crate::http::auth::login`]). `error` is shown when a previous POST failed.
pub(crate) fn login_page(error: Option<&str>) -> Response {
    Html(LoginTemplate {
        error: error.map(str::to_owned),
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_page_renders_form_and_optional_error() {
        let no_err = LoginTemplate { error: None }.render().expect("render");
        assert!(no_err.contains(r#"name="token""#), "token field: {no_err}");
        assert!(no_err.contains("/ui/login"), "posts to login: {no_err}");

        let with_err = LoginTemplate {
            error: Some("invalid token".to_string()),
        }
        .render()
        .expect("render");
        assert!(
            with_err.contains("invalid token"),
            "error shown: {with_err}"
        );
    }

    /// The login page interpolates a server-controlled string today, but keep
    /// the escaping pin anyway — askama auto-escaping is load-bearing the
    /// moment anything user-influenced lands in `error`.
    #[test]
    fn login_page_escapes_hostile_error_text() {
        let hostile = LoginTemplate {
            error: Some("<script>alert(1)</script>".to_string()),
        }
        .render()
        .expect("render");
        assert!(
            !hostile.contains("<script>"),
            "raw script must not survive: {hostile}"
        );
        assert!(
            hostile.contains("&lt;script&gt;"),
            "escaped form present: {hostile}"
        );
    }
}
