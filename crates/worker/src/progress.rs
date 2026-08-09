//! Stderr progress reporting behind a `Write` seam.
//!
//! [`Progress`] wraps any `Write + Send` behind a `Mutex`, so calls from
//! parallel synth threads serialize cleanly and tests capture lines into a
//! `Vec<u8>` instead of stderr. Production constructs via [`Progress::to_stderr`];
//! tests via [`Progress::new`] with `Box::new(Vec::new())`.
//!
//! Three line shapes, all newline-terminated and flushed eagerly so a long run
//! shows live progress:
//! - synth step ([`ProgressSink::synth_step`]): `synth [done/total] pct%`
//! - download step ([`ProgressSink::download_step`]): `voice d.t MiB (pct%)`
//!   (total + pct omitted when `Content-Length` is unknown)
//! - summary ([`Progress::summary`]): `kind: N segments, voice V, Mm Ss → out`
//!
//! The two engine-facing methods (`synth_step`, `download_step`) are on the
//! [`crate::ProgressSink`] trait so the server can supply its own reporter
//! (a job row, not stderr). The CLI-only `summary` / `elapsed` / `to_stderr` /
//! `new` constructors stay inherent on [`Progress`] — the server never
//! summarizes.

use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::ProgressSink;

/// Testable progress sink. Wraps a `Write + Send` behind a `Mutex` so parallel
/// synth threads can report without racing on the underlying handle. `Send +
/// Sync` so `&Progress` may be shared into a rayon pool by reference.
///
/// Progress reporting is best-effort: write/flush errors are swallowed so a
/// failing sink (e.g. closed stderr) never breaks a synth run.
pub struct Progress {
    /// Output sink, guarded so a line is never split by a concurrent write.
    state: Mutex<State>,
    /// Run start instant, read concurrently (`Instant` is `Copy`) for the
    /// summary's elapsed duration.
    start: Instant,
}

struct State {
    out: Box<dyn Write + Send>,
}

impl Progress {
    /// Wrap an arbitrary sink. Tests pass `Box::new(Vec::new())`; production
    /// uses [`Progress::to_stderr`].
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self {
            state: Mutex::new(State { out }),
            start: Instant::now(),
        }
    }

    /// Construct a progress sink writing to `stderr` — the production default.
    pub fn to_stderr() -> Self {
        Self::new(Box::new(io::stderr()))
    }

    /// Elapsed since construction; used by [`Progress::summary`].
    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    /// Emit the final summary line:
    /// `kind: segments segments, voice voice_id, Mm Ss → out`.
    ///
    /// `kind` is `"synth"` or `"resynth"`; the duration comes from
    /// [`Progress::elapsed`] formatted by [`format_duration`].
    pub fn summary(&self, kind: &str, segments: usize, voice_id: &str, out: &Path) {
        let dur = format_duration(self.elapsed());
        self.write_line(&format!(
            "{kind}: {segments} segments, voice {voice_id}, {dur} → {}",
            out.display()
        ));
    }

    /// Write one line (newline appended) under the lock, then flush. Errors are
    /// ignored — progress is best-effort and must never break a synth run.
    fn write_line(&self, line: &str) {
        let mut state = self.state.lock().unwrap();
        let _ = writeln!(state.out, "{line}");
        let _ = state.out.flush();
    }
}

impl ProgressSink for Progress {
    /// Emit a synth step line: `synth [done/total] pct%`.
    ///
    /// `pct = done * 100 / total` (integer division, clamped to 100). When
    /// `total == 0` the line is skipped — there is nothing to report (e.g. an
    /// empty bundle). Flushes so a long run shows live progress.
    fn synth_step(&self, done: usize, total: usize) {
        if total == 0 {
            return;
        }
        let pct = usize::min(done * 100 / total, 100);
        self.write_line(&format!("synth [{done}/{total}] {pct}%"));
    }

    /// Emit a download step line.
    ///
    /// When `bytes_total > 0`: `voice done.total MiB (pct%)` with one-decimal
    /// MiB and integer pct. When `bytes_total == 0` (Content-Length unknown),
    /// the total + pct are omitted: `voice done MiB`.
    fn download_step(&self, bytes_done: u64, bytes_total: u64) {
        let done_mib = bytes_done as f64 / (1024.0 * 1024.0);
        let line = if bytes_total == 0 {
            format!("voice {done_mib:.1} MiB")
        } else {
            let total_mib = bytes_total as f64 / (1024.0 * 1024.0);
            let pct = u64::min(bytes_done * 100 / bytes_total, 100);
            format!("voice {done_mib:.1}/{total_mib:.1} MiB ({pct}%)")
        };
        self.write_line(&line);
    }
}

