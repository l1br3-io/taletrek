//! Server-rendered operator UI (T11) — the self-hoster's control panel.
//!
//! Not the product surface (the SPA is); this is the minimal browser UI for
//! browsing the library, uploading a bundle, triggering synth/resynth, and
//! watching recent jobs. Server-rendered via [`askama`] (typed, compiled
//! templates — a syntax error fails the build), no JS framework, no build step,
//! no external assets (inline `<style>` so the page is self-contained).
//!
//! # Post/Redirect/Get, no client JS
//!
//! The GET handlers render pages; the POST handlers (`upload_book`,
//! `synth_book`, `resynth_book`, `delete_book`) accept plain HTML `<form>`
//! submits, run the **same cores** as the JSON API (`books::ingest_bundle_bytes`,
//! `run_synth_job`, …), and return `303 See Other` redirects (Post/Redirect/Get)
//! so a browser refresh doesn't re-submit. Auth is cookie-based (see
//! [`crate::http::auth`] for the tradeoff) — forms cannot send a bearer header,
//! so the login flow sets a `taletrek_token` cookie the middleware accepts.
//!
//! # Templates
//!
//! Live under `server/src/templates/`; askama compiles them at build time via
//! the `#[derive(Template)]` macro. [`Html`] is a thin `IntoResponse` wrapper
//! (askama_axum 0.4 exposes a helper but no blanket impl, so we wrap).

use askama::Template;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Form;
use serde::Deserialize;

use taletrek_worker::voices::CURATED_VOICES;

use crate::db::{BookRow, JobRow};
use crate::http::books::{delete_book_id, ingest_bundle_bytes, read_bundle_field};
use crate::http::AppState;
use crate::synth::{run_resynth_job, run_synth_job, SynthContext};

/// Cap on the recent-jobs panel size on the index + jobs pages.
const JOBS_PANEL_LIMIT: usize = 20;

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
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        }
    }
}

// ===== views (plain data handed to templates; public fields for askama) =====

/// camelCase-free view of a book for the table/detail templates. Escaped by
/// askama on render (book metadata is untrusted — it comes from an uploaded
/// bundle — so auto-escaping is load-bearing against stored XSS).
#[derive(Debug)]
pub(crate) struct BookView {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub source_format: String,
    pub voice_id: String,
    pub audio_present: bool,
    pub chapter_count: i64,
}

impl BookView {
    /// One-word badge text for the audio column ("audio" / "text-only").
    fn badge(&self) -> &'static str {
        if self.audio_present {
            "audio"
        } else {
            "text-only"
        }
    }
}

impl From<BookRow> for BookView {
    fn from(r: BookRow) -> Self {
        Self {
            id: r.id,
            title: r.title,
            author: r.author,
            source_format: r.source_format,
            voice_id: r.voice_id,
            audio_present: r.audio_present,
            chapter_count: r.chapter_count,
        }
    }
}

/// One row in the jobs panel/table.
#[derive(Debug)]
pub(crate) struct JobView {
    /// Job id — not rendered by the templates yet, but kept so the view is a
    /// faithful projection of [`JobRow`] (a future "link to this job" affordance
    /// would use it).
    #[allow(dead_code)]
    pub id: String,
    pub book_id: String,
    pub kind: String,
    pub voice: String,
    pub status: String,
    pub progress: String,
    pub error: Option<String>,
}

impl From<JobRow> for JobView {
    fn from(j: JobRow) -> Self {
        Self {
            id: j.id,
            book_id: j.book_id,
            kind: format!("{:?}", j.kind).to_lowercase(),
            voice: j.voice,
            status: format!("{:?}", j.status).to_lowercase(),
            progress: format!("{}/{}", j.done, j.total),
            error: j.error,
        }
    }
}

/// One `<option>` in the voice `<select>` — id, label, and whether it's the
/// selected option (the book's current voice, or the default).
#[derive(Debug)]
pub(crate) struct VoiceOption {
    pub id: &'static str,
    pub label: String,
    pub selected: bool,
}

