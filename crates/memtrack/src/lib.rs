//! Peak-heap instrument: a [`GlobalAlloc`] wrapper that counts current live
//! bytes and keeps the maximum watermark. Exists for
//! `crates/worker/tests/peak_memory.rs` — the `streaming-synth` memory-bound
//! proof — which installs it as the test binary's global allocator and
//! asserts a full convert never accumulates the book's audio.
//!
//! The hooks are allocation-free by construction (atomics only, `System` as
//! the backstop): an allocating hook deadlocks or recursion-crashes. The
//! counters are `u64` (no wrap on 64-bit targets) and the watermark uses
//! `fetch_max` under `Relaxed` ordering — it is a monotone maximum, not a
//! synchronization point.
//!
//! This crate is the only workspace code with `unsafe_code` allowed: the
//! `unsafe impl` is the entire, irreducible surface of the instrument. Keep
//! it that way.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};

static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);

/// Peak-tracking allocator. Register with
/// `#[global_allocator] static A: PeakTrackingAlloc = PeakTrackingAlloc;`
/// then read [`live_bytes`] / [`peak_bytes`]. `realloc` and `alloc_zeroed`
/// use the trait defaults, which route through the counted
/// [`GlobalAlloc::alloc`] / [`GlobalAlloc::dealloc`] pair.
pub struct PeakTrackingAlloc;

// SAFETY: both hooks delegate to `System` with the exact `Layout` they were
// given, and only touch atomics around the delegation — no allocation, no
// locks, no reentrancy.
unsafe impl GlobalAlloc for PeakTrackingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forward-safety — `System.alloc` with a caller-provided
        // valid `Layout` (invariant of the trait contract).
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let size = layout.size() as u64;
            let live = LIVE.fetch_add(size, Ordering::Relaxed) + size;
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as u64, Ordering::Relaxed);
        // SAFETY: `ptr` originates from this allocator's `alloc` and `layout`
        // matches it (trait contract).
        unsafe { System.dealloc(ptr, layout) }
    }
}

/// Current live bytes under [`PeakTrackingAlloc`].
#[must_use]
pub fn live_bytes() -> u64 {
    LIVE.load(Ordering::Relaxed)
}

/// Maximum live bytes ever observed since process start (the watermark).
#[must_use]
pub fn peak_bytes() -> u64 {
    PEAK.load(Ordering::Relaxed)
}
