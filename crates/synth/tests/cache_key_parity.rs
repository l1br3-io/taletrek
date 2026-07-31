//! Cross-language cache-key parity. These exact SHA-256 values are produced by
//! the SPA's `audioCacheKey` for the same inputs; locking them here guarantees
//! the Rust crate and the SPA agree byte-for-byte (the foundation of audio
//! dedup across apps). Hashes computed via `printf '<text>' | sha256sum`, i.e.
//! UTF-8 bytes — identical to the SPA's `TextEncoder().encode(text)`.

use taletrek_synth::{cache_key, normalize_for_speech, NORM_VERSION};

#[test]
fn plain_text_key_is_stable() {
    // sha256("Hello world.") = aa3ec16e…
    assert_eq!(
        cache_key("v", "Hello world."),
        format!(
            "v:{NORM_VERSION}:aa3ec16e6acc809d8b2818662276256abfd2f1b441cb51574933f3d4bd115d11"
        ),
    );
}

#[test]
fn normalization_collides_curly_and_straight_apostrophe() {
    // Both normalize to "O'Reilly books" → sha256 = 5835dab3…
    let expected = format!(
        "v:{NORM_VERSION}:5835dab30eff4eccde5076eec882a1f80a78433694269940752aac6626ad8e9d"
    );
    assert_eq!(cache_key("v", "O'Reilly books"), expected);
    assert_eq!(cache_key("v", "O\u{2019}Reilly books"), expected);
}

#[test]
fn whitespace_collapse_collides() {
    // "too   much space" → "too much space" → sha256 = c86cfd5d…
    let expected = format!(
        "v:{NORM_VERSION}:c86cfd5dc85cd2b2f6a1bf0144c229bdda9d95f9c8be8908e83534e8c315d5d1"
    );
    assert_eq!(cache_key("v", "too much space"), expected);
    assert_eq!(cache_key("v", "too   much\t\nspace"), expected);
}

#[test]
fn voice_id_is_in_the_key_prefix() {
    let a = cache_key("voiceA", "same text");
    let b = cache_key("voiceB", "same text");
    assert!(a.starts_with("voiceA:"));
    assert!(b.starts_with("voiceB:"));
    assert_ne!(a, b);
}

#[test]
fn normalize_matches_spa_end_to_end_paragraph() {
    // The exact input from the SPA's `normalize.test.ts` end-to-end case.
    let input = "O\u{2019}Reilly books may be purchased for educational, business, or sales promotional use. Online editions are also available for most titles ( ). For more information, contact our corporate/institu\u{2010} tional sales department: 800-998-9938 or corporate@oreilly.com .";
    let out = normalize_for_speech(input);
    assert!(out.contains("O'Reilly"));
    assert!(out.contains("institutional"));
    assert!(!out.contains("( )"));
}
