//! Audio encoding behind a trait, so the host app picks the codec and tests
//! stub the encoder without touching native libs.
//!
//! v1 ships [`OpusEncoder`] (the format default, see `docs/bundle-format.md`)
//! which shells out to `ffmpeg -c:a libopus`. We use the ffmpeg subprocess
//! rather than a native Opus binding (`audiopus` / `opus` crate) because those
//! require `libopus` dev headers to link, and the supported build environment
//! (pinned toolchain 1.97) does not guarantee them. The trait means a native
//! encoder can replace this impl later without touching [`crate::synthesize_paragraph`].
//!
//! [`WavPassthrough`] is a no-op encoder for tests.

use std::io::Write;
use std::process::{Command, Stdio};

use crate::bundle::audio::AudioCodec;
use crate::synth::SynthError;

/// Encode PCM WAV bytes into a compressed audio format picked by the host.
pub trait Encoder {
    /// Encode `wav` (canonical PCM WAV bytes from Piper) into the target codec.
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError>;

    /// The codec this encoder produces.
    fn codec(&self) -> AudioCodec;
}

/// Opus encoder backed by the `ffmpeg` binary (`-c:a libopus`, OGG/Opus
/// container on stdout).
///
/// `bitrate_bps` defaults to 24 kbps — a sensible speech floor (Opus is
/// efficient at low rates; Piper output is mono 16 kHz). The container is
/// `.opus` (OGG) so the bytes play in browsers and the SPA's `<audio>` path.
pub struct OpusEncoder {
    bitrate_bps: u32,
    ffmpeg_bin: String,
}

impl OpusEncoder {
    /// Default speech bitrate: 24 kbps.
    pub const DEFAULT_BITRATE: u32 = 24_000;

    /// Create an encoder with the default bitrate and `ffmpeg` resolved from `PATH`.
    #[must_use]
    pub fn new() -> Self {
        Self::with_bitrate(Self::DEFAULT_BITRATE)
    }

    /// Create an encoder with a specific target bitrate (bits per second).
    #[must_use]
    pub fn with_bitrate(bitrate_bps: u32) -> Self {
        Self {
            bitrate_bps,
            ffmpeg_bin: String::from("ffmpeg"),
        }
    }

    /// Use an explicit path to the `ffmpeg` binary instead of `PATH` lookup.
    #[must_use]
    pub fn with_binary(mut self, bin: impl Into<String>) -> Self {
        self.ffmpeg_bin = bin.into();
        self
    }
}

impl Default for OpusEncoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Encoder for OpusEncoder {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        // Read WAV from stdin, write OGG/Opus to stdout. `-loglevel error`
        // keeps stderr focused on real failures.
        let mut child = Command::new(&self.ffmpeg_bin)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-i")
            .arg("pipe:0")
            .arg("-c:a")
            .arg("libopus")
            .arg("-b:a")
            .arg(self.bitrate_bps.to_string())
            .arg("-f")
            .arg("opus")
            .arg("pipe:1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SynthError::EncoderMissing {
                bin: self.ffmpeg_bin.clone(),
                source: e,
            })?;

        // Write the WAV to stdin in one go, then drop stdin to signal EOF so
        // ffmpeg flushes the OGG stream and exits.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(wav);
        }
        let output = child.wait_with_output().map_err(SynthError::EncoderIo)?;

        if !output.status.success() {
            return Err(SynthError::EncoderFailed {
                bin: self.ffmpeg_bin.clone(),
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        Ok(output.stdout)
    }

    fn codec(&self) -> AudioCodec {
        AudioCodec::Opus
    }
}

/// No-op encoder: returns the input WAV bytes unchanged and reports the WAV
/// codec. For unit tests that need to inspect the synthesized/concatenated WAV
/// without invoking a real encoder.
pub struct WavPassthrough;

impl Encoder for WavPassthrough {
    fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError> {
        Ok(wav.to_vec())
    }

    fn codec(&self) -> AudioCodec {
        AudioCodec::Wav
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_passthrough_returns_input_and_reports_wav() {
        let enc = WavPassthrough;
        let bytes = vec![1, 2, 3, 4];
        assert_eq!(enc.encode(&bytes).unwrap(), bytes);
        assert_eq!(enc.codec(), AudioCodec::Wav);
    }

    #[test]
    fn opus_encoder_reports_opus_without_running_ffmpeg() {
        let enc = OpusEncoder::new();
        assert_eq!(enc.codec(), AudioCodec::Opus);
    }

    #[test]
    fn opus_encoder_missing_binary_is_typed_error() {
        let enc = OpusEncoder::new().with_binary("/does/not/exist/ffmpeg");
        let err = enc.encode(b"").unwrap_err();
        assert!(
            matches!(err, SynthError::EncoderMissing { .. }),
            "got {err:?}"
        );
    }
}
