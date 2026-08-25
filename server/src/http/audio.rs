//! Audio playback endpoint — `GET /api/books/{id}/audio/{contentKey}` (T10).
//!
//! The hosted SPA fetches one paragraph's audio by its content-addressed key
//! (`${voice}:${NORM_VERSION}:${sha256}` — identical scheme on both sides by
//! construction, see `crates/synth/src/cache_key.rs`). The handler reads a
//! single entry out of the stored bundle zip — central-directory lookup + one
//! decompress, no full unzip, no whole-file read (the synth crate's
//! [`taletrek_synth::read_audio_segment`]).
//!
//! # GOTCHA — colons in the path param
//!
//! Content keys contain `:` (`voice:2:hash…`). `:` is a legal path-segment
//! character (RFC 3986 `pchar`) and axum's `{contentKey}` captures everything
//! up to the next `/` verbatim, so clients pass the key **raw**:
//! `/audio/en_US-lessac-medium:2:abcd…`. A `%3A`-encoded colon decodes to the
//! same key via `Path`'s percent-decoding — both forms work, no special
//! encoding rules. What is never legal inside a key: `/`, `..`, `\`, NUL —
//! rejected with `400` by [`taletrek_synth::validate_audio_key`] **before**
//! the FS-backed zip is touched (a `%2F` decodes into the key and is caught
//! the same way; a raw `/` splits segments and never routes here at all).
//!
//! # GOTCHA — buffered response ceiling
//!
//! The response body is fully buffered in memory. Fine for what this serves:
//! one paragraph of speech (tens of KB of Opus). The hard ceiling is the synth
//! crate's per-entry decompression cap (256 MiB default, `ReadBudget`) — this
//! endpoint never streams whole-book audio.
//!
//! # Decisions (v1, per-book)
//!
//! - Entry name resolved via the manifest's declared codec
//!   (`audio/<key>.<ext>`): production bundles are Opus → `audio/ogg`; a
//!   wav/m4a-codec bundle (stub encoders; wav is permitted-but-discouraged)
//!   is served with its native content type rather than 404ing every key.
//! - Known book + missing key → `404` (not `204`): identical to the
//!   unknown-book case on purpose — the SPA treats any 404 here as
//!   "key not in this bundle" and resynthesizes/falls back; a 204 would blur
//!   the book-missing case for no consumer benefit.
//! - No cross-book store, no Range (per-book v1; both are follow-ons).

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use taletrek_synth::{validate_audio_key, AudioCodec};

use crate::http::AppState;
use crate::store::{self, StoreError};

/// Content type served per bundle codec. Opus travels in an Ogg container.
fn content_type(codec: AudioCodec) -> &'static str {
    match codec {
        AudioCodec::Opus => "audio/ogg",
        AudioCodec::M4a => "audio/mp4",
        AudioCodec::Wav => "audio/wav",
    }
}

/// `GET /api/books/{id}/audio/{contentKey}` (protected).
///
/// Unknown book (no bundle on disk) → `404`; known book, missing key → `404`
/// (see module docs for why not `204`); traversal-shaped key or book id →
/// `400`; corrupt bundle / I/O → `500`; success → `200` with the codec's
/// content type (`nosniff` is stamped router-wide).
pub async fn get_audio(
    State(state): State<AppState>,
    Path((id, content_key)): Path<(String, String)>,
) -> Result<Response, (StatusCode, String)> {
    // Traversal-shaped keys are rejected before anything touches the FS-backed
    // zip. The synth crate re-validates inside the read as defense-in-depth.
    validate_audio_key(&content_key).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let data_dir = state.data_dir.clone();
    let book_id = id.clone();
    let key = content_key.clone();
    let segment = tokio::task::spawn_blocking(move || {
        store::get_audio_segment(&data_dir, &book_id, &key)
    })
    .await
    .map_err(internal_error)?
    .map_err(|e| match e {
        StoreError::NotFound(book) => (StatusCode::NOT_FOUND, format!("book not found: {book}")),
        StoreError::InvalidBookId(_) => (StatusCode::BAD_REQUEST, e.to_string()),
        other => internal_error(other),
    })?;

    // Known book, missing key → 404 (decision documented in the module docs).
    let Some(segment) = segment else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("no audio segment for key {content_key} in book {id}"),
        ));
    };

    let content_type = header::HeaderValue::from_static(content_type(segment.codec));
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type)],
        segment.bytes,
    )
        .into_response())
}

