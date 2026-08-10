//! HTTP layer: router composition + handlers.
//!
//! T4 wires only the unauthenticated `GET /api/health` behind a
//! [`TraceLayer`]. Auth middleware, book CRUD, synth/job, voices, and UI routes
//! are layered on in T7+.
//!
//! [`TraceLayer`]: tower_http::trace::TraceLayer

mod health;

use axum::Router;
use axum::routing::get;
use tower_http::trace::TraceLayer;

/// Build the application router.
///
/// T4: `/api/health` only (+ `TraceLayer` for request/response tracing). Later
/// tasks add bearer-auth middleware around everything except health, plus the
/// book / job / voice / UI routes.
pub fn router() -> Router {
    Router::new()
        .route("/api/health", get(health::health))
        .layer(TraceLayer::new_for_http())
}
