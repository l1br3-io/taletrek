//! Whole-book export for foreign callers — the merged `.opus` entry
//! point. A synchronous, I/O-bound remux (no decode/re-encode) whose
//! cost is dominated by reading the bundle's audio entries once; hosts
//! call it off the main thread and share/save the produced file. Mirrors
//! `decode_segment`'s free-fn shape: path strings in, typed error out.

use std::path::Path;

use taletrek_synth::merge_bundle_audio;

use crate::error::FfiError;

/// Merge the whole book's audio at `bundle_path` into one gapless OGG
/// Opus file at `dest_path` (created/truncated by the call — hosts own
/// choosing a location under their cache dir). Returns the number of
/// distinct segments merged. A text-only bundle, a non-Opus codec, or a
/// corrupt segment fails as [`FfiError::MergeFailed`], never a panic.
#[uniffi::export]
pub fn export_merged_audio(bundle_path: String, dest_path: String) -> Result<u32, FfiError> {
    merge_bundle_audio(Path::new(&bundle_path), Path::new(&dest_path)).map_err(|e| {
        FfiError::MergeFailed {
            detail: e.to_string(),
        }
    })
}
