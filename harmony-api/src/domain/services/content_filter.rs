//! Content moderation filter (`AutoMod`).
//!
//! WHY: Protects against abusive user-generated content (slurs, hate speech).
//! Pure domain logic — no I/O, no async. Word lists are embedded at compile time.
//!
//! Two enforcement tiers:
//! - `check_hard`: rejects input entirely (server names, usernames, etc.)
//! - `check_soft`: masks matched words with `****` (messages)

use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;

use crate::domain::errors::DomainError;

// ── Embedded word lists (abuse only — profanity is client-side) ──────

const EN_ABUSE: &str = include_str!("banned_words/en_abuse.txt");
const AR_ABUSE: &str = include_str!("banned_words/ar_abuse.txt");
const CS_ABUSE: &str = include_str!("banned_words/cs_abuse.txt");
const DA_ABUSE: &str = include_str!("banned_words/da_abuse.txt");
const DE_ABUSE: &str = include_str!("banned_words/de_abuse.txt");
const EO_ABUSE: &str = include_str!("banned_words/eo_abuse.txt");
const ES_ABUSE: &str = include_str!("banned_words/es_abuse.txt");
const FA_ABUSE: &str = include_str!("banned_words/fa_abuse.txt");
const FI_ABUSE: &str = include_str!("banned_words/fi_abuse.txt");
const FR_ABUSE: &str = include_str!("banned_words/fr_abuse.txt");
const HI_ABUSE: &str = include_str!("banned_words/hi_abuse.txt");
const HU_ABUSE: &str = include_str!("banned_words/hu_abuse.txt");
const IT_ABUSE: &str = include_str!("banned_words/it_abuse.txt");
const JA_ABUSE: &str = include_str!("banned_words/ja_abuse.txt");
const KO_ABUSE: &str = include_str!("banned_words/ko_abuse.txt");
const NL_ABUSE: &str = include_str!("banned_words/nl_abuse.txt");
const NO_ABUSE: &str = include_str!("banned_words/no_abuse.txt");
const PL_ABUSE: &str = include_str!("banned_words/pl_abuse.txt");
const PT_ABUSE: &str = include_str!("banned_words/pt_abuse.txt");
const RU_ABUSE: &str = include_str!("banned_words/ru_abuse.txt");
const SV_ABUSE: &str = include_str!("banned_words/sv_abuse.txt");
const TH_ABUSE: &str = include_str!("banned_words/th_abuse.txt");
const TR_ABUSE: &str = include_str!("banned_words/tr_abuse.txt");
const ZH_ABUSE: &str = include_str!("banned_words/zh_abuse.txt");

/// All abuse word lists, loaded at compile time.
const ALL_ABUSE_LISTS: &[&str] = &[
    EN_ABUSE, AR_ABUSE, CS_ABUSE, DA_ABUSE, DE_ABUSE, EO_ABUSE, ES_ABUSE, FA_ABUSE, FI_ABUSE,
    FR_ABUSE, HI_ABUSE, HU_ABUSE, IT_ABUSE, JA_ABUSE, KO_ABUSE, NL_ABUSE, NO_ABUSE, PL_ABUSE,
    PT_ABUSE, RU_ABUSE, SV_ABUSE, TH_ABUSE, TR_ABUSE, ZH_ABUSE,
];

// ── Public types ────────────────────────────────────────────────────

/// Result of checking message content for banned words.
#[derive(Debug)]
pub enum ModerationVerdict {
    /// No banned words detected.
    Clean,
    /// Banned words detected and replaced with `****`.
    Flagged {
        /// Content with matched words replaced by `*` (same length).
        masked_content: String,
        /// Generic reason (never the matched word itself).
        reason: String,
    },
}

/// Pure domain service: checks text for abusive language across 24 languages.
///
/// WHY concrete struct, not a trait: `ContentFilter` is pure in-memory validation
/// with zero I/O. Unlike [`PlanLimitChecker`] (a port that queries Postgres),
/// this has no polymorphism benefit beyond noop. The `enabled` flag is simpler
/// than a trait + `NoopContentFilter` impl.
#[derive(Debug)]
pub struct ContentFilter {
    /// Unified set from all `*_abuse.txt` files across 24 languages.
    banned_words: HashSet<String>,
    enabled: bool,
}

