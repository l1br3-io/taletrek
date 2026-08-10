//! Unauthenticated liveness probe.

/// `GET /api/health` → `200 "ok"` (plain text).
///
/// Unauthenticated by design: docker and load-balancer health checks must not
/// need the bearer token. Every other route is auth-gated in T7.
pub async fn health() -> &'static str {
    "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_returns_ok_plain_text() {
        assert_eq!(health().await, "ok");
    }
}
