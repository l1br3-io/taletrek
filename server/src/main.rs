//! Entry point for `taletrek-server`.
//!
//! Loads [`Settings`] from the env, ensures `data_dir` exists, opens + migrates
//! the SQLite db, builds the [`AppState`] (db + data_dir + settings), and serves
//! the axum router. The db is held by [`AppState`] from here on (T7+).

mod config;
mod db;
mod http;
mod store;
mod synth;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing::{debug, info, warn};
use tracing_subscriber::EnvFilter;

use crate::db::{Db, SqliteDb};
use crate::http::AppState;
use crate::synth::SynthBackend;

/// Boot: init tracing → resolve config → ensure data dir → open db → serve.
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let settings = Arc::new(config::Settings::from_env()?);

    std::fs::create_dir_all(&settings.data_dir)
        .with_context(|| format!("creating data dir {}", settings.data_dir.display()))?;

    // Open + migrate the db on boot (T5). Held by AppState below so handlers
    // can reach it; WAL files are in place after open.
    let db_path = settings.data_dir.join("taletrek.db");
    let sqlite =
        SqliteDb::open(&db_path).with_context(|| format!("opening db {}", db_path.display()))?;
    debug!(db = %db_path.display(), "sqlite migrated");

    // Boot sweep: jobs left `queued`/`running` by a previous process are owned
    // by no one — mark them failed so `GET /api/jobs` can't report a phantom
    // running job forever.
    let swept = sqlite
        .fail_active_jobs("server restarted during job")
        .with_context(|| format!("sweeping orphaned jobs in {}", db_path.display()))?;
    if swept > 0 {
        warn!(
            swept,
            "marked orphaned jobs failed (left over from a restart)"
        );
    }

    let state = AppState {
        db: Arc::new(sqlite),
        data_dir: settings.data_dir.clone(),
        settings: settings.clone(),
        synth: Arc::new(SynthBackend::subprocess(
            settings.piper.clone(),
            settings.ffmpeg.clone(),
        )),
        in_flight: crate::synth::InFlightBooks::default(),
        login_limiter: crate::http::LoginLimiter::default(),
    };
    let app = http::router(state);

    // SPA availability probe (T8): a missing/empty static dir is not fatal —
    // the API + login page keep working headless — but `/` will 404, so
    // say so loudly instead of leaving a silent misconfiguration.
    if settings.static_dir.join("index.html").is_file() {
        info!(
            static_dir = %settings.static_dir.display(),
            "serving SPA at / (behind login)"
        );
    } else {
        warn!(
            static_dir = %settings.static_dir.display(),
            "TALETREK_STATIC_DIR has no index.html — SPA not served at / \
             (API + login page still available); point it at a built web/dist"
        );
    }

    let listener = TcpListener::bind(settings.bind)
        .await
        .with_context(|| format!("binding {}", settings.bind))?;

    info!(
        addr = %settings.bind,
        data_dir = %settings.data_dir.display(),
        voices_cache = %settings.voices_cache_dir.display(),
        jobs = settings.jobs,
        piper = %settings.piper,
        ffmpeg = %settings.ffmpeg,
        "taletrek-server listening"
    );
    // Reference the token without ever logging its value (ADR-0013).
    debug!(token_chars = settings.token.len(), "bearer auth configured");
    if settings.token.len() < crate::config::MIN_TOKEN_CHARS {
        warn!(
            len = settings.token.len(),
            min = crate::config::MIN_TOKEN_CHARS,
            "TALETREK_TOKEN is short; use a long random secret (e.g. `openssl rand -hex 32`)"
        );
    }

    // `into_make_service_with_connect_info` threads each connection's socket
    // addr into handlers — the login throttle keys on it. Without this the
    // extractor yields None and all attempts share one fallback bucket.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
