//! Voice catalog + prefetch handlers (T10).
//!
//! - `GET /api/voices` — the read-only curated catalog
//!   ([`taletrek_worker::voices::CURATED_VOICES`]) as camelCase JSON, so the
//!   web UI can render the voice picker without bundling a copy of the list.
//! - `POST /api/voices/{id}/fetch` — resolve + cache a voice model ahead of a
//!   synth so the first run isn't slow. Cache hits short-circuit (no network).
//!
//! Both inherit the auth layer (no auth-free shortcut) — they live on the
//! protected sub-router alongside the other `/api` routes.

use std::fmt::Display;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;

use taletrek_worker::voices::{find_curated, resolve_voice, ResolveError, ResolveOpts, UreqVoiceSource, VoiceQuality, CURATED_VOICES};

use crate::http::AppState;

/// camelCase JSON view of one curated voice — the public wire shape. Mirrors
/// the SPA's `Voice` interface (`web/src/lib/tts/types.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceDto {
    id: &'static str,
    name: &'static str,
    quality: &'static str,
    size_bytes: u64,
    language: &'static str,
}

/// Render the quality tier as the lowercase string the SPA expects
/// (`"low"` / `"medium"` / `"high"`).
fn quality_str(q: VoiceQuality) -> &'static str {
    match q {
        VoiceQuality::Low => "low",
        VoiceQuality::Medium => "medium",
        VoiceQuality::High => "high",
    }
}

/// `GET /api/voices` → `200` array of every curated voice.
pub async fn list_voices() -> Json<Vec<VoiceDto>> {
    let dtos = CURATED_VOICES
        .iter()
        .map(|v| VoiceDto {
            id: v.id,
            name: v.name,
            quality: quality_str(v.quality),
            size_bytes: v.size_bytes,
            language: v.language,
        })
        .collect();
    Json(dtos)
}

/// `POST /api/voices/{id}/fetch` — prefetch a voice model into the cache.
///
/// Unknown curated id → `404`. A cache hit resolves without network; a miss
/// downloads via `ureq` (blocking → `spawn_blocking`). Download failure → `500`
/// (the caller can retry; the voice id was valid, the network wasn't).
pub async fn fetch_voice(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Cheap curated-id check up front — avoids a spawn_blocking round-trip for
    // the 404 case and keeps the resolve_voice error path narrow.
    if find_curated(&id).is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            ResolveError::UnknownCuratedId(id).to_string(),
        ));
    }
    let cache_dir = state.settings.voices_cache_dir.clone();
    let inner = tokio::task::spawn_blocking(move || {
        let opts = ResolveOpts::new(None, cache_dir);
        // `progress=None`: prefetch is silent (no job row to tick). The download
        // still lands in the cache; a later synth reads the cache hit.
        resolve_voice(Some(&id), &opts, &UreqVoiceSource, None)
            .map(|_| ())
            .map_err(fetch_status)
    })
    .await
    .map_err(internal_error)?; // JoinError → 500
    inner?; // resolve error → already (StatusCode, String)
    Ok(StatusCode::NO_CONTENT)
}

