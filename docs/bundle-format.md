# TaleTrek Bundle Format (`*.taletrek`)

> **Status:** Canonical spec · v1 (`schemaVersion: 1`)
> **Owners:** all three apps (SPA / TS, desktop / Rust, server / Rust) MUST conform.
> Origin ADR: [`adrs/0013-off-device-synth-and-portable-bundles.md`](./adrs/0013-off-device-synth-and-portable-bundles.md).

A **bundle** is the portable interchange unit for one book (or a whole library) between the TaleTrek apps. It is a compressed archive: a manifest, the cleaned text, and (optionally) content-addressed audio. The same container carries both a *text-only* book (parsed, pre-synth) and a *full* book (synth'd, with audio).

## Design invariants

1. **Content-addressed audio.** Every audio segment is named by its TaleTrek cache key: `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`. Re-importing the same paragraph never double-stores. This is the same key the SPA's `audioCache` IDB store already uses.
2. **One format, two implementations.** Rust (`crates/synth`) and TypeScript (SPA) must produce byte-compatible archives. A shared fixtures set (under `crates/synth/tests/fixtures/`) is the conformance gate — both sides must round-trip every fixture.
3. **Forward-compatible.** The manifest carries a `schemaVersion`. Unknown fields are ignored on read; a major bump is a breaking change that readers must refuse with a clear error.
4. **State-independent.** A bundle may be text-only (no `audio/` entries) or full. Import handles both; "additional synth" imports a text-only (or partial) bundle, synth fills the gaps, re-export is full.

## Book bundle — `*.taletrek`

A uncompressed-then-gzipped tar is NOT used; the container is a **ZIP archive** (deflate). ZIP is natively readable in all three stacks (Rust `zip`, JS `fflate`/browser `DecompressionStream`, and is stream-friendly). Extension: `.taletrek`.

```
book.taletrek  (ZIP)
├── manifest.json
├── text.json
├── audio/
│   ├── <cache-key>.opus        # one per synthesized paragraph (optional)
│   └── ...
└── meta/
    ├── source.json             # original filename + format + sha256 (optional)
    ├── processing.json         # AppliedProcessing record (optional, M6)
    └── position.json           # last BookPosition (optional)
```

### `manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "book",
  "book": {
    "id": "bk_01HZX...",         // TaleTrek BookId (branded string). New on import if absent.
    "title": "...",
    "author": "...",             // optional
    "sourceFormat": "epub",      // pdf | epub | mobi | txt | md | unknown
    "chapterCount": 42,
    "voiceId": "en_US-lessac-medium",
    "createdAt": 1780000000000,  // ms since epoch
    "updatedAt": 1780000000000,
    "progressFraction": 0.0      // optional
  },
  "audio": {
    "present": true,             // false → text-only bundle (pre-synth)
    "codec": "opus",             // opus | m4a | wav (wav discouraged; huge)
    "normVersion": 3,            // matches the cache-key NORM_VERSION
    "segmentCount": 312
  },
  "generator": {
    "app": "taletrek-desktop",   // taletrek-spa | taletrek-desktop | taletrek-server
    "version": "0.1.0"
  }
}
```

### `text.json`

The cleaned chapter structure — identical shape to the SPA's `Chapter` type so the SPA can ingest without translation.

```jsonc
{
  "schemaVersion": 1,
  "chapters": [
    {
      "id": "ch_01HZ...",
      "bookId": "bk_01HZ...",
      "index": 0,
      "title": "Chapter One",
      "paragraphs": ["...", "..."],   // cleaned paragraph strings
      "headings": []                  // optional, M10
    }
  ]
}
```

### `audio/<cache-key>.<ext>`

Binary audio for one paragraph, named exactly by the cache key (URL-safe; `:` is preserved on disk and inside ZIP entry names). The codec matches `manifest.audio.codec`. The mapping from paragraph → audio is **implicit**: the importer computes the cache key from `(voiceId, normalizedText)` and looks up the matching entry. This means audio dedups across bundles and across books automatically.

### `meta/*` (all optional)

- `source.json` — `{ "filename": "book.epub", "format": "epub", "sha256": "..." }`. The original raw file is **not** embedded by default (size + privacy); a future flag may include it.
- `processing.json` — the `AppliedProcessing` record (M6 AI transforms), so an imported book retains its transform provenance.
- `position.json` — `{ "chapterIndex": 3, "paragraphIndex": 12 }` (the `BookPosition`). Lets export/import preserve reading place.

## Library bundle — `*.taletrek-lib`

A ZIP wrapping a library manifest + N book bundles (each itself a ZIP, stored uncompressed-inside to avoid double-compression pain, or deflate — implementer's choice; documented in `library-manifest.json`).

```
library.taletrek-lib  (ZIP)
├── library-manifest.json
└── books/
    ├── <book-id>.taletrek
    └── ...
```

### `library-manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "library",
  "exportedAt": 1780000000000,
  "bookCount": 17,
  "books": [
    { "id": "bk_...", "title": "...", "file": "books/bk_....taletrek" }
  ],
  "generator": { "app": "taletrek-spa", "version": "0.1.0" }
```

Library import is **idempotent and merge-safe**: each book is ingested by its content; content-addressed audio dedups. Importing the same library twice is a no-op (books matched by id; audio by key).

## Conformance rules

- **Write:** must emit `manifest.json` with `schemaVersion: 1`, `text.json`, and (if full) at least one `audio/` entry whose codec matches the manifest.
- **Read:** must accept a text-only bundle (`audio.present === false` or missing `audio/`). Must refuse a `schemaVersion` it does not understand with a typed error, not a silent best-effort load.
- **Audio codec:** Opus is the default for v1 (best size/quality for speech). M4A is permitted (iOS-native). WAV is permitted but discouraged. Readers must support Opus + M4A.
  - *Rust crate encoder note:* `crates/synth` ships its Opus encoder as an ffmpeg subprocess (`-c:a libopus`, OGG/Opus on stdout) behind an `Encoder` trait. This avoids a hard dependency on `libopus` dev headers (the native `audiopus`/`opus` crates require them to link); `ffmpeg` is already expected wherever off-device synth runs (desktop/server). A native-Opus impl can replace it behind the same trait without touching the pipeline. Default bitrate 24 kbps (mono speech).
- **IDs:** book/chapter IDs are preserved across export/import when present; if an importer finds a collision with an existing book, it allocates a new id and ingests as a separate book (never overwrites silently).

## Versioning

`schemaVersion` bumps:
- **Patch/minor (still `1`):** additive optional fields. Readers ignore unknowns.
- **`2` (future):** breaking. A v1 reader refuses v2 with a clear "newer bundle format" error pointing the user at an upgrade.
