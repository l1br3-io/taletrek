//! Peak-memory proof of the streaming convert path (`streaming-synth`, spec
//! success criterion 1): a full `PipelineJob` run over a synthetic
//! 10,000-paragraph book with ~64 KiB incompressible segments keeps peak
//! **live heap** allocations under 128 MiB — where the pre-streaming
//! (accumulating) path would have held every segment in memory at once
//! (≥ 640 MB of audio before the serialized-ZIP copies). This is the
//! regression guard that keeps every future convert path bounded: if someone
//! reintroduces accumulation on the synth/write path, the ceiling fails
//! loudly here, not as an OOM kill on a phone.
//!
//! The allocator hook itself lives in the `taletrek-memtrack` leaf crate (the
//! workspace's only `unsafe_code` allowance — a `GlobalAlloc` impl cannot
//! exist without it; the hooks are allocation-free: atomics + the `System`
//! backstop). This binary is its own integration test target so the global
//! allocator is installed without contention from other suites.
//!
//! Disk budget: the produced bundle is ~700 MB of pseudo-random (incompressible
//! — deflate cannot dishonestly shrink it) WAV payload in a temp dir; runtime
//! is dominated by deflating it (~tens of seconds). It stays a normal,
//! non-ignored test: this bound gates CI.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use taletrek_memtrack::{live_bytes, peak_bytes, PeakTrackingAlloc};
use taletrek_synth::cache_key;
use taletrek_worker::{
    PipelineJob, PipelineSpec, PipelineVariant, ResolveOpts, RunnerFactory, VoiceSource,
};

#[global_allocator]
static GLOBAL_ALLOC: PeakTrackingAlloc = PeakTrackingAlloc;

/// Ceiling on peak live heap during the whole test binary: 128 MiB
/// (spec-locked; ≥5× headroom over the ~few-MiB working set, far under
/// Android's ~512 MB large heap). The naive accumulating path would need
/// ≥ 640 MB just for the audio map — the assertion separates cleanly.
const PEAK_CEILING_BYTES: u64 = 128 * 1024 * 1024;

/// Liveness floor: the watermark must have genuinely tracked allocations
/// (a no-op hook would report ~0). The harness + fixture alone allocate
/// megabytes, so this floor proves the hook without coupling to exact noise.
const PEAK_FLOOR_BYTES: u64 = 1024 * 1024;

/// Paragraph count: the "big novel ×10" scale from the spec's user story.
const PARAGRAPHS: usize = 10_000;

/// Audio payload per paragraph (~64 KiB). `PARAGRAPHS × (44 + 64 KiB)` ≈
/// 640 MB of audio — far past the ceiling if anything accumulates it.
const PCM_BYTES: usize = 64 * 1024;

