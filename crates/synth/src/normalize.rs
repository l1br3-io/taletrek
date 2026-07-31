//! Text normalization for speech synthesis — a faithful Rust port of the SPA's
//! `web/src/lib/tts/normalize.ts`.
//!
//! [`normalize_for_speech`] MUST produce byte-for-byte the same string the SPA's
//! `normalizeForSpeech` produces for the same input, because the cache key
//! ([`crate::cache_key`]) hashes the normalized text. Drift here breaks
//! cross-app audio dedup.
//!
//! ## Lone surrogates
//!
//! The SPA strips unpaired UTF-16 surrogate code units (U+D800–U+DFFF) that
//! pdfjs emits for certain glyphs — they crash the C++ JSON parser inside the
//! Piper WASM. Rust `&str` is guaranteed valid UTF-8, and surrogates are not
//! valid Unicode scalar values, so they **cannot appear in a Rust string at
//! all**. The equivalent of "stripped" is therefore already true on this side;
//! no surrogate handling is needed or possible here. The parity contract is
//! "valid Unicode text → identical normalized output on both sides."

use std::sync::LazyLock;

use regex::Regex;

/// A chain of find-replace steps applied in order by [`normalize_for_speech`].
/// Mirrors the sequential `String.prototype.replace` calls in the SPA.
struct Step {
    pattern: &'static LazyLock<Regex>,
    replacement: &'static str,
}

// Smart single quotes / apostrophes → ASCII apostrophe.
static SMART_SINGLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\u{2018}\u{2019}\u{201A}\u{201B}]").unwrap());
// Smart double quotes → ASCII double quote.
static SMART_DOUBLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\u{201C}\u{201D}\u{201E}\u{201F}]").unwrap());
// Unicode hyphens/dashes (U+2010 HYPHEN … U+2015 HORIZONTAL BAR) → ASCII '-'.
static DASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new("[\u{2010}-\u{2015}]").unwrap());
// Rejoin words broken by an end-of-line hyphen turned into a space:
// lowercase + '-' + ' ' + lowercase → the two lowercase letters joined.
// Mirrors the SPA's `/(\p{Ll})- (\p{Ll})/gu`.
static DEHYPHEN: LazyLock<Regex> = LazyLock::new(|| Regex::new("(\\p{Ll})- (\\p{Ll})").unwrap());
// Empty parentheses left by URL/image stripping, e.g. "titles ( ).".
static EMPTY_PARENS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\s*\)").unwrap());
// Runs of whitespace → single space.
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

static STEPS: LazyLock<Vec<Step>> = LazyLock::new(|| {
    vec![
        Step {
            pattern: &SMART_SINGLE,
            replacement: "'",
        },
        Step {
            pattern: &SMART_DOUBLE,
            replacement: "\"",
        },
        Step {
            pattern: &DASHES,
            replacement: "-",
        },
        Step {
            pattern: &DEHYPHEN,
            replacement: "$1$2",
        },
        Step {
            pattern: &EMPTY_PARENS,
            replacement: "",
        },
        Step {
            pattern: &WS_RUN,
            replacement: " ",
        },
    ]
});

/// Normalize text for speech synthesis (port of the SPA's `normalizeForSpeech`).
///
/// Applies, in order: smart-quote → ASCII, Unicode dash → ASCII `-`,
/// end-of-line dehyphenation, empty-paren removal, whitespace collapse, trim.
#[must_use]
pub fn normalize_for_speech(text: &str) -> String {
    let mut out = text.to_string();
    for step in STEPS.iter() {
        out = step
            .pattern
            .replace_all(&out, step.replacement)
            .into_owned();
    }
    out.trim().to_string()
}

/// Maximum chars fed to a single Piper inference call. Mirrors the SPA's
/// `MAX_SYNTH_CHARS` (400).
pub const MAX_SYNTH_CHARS: usize = 400;

/// Split `text` into chunks small enough for a single Piper inference call
/// (port of the SPA's `splitForSpeech`).
///
/// Splits on sentence terminators first; hard-splits at word boundaries only
/// when a single sentence exceeds `max_chars`. Trailing terminators stay with
/// their sentence. Empty chunks are dropped.
#[must_use]
pub fn split_for_speech(text: &str, max_chars: usize) -> Vec<String> {
    split_for_speech_with(text, max_chars)
}

/// Same as [`split_for_speech`] but with an explicit cap (used by tests).
#[must_use]
pub fn split_for_speech_with(text: &str, max_chars: usize) -> Vec<String> {
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }

    // Sentence boundary: run of non-terminators, then one or more terminators
    // (. ! ?), then trailing whitespace or end. Mirrors the SPA regex
    // `/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g`. `find_iter` ≡ JS `match(/…/g)`.
    static SENTENCE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$").unwrap());

    let sentences: Vec<&str> = SENTENCE.find_iter(text).map(|m| m.as_str()).collect();
    let sentences = if sentences.is_empty() {
        vec![text]
    } else {
        sentences
    };

    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();

    for sentence in sentences {
        if sentence.chars().count() > max_chars {
            // Hard-split an over-long sentence at word boundaries, keeping
            // whitespace runs as their own tokens (≡ JS `split(/(\s+)/)`).
            flush_into(&mut buf, &mut chunks);
            let tokens = word_tokens(sentence);
            let mut line = String::new();
            for token in tokens {
                if !line.is_empty()
                    && line.chars().count() + token.chars().count() > max_chars
                    && !line.trim().is_empty()
                {
                    chunks.push(line.trim().to_string());
                    line = token.trim_start().to_string();
                } else {
                    line.push_str(&token);
                }
            }
            if !line.trim().is_empty() {
                buf = line;
            }
            continue;
        }
        // Normal path: accumulate sentences until the next would exceed the cap.
        if !buf.is_empty()
            && buf.chars().count() + sentence.chars().count() > max_chars
            && !buf.trim().is_empty()
        {
            flush_into(&mut buf, &mut chunks);
        }
        buf.push_str(sentence);
    }
    flush_into(&mut buf, &mut chunks);

    chunks
}

