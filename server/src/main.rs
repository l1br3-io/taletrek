//! Entry point for `taletrek-server`.
//!
//! Loads [`Settings`] from the env, ensures `data_dir` exists, binds the axum
//! router, and serves. T5 opens the SQLite db on boot (migrations run here);
//! wiring it into axum handlers lands in T7+.

mod config;
mod db;
mod http;
mod store;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

use crate::db::SqliteDb;

/// Boot: init tracing → resolve config → ensure data dir → open db → bind → serve.
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let settings = config::Settings::from_env()?;

    std::fs::create_dir_all(&settings.data_dir).with_context(|| {
        format!("creating data dir {}", settings.data_dir.display())
    })?;

    // Open + migrate the db on boot (T5). Held by axum AppState from T7 on;
    // today we drop it — migrations already ran, WAL files are in place.
    let db_path = settings.data_dir.join("taletrek.db");
    let _db = SqliteDb::open(&db_path)
        .with_context(|| format!("opening db {}", db_path.display()))?;
    debug!(db = %db_path.display(), "sqlite migrated");

    let app = http::router();
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
