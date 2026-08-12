//! End-to-end integration for `taletrek-server`: spins the **real built binary**
//! as a subprocess on an ephemeral port and drives the full library loop over
//! HTTP — upload a text-only `.taletrek` fixture → `POST synth` → poll the job
//! to `succeeded` → download the full bundle, then assert `manifest.audio.present`
//! is true, every segment is real OGG/Opus (`OggS` magic), and the
//! `taletrek-server` provenance stamp is set.
//!
//! This is the server analogue of desktop's `tests/synth_e2e.rs`. Both tests
//! are `#[ignore]`d and gated identically — they soft-skip (print `skipped: …`
//! and return) unless ALL of:
//! - `piper` resolves on `PATH` (or via `TALETREK_PIPER_BIN`), and
//! - `ffmpeg` resolves on `PATH` (or via `TALETREK_FFMPEG_BIN`), and
//! - `TALETREK_VOICE_PATH` points at a `.onnx` whose sibling `<stem>.json`
//!   exists (the offline escape hatch — point it at any curated voice you've
//!   pre-downloaded, e.g. `~/.cache/taletrek/voices/en_US-hfc_female-medium.onnx`).
//!
//! Run with: `cargo test -p taletrek-server --test server_e2e -- --ignored`
//! after exporting those three env vars. The HTTP-handler + synth-runner unit
//! tests in `src/` cover the full wiring with stub runners; this file proves
//! the real server binary, invoked as a subprocess with real `piper` + real
//! `ffmpeg`, produces a bundle whose Opus audio is valid.
//!
//! See `docs/specs/personal-server/runbook.md` for the human smoke test
//! (the SPA audio-plays check that no test can assert — the Tier-3 sign-off).

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Absolute path to the `taletrek-server` binary under test. Cargo sets this at
/// compile time when building integration tests for a `[[bin]]` crate.
const BIN: &str = env!("CARGO_BIN_EXE_taletrek-server");

/// Bearer token both sides of the subprocess boundary agree on.
const TOKEN: &str = "e2e-secret";

/// OGG container magic — every Opus segment `ffmpeg -c:a libopus` emits starts
/// with these four bytes. Stronger than "non-empty": it proves real ffmpeg ran.
const OGG_MAGIC: &[u8] = b"OggS";

/// The committed text-only fixture (two chapters, no audio). Baked into the
/// test via `include_bytes!`, so the runbook's hand-uploaded file isn't needed.
/// Path is relative to `server/tests/` (two `..` reach the repo root).
const TEXT_ONLY_FIXTURE: &[u8] =
    include_bytes!("../../crates/synth/tests/fixtures/book-text-only.taletrek");

/// The committed full fixture (already carries audio under its fixture voice) —
/// the starting point for the resynth test.
const FULL_FIXTURE: &[u8] = include_bytes!("../../crates/synth/tests/fixtures/book-full.taletrek");

// ===== gate (mirrors desktop's tests/synth_e2e.rs) =====

/// Resolve a binary path: `TALETREK_<NAME>_BIN` env override, else `name` on
/// `PATH`. Returns the string the subprocess receives via `TALETREK_PIPER` /
/// `TALETREK_FFMPEG`.
fn resolve_bin(env_var: &str, default: &str) -> String {
    std::env::var(env_var).unwrap_or_else(|_| default.to_string())
}

/// Probe whether a binary exists + runs by invoking `<bin> --help` (piper) or
/// `<bin> -version` (ffmpeg). Returns `Some(bin)` if it runs, `None` otherwise.
fn binary_runs(bin: &str, probe_args: &[&str]) -> Option<String> {
    Command::new(bin)
        .args(probe_args)
        .output()
        .ok()
        .filter(|o| o.status.success() || !o.stderr.is_empty())
        .map(|_| bin.to_string())
}