/// FNV-1a: deterministic per-paragraph PRNG seed (payload reproducibility for
/// the spot-checks — the runner only sees the text, so the payload must be
/// derivable from it).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// Canonical mono 16-bit 16 kHz WAV header + `pcm` payload.
fn canonical_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap();
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&16_000u32.to_le_bytes());
    out.extend_from_slice(&32_000u32.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// The incompressible ~64 KiB payload for `text`: xorshift stream seeded by
/// the text's FNV hash. Pseudo-random so the zip deflate path does honest
/// work (no fake shrink), deterministic so spot-checks can rebuild it.
fn payload_for(text: &str) -> Vec<u8> {
    let mut state = fnv1a(text.as_bytes()) | 1;
    let mut pcm = vec![0u8; PCM_BYTES];
    for b in &mut pcm {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *b = (state >> 33) as u8;
    }
    pcm
}

/// Stub engine runner: canonical WAV of the per-text pseudo-random payload.
struct StubRunner;

impl taletrek_synth::PiperRunner for StubRunner {
    fn predict(
        &mut self,
        _voice_model: &Path,
        text: &str,
    ) -> Result<Vec<u8>, taletrek_synth::SynthError> {
        Ok(canonical_wav(&payload_for(text)))
    }
}

/// Offline voice source (mirror of the pipeline tests' stub): serves URLs as
/// their own bytes, `.onnx` padded to the catalog size band.
#[derive(Default)]
struct StubSource {
    #[allow(dead_code)] // recorded for parity with the pipeline stubs
    calls: Mutex<Vec<String>>,
}

impl VoiceSource for StubSource {
    fn fetch_with_progress(
        &self,
        url: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        self.calls.lock().unwrap().push(url.to_string());
        let mut body = url.as_bytes().to_vec();
        if let Some(id) = url.rsplit('/').next().unwrap_or("").strip_suffix(".onnx") {
            if let Some(v) = taletrek_worker::find_curated(id) {
                body.resize(v.size_bytes as usize, 0);
            }
        }
        progress(body.len() as u64, body.len() as u64);
        Ok(body)
    }
}

/// Distinct paragraph `i` (dedup must not collapse any of them).
fn paragraph(i: usize) -> String {
    format!("paragraph {i:05}: the quick brown fox jumps over the lazy dog {i}")
}

#[test]
fn full_convert_peak_memory_stays_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let espeak_root = dir.path().join("espeak");
    // Pre-seed the marker so the run stays offline (espeak ensure is covered
    // by the pipeline suite; this test measures the synth/write memory).
    fs::create_dir_all(espeak_root.join("espeak-ng-data")).unwrap();
    fs::write(espeak_root.join("espeak-ng-data/en_dict"), b"marker").unwrap();

    let source = format!(
        "chapter one\n\n{}",
        (0..PARAGRAPHS)
            .map(paragraph)
            .collect::<Vec<_>>()
            .join("\n\n")
    );

    let factory: RunnerFactory = Arc::new(|| Box::new(StubRunner) as _);

    let spec = PipelineSpec {
        source: source.into_bytes(),
        hint: Some("big-book.txt".to_string()),
        variant: PipelineVariant::Full { voice_id: None },
        generator_app: "taletrek-peak-memory-test".to_string(),
        jobs: 2,
        resolve: ResolveOpts::new(None, dir.path().join("voices")),
        espeak_root,
        books_dir: dir.path().to_path_buf(),
        make_runner: factory,
        encoder: Arc::new(taletrek_synth::WavPassthrough),
        initial_anchor: None,
    };

    let outcome = PipelineJob::new(spec)
        .run(&StubSource::default(), None)
        .expect("10k-paragraph full convert completes");

    // The bundle validates: metadata first (never the whole audio map — that
    // read would itself blow the ceiling), then per-segment spot-checks
    // through the reader's single-entry path.
    assert_eq!(outcome.segments, PARAGRAPHS);
    assert!(!outcome.text_only);
    assert_eq!(outcome.paragraphs, PARAGRAPHS);

    let (manifest, chapters) = taletrek_synth::read_book_metadata(&outcome.bundle_path).unwrap();
    assert!(manifest.audio.present);
    assert_eq!(manifest.audio.segment_count as usize, PARAGRAPHS);
    assert_eq!(manifest.audio.codec, taletrek_synth::AudioCodec::Wav);
    assert_eq!(chapters.len(), 1);
    assert_eq!(chapters[0].paragraphs.len(), PARAGRAPHS);

    let voice = taletrek_worker::DEFAULT_VOICE_ID;
    for i in [0, PARAGRAPHS / 2, PARAGRAPHS - 1] {
        let text = paragraph(i);
        let key = cache_key(voice, &text);
        let seg = taletrek_synth::read_audio_segment(&outcome.bundle_path, &key)
            .expect("spot-check read")
            .expect("segment present");
        assert_eq!(seg.bytes, canonical_wav(&payload_for(&text)), "segment {i}");
    }

    // The bound itself, with liveness: the watermark moved (the hook is
    // real) and stayed far under the ceiling (nothing accumulated).
    let peak = peak_bytes();
    let live_now = live_bytes();
    println!(
        "peak live heap: {:.1} MiB (ceiling {} MiB, floor {} MiB); live at assert: {:.1} MiB",
        peak as f64 / (1024.0 * 1024.0),
        PEAK_CEILING_BYTES / (1024 * 1024),
        PEAK_FLOOR_BYTES / (1024 * 1024),
        live_now as f64 / (1024.0 * 1024.0),
    );
    assert!(
        peak > PEAK_FLOOR_BYTES,
        "watermark never moved — the allocator hook is a no-op (peak {peak})"
    );
    assert!(
        peak < PEAK_CEILING_BYTES,
        "peak live heap {peak} bytes ({:.1} MiB) exceeded the {} MiB ceiling — something accumulated",
        peak as f64 / (1024.0 * 1024.0),
        PEAK_CEILING_BYTES / (1024 * 1024),
    );
}