/// Format a duration as `Ss` (under a minute) or `Mm Ss` (a minute or more).
/// Pure so tests assert exact output without sleeping.
fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else {
        let m = secs / 60;
        let s = secs % 60;
        format!("{m}m {s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A `Write` that records into a shared `Arc<Mutex<Vec<u8>>>` so the test
    /// can read back what `Progress` wrote without touching the `Box<dyn Write>`
    /// the sink owns.
    #[derive(Clone)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Build a `Progress` backed by a `Vec<u8>` plus a closure that drains the
    /// captured bytes. Each call yields every line written so far.
    fn capturing() -> (Progress, impl Fn() -> String) {
        let cell: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let reader = Arc::clone(&cell);
        let progress = Progress::new(Box::new(Captured(cell)));
        (progress, move || {
            String::from_utf8(reader.lock().unwrap().clone()).unwrap()
        })
    }

    #[test]
    fn synth_step_formats_done_total_and_integer_pct() {
        let (p, read) = capturing();
        p.synth_step(1, 4);
        p.synth_step(2, 4);
        p.synth_step(4, 4);
        let out = read();
        assert_eq!(out, "synth [1/4] 25%\nsynth [2/4] 50%\nsynth [4/4] 100%\n");
    }

    #[test]
    fn synth_step_pct_clamps_to_100_even_if_done_exceeds_total() {
        let (p, read) = capturing();
        p.synth_step(10, 4);
        assert_eq!(read(), "synth [10/4] 100%\n");
    }

    #[test]
    fn synth_step_skips_when_total_is_zero() {
        let (p, read) = capturing();
        p.synth_step(0, 0);
        assert_eq!(read(), "", "empty bundle — nothing to report");
    }

    #[test]
    fn download_step_formats_total_and_pct_when_known() {
        let (p, read) = capturing();
        // 1 MiB done of 4 MiB → 25%.
        p.download_step(1024 * 1024, 4 * 1024 * 1024);
        assert_eq!(read(), "voice 1.0/4.0 MiB (25%)\n");
    }

    #[test]
    fn download_step_omits_total_when_unknown() {
        let (p, read) = capturing();
        p.download_step(1024 * 1024, 0);
        assert_eq!(read(), "voice 1.0 MiB\n");
    }

    #[test]
    fn download_step_rounds_mib_to_one_decimal() {
        let (p, read) = capturing();
        // 1.5 MiB done of 3 MiB → 50%.
        p.download_step(1024 * 1024 + 512 * 1024, 3 * 1024 * 1024);
        assert_eq!(read(), "voice 1.5/3.0 MiB (50%)\n");
    }

    #[test]
    fn summary_contains_kind_segments_voice_arrow_and_path() {
        let (p, read) = capturing();
        p.summary(
            "synth",
            312,
            "en_US-ryan-medium",
            Path::new("book.synth.taletrek"),
        );
        let line = read();
        // The exact duration is non-deterministic; assert the stable parts and
        // that a duration token is present (format_duration is tested exactly
        // below).
        assert!(
            line.starts_with("synth: 312 segments, voice en_US-ryan-medium, "),
            "summary prefix wrong: {line:?}"
        );
        assert!(
            line.ends_with(" → book.synth.taletrek\n"),
            "summary suffix wrong: {line:?}"
        );
        // A duration token (e.g. `0s`, `4m 17s`) sits between the trailing
        // comma and the arrow.
        let middle = line
            .trim_start_matches("synth: 312 segments, voice en_US-ryan-medium, ")
            .trim_end_matches(" → book.synth.taletrek\n");
        assert!(
            middle == "0s" || middle.contains('m') && middle.contains('s'),
            "expected a duration token, got {middle:?}"
        );
    }

    #[test]
    fn format_duration_under_a_minute_is_seconds() {
        assert_eq!(format_duration(Duration::ZERO), "0s");
        assert_eq!(format_duration(Duration::from_secs(1)), "1s");
        assert_eq!(format_duration(Duration::from_secs(59)), "59s");
    }

    #[test]
    fn format_duration_a_minute_or_more_is_minutes_and_seconds() {
        assert_eq!(format_duration(Duration::from_secs(60)), "1m 0s");
        assert_eq!(format_duration(Duration::from_secs(125)), "2m 5s");
        assert_eq!(format_duration(Duration::from_secs(257)), "4m 17s");
    }
}