#[allow(clippy::new_without_default)]
impl ContentFilter {
    /// Build a filter from all embedded abuse word lists.
    #[must_use]
    pub fn new() -> Self {
        let mut banned_words = HashSet::new();

        for list in ALL_ABUSE_LISTS {
            for line in list.lines() {
                let raw = line.trim();
                if raw.is_empty() {
                    continue;
                }
                // WHY: Apply the same normalization pipeline used on input text.
                // Without this, accented words (é→e), CJK with combining marks,
                // and Turkish special chars would never match normalized input.
                let normalized = normalize_text(raw).to_lowercase();
                if !normalized.is_empty() {
                    banned_words.insert(normalized);
                }
            }
        }

        tracing::info!(
            word_count = banned_words.len(),
            "ContentFilter loaded abuse word lists"
        );

        Self {
            banned_words,
            enabled: true,
        }
    }

    /// Build a no-op filter (all checks pass). Used when content moderation is disabled.
    #[must_use]
    pub fn noop() -> Self {
        Self {
            banned_words: HashSet::new(),
            enabled: false,
        }
    }

    /// Tier 1: hard reject. Returns `Err(ValidationError)` if banned words are found.
    ///
    /// Used for structural inputs: server names, channel names, usernames, etc.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ValidationError`] if the text contains banned words.
    pub fn check_hard(&self, text: &str) -> Result<(), DomainError> {
        if !self.enabled {
            return Ok(());
        }

        let normalized = normalize_text(text);

        if self.has_banned_word(&normalized) {
            return Err(DomainError::ValidationError(
                "Content contains prohibited language".to_string(),
            ));
        }

        Ok(())
    }

    /// Tier 2: soft redact. Returns the masked version if banned words are found.
    ///
    /// Used for messages: preserves the message but replaces bad words with `****`.
    /// Operates entirely on the normalized form to avoid byte-position mismatches
    /// between normalized and original text. The returned `masked_content` is the
    /// normalized (accent-stripped, zero-width-stripped) version with banned words
    /// replaced by `*` characters.
    #[must_use]
    pub fn check_soft(&self, text: &str) -> ModerationVerdict {
        if !self.enabled {
            return ModerationVerdict::Clean;
        }

        let normalized = normalize_text(text);
        let masked = self.mask_banned_words(&normalized);

        // WHY: Compare against normalized (not original) since masking operates
        // on the normalized form. If nothing was masked, the text is clean.
        if masked == normalized {
            ModerationVerdict::Clean
        } else {
            // WHY: Escape `*` as `\*` so markdown renderers treat them as
            // literal asterisks. Without this, `*****` alone is parsed as a
            // CommonMark thematic break (<hr>) — rendering an empty message.
            let markdown_safe = masked.replace('*', r"\*");
            ModerationVerdict::Flagged {
                masked_content: markdown_safe,
                reason: "Content violates community guidelines".to_string(),
            }
        }
    }

    /// Check if any token in the normalized text matches a banned word.
    fn has_banned_word(&self, normalized: &str) -> bool {
        // Pass 1: word-boundary tokenization
        if tokenize(normalized).any(|word| self.banned_words.contains(&word)) {
            return true;
        }

        // Pass 2: "squeezed" — catches separator bypasses like f*u*c*k
        let squeezed = squeeze(normalized);
        tokenize(&squeezed).any(|word| self.banned_words.contains(&word))
    }

    /// Replace banned words in text with `*` characters of the same length.
    ///
    /// Runs two passes (matching `has_banned_word`):
    /// - Pass 1: word-boundary tokenization (catches whole words)
    /// - Pass 2: squeezed pass (catches `f*u*c*k` separator bypasses)
    fn mask_banned_words(&self, text: &str) -> String {
        let lower = text.to_lowercase();
        let mut result = lower.clone();

        // Pass 1: word-boundary masking
        for (start, word) in word_positions(&lower) {
            if self.banned_words.contains(&word) {
                let end = start + word.len();
                let mask = "*".repeat(word.len());
                result.replace_range(start..end, &mask);
            }
        }

        // Pass 2: squeezed pass — detect separator bypasses
        // WHY: If the squeezed form matches but Pass 1 didn't catch it,
        // we need to mask the original characters that formed the word.
        let squeezed = squeeze(&lower);
        for (_, word) in word_positions(&squeezed) {
            if self.banned_words.contains(&word) {
                // Find and mask all alphanumeric chars that formed this word
                // in the original text. We scan for runs of the word's chars
                // interspersed with non-alphanumeric separators.
                result = mask_separated_word(&result, &word);
            }
        }

        result
    }
}