/// Map a join error to a `500` body (same idiom as the books/chapters
/// handlers).
fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::db::{test_utils::StubDb, Db};
    use crate::http::router;
    use crate::http::test_support::app_state_with_data_dir;

    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, HeaderMap, StatusCode};
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    /// The curated voice the synth test requests; pre-seeding the cache makes
    /// `resolve_voice` a cache hit (no network).
    const TEST_VOICE: &str = "en_US-hfc_female-medium";

    const BOOK_TEXT_ONLY_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-text-only.taletrek");
    const BOOK_FULL_FIX: &[u8] =
        include_bytes!("../../../crates/synth/tests/fixtures/book-full.taletrek");

    /// The planted payload for the opus happy path — must start with the Ogg
    /// magic the acceptance criteria pin (`OggS`).
    const OGGS_BYTES: &[u8] = b"OggS-fake-paragraph-opus-bytes";

    // ---- shared helpers (mirroring chapters.rs / jobs.rs test patterns) ----

    fn seed_voice(cache_dir: &Path, id: &str) {
        std::fs::create_dir_all(cache_dir).expect("create voice cache dir");
        std::fs::write(cache_dir.join(format!("{id}.onnx")), b"stub-model-bytes")
            .expect("seed onnx");
        std::fs::write(cache_dir.join(format!("{id}.json")), b"{}").expect("seed json");
    }

    /// A fresh router backed by an empty [`StubDb`] + a real tempdir `data_dir`
    /// (which also hosts the voices cache for the stub-synth test).
    fn audio_router() -> (axum::Router, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        seed_voice(&tmp.path().join("voices"), TEST_VOICE);
        let db: Arc<dyn Db> = Arc::new(StubDb::new());
        let r = router(app_state_with_data_dir(
            db,
            tmp.path().to_path_buf(),
            "sekrit",
        ));
        (r, tmp)
    }

    /// `POST /api/books` with the bearer token + `bytes` as the `bundle`
    /// field; returns the uploaded book's id.
    async fn upload(router: axum::Router, bytes: &[u8]) -> String {
        let boundary = "TESTBOUNDARY";
        let mut body = Vec::with_capacity(bytes.len() + 256);
        body.extend_from_slice(b"--TESTBOUNDARY\r\n");
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"bundle\"; filename=\"b.taletrek\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: application/zip\r\n\r\n");
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--TESTBOUNDARY--\r\n");
        let req = Request::builder()
            .method("POST")
            .uri("/api/books")
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::CREATED);
        let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&b).expect("json");
        json.as_array().expect("array").first().expect("one book")["id"]
            .as_str()
            .expect("string")
            .to_string()
    }

    /// Authed `GET /api/books/{id}/audio/{key}` returning status + headers +
    /// body bytes.
    async fn get_audio(
        router: axum::Router,
        id: &str,
        key: &str,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let req = Request::builder()
            .method("GET")
            .uri(format!("/api/books/{id}/audio/{key}"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes")
            .to_vec();
        (status, headers, bytes)
    }

    /// Authed JSON GET returning `(status, json)` (plain-text error bodies
    /// wrapped as JSON strings, as in jobs.rs).
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
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            serde_json::Value::String(String::from_utf8_lossy(&bytes).into_owned())
        });
        (status, json)
    }

    /// Poll `GET /api/jobs/{id}` until terminal (jobs.rs pattern).
    async fn poll_until_terminal(
        router: axum::Router,
        job_id: &str,
        timeout: Duration,
    ) -> serde_json::Value {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let (_, json) = get_json(router.clone(), &format!("/api/jobs/{job_id}")).await;
            match json["status"].as_str() {
                Some("succeeded") | Some("failed") => return json,
                _ => {}
            }
            if std::time::Instant::now() > deadline {
                panic!("job {job_id} not terminal within {timeout:?}: {json}");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The full fixture with every segment's bytes replaced by the planted
    /// `OggS` payload, re-serialized. Keys (colons and all) are kept verbatim.
    fn full_bundle_with_oggs_bytes() -> (Vec<u8>, Vec<String>) {
        let mut bundle = taletrek_synth::read_book_bundle(BOOK_FULL_FIX).expect("fixture parses");
        let mut keys: Vec<String> = bundle.audio.keys().cloned().collect();
        keys.sort();
        for seg in bundle.audio.values_mut() {
            seg.bytes = OGGS_BYTES.to_vec();
        }
        let mut buf = Cursor::new(Vec::new());
        taletrek_synth::write_book_bundle(&bundle, &mut buf).expect("serialize");
        (buf.into_inner(), keys)
    }

    // ---- happy path: known key → planted bytes + audio/ogg + nosniff ----

    #[tokio::test]
    async fn known_key_serves_opus_bytes_with_audio_ogg() {
        let (router, _tmp) = audio_router();
        let (bytes, keys) = full_bundle_with_oggs_bytes();
        let id = upload(router.clone(), &bytes).await;

        // Raw colons in the key must survive path-param capture verbatim.
        let (status, headers, body) = get_audio(router, &id, &keys[0]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("audio/ogg")
        );
        assert_eq!(
            headers
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|v| v.to_str().ok()),
            Some("nosniff")
        );
        assert!(body.starts_with(b"OggS"), "Ogg magic: {body:?}");
        assert_eq!(body, OGGS_BYTES);
    }

    // ---- happy path through the stub synth loop (jobs.rs pattern) ----

    #[tokio::test(flavor = "multi_thread")]
    async fn synthesized_book_serves_stub_encoder_audio() {
        let (router, _tmp) = audio_router();
        let id = upload(router.clone(), BOOK_TEXT_ONLY_FIX).await;

        // Trigger synth on the seeded voice (stub runner + WavPassthrough).
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/books/{id}/synth"))
            .header(header::AUTHORIZATION, "Bearer sekrit")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "voice": TEST_VOICE }).to_string(),
            ))
            .expect("valid request");
        let resp = router.clone().oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::ACCEPTED);
        let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let job_id = serde_json::from_slice::<serde_json::Value>(&b).expect("json")["jobId"]
            .as_str()
            .expect("jobId")
            .to_string();
        let job = poll_until_terminal(router.clone(), &job_id, Duration::from_secs(10)).await;
        assert_eq!(job["status"].as_str(), Some("succeeded"), "job: {job}");

        // The stub encoder produces WAV segments — the endpoint must resolve
        // the manifest codec (.wav) and serve them as audio/wav.
        let key = taletrek_synth::cache_key(TEST_VOICE, "Hello world.");
        let (status, headers, body) = get_audio(router, &id, &key).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("audio/wav")
        );
        assert!(body.starts_with(b"RIFF"), "RIFF magic: {body:?}");
    }

    // ---- error paths ----

    #[tokio::test]
    async fn known_book_missing_key_is_404() {
        let (router, _tmp) = audio_router();
        let (bytes, _) = full_bundle_with_oggs_bytes();
        let id = upload(router.clone(), &bytes).await;
        // Well-formed key shape that no bundle carries.
        let absent = format!("{}:2:{}", "no-such-voice", "ab".repeat(32));
        let (status, _, _) = get_audio(router, &id, &absent).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_book_is_404() {
        let (router, _tmp) = audio_router();
        let (status, _, _) = get_audio(router, "definitely-absent", "v:2:ab").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn traversal_shaped_keys_are_400() {
        let (router, _tmp) = audio_router();
        let (bytes, _) = full_bundle_with_oggs_bytes();
        let id = upload(router.clone(), &bytes).await;
        // `%2F` decodes into the key after routing → caught by validation.
        // `..` substring and NUL likewise. None may touch the zip.
        for bad in ["..%2Fevil", "x..y", "a%00b"] {
            let (status, _, _) = get_audio(router.clone(), &id, bad).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "key {bad}");
        }
    }

    #[tokio::test]
    async fn audio_requires_auth() {
        let (router, _tmp) = audio_router();
        let req = Request::builder()
            .method("GET")
            .uri("/api/books/any/audio/v:2:ab")
            .body(Body::empty())
            .expect("valid request");
        let resp = router.oneshot(req).await.expect("router serves");
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