/// Build the voice `<select>` options from the curated catalog, marking the
/// book's current voice (falling back to [`DEFAULT_VOICE_ID`]) as selected.
/// Generating from `CURATED_VOICES` keeps the UI and the API from ever
/// disagreeing on the catalog.
fn voice_options(selected_voice: &str) -> Vec<VoiceOption> {
    CURATED_VOICES
        .iter()
        .map(|v| VoiceOption {
            id: v.id,
            label: format!("{} ({})", v.name, v.language),
            selected: v.id == selected_voice,
        })
        .collect()
}

// ===== templates =====

#[derive(Template)]
#[template(path = "index.html")]
struct IndexTemplate<'a> {
    books: &'a [BookView],
    jobs: &'a [JobView],
}

#[derive(Template)]
#[template(path = "book.html")]
struct BookTemplate<'a> {
    book: &'a BookView,
    voices: &'a [VoiceOption],
}

#[derive(Template)]
#[template(path = "jobs.html")]
struct JobsTemplate<'a> {
    jobs: &'a [JobView],
}

#[derive(Template)]
#[template(path = "login.html")]
struct LoginTemplate {
    error: Option<String>,
}

#[derive(Template)]
#[template(path = "error.html")]
struct ErrorTemplate {
    message: String,
    back: String,
}

/// Render the login page (used by [`crate::http::auth::login_form`] +
/// [`crate::http::auth::login`]). `error` is shown when a previous POST failed.
pub(crate) fn login_page(error: Option<&str>) -> Response {
    Html(LoginTemplate {
        error: error.map(str::to_owned),
    })
    .into_response()
}

/// A simple "something went wrong" page for a failed UI POST (e.g. synth
/// trigger error). `back` is the link target the operator returns to. Keeps the
/// operator informed without a flash-message system (v1 simplicity).
fn error_page(message: impl Into<String>, back: impl Into<String>) -> Response {
    Html(ErrorTemplate {
        message: message.into(),
        back: back.into(),
    })
    .into_response()
}

// ===== GET handlers =====

/// Collapse an index-panel query into an empty list, logging why. A db failure
/// rendering as an empty table would mislead the operator into thinking the
/// library was wiped — the warn keeps the real cause visible in the logs.
fn unwrap_or_empty<T>(
    res: Result<Result<Vec<T>, crate::db::DbError>, tokio::task::JoinError>,
    panel: &str,
) -> Vec<T> {
    match res {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, panel, "index panel query failed");
            Vec::new()
        }
        Err(e) => {
            tracing::warn!(error = %e, panel, "index panel task join failed");
            Vec::new()
        }
    }
}

/// `GET /ui/admin` + `GET /ui/admin/` → the index: library table + upload form
/// + jobs panel.
pub async fn index(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    let jobs_db = state.db.clone();
    let (books, jobs) = tokio::join!(
        async {
            unwrap_or_empty(
                tokio::task::spawn_blocking(move || db.list_books()).await,
                "books",
            )
        },
        async {
            unwrap_or_empty(
                tokio::task::spawn_blocking(move || jobs_db.list_recent_jobs(JOBS_PANEL_LIMIT))
                    .await,
                "jobs",
            )
        },
    );
    let books: Vec<BookView> = books.into_iter().map(BookView::from).collect();
    let jobs: Vec<JobView> = jobs.into_iter().map(JobView::from).collect();
    Html(IndexTemplate {
        books: &books,
        jobs: &jobs,
    })
    .into_response()
}

/// `GET /ui/admin/books/{id}` → book detail: metadata + synth form (voice `<select>`)
/// + resynth form + download link + delete form. Unknown id → error page.
pub async fn book_detail(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let db = state.db.clone();
    let id_for_db = id.clone();
    let row = tokio::task::spawn_blocking(move || db.get_book(&id_for_db))
        .await
        .ok()
        .and_then(|r| r.ok())
        .flatten();
    match row {
        Some(row) => {
            let book = BookView::from(row);
            let voices = voice_options(&book.voice_id);
            Html(BookTemplate {
                book: &book,
                voices: &voices,
            })
            .into_response()
        }
        None => Html(ErrorTemplate {
            message: format!("book {id} not found"),
            back: "/ui/admin".to_string(),
        })
        .into_response(),
    }
}