/// The shared gate: soft-skip unless piper, ffmpeg, and a voice model are all
/// available. Prints a `skipped:` line per missing prerequisite so the reason
/// is visible under `--nocapture`. Returns `(piper, ffmpeg, voice_model)`.
fn gate() -> Option<(String, String, PathBuf)> {
    let piper = resolve_bin("TALETREK_PIPER_BIN", "piper");
    let piper = binary_runs(&piper, &["--help"]).or_else(|| {
        eprintln!("skipped: `{piper}` binary not found (set TALETREK_PIPER_BIN or add to PATH)");
        None
    })?;

    let ffmpeg = resolve_bin("TALETREK_FFMPEG_BIN", "ffmpeg");
    let ffmpeg = binary_runs(&ffmpeg, &["-version"]).or_else(|| {
        eprintln!("skipped: `{ffmpeg}` binary not found (set TALETREK_FFMPEG_BIN or add to PATH)");
        None
    })?;

    let voice_model = match std::env::var_os("TALETREK_VOICE_PATH") {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!(
                "skipped: TALETREK_VOICE_PATH not set (point it at a Piper .onnx with a sibling .json)"
            );
            return None;
        }
    };
    if !voice_model.is_file() {
        eprintln!(
            "skipped: TALETREK_VOICE_PATH `{}` does not exist",
            voice_model.display()
        );
        return None;
    }
    let json_sibling = voice_model.with_extension("json");
    if !json_sibling.is_file() {
        eprintln!(
            "skipped: TALETREK_VOICE_PATH `{}` has no sibling `{}`",
            voice_model.display(),
            json_sibling.display()
        );
        return None;
    }
    Some((piper, ffmpeg, voice_model))
}

// ===== subprocess server =====

/// RAII guard that kills + reaps the server subprocess on drop, so a failing
/// assertion never leaks a bound port.
struct ServerGuard {
    child: Child,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Claim an ephemeral port by binding `127.0.0.1:0`, reading the assigned port,
/// and dropping the listener. There is a small TIME_WAIT race (another process
/// could grab the port before the server rebinds); acceptable for an
/// `#[ignore]`d, human-run test.
fn ephemeral_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local addr").port()
}

/// Spawn the server binary on an ephemeral port with an isolated tempdir data
/// dir + the gate-resolved `piper`/`ffmpeg`. Returns the guard + the base URL.
/// Server logs stream to stderr (visible under `--nocapture`).
fn spawn_server(
    data_dir: &Path,
    voices_cache: &Path,
    piper: &str,
    ffmpeg: &str,
) -> (ServerGuard, String) {
    let port = ephemeral_port();
    let child = Command::new(BIN)
        .env("TALETREK_TOKEN", TOKEN)
        .env("TALETREK_BIND", format!("127.0.0.1:{port}"))
        .env("TALETREK_DATA_DIR", data_dir)
        .env("TALETREK_VOICES_CACHE_DIR", voices_cache)
        .env("TALETREK_PIPER", piper)
        .env("TALETREK_FFMPEG", ffmpeg)
        .env("RUST_LOG", "info")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn `{BIN}`: {e}"));
    let base = format!("http://127.0.0.1:{port}");
    (ServerGuard { child }, base)
}