/// Push `buf` (trimmed, non-empty) onto `chunks`, then clear `buf`.
fn flush_into(buf: &mut String, chunks: &mut Vec<String>) {
    let trimmed = buf.trim();
    if !trimmed.is_empty() {
        chunks.push(trimmed.to_string());
    }
    buf.clear();
}

/// Split into alternating (non-whitespace, whitespace-run) tokens, keeping the
/// whitespace runs — equivalent to the SPA's `sentence.split(/(\s+)/)`.
fn word_tokens(s: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_is_ws: Option<bool> = None;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        match cur_is_ws {
            None => {
                cur.push(ch);
                cur_is_ws = Some(is_ws);
            }
            Some(b) if b == is_ws => cur.push(ch),
            Some(_) => {
                tokens.push(std::mem::take(&mut cur));
                cur.push(ch);
                cur_is_ws = Some(is_ws);
            }
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ascii_unchanged() {
        assert_eq!(normalize_for_speech("Hello world."), "Hello world.");
    }

    #[test]
    fn smart_quotes_to_ascii() {
        assert_eq!(
            normalize_for_speech("\u{201C}Hello\u{201D} \u{2018}world\u{2019}"),
            "\"Hello\" 'world'"
        );
        assert_eq!(normalize_for_speech("O\u{2019}Reilly"), "O'Reilly");
    }

    #[test]
    fn unicode_dashes_to_ascii() {
        assert_eq!(normalize_for_speech("en\u{2013}dash"), "en-dash");
        assert_eq!(normalize_for_speech("em\u{2014}dash"), "em-dash");
    }

    #[test]
    fn rejoins_broken_eol_hyphens() {
        assert_eq!(
            normalize_for_speech("institu\u{2010} tional"),
            "institutional"
        );
        assert_eq!(normalize_for_speech("glimmer- ing"), "glimmering");
    }

    #[test]
    fn keeps_real_hyphenated_compounds() {
        assert_eq!(normalize_for_speech("well-being"), "well-being");
        assert_eq!(normalize_for_speech("800-998-9938"), "800-998-9938");
    }

    #[test]
    fn removes_empty_parens() {
        assert_eq!(normalize_for_speech("titles ( ). More."), "titles . More.");
        assert_eq!(normalize_for_speech("see ( ) here"), "see here");
    }

    #[test]
    fn collapses_whitespace() {
        assert_eq!(
            normalize_for_speech("too   much\t\nspace"),
            "too much space"
        );
    }

    #[test]
    fn end_to_end_oreilly_paragraph() {
        let input = "O\u{2019}Reilly books may be purchased for educational, business, or sales promotional use. Online editions are also available for most titles ( ). For more information, contact our corporate/institu\u{2010} tional sales department: 800-998-9938 or corporate@oreilly.com .";
        let out = normalize_for_speech(input);
        assert!(out.contains("O'Reilly"));
        assert!(out.contains("institutional"));
        assert!(!out.contains("( )"));
        assert!(!out.contains('\u{2019}'));
        assert!(!out.contains('\u{2010}'));
    }

    // --- splitForSpeech parity ---

    #[test]
    fn split_short_is_single_chunk() {
        assert_eq!(
            split_for_speech("Hello world.", MAX_SYNTH_CHARS),
            vec!["Hello world.".to_string()]
        );
    }

    #[test]
    fn split_at_exact_cap_is_single_chunk() {
        let text = "a".repeat(MAX_SYNTH_CHARS);
        assert_eq!(split_for_speech(&text, MAX_SYNTH_CHARS), vec![text]);
    }

    #[test]
    fn split_keeps_terminator_with_sentence() {
        let chunks = split_for_speech("Hello. World!", 10);
        assert!(chunks.iter().any(|c| c.starts_with("Hello")));
        assert!(chunks.iter().any(|c| c.contains("World")));
    }

    #[test]
    fn split_hard_splits_overlong_sentence_at_word_boundaries() {
        let words: Vec<String> = (0..20).map(|i| format!("word{i}")).collect();
        let text = words.join(" ");
        let chunks = split_for_speech(&text, 30);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.chars().count() <= 30);
            assert!(c.starts_with("word"));
        }
    }

    #[test]
    fn split_no_empty_chunks() {
        let chunks = split_for_speech("One. Two. Three.", 5);
        for c in &chunks {
            assert!(!c.is_empty());
        }
    }
}
