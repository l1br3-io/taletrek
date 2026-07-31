//! Audio codec + segment model.

use serde::{Deserialize, Serialize};

/// Container/codec for a synthesized audio segment. Stored lowercase in the
/// manifest (`"opus"` / `"m4a"` / `"wav"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    /// Opus — v1 default (best size/quality for speech).
    Opus,
    /// AAC in M4A — iOS-native.
    M4a,
    /// Uncompressed WAV — permitted, discouraged (huge).
    Wav,
}

impl AudioCodec {
    /// File extension used inside the bundle's `audio/` directory.
    #[must_use]
    pub const fn ext(self) -> &'static str {
        match self {
            AudioCodec::Opus => "opus",
            AudioCodec::M4a => "m4a",
            AudioCodec::Wav => "wav",
        }
    }

    /// Parse a codec from a file extension (`"opus"` / `"m4a"` / `"wav"`).
    ///
    /// Returns `None` for an unknown extension rather than erroring, so unknown
    /// audio entries are skipped on import instead of aborting the whole bundle.
    #[must_use]
    pub fn from_ext(ext: &str) -> Option<AudioCodec> {
        match ext {
            "opus" => Some(AudioCodec::Opus),
            "m4a" => Some(AudioCodec::M4a),
            "wav" => Some(AudioCodec::Wav),
            _ => None,
        }
    }
}

/// One synthesized paragraph's audio. The `key` is the content-addressed cache
/// key (`${voice}:${NORM_VERSION}:${sha256}`); the file name inside the bundle
/// is `<key>.<codec ext>`.
#[derive(Debug, Clone)]
pub struct AudioSegment {
    /// Content-addressed cache key (see [`crate::cache_key`]).
    pub key: String,
    /// Codec of `bytes`.
    pub codec: AudioCodec,
    /// Encoded audio bytes.
    pub bytes: Vec<u8>,
}