/// Map a resolve error from prefetch to its HTTP status. Only
/// `UnknownCuratedId` is `404` (and it's already guarded above, so reaching
/// here is a race); everything else (disk write, download) is `500`.
fn fetch_status(e: ResolveError) -> (StatusCode, String) {
    match e {
        ResolveError::UnknownCuratedId(_) => (StatusCode::NOT_FOUND, e.to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Map any join / resolve error to a `500` body.
fn internal_error<E: Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::db::{Db, test_utils::StubDb};
    use crate::http::router;
    use crate::http::test_support::app_state_with_data_dir;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};
    use std::sync::Arc;
    use tower::ServiceExt;

    use taletrek_worker::voices::CURATED_VOICES;

    /// A known curated id the prefetch tests target. Pre-seeding the cache with
    /// `<id>.onnx` + `<id>.json` makes `resolve_voice` a cache hit (no network).
    const KNOWN_VOICE: &str = "en_US-ryan-medium";

    /// A router backed by an empty [`StubDb`] + a tempdir `data_dir` that also
    /// hosts the voices cache (so tests can seed cache hits). The tempdir is
    /// returned so the test keeps it alive.
    fn voices_router() -> (axum::Router, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db: Arc<dyn Db> = Arc::new(StubDb::new());
        let r = router(app_state_with_data_dir(db, tmp.path().to_path_buf(), "sekrit"));
        (r, tmp)
    }

    /// Authed `GET` returning `(status, parsed-json)`.
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
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// Authed `POST` returning `(status, body-text)`.
    async fn post_empty(router: axum::Router, uri: &str) -> (StatusCode, String) {
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Seed `<cache>/<id>.onnx` + `.json` so resolution is a cache hit.
    fn seed_cache(cache_dir: &std::path::Path, id: &str) {
        std::fs::create_dir_all(cache_dir).expect("cache dir");
        std::fs::write(cache_dir.join(format!("{id}.onnx")), b"stub-model").expect("onnx");
        std::fs::write(cache_dir.join(format!("{id}.json")), b"{}").expect("json");
    }

    // ===== GET /api/voices — full catalog, right shape =====

    #[tokio::test(flavor = "multi_thread")]
    async fn list_voices_returns_all_curated_entries() {
        let (router, _tmp) = voices_router();
        let (status, json) = get_json(router, "/api/voices").await;
        assert_eq!(status, StatusCode::OK);
        let arr = json.as_array().expect("array");
        assert_eq!(
            arr.len(),
            CURATED_VOICES.len(),
            "every curated voice surfaces: {json}"
        );
        // Shape: camelCase keys, quality is a lowercase string, sizeBytes is a
        // number. Check the first entry in detail + parity on ids.
        let first = &arr[0];
        assert!(first.get("id").is_some(), "id present");
        assert!(first.get("name").is_some(), "name present");
        assert!(
            matches!(first["quality"].as_str(), Some("low" | "medium" | "high")),
            "quality is a lowercase tier string: {first}"
        );
        assert!(first.get("sizeBytes").is_some(), "camelCase sizeBytes");
        assert!(first.get("language").is_some(), "language present");
        // No snake_case leak.
        assert!(first.get("size_bytes").is_none(), "no snake_case leak");

        let got_ids: Vec<&str> = arr
            .iter()
            .map(|v| v["id"].as_str().expect("id str"))
            .collect();
        let want_ids: Vec<&str> = CURATED_VOICES.iter().map(|v| v.id).collect();
        assert_eq!(got_ids, want_ids, "catalog order + ids match the worker list");
    }

    // ===== POST /api/voices/:id/fetch — unknown → 404, cache-hit → 204 =====

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_unknown_voice_is_404() {
        let (router, _tmp) = voices_router();
        let (status, _body) = post_empty(router, "/api/voices/en_US-bogus-high/fetch").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_known_voice_cache_hit_is_204_no_network() {
        let (router, tmp) = voices_router();
        // Seed the cache so resolve_voice short-circuits (no network).
        seed_cache(&tmp.path().join("voices"), KNOWN_VOICE);
        let (status, body) = post_empty(router, format!("/api/voices/{KNOWN_VOICE}/fetch").as_str()).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "body: {body}");
        assert!(body.is_empty() || body == "null", "204 has empty body: {body}");
    }

    // ===== auth still required =====

    #[tokio::test(flavor = "multi_thread")]
    async fn voices_without_auth_is_401() {
        let (router, _tmp) = voices_router();
        let req = Request::builder()
            .method("GET")
            .uri("/api/voices")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_without_auth_is_401() {
        let (router, _tmp) = voices_router();
        let req = Request::builder()
            .method("POST")
            .uri("/api/voices/en_US-ryan-medium/fetch")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