/// Mask a word that may be separated by non-alphanumeric characters in the text.
///
/// Example: `mask_separated_word("f*u*c*k you", "fuck")` → `"*******: you"`
/// Scans the text for the word's characters in order, treating non-alphanumeric
/// chars between them as part of the span to mask.
fn mask_separated_word(text: &str, word: &str) -> String {
    let text_lower = text.to_lowercase();
    let word_chars: Vec<char> = word.chars().collect();
    let text_chars: Vec<char> = text_lower.chars().collect();
    let mut result_chars: Vec<char> = text.chars().collect();

    let mut ti = 0;
    while ti < text_chars.len() {
        // Try to match the word starting at position ti
        let mut wi = 0;
        let mut scan = ti;
        let mut span_start = None;

        while scan < text_chars.len() && wi < word_chars.len() {
            if text_chars[scan] == word_chars[wi] {
                if span_start.is_none() {
                    span_start = Some(scan);
                }
                wi += 1;
                scan += 1;
            } else if !text_chars[scan].is_alphanumeric() {
                // Skip separators between word chars
                if span_start.is_some() {
                    scan += 1;
                } else {
                    break;
                }
            } else {
                // Different alphanumeric char — not a match
                break;
            }
        }

        if wi == word_chars.len() {
            if let Some(start) = span_start {
                // Mask the entire span (including separators)
                for c in &mut result_chars[start..scan] {
                    *c = '*';
                }
            }
            ti = scan;
        } else {
            ti += 1;
        }
    }

    result_chars.into_iter().collect()
}

// ── Normalization pipeline ─────────────────────────────────────────

/// Full normalization pipeline applied before banned-word matching.
///
/// 1. NFKC normalize (fullwidth→ASCII, mathematical symbols→ASCII)
/// 2. NFD decompose + strip combining marks (ü→u, é→e)
/// 3. Strip zero-width characters
fn normalize_text(text: &str) -> String {
    let nfkc: String = text.nfkc().collect();

    // WHY NFD after NFKC: NFKC handles compatibility decomposition (ﬁ→fi),
    // then NFD breaks accented chars into base+combining so we can strip marks.
    let stripped: String = nfkc
        .nfd()
        .filter(|c| {
            // Strip combining marks (accents, diacritics)
            if unicode_normalization::char::is_combining_mark(*c) {
                return false;
            }
            // Strip zero-width characters
            !matches!(
                *c,
                '\u{200B}' // zero-width space
                | '\u{200C}' // zero-width non-joiner
                | '\u{200D}' // zero-width joiner
                | '\u{2060}' // word joiner
                | '\u{FEFF}' // BOM / zero-width no-break space
                | '\u{200E}' // left-to-right mark
                | '\u{200F}' // right-to-left mark
                | '\u{202A}' // LTR embedding
                | '\u{202B}' // RTL embedding
                | '\u{202C}' // pop directional formatting
                | '\u{202D}' // LTR override
                | '\u{202E}' // RTL override
            )
        })
        .collect();

    stripped
}

/// Tokenize text into words by splitting on non-alphanumeric boundaries.
fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
}

/// "Squeeze" text: strip all non-alphanumeric characters except whitespace.
///
/// WHY: Catches separator-based bypasses like `f*u*c*k` → `fuck`, `s.h.i.t` → `shit`.
fn squeeze(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect()
}