/// `GET /ui/admin/jobs` → recent jobs table (poll = refresh the page; no live updates).
pub async fn jobs(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    let rows = tokio::task::spawn_blocking(move || db.list_recent_jobs(JOBS_PANEL_LIMIT))
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    let jobs: Vec<JobView> = rows.into_iter().map(JobView::from).collect();
    Html(JobsTemplate { jobs: &jobs }).into_response()
}

// ===== POST handlers (Post/Redirect/Get, reuse the JSON-API cores) =====

/// `POST /ui/admin` (multipart) — the upload form. Reads the `bundle` field,
/// ingests via the shared [`ingest_bundle_bytes`], redirects to `/ui/admin`.
/// On error, renders an error page (the book simply won't appear in the table).
pub async fn upload_book(State(state): State<AppState>, mut multipart: Multipart) -> Response {
    let bytes = match read_bundle_field(&mut multipart).await {
        Ok(b) => b,
        Err((_status, msg)) => return error_page(msg, "/ui/admin"),
    };
    match ingest_bundle_bytes(&state, bytes).await {
        Ok(_) => Redirect::to("/ui/admin").into_response(),
        Err((_status, msg)) => error_page(msg, "/ui/admin"),
    }
}

/// The `<select name="voice">` body shared by the synth + resynth forms.
/// `voice` is always present (a `<select>` submits its first option at minimum).
/// `pub(crate)` because the handler signatures are `pub` (the type leaks).
#[derive(Debug, Deserialize)]
pub(crate) struct VoiceForm {
    voice: String,
}

/// `POST /ui/admin/books/{id}/synth` — synth form. Runs [`run_synth_job`] under the
/// selected voice, redirects back to the book page. Trigger errors (404/409/…)
/// surface as an error page.
pub async fn synth_book(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<VoiceForm>,
) -> Response {
    let ctx = synth_ctx(&state);
    let voice = if form.voice.is_empty() {
        None
    } else {
        Some(form.voice)
    };
    match run_synth_job(ctx, id.clone(), voice, None, None).await {
        Ok(_) => Redirect::to(&format!("/ui/admin/books/{id}")).into_response(),
        Err(e) => error_page(e.to_string(), format!("/ui/admin/books/{id}")),
    }
}

/// `POST /ui/admin/books/{id}/resynth` — resynth form. Runs [`run_resynth_job`] under
/// the selected (required) voice, redirects to the book page.
pub async fn resynth_book(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Form(form): Form<VoiceForm>,
) -> Response {
    let ctx = synth_ctx(&state);
    let voice = if form.voice.is_empty() {
        None
    } else {
        Some(form.voice)
    };
    match run_resynth_job(ctx, id.clone(), voice, None, None).await {
        Ok(_) => Redirect::to(&format!("/ui/admin/books/{id}")).into_response(),
        Err(e) => error_page(e.to_string(), format!("/ui/admin/books/{id}")),
    }
}

/// `POST /ui/admin/books/{id}/delete` — delete form. Runs the shared
/// [`delete_book_id`], redirects to `/ui/admin` (idempotent — a missing book
/// is fine).
pub async fn delete_book(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match delete_book_id(&state, &id).await {
        Ok(()) => Redirect::to("/ui/admin").into_response(),
        Err((_status, msg)) => error_page(msg, "/ui/admin"),
    }
}