/// Poll `GET /api/health` until it answers `ok` (the only unauthed route), or
/// panic after `timeout`. The server boots fast; 15 s is generous headroom.
fn wait_until_ready(base: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(resp) = ureq::get(&format!("{base}/api/health")).call() {
            if resp.status().as_u16() == 200 {
                return;
            }
        }
        if Instant::now() > deadline {
            panic!("server at {base} did not reach /api/health within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ===== HTTP helpers (ureq, blocking) =====

/// Read a ureq response body fully into a `Vec<u8>` via the streaming reader
/// (the same `into_reader` path `crates/worker::voices` uses — proven against
/// ureq 3.x).
fn body_bytes(resp: ureq::http::Response<ureq::Body>) -> Vec<u8> {
    let mut reader = resp.into_body().into_reader();
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .unwrap_or_else(|e| panic!("reading response body: {e}"));
    buf
}

/// A bearer-authed multipart body carrying one field named `bundle`.
fn multipart_bundle_body(boundary: &str, bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(b"--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"bundle\"; filename=\"bundle.taletrek\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/zip\r\n\r\n");
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--");
    body.extend_from_slice(boundary.as_bytes());
    body.extend_from_slice(b"--\r\n");
    body
}

/// `POST /api/books` (multipart) → `(status, body)`.
fn upload_book(base: &str, bytes: &[u8]) -> (u16, Vec<u8>) {
    let boundary = "E2EBOUNDARY";
    let body = multipart_bundle_body(boundary, bytes);
    let resp = ureq::post(&format!("{base}/api/books"))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .content_type(format!("multipart/form-data; boundary={boundary}"))
        .send(&body)
        .unwrap_or_else(|e| panic!("upload request failed: {e}"));
    (resp.status().as_u16(), body_bytes(resp))
}

/// `POST /api/books/{id}/synth` (or `/resynth`) with a JSON body → `(status, body)`.
fn post_json(base: &str, path: &str, json_body: &str) -> (u16, Vec<u8>) {
    let resp = ureq::post(&format!("{base}{path}"))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .content_type("application/json")
        .send(json_body)
        .unwrap_or_else(|e| panic!("POST {path} failed: {e}"));
    (resp.status().as_u16(), body_bytes(resp))
}

/// Authed `GET` → `(status, body bytes)`.
fn get(base: &str, path: &str) -> (u16, Vec<u8>) {
    let resp = ureq::get(&format!("{base}{path}"))
        .header("Authorization", format!("Bearer {TOKEN}"))
        .call()
        .unwrap_or_else(|e| panic!("GET {path} failed: {e}"));
    (resp.status().as_u16(), body_bytes(resp))
}

/// Parse a JSON body to a `serde_json::Value` (panics with context on failure).
fn parse_json(bytes: &[u8]) -> serde_json::Value {
    serde_json::from_slice(bytes).unwrap_or_else(|e| {
        panic!(
            "invalid JSON body: {e}; body=`{}`",
            String::from_utf8_lossy(bytes)
        )
    })
}

/// Poll `GET /api/jobs/{id}` until `status` is terminal (`succeeded`/`failed`),
/// returning the final job JSON. Panics after `timeout`.
fn poll_until_terminal(base: &str, job_id: &str, timeout: Duration) -> serde_json::Value {
    let deadline = Instant::now() + timeout;
    loop {
        let (status, body) = get(base, &format!("/api/jobs/{job_id}"));
        if status == 200 {
            let job = parse_json(&body);
            if matches!(job["status"].as_str(), Some("succeeded") | Some("failed")) {
                return job;
            }
        }
        if Instant::now() > deadline {
            panic!(
                "job {job_id} did not reach terminal status within {timeout:?}; last body=`{}`",
                String::from_utf8_lossy(&body)
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ===== the tests =====

/// End-to-end: upload a text-only fixture → synth → poll succeeded → download →
/// the full bundle carries `audio.present` + the `taletrek-server` stamp + every
/// segment is real OGG/Opus.
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/personal-server/runbook.md"]
fn real_synth_produces_full_opus_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let data_dir = tempfile::tempdir().expect("data tempdir");
    let voices = tempfile::tempdir().expect("voices tempdir");

    let (_guard, base) = spawn_server(data_dir.path(), voices.path(), &piper, &ffmpeg);
    wait_until_ready(&base, Duration::from_secs(15));

    // (a) Upload the text-only fixture.
    let (status, body) = upload_book(&base, TEXT_ONLY_FIXTURE);
    assert_eq!(
        status,
        201,
        "upload status (body=`{}`)",
        String::from_utf8_lossy(&body)
    );
    let uploaded = parse_json(&body);
    let book = uploaded
        .as_array()
        .and_then(|a| a.first())
        .expect("upload response is a non-empty array of ingested books");
    let book_id = book["id"]
        .as_str()
        .expect("upload response carries the book id")
        .to_string();
    assert_eq!(
        book["audioPresent"].as_bool(),
        Some(false),
        "text-only fixture ingested without audio"
    );

    // (b) Trigger synth with voicePath (offline model — skips catalog + network).
    let synth_body = serde_json::json!({
        "voicePath": voice_model,
    })
    .to_string();
    let (status, body) = post_json(&base, &format!("/api/books/{book_id}/synth"), &synth_body);
    assert_eq!(
        status,
        202,
        "synth accepted (body=`{}`)",
        String::from_utf8_lossy(&body)
    );
    let job_id = parse_json(&body)["jobId"]
        .as_str()
        .expect("202 carries jobId")
        .to_string();

    // (c) Poll to terminal. Real piper + ffmpeg on three paragraphs is quick;
    //     120 s is generous headroom for a cold model load on a slow machine.
    let job = poll_until_terminal(&base, &job_id, Duration::from_secs(120));
    assert_eq!(
        job["status"].as_str(),
        Some("succeeded"),
        "synth should succeed; got: {job}"
    );

    // (d) Download + parse the produced bundle.
    let (status, bundle_bytes) = get(&base, &format!("/api/books/{book_id}/bundle"));
    assert_eq!(status, 200, "download status");
    let bundle = taletrek_synth::read_book_bundle(&bundle_bytes).expect("parses as a book bundle");

    // (e) Assert the manifest + real Opus segments.
    assert!(bundle.manifest.audio.present, "audio.present must be true");
    assert_eq!(
        bundle.manifest.audio.codec,
        taletrek_synth::AudioCodec::Opus
    );
    assert_eq!(
        bundle.manifest.generator.app, "taletrek-server",
        "provenance stamp — the server is the producer"
    );
    assert!(!bundle.audio.is_empty(), "audio map populated");
    for (key, seg) in &bundle.audio {
        assert_eq!(seg.codec, taletrek_synth::AudioCodec::Opus);
        assert!(
            seg.bytes.starts_with(OGG_MAGIC),
            "segment `{key}` must start with OGG magic `OggS`; got first 4 bytes {:?}",
            &seg.bytes[..seg.bytes.len().min(4)]
        );
    }
}

/// End-to-end: a full book (already has audio) is re-voiced via `POST resynth`
/// under a different voice id (same `voicePath` model) → the manifest's
/// `book.voiceId` flips + every segment is still real OGG/Opus under the new key.
#[test]
#[ignore = "requires piper + ffmpeg on PATH and TALETREK_VOICE_PATH; see docs/specs/personal-server/runbook.md"]
fn real_resynth_revoices_full_bundle() {
    let Some((piper, ffmpeg, voice_model)) = gate() else {
        return;
    };
    let data_dir = tempfile::tempdir().expect("data tempdir");
    let voices = tempfile::tempdir().expect("voices tempdir");

    let (_guard, base) = spawn_server(data_dir.path(), voices.path(), &piper, &ffmpeg);
    wait_until_ready(&base, Duration::from_secs(15));

    // Upload a FULL bundle (already carries audio under its fixture voice).
    let (status, body) = upload_book(&base, FULL_FIXTURE);
    assert_eq!(
        status,
        201,
        "upload status (body=`{}`)",
        String::from_utf8_lossy(&body)
    );
    let uploaded = parse_json(&body);
    let book = uploaded
        .as_array()
        .and_then(|a| a.first())
        .expect("upload response is a non-empty array of ingested books");
    let book_id = book["id"]
        .as_str()
        .expect("upload response carries the book id")
        .to_string();

    // Resynth under a different voice id (same physical model — only the stamp
    // + segment keys change, exactly like desktop's resynth e2e).
    let new_voice = "en_US-ryan-medium";
    let resynth_body = serde_json::json!({
        "voice": new_voice,
        "voicePath": voice_model,
    })
    .to_string();
    let (status, body) = post_json(
        &base,
        &format!("/api/books/{book_id}/resynth"),
        &resynth_body,
    );
    assert_eq!(
        status,
        202,
        "resynth accepted (body=`{}`)",
        String::from_utf8_lossy(&body)
    );
    let job_id = parse_json(&body)["jobId"]
        .as_str()
        .expect("202 carries jobId")
        .to_string();

    let job = poll_until_terminal(&base, &job_id, Duration::from_secs(120));
    assert_eq!(
        job["status"].as_str(),
        Some("succeeded"),
        "resynth should succeed; got: {job}"
    );
    assert_eq!(job["kind"].as_str(), Some("resynth"));

    // Download + assert the manifest moved to the new voice.
    let (status, bundle_bytes) = get(&base, &format!("/api/books/{book_id}/bundle"));
    assert_eq!(status, 200);
    let bundle = taletrek_synth::read_book_bundle(&bundle_bytes).expect("parses as a book bundle");
    assert_eq!(bundle.manifest.book.voice_id, new_voice);
    assert!(bundle.manifest.audio.present);
    assert!(!bundle.audio.is_empty());
    for (key, seg) in &bundle.audio {
        assert_eq!(seg.codec, taletrek_synth::AudioCodec::Opus);
        assert!(
            seg.bytes.starts_with(OGG_MAGIC),
            "resynth segment `{key}` must start with OGG magic `OggS`"
        );
    }
}
