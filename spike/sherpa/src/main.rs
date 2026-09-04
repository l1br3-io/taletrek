//! T1 spike — sherpa-onnx in-process TTS validation (throwaway; not in the workspace).
//!
//! Proves: crate links on Rust 1.97/Linux, a cached Piper voice (`.onnx` + `.onnx.json`
//! from `~/.cache/taletrek/voices/`) synthesizes to 22050 Hz WAV via the official
//! `sherpa-onnx` crate, with tokens.txt derived from the piper json. Measures
//! model-load time and RSS with 1 vs 2 loaded models (rayon per-thread cost model).
//!
//! Run: ./fetch-assets.sh && cargo run --release

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};

const PARAGRAPH: &str = "The quick brown fox jumps over the lazy dog. TaleTrek turns any \
    ebook into an audiobook, entirely on this machine, with no cloud and no accounts.";

fn voice_dir() -> PathBuf {
    let dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME")
        .join(".cache/taletrek/voices");
    assert!(dir.is_dir(), "voice cache missing: {}", dir.display());
    dir
}

fn assets_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets");
    assert!(
        dir.join("espeak-ng-data").is_dir(),
        "assets missing — run ./fetch-assets.sh"
    );
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Derive sherpa tokens.txt from the piper `.onnx.json` phoneme_id_map
/// (`<symbol> <first id>` per line — verified byte-identical to k2-fsa's tokens.txt).
fn derive_tokens(voice_id: &str, json: &serde_json::Value, out_dir: &Path) -> PathBuf {
    let map = json["phoneme_id_map"].as_object().expect("phoneme_id_map");
    let mut lines = Vec::new();
    for (sym, ids) in map {
        let id = ids[0].as_i64().expect("id");
        lines.push(format!("{sym} {id}"));
    }
    let path = out_dir.join(format!("tokens-{voice_id}.txt"));
    fs::write(&path, lines.join("\n") + "\n").unwrap();
    path
}

fn load_tts(voice_id: &str, cache: &Path, assets: &Path) -> OfflineTts {
    let json_path = cache.join(format!("{voice_id}.json"));
    let json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&json_path).unwrap()).unwrap();
    let infer = &json["inference"];
    // sherpa requires `sample_rate` ONNX metadata — present in k2-fsa mirrors, absent
    // from the diffusionStudio files our cache seeds. Prefer a stamped copy in assets/.
    let stamped = assets.join(format!("{voice_id}.onnx"));
    let model_path = if stamped.is_file() {
        stamped
    } else {
        cache.join(format!("{voice_id}.onnx"))
    };
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            vits: OfflineTtsVitsModelConfig {
                model: Some(model_path.to_string_lossy().into_owned()),
                tokens: Some(
                    derive_tokens(voice_id, &json, assets)
                        .to_string_lossy()
                        .into_owned(),
                ),
                data_dir: Some(assets.join("espeak-ng-data").to_string_lossy().into_owned()),
                noise_scale: infer["noise_scale"].as_f64().unwrap_or(0.667) as f32,
                noise_scale_w: infer["noise_w"].as_f64().unwrap_or(0.8) as f32,
                length_scale: infer["length_scale"].as_f64().unwrap_or(1.0) as f32,
                ..Default::default()
            },
            num_threads: 1, // one runner per rayon thread in production
            ..Default::default()
        },
        ..Default::default()
    };
    let t0 = Instant::now();
    let tts =
        OfflineTts::create(&config).unwrap_or_else(|| panic!("model load failed: {voice_id}"));
    println!("  load time: {:#?}", t0.elapsed());
    tts
}

fn synth_and_check(tts: &OfflineTts, voice_id: &str, out: &Path) {
    let t0 = Instant::now();
    let audio = tts
        .generate_with_config(
            PARAGRAPH,
            &GenerationConfig {
                speed: 1.0,
                sid: 0,
                ..Default::default()
            },
            None::<fn(&[f32], f32) -> bool>,
        )
        .unwrap_or_else(|| panic!("synth failed: {voice_id}"));
    let synth_time = t0.elapsed();
    let samples = audio.samples();
    let rate = audio.sample_rate();
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    assert_eq!(rate, 22050, "sample rate for {voice_id}");
    assert!(!samples.is_empty(), "empty audio for {voice_id}");
    assert!(peak > 0.01, "silent audio for {voice_id} (peak {peak})");
    audio
        .save(&out.to_string_lossy())
        .then_some(())
        .expect("wav write");
    check_wav_bytes(out);
    println!(
        "  synth: {synth_time:#?} -> {} samples ({:.1}s audio), peak {peak:.3}, wav {} bytes",
        samples.len(),
        samples.len() as f32 / rate as f32,
        fs::metadata(out).unwrap().len()
    );
}

/// Assert the WAV on disk: RIFF/WAVE headers, mono PCM16, 22050 Hz.
fn check_wav_bytes(path: &Path) {
    let b = fs::read(path).unwrap();
    assert_eq!(&b[0..4], b"RIFF");
    assert_eq!(&b[8..12], b"WAVE");
    assert_eq!(&b[12..16], b"fmt ");
    let fmt_audio_format = u16::from_le_bytes([b[20], b[21]]);
    let channels = u16::from_le_bytes([b[22], b[23]]);
    let rate = u32::from_le_bytes([b[24], b[25], b[26], b[27]]);
    let bits = u16::from_le_bytes([b[34], b[35]]);
    assert_eq!(fmt_audio_format, 1, "PCM");
    assert_eq!(channels, 1, "mono");
    assert_eq!(rate, 22050, "sample rate");
    assert_eq!(bits, 16, "PCM16");
}

/// RSS in MB from /proc/self/status (Linux-only spike).
fn rss_mb() -> f64 {
    let status = fs::read_to_string("/proc/self/status").unwrap();
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: f64 = rest.trim().trim_end_matches("kB").trim().parse().unwrap();
            return kb / 1024.0;
        }
    }
    panic!("no VmRSS");
}

fn main() {
    let cache = voice_dir();
    let assets = assets_dir();
    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out");
    fs::create_dir_all(&out_dir).unwrap();

    let rss0 = rss_mb();
    println!("== baseline RSS: {rss0:.1} MB");

    println!("== model 1: en_US-hfc_female-medium");
    let m1 = load_tts("en_US-hfc_female-medium", &cache, &assets);
    synth_and_check(
        &m1,
        "en_US-hfc_female-medium",
        &out_dir.join("hfc_female.wav"),
    );
    let rss1 = rss_mb();
    let d1 = rss1 - rss0;
    println!("  RSS after 1 model: {rss1:.1} MB (delta {d1:.1} MB)");

    println!("== model 2: en_US-ryan-medium");
    let m2 = load_tts("en_US-ryan-medium", &cache, &assets);
    synth_and_check(&m2, "en_US-ryan-medium", &out_dir.join("ryan.wav"));
    let rss2 = rss_mb();
    let d2 = rss2 - rss1;
    println!("  RSS after 2 models: {rss2:.1} MB (delta {d2:.1} MB)");

    println!("\n== summary");
    println!("baseline RSS      : {rss0:8.1} MB");
    println!("RSS with 1 model  : {rss1:8.1} MB  (+{d1:.1})");
    println!("RSS with 2 models : {rss2:8.1} MB  (+{d2:.1} for the 2nd)");
    println!("per-model steady-state cost ≈ {d2:.1} MB (2nd model delta)");
    println!("first-model cost ≈ {d1:.1} MB (includes onnxruntime arena init)");
}
