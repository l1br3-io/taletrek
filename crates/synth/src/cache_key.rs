//! Content-addressed cache key — the parity-critical bridge between the SPA's
//! `audioCacheKey` and this crate.
//!
//! The key is `${voice_id}:${NORM_VERSION}:${sha256_hex(normalized_text)}`.
//! `normalized_text` is [`crate::normalize::normalize_for_speech`] applied to
//! the input, then UTF-8 encoded and SHA-256 hashed to lowercase hex. This
//! MUST match the SPA's `audioCacheKey` (`web/src/lib/audio-cache.ts`)
//! byte-for-byte so audio deduplicates across apps.

use sha2::{Digest, Sha256};

/// Normalization version tag embedded in the cache key. Bumped when
/// [`crate::normalize::normalize_for_speech`] changes. Mirrors the SPA's
/// `NORM_VERSION = '2'`.
pub const NORM_VERSION: &str = "2";

/// Build the content-addressed cache key for a synthesis request.
///
/// Equivalent to the SPA's `audioCacheKey(voiceId, text)`:
/// `normalize → sha256 → hex → "${voice}:${ver}:${hash}"`.
#[must_use]
pub fn cache_key(voice_id: &str, text: &str) -> String {
    let normalized = crate::normalize::normalize_for_speech(text);
    let hash = sha256_hex(normalized.as_bytes());
    format!("{voice_id}:{NORM_VERSION}:{hash}")
}

/// SHA-256 of a byte slice, lowercase hex-encoded. Mirrors the SPA's
/// `sha256Hex` (UTF-8 via `TextEncoder`, then hex).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_shape_is_voice_version_hash() {
        let key = cache_key("en_US-lessac-medium", "Hello world.");
        let parts: Vec<&str> = key.splitn(3, ':').collect();
        assert_eq!(parts[0], "en_US-lessac-medium");
        assert_eq!(parts[1], NORM_VERSION);
        assert_eq!(parts[2].len(), 64); // sha256 hex
    }

    #[test]
    fn normalization_changes_the_key() {
        // "O'Reilly" vs its curly form normalize to the same key.
        let straight = cache_key("v", "O'Reilly books");
        let curly = cache_key("v", "O\u{2019}Reilly books");
        assert_eq!(straight, curly);
    }

    #[test]
    fn voice_change_changes_the_key() {
        assert_ne!(
            cache_key("voiceA", "same text"),
            cache_key("voiceB", "same text")
        );
    }

    #[test]
    fn whitespace_only_diffs_collapse_to_same_key() {
        assert_eq!(
            cache_key("v", "too   much space"),
            cache_key("v", "too much space")
        );
    }
}