/// Return (`byte_offset`, `lowercase_word`) for each word in the text.
fn word_positions(text: &str) -> Vec<(usize, String)> {
    let mut positions = Vec::new();
    let mut start = None;

    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start {
            let word = text[s..i].to_lowercase();
            positions.push((s, word));
            start = None;
        }
    }

    // Handle last word (no trailing non-alphanumeric)
    if let Some(s) = start {
        let word = text[s..].to_lowercase();
        positions.push((s, word));
    }

    positions
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    /// Helper: build a filter with a small custom word list for testing.
    fn test_filter(words: &[&str]) -> ContentFilter {
        let banned_words: HashSet<String> = words.iter().map(|w| w.to_lowercase()).collect();
        ContentFilter {
            banned_words,
            enabled: true,
        }
    }

    // ── check_hard ──────────────────────────────────────────────────

    #[test]
    fn hard_detects_banned_word() {
        let filter = test_filter(&["slurword"]);
        assert!(filter.check_hard("hello slurword there").is_err());
    }

    #[test]
    fn hard_allows_clean_text() {
        let filter = test_filter(&["slurword"]);
        assert!(filter.check_hard("hello world").is_ok());
    }

    #[test]
    fn hard_case_insensitive() {
        let filter = test_filter(&["slurword"]);
        assert!(filter.check_hard("SLURWORD").is_err());
        assert!(filter.check_hard("SlUrWoRd").is_err());
    }

    #[test]
    fn hard_no_partial_match_scunthorpe() {
        let filter = test_filter(&["ass"]);
        assert!(filter.check_hard("class").is_ok());
        assert!(filter.check_hard("assassin").is_ok());
        assert!(filter.check_hard("classic").is_ok());
    }

    #[test]
    fn hard_returns_validation_error() {
        let filter = test_filter(&["slurword"]);
        let err = filter.check_hard("slurword").unwrap_err();
        match err {
            DomainError::ValidationError(msg) => {
                assert_eq!(msg, "Content contains prohibited language");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    // ── check_soft ──────────────────────────────────────────────────

    #[test]
    fn soft_returns_clean_for_safe_text() {
        let filter = test_filter(&["slurword"]);
        assert!(matches!(
            filter.check_soft("hello world"),
            ModerationVerdict::Clean
        ));
    }

    #[test]
    fn soft_masks_banned_word_with_stars() {
        let filter = test_filter(&["slurword"]);
        match filter.check_soft("you are a slurword ok") {
            ModerationVerdict::Flagged {
                masked_content,
                reason,
            } => {
                // WHY: `*` is escaped as `\*` for markdown safety
                assert_eq!(masked_content, r"you are a \*\*\*\*\*\*\*\* ok");
                assert_eq!(reason, "Content violates community guidelines");
            }
            ModerationVerdict::Clean => panic!("Expected Flagged"),
        }
    }

    #[test]
    fn soft_preserves_word_length() {
        let filter = test_filter(&["bad"]);
        match filter.check_soft("this is bad text") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert_eq!(masked_content, r"this is \*\*\* text");
            }
            ModerationVerdict::Clean => panic!("Expected Flagged"),
        }
    }

    #[test]
    fn soft_reason_never_contains_matched_word() {
        let filter = test_filter(&["slurword"]);
        match filter.check_soft("slurword here") {
            ModerationVerdict::Flagged { reason, .. } => {
                assert!(!reason.contains("slurword"));
            }
            ModerationVerdict::Clean => panic!("Expected Flagged"),
        }
    }

    // ── Unicode normalization ────────────────────────────────────────

    #[test]
    fn unicode_nfkc_fullwidth() {
        // Fullwidth "ｆｕｃｋ" should match "fuck"
        let filter = test_filter(&["fuck"]);
        assert!(
            filter
                .check_hard("\u{FF46}\u{FF55}\u{FF43}\u{FF4B}")
                .is_err()
        );
    }

    #[test]
    fn unicode_combining_marks_stripped() {
        // "fück" → normalize → "fuck"
        let filter = test_filter(&["fuck"]);
        assert!(filter.check_hard("f\u{00FC}ck").is_err());
    }

    #[test]
    fn zero_width_chars_stripped() {
        // "f\u{200B}uck" → "fuck"
        let filter = test_filter(&["fuck"]);
        assert!(filter.check_hard("f\u{200B}uck").is_err());
    }

    // ── Squeezed pass (separator bypass) ─────────────────────────────

    #[test]
    fn separator_bypass_caught() {
        let filter = test_filter(&["fuck"]);
        assert!(filter.check_hard("f*u*c*k").is_err());
        assert!(filter.check_hard("f.u.c.k").is_err());
        assert!(filter.check_hard("f-u-c-k").is_err());
    }

    #[test]
    fn separator_bypass_with_markdown() {
        let filter = test_filter(&["fuck"]);
        // Markdown bold markers
        assert!(filter.check_hard("f**u**ck").is_err());
    }

    // ── Squeezed pass in check_soft (P0 fix) ────────────────────────

    #[test]
    fn soft_catches_separator_bypass() {
        let filter = test_filter(&["fuck"]);
        match filter.check_soft("you are f*u*c*k terrible") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(
                    !masked_content.contains("fuck"),
                    "masked content should not contain the word"
                );
                // WHY: `*` is escaped as `\*` for markdown safety
                assert!(
                    masked_content.contains(r"\*"),
                    "should have escaped asterisks"
                );
            }
            ModerationVerdict::Clean => {
                panic!("Expected Flagged — separator bypass should be caught by check_soft")
            }
        }
    }

    #[test]
    fn soft_masks_separator_bypass_preserves_rest() {
        let filter = test_filter(&["fuck"]);
        match filter.check_soft("hello f.u.c.k world") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(masked_content.contains("hello"));
                assert!(masked_content.contains("world"));
            }
            ModerationVerdict::Clean => panic!("Expected Flagged"),
        }
    }

    // ── mask_separated_word ─────────────────────────────────────────

    #[test]
    fn mask_separated_word_basic() {
        let result = mask_separated_word("f*u*c*k you", "fuck");
        assert!(result.starts_with("*******"), "Expected masked: {}", result);
        assert!(result.contains("you"));
    }

    #[test]
    fn mask_separated_word_no_match() {
        let result = mask_separated_word("hello world", "fuck");
        assert_eq!(result, "hello world");
    }

    // ── Noop filter ─────────────────────────────────────────────────

    #[test]
    fn noop_hard_always_ok() {
        let filter = ContentFilter::noop();
        assert!(filter.check_hard("slurword").is_ok());
    }

    #[test]
    fn noop_soft_always_clean() {
        let filter = ContentFilter::noop();
        assert!(matches!(
            filter.check_soft("slurword"),
            ModerationVerdict::Clean
        ));
    }

    // ── Edge cases ──────────────────────────────────────────────────

    #[test]
    fn empty_string_is_clean() {
        let filter = test_filter(&["slurword"]);
        assert!(filter.check_hard("").is_ok());
        assert!(matches!(filter.check_soft(""), ModerationVerdict::Clean));
    }

    #[test]
    fn whitespace_only_is_clean() {
        let filter = test_filter(&["slurword"]);
        assert!(filter.check_hard("   \t\n  ").is_ok());
    }

    #[test]
    fn exact_word_boundary_match() {
        let filter = test_filter(&["ass"]);
        // "ass" alone should match
        assert!(filter.check_hard("ass").is_err());
        // "ass" at word boundary should match
        assert!(filter.check_hard("you ass hole").is_err());
        // "ass" as part of a word should NOT match
        assert!(filter.check_hard("class").is_ok());
        assert!(filter.check_hard("massive").is_ok());
    }

    // ── Normalization helpers ────────────────────────────────────────

    #[test]
    fn normalize_strips_combining_marks() {
        let result = normalize_text("café");
        assert_eq!(result, "cafe");
    }

    #[test]
    fn normalize_strips_zero_width() {
        let result = normalize_text("he\u{200B}llo");
        assert_eq!(result, "hello");
    }

    #[test]
    fn normalize_fullwidth_to_ascii() {
        let result = normalize_text("\u{FF41}\u{FF42}\u{FF43}");
        assert_eq!(result, "abc");
    }

    #[test]
    fn squeeze_removes_separators() {
        assert_eq!(squeeze("f*u*c*k you"), "fuck you");
        assert_eq!(squeeze("s.h.i.t"), "shit");
        assert_eq!(squeeze("hello world"), "hello world");
    }

    #[test]
    fn word_positions_basic() {
        let positions = word_positions("hello world");
        assert_eq!(
            positions,
            vec![(0, "hello".to_string()), (6, "world".to_string())]
        );
    }

    #[test]
    fn word_positions_with_punctuation() {
        let positions = word_positions("hello, world!");
        assert_eq!(
            positions,
            vec![(0, "hello".to_string()), (7, "world".to_string())]
        );
    }
}
