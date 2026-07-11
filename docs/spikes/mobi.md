# Spike: MOBI support in the browser

> **Status:** Complete — minimal self-written KF7 parser shipped (`web/src/lib/parse/mobi.ts`).
> **Track:** M1 deferred task (T8). Independent of the three-format slice (T1–T7).

## Goal

Decide whether MOBI (`.mobi` / `.prc`) can be read in the browser without a backend,
and if so, what scope. MOBI was the only format in the M1 plan with **no healthy
off-the-shelf browser parser**, which is why it was deferred to its own spike.

## Verdict: viable for KF7 (the common non-DRM case). Ship a self-written parser.

A minimal, dependency-free parser handles the formats real users actually carry:
uncompressed and PalmDOC-LZ77-compressed MOBI (KF7). The hard cases (KF8/AZW3,
HUFF/CDIC compression, DRM) are detected and rejected with a friendly error that
points the user toward converting to EPUB. This matches the locked PRD decision
("MOBI will be a self-written minimal parser — no dependency", M1 PRD §Technologies).

## What the parser supports

| Case                              | Handling                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| Container: Palm Database (PDB)    | Parsed — record offsets read from the header                   |
| Compression `1` (none)            | Pass-through                                                   |
| Compression `2` (PalmDOC LZ77)    | Decompressed (full algorithm, all 5 byte classes)              |
| Encoding CP1252 (`1252`)          | `TextDecoder('windows-1252')`                                  |
| Encoding UTF-8 (`65001`)          | `TextDecoder('utf-8')`                                         |
| Title                             | MOBI full-name field, falling back to filename                 |
| Trailing-entry bytes (per record) | Stripped per `extraDataFlags` (multibyte overlap + TBS + uncrossable breaks) |
| HTML text content                 | Block tags → paragraph breaks, tags stripped, entities decoded |
| Chapter structure                 | Single chapter (matches TXT/PDF precedent; KF7 has no native chapter records) |

## What the parser rejects (friendly `ParseError`)

| Case                                   | Reason                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| Compression `17480` (HUFF/CDIC)        | Proprietary Huffman scheme; only Calibre implements it. Reject. |
| Encryption ≠ 0 (DRM)                   | DRM circumvention is a non-goal (`docs/VISION.md`). Reject.    |
| KF8 / AZW3 (mobi type `248`, version ≥ 8, or EXTH 121 boundary) | Separate, far more complex format. Reject — recommend EPUB. |

Users hitting a rejection get a message naming the sub-format and suggesting they
convert the file to EPUB (e.g. via Calibre), which TaleTrek reads natively.

## Format notes (source: MobileRead wiki)

The MOBI file is a **Palm Database (PDB)** container:

```
PDB header (78 bytes) + record-info array (8 bytes/record)
record 0 → PalmDOC header (16 B) + MOBI header (≤232 B) + full name
record 1..N → text records (each ≤4096 B uncompressed), possibly compressed,
              each optionally followed by trailing-entry bytes
```

- **PalmDOC header** (record 0, first 16 B): compression (u16), text length (u32),
  text record count (u16), record size (u16, always 4096), encryption type (u16).
- **MOBI header** (record 0, offset 16+): magic `MOBI`, header length, mobi type,
  text encoding, file version, full-name offset/length, extra-data flags (offset 0xF0).
- **PalmDOC LZ77** (`docs/spikes/piper-wasm.md` has nothing to do with this; see
  the algorithm below) operates per 4096-byte block; blocks are independent.

### PalmDOC LZ77 decompression (per 4096-byte block)

Read a byte `c` from the compressed stream:

| `c` range      | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `0x00`         | One literal: copy `0x00`                                     |
| `0x01`–`0x08`  | Copy the next `c` bytes literally                            |
| `0x09`–`0x7F`  | One literal: copy `c`                                        |
| `0x80`–`0xBF`  | Back-reference: read next byte `c2`; `pair = ((c & 0x3F) << 8) | c2`; `length = (pair & 0x07) + 3`; `distance = (pair >> 3) + 1`; copy `length` bytes from `distance` back (byte-by-byte, to handle overlapping runs) |
| `0xC0`–`0xFF`  | Byte pair: emit space (`0x20`) then `c ^ 0x80`               |

Blocks are independent — no state carries across the 4096-byte boundary.

## npm landscape (evaluated, not adopted)

| Package                       | Verdict                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `@lingo-reader/mobi-parser`   | Maintained (2026), MOBI + KF8. **Not adopted:** the PRD locked "no dependency" for MOBI, and adding one is ask-first. Revisit if KF8 demand appears. |
| `mobi` (`0.0.1`, 2012)        | Dead (14 years old). Skip.                                  |
| others                        | Generators / CLI plugins, not parsers. Skip.                |

The self-written parser keeps TaleTrek fully MIT (ADR-0002) with zero new deps.

## Limitations & future work

- **KF8/AZW3 unsupported.** These are the dominant format for *modern* Kindle
  files. If demand grows, evaluate `@lingo-reader/mobi-parser` (handles KF8) or
  port libmobi's KF8 decoder.
- **HUFF/CDIC compression unsupported** (rare outside old dictionaries).
- **Single chapter.** KF7 text is one HTML flow; heading-based (`<h1>`/`<h2>`) or
  `<mbp:pagebreak/>`-based chapter splitting is a future enhancement, not needed
  for M2 TTS chunking (which works per-paragraph).
- **No image/font/resource extraction** — out of scope (M1 extracts text only).

## References

- MobileRead wiki — [MOBI](https://wiki.mobileread.com/wiki/MOBI), [PalmDOC](https://wiki.mobileread.com/wiki/PalmDOC)
- libmobi (canonical C library) — distance/length convention `distance = (pair >> 3) + 1`
