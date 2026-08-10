//! Entry point for `taletrek-server`.
//!
//! Loads [`Settings`] from the env, ensures `data_dir` exists, binds the axum
//! router, and serves. T4: `/api/health` is the only route; auth, db, store,
//! and synth land in T5+.

mod config;
mod http;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing::{debug, info};
use tracing_subscriber::EnvFilter;

/// Boot: init tracing → resolve config → ensure data dir → bind → serve.
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