/// Build a [`SynthContext`] from the shared state. Mirrors the construction in
/// the JSON synth/resynth handlers; kept here (not in `synth.rs`) to avoid
/// coupling the synth module to `AppState`.
fn synth_ctx(state: &AppState) -> SynthContext {
    SynthContext {
        db: state.db.clone(),
        data_dir: state.data_dir.clone(),
        voices_cache_dir: state.settings.voices_cache_dir.clone(),
        default_jobs: state.settings.jobs,
        backend: (*state.synth).clone(),
        in_flight: state.in_flight.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{BookRow, Db, JobKind, JobRow, JobStatus};
    use crate::http::router;
    use crate::http::test_support::{app_state, app_state_with_db};

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, StatusCode};
    use std::sync::Arc;
    use tower::ServiceExt;

    // ===== template render tests (askama templates are testable as fns) =====

    fn book(id: &str, audio: bool) -> BookView {
        BookView {
            id: id.to_string(),
            title: format!("Title {id}"),
            author: Some(format!("Author {id}")),
            source_format: "epub".to_string(),
            voice_id: "en_US-hfc_female-medium".to_string(),
            audio_present: audio,
            chapter_count: 12,
        }
    }

    fn job(id: &str, status: JobStatus) -> JobView {
        JobView {
            id: id.to_string(),
            book_id: "bk1".to_string(),
            kind: "synth".to_string(),
            voice: "en_US-ryan-medium".to_string(),
            status: format!("{:?}", status).to_lowercase(),
            progress: "3/10".to_string(),
            error: None,
        }
    }

    #[test]
    fn index_renders_seeded_book_title_and_job_status() {
        let books = vec![book("b1", true), book("b2", false)];
        let jobs = vec![job("j1", JobStatus::Succeeded)];
        let html = IndexTemplate {
            books: &books,
            jobs: &jobs,
        }
        .render()
        .expect("render");

        // Book titles + ids appear (the detail link carries the id).
        assert!(html.contains("Title b1"), "title b1 in index: {html}");
        assert!(html.contains("/ui/admin/books/b1"), "detail link: {html}");
        // Audio badge reflects audio_present.
        assert!(html.contains("audio"), "audio badge present: {html}");
        assert!(html.contains("text-only"), "text-only badge: {html}");
        // A job's status appears in the jobs panel.
        assert!(html.contains("succeeded"), "job status in panel: {html}");
        // Upload form posts to the admin index route.
        assert!(
            html.contains(r#"action="/ui/admin""#),
            "upload form: {html}"
        );
    }

    // ===== escaping: book metadata is untrusted (stored XSS) =====

    /// Askama's auto-escaping is load-bearing — every interpolation renders
    /// attacker-influenced strings (titles/authors/ids from uploaded bundles).
    /// This pins it: a future `|safe` filter or template rewrite that drops
    /// escaping fails here instead of in the operator's browser.
    #[test]
    fn index_escapes_hostile_book_metadata() {
        let mut hostile = book("b1", false);
        hostile.title = "<script>alert(1)</script>\"<img src=x onerror=alert(2)>".into();
        hostile.author = Some("<svg onload=alert(3)>".into());
        let jobs = vec![];
        let html = IndexTemplate {
            books: &[hostile],
            jobs: &jobs,
        }
        .render()
        .expect("render");

        assert!(
            !html.contains("<script>"),
            "raw script tag must not survive: {html}"
        );
        assert!(
            !html.contains("<img src=x"),
            "raw img must not survive: {html}"
        );
        assert!(
            !html.contains("<svg onload"),
            "raw svg must not survive: {html}"
        );
        assert!(
            html.contains("&lt;script&gt;"),
            "escaped form present: {html}"
        );
    }

    /// Same pin for the detail page, where the id also lands inside links.
    #[test]
    fn book_page_escapes_hostile_book_metadata() {
        let mut hostile = book("b1", false);
        hostile.title = "\"><script>alert(1)</script>".into();
        hostile.author = Some("' onmouseover='alert(2)".into());
        let voices = voice_options(&hostile.voice_id);
        let html = BookTemplate {
            book: &hostile,
            voices: &voices,
        }
        .render()
        .expect("render");

        assert!(
            !html.contains("<script>"),
            "raw script must not survive: {html}"
        );
        assert!(
            !html.contains("' onmouseover='"),
            "attribute breakout must not survive: {html}"
        );
        assert!(
            html.contains("&lt;script&gt;"),
            "escaped form present: {html}"
        );
    }

    #[test]
    fn book_page_renders_voice_select_with_curated_options() {
        let b = book("b1", false);
        let voices = voice_options(&b.voice_id);
        let html = BookTemplate {
            book: &b,
            voices: &voices,
        }
        .render()
        .expect("render");

        // The book's own voice is selected; the default is too (book uses it).
        assert!(html.contains("selected"), "one option selected: {html}");
        // Every curated id is an <option>.
        for v in CURATED_VOICES {
            assert!(
                html.contains(&format!("value=\"{}\"", v.id)),
                "voice {}: {html}",
                v.id
            );
        }
        // Synth + resynth + delete forms + download link are present.
        assert!(
            html.contains("/ui/admin/books/b1/synth"),
            "synth form: {html}"
        );
        assert!(
            html.contains("/ui/admin/books/b1/resynth"),
            "resynth form: {html}"
        );
        assert!(
            html.contains("/ui/admin/books/b1/delete"),
            "delete form: {html}"
        );
        assert!(
            html.contains("/api/books/b1/bundle"),
            "download link: {html}"
        );
    }

    #[test]
    fn jobs_page_renders_job_kind_voice_and_progress() {
        let jobs = vec![job("j1", JobStatus::Running)];
        let html = JobsTemplate { jobs: &jobs }.render().expect("render");
        assert!(html.contains("synth"), "kind: {html}");
        assert!(html.contains("en_US-ryan-medium"), "voice: {html}");
        assert!(html.contains("3/10"), "progress: {html}");
        assert!(html.contains("running"), "status: {html}");
    }

    #[test]
    fn login_page_renders_form_and_optional_error() {
        let no_err = LoginTemplate { error: None }.render().expect("render");
        assert!(no_err.contains("name=\"token\""), "token field: {no_err}");
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

    #[test]
    fn book_view_badge_reflects_audio_present() {
        assert_eq!(book("a", true).badge(), "audio");
        assert_eq!(book("b", false).badge(), "text-only");
    }

    #[test]
    fn voice_options_marks_the_book_voice_selected() {
        let opts = voice_options("en_US-ryan-medium");
        let selected: Vec<_> = opts.iter().filter(|o| o.selected).collect();
        assert_eq!(selected.len(), 1, "exactly one selected: {selected:?}");
        assert_eq!(selected[0].id, "en_US-ryan-medium");
    }

    #[test]
    fn voice_options_falls_back_to_default_when_book_voice_unknown() {
        // A voice id not in the catalog → nothing selected (no panic).
        let opts = voice_options("not-a-curated-id");
        assert!(
            opts.iter().all(|o| !o.selected),
            "none selected for unknown"
        );
    }

    // sanity: the Db-row → view conversions compile + preserve fields.
    #[test]
    fn bookrow_to_bookview_preserves_fields() {
        let row = BookRow {
            id: "bk".into(),
            title: "T".into(),
            author: Some("A".into()),
            source_format: "pdf".into(),
            voice_id: "v".into(),
            audio_present: true,
            chapter_count: 7,
            created_at: 1,
            updated_at: 2,
            exploded_at: None,
            position: None,
        };
        let v = BookView::from(row);
        assert_eq!(v.id, "bk");
        assert_eq!(v.source_format, "pdf");
        assert!(v.audio_present);
    }

    #[test]
    fn jobrow_to_jobview_preserves_fields() {
        let row = JobRow {
            id: "j".into(),
            book_id: "bk".into(),
            kind: JobKind::Resynth,
            voice: "v".into(),
            status: JobStatus::Failed,
            done: 1,
            total: 4,
            error: Some("boom".into()),
            created_at: 0,
            updated_at: 0,
        };
        let v = JobView::from(row);
        assert_eq!(v.kind, "resynth");
        assert_eq!(v.status, "failed");
        assert_eq!(v.progress, "1/4");
        assert_eq!(v.error.as_deref(), Some("boom"));
    }

    // ===== HTTP-level wiring (cookie auth + login flow + page serving) =====

    /// `GET /ui/admin` with a valid cookie → 200 + the rendered library page.
    #[tokio::test(flavor = "multi_thread")]
    async fn get_admin_with_cookie_renders_library() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap_or("")),
            Some("text/html; charset=utf-8")
        );
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let html = String::from_utf8(bytes.to_vec()).unwrap_or_default();
        assert!(
            html.contains("<title>Library"),
            "library page title: {html}"
        );
        assert!(html.contains("TaleTrek"), "brand present: {html}");
        assert!(html.contains("❯~"), "brand mark present: {html}");
    }

    /// `GET /ui/admin` without auth → redirect to the login page (cookie-login
    /// model; UI paths redirect rather than 401 so a browser lands on the form).
    #[tokio::test(flavor = "multi_thread")]
    async fn get_admin_without_auth_redirects_to_login() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert!(
            resp.status() == StatusCode::FOUND || resp.status() == StatusCode::SEE_OTHER,
            "redirect: got {}",
            resp.status()
        );
        let loc = resp
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert_eq!(loc, "/ui/login", "redirects to login: {loc}");
    }

    /// `GET /ui/login` (unauthed) → 200 + the token form.
    #[tokio::test(flavor = "multi_thread")]
    async fn login_form_renders_without_auth() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/login")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let html = String::from_utf8(bytes.to_vec()).unwrap_or_default();
        assert!(html.contains(r#"name="token""#), "token field: {html}");
    }

    /// `POST /ui/login` with the right token → 303 + a `Set-Cookie` carrying the
    /// token, pointing at `/`. Wrong token → re-renders the form, no Set-Cookie.
    #[tokio::test(flavor = "multi_thread")]
    async fn login_post_sets_cookie_on_success() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("POST")
            .uri("/ui/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("token=sekrit"))
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            resp.headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok()),
            Some("/")
        );
        let set_cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(
            set_cookie.contains("taletrek_token=sekrit"),
            "cookie set: {set_cookie}"
        );
        assert!(set_cookie.contains("HttpOnly"), "HttpOnly: {set_cookie}");
        assert!(
            set_cookie.contains("SameSite=Lax"),
            "SameSite=Lax: {set_cookie}"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_post_wrong_token_rerenders_no_cookie() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("POST")
            .uri("/ui/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("token=nope"))
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        // Wrong token re-renders the form (200), not a redirect.
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            resp.headers().get(header::SET_COOKIE).is_none(),
            "no cookie on failure"
        );
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let html = String::from_utf8(bytes.to_vec()).unwrap_or_default();
        assert!(html.contains("invalid token"), "error shown: {html}");
    }

    /// `GET /ui/admin/jobs` with a cookie → 200 jobs page.
    #[tokio::test(flavor = "multi_thread")]
    async fn get_jobs_with_cookie_renders() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin/jobs")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /// `GET /ui/admin` with a bearer header (API-style auth) also authorizes the
    /// UI — the middleware accepts either credential, so the bearer path still
    /// works for non-browser clients hitting the pages.
    #[tokio::test(flavor = "multi_thread")]
    async fn get_admin_with_bearer_header_renders() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin")
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /// `GET /ui/admin/books/:id` for an unknown id → 200 error page (not a raw
    /// 404), so the operator gets a friendly message + back link.
    #[tokio::test(flavor = "multi_thread")]
    async fn book_detail_unknown_renders_error_page() {
        let app = router(app_state("sekrit"));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin/books/nope")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let html = String::from_utf8(bytes.to_vec()).unwrap_or_default();
        assert!(html.contains("not found"), "error message: {html}");
    }

    /// A seeded book appears on the index page served over HTTP (end-to-end:
    /// StubDb → handler → askama render → body).
    #[tokio::test(flavor = "multi_thread")]
    async fn index_page_lists_seeded_book_over_http() {
        let db = crate::db::test_utils::StubDb::new();
        db.upsert_book(BookRow {
            id: "bk_http".into(),
            title: "HTTP Rendered Book".into(),
            author: None,
            source_format: "txt".into(),
            voice_id: "en_US-ryan-medium".into(),
            audio_present: false,
            chapter_count: 1,
            created_at: 1,
            updated_at: 1,
            exploded_at: None,
            position: None,
        })
        .expect("seed");
        let app = router(app_state_with_db_with_tmp(Arc::new(db)));
        let req = Request::builder()
            .method("GET")
            .uri("/ui/admin")
            .header(header::COOKIE, "taletrek_token=sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = app.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        let html = String::from_utf8(bytes.to_vec()).unwrap_or_default();
        assert!(
            html.contains("HTTP Rendered Book"),
            "seeded title on page: {html}"
        );
        assert!(
            html.contains("/ui/admin/books/bk_http"),
            "detail link: {html}"
        );
    }

    /// Build an AppState from a stub db reusing the shared test_support (token
    /// "sekrit"). The UI handlers don't touch disk on GET, so the default
    /// non-existent data_dir is fine.
    fn app_state_with_db_with_tmp(db: Arc<dyn Db>) -> AppState {
        app_state_with_db(db, "sekrit")
    }
}
