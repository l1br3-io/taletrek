//! Entry point for `taletrek-server`.
//!
//! Loads [`Settings`] from the env, ensures `data_dir` exists, opens + migrates
//! the SQLite db, builds the [`AppState`] (db + data_dir + settings), and serves
//! the axum router. The db is held by [`AppState`] from here on (T7+).

mod config;
mod db;
mod http;
mod store;

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

use crate::db::SqliteDb;
use crate::http::AppState;

/// Boot: init tracing → resolve config → ensure data dir → open db → serve.
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let settings = Arc::new(config::Settings::from_env()?);

    std::fs::create_dir_all(&settings.data_dir).with_context(|| {
        format!("creating data dir {}", settings.data_dir.display())
    })?;

    // Open + migrate the db on boot (T5). Held by AppState below so handlers
    // can reach it; WAL files are in place after open.
    let db_path = settings.data_dir.join("taletrek.db");
    let sqlite = SqliteDb::open(&db_path)
        .with_context(|| format!("opening db {}", db_path.display()))?;
    debug!(db = %db_path.display(), "sqlite migrated");

    let state = AppState {
        db: Arc::new(sqlite),
        data_dir: settings.data_dir.clone(),
        settings: settings.clone(),
    };
    let app = http::router(state);

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

    axum::serve(listener, app).await?;
    Ok(())
}
