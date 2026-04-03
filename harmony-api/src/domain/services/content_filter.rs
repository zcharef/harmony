//! Content moderation filter (`AutoMod`).
//!
//! WHY: Protects against abusive user-generated content (slurs, hate speech).
//! Pure domain logic — no I/O, no async. Word lists are embedded at compile time.
//!
//! Two enforcement tiers:
//! - `check_hard`: rejects input entirely (server names, usernames, etc.)
//! - `check_soft`: masks matched words with `****` (messages)

use std::collections::{HashMap, HashSet};

use regex::Regex;
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
    /// Collapsed forms: consecutive identical chars → 1. Catches "niggaaa" → "niga".
    /// Value = minimum input token length to accept a match.
    /// WHY: "ass" → collapsed "as". Without a min-length guard, the English word
    /// "as" would be a false positive. Requiring input ≥ 3 chars means "as" (2)
    /// doesn't match, but "asss" (4) and "kkkk" (4) do.
    collapsed_banned_words: HashMap<String, usize>,
    /// B5: Compiled regex for competitor invite link detection.
    invite_regex: Regex,
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

        // WHY: Pre-compute collapsed forms for repeated-char bypass detection.
        // Each entry stores the minimum input token length to accept a match.
        // "nigga" (5) → ("niga", 3), "kkk" (3) → ("k", 3), "ass" (3) → ("as", 3).
        // This means "as" (2 chars) won't match collapsed "as" (min 3), avoiding
        // false positives, while "asss" (4 ≥ 3) and "kkkk" (4 ≥ 3) still match.
        let mut collapsed_banned_words: HashMap<String, usize> = HashMap::new();
        for word in &banned_words {
            if word.len() >= 3 {
                let collapsed = collapse_repeats(word);
                // WHY: Use min() — if multiple banned words collapse to the same form,
                // keep the smallest min-length so the strictest check applies.
                let min_len = 3.min(word.len());
                collapsed_banned_words
                    .entry(collapsed)
                    .and_modify(|existing| *existing = (*existing).min(min_len))
                    .or_insert(min_len);
            }
        }

        tracing::info!(
            word_count = banned_words.len(),
            collapsed_count = collapsed_banned_words.len(),
            "ContentFilter loaded abuse word lists"
        );

        Self {
            banned_words,
            collapsed_banned_words,
            invite_regex: build_invite_regex(),
            enabled: true,
        }
    }

    /// Build a no-op filter (all checks pass). Used when content moderation is disabled.
    #[must_use]
    pub fn noop() -> Self {
        Self {
            banned_words: HashSet::new(),
            collapsed_banned_words: HashMap::new(),
            invite_regex: build_invite_regex(),
            enabled: false,
        }
    }

    /// Check if a word's collapsed form matches the collapsed banned set,
    /// respecting the minimum input length guard to prevent false positives.
    fn is_collapsed_match(&self, original_word: &str) -> bool {
        let collapsed = collapse_repeats(original_word);
        self.collapsed_banned_words
            .get(&collapsed)
            .is_some_and(|&min_len| original_word.len() >= min_len)
    }

    /// Tier 1: hard reject. Returns `Err(ValidationError)` if banned words are found.
    ///
    /// Used for structural inputs: server names, channel names, usernames, etc.
    /// Includes substring scan (Pass 5) that `check_soft` does not — catches
    /// concatenated slurs like "nigganigga" where the banned word is embedded
    /// inside a larger token.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ValidationError`] if the text contains banned words.
    pub fn check_hard(&self, text: &str) -> Result<(), DomainError> {
        if !self.enabled {
            return Ok(());
        }

        let normalized = normalize_text(text);

        if self.has_banned_word(&normalized) || self.has_banned_substring(&normalized) {
            return Err(DomainError::ValidationError(
                "Content contains prohibited language".to_string(),
            ));
        }

        Ok(())
    }

    /// Pass 5 (`check_hard` only): substring scan for concatenated slurs.
    ///
    /// WHY: Word-boundary tokenization treats "nigganigga" as a single token
    /// that doesn't match any exact entry. This pass checks if any banned word
    /// (≥ 5 chars) appears as a substring within any token that is longer than
    /// the banned word itself (exact matches are already caught by `has_banned_word`).
    ///
    /// The ≥ 5 char threshold avoids Scunthorpe-type false positives: "ass" (3)
    /// inside "assassin", "coon" (4) inside "raccoon", etc. The 4-char slurs
    /// ("kike", "coon", "gook", "dago") are still caught standalone by Pass 1
    /// exact word matching.
    ///
    /// WHY not in `check_soft`: for messages, word-boundary matching is sufficient
    /// and substring matching would over-mask legitimate words in sentences.
    fn has_banned_substring(&self, normalized: &str) -> bool {
        // WHY: Also apply to leet-decoded form so "n1ggan1gga" is caught.
        let decoded = leet_to_alpha(normalized);
        let inputs = if decoded == *normalized {
            vec![normalized.to_string()]
        } else {
            vec![normalized.to_string(), decoded]
        };

        for input in &inputs {
            for token in tokenize(input) {
                for banned in &self.banned_words {
                    if banned.len() >= 5
                        && token.len() > banned.len()
                        && token.contains(banned.as_str())
                    {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Tier 2: soft redact. Returns the masked version if banned words are found.
    ///
    /// Used for messages: preserves the message but replaces bad words with `****`.
    /// Operates on the normalized form to avoid byte-position mismatches between
    /// normalized and original text. The returned `masked_content` preserves the
    /// original casing while replacing banned words with `*` characters.
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

    /// B5: Check if the text contains competitor invite links.
    ///
    /// Only call for unencrypted messages (can't inspect ciphertext).
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::ValidationError`] if an invite link is detected.
    pub fn check_invite_links(&self, text: &str) -> Result<(), DomainError> {
        if !self.enabled {
            return Ok(());
        }

        // WHY: Normalize before regex to catch fullwidth character bypasses
        // (e.g., ｄｉｓｃｏｒｄ.gg) and zero-width character insertion
        // (e.g., d\u{200B}iscord.gg). Same pipeline used by word matching.
        let normalized = normalize_text(text);
        if self.invite_regex.is_match(&normalized) {
            return Err(DomainError::ValidationError(
                "Message contains blocked invite links".to_string(),
            ));
        }

        Ok(())
    }

    /// Check if any token in the normalized text matches a banned word.
    ///
    /// Six matching passes, ordered from cheapest to most aggressive:
    ///
    /// 1. Exact word match
    /// 2. Squeezed (separator bypass: `f*u*c*k`)
    ///    2b. Squeezed + collapsed (`n-i-g-g-a-a-a`)
    ///    2c. Squeezed + leet (`n-1-g-g-a`)
    /// 3. Collapsed repeats (`niggaaa`, `kkkk`)
    /// 4. Leet speak (`n1gga`, `@ss`) + leet+collapse (`n1ggaaa`)
    fn has_banned_word(&self, normalized: &str) -> bool {
        // Pass 1: word-boundary tokenization (exact match)
        if tokenize(normalized).any(|word| self.banned_words.contains(&word)) {
            return true;
        }

        // Pass 2: "squeezed" — catches separator bypasses like f*u*c*k
        let squeezed = squeeze(normalized);
        if tokenize(&squeezed).any(|word| self.banned_words.contains(&word)) {
            return true;
        }

        // Pass 2b: squeezed + collapsed — catches "n-i-g-g-a-a-a"
        if tokenize(&squeezed).any(|word| self.is_collapsed_match(&word)) {
            return true;
        }

        // Pass 2c: leet + squeezed — catches "n-1-g-g-a", "$-h-1-t"
        // WHY: Apply leet BEFORE squeeze. Squeeze strips `$`, `@`, `!` etc.
        // but those are leet substitutes. Decode first so `$-h-1-t` → `s-h-i-t`,
        // then squeeze → `shit`.
        let decoded_then_squeezed = squeeze(&leet_to_alpha(normalized));
        if decoded_then_squeezed != squeezed
            && tokenize(&decoded_then_squeezed)
                .any(|word| self.banned_words.contains(&word) || self.is_collapsed_match(&word))
        {
            return true;
        }

        // Pass 3: collapsed repeats — catches "niggaaa", "kkkk"
        if tokenize(normalized).any(|word| self.is_collapsed_match(&word)) {
            return true;
        }

        // Pass 4: leet speak — catches "n1gga", "@ss"
        // WHY: Apply leet decoding to the FULL text before tokenizing, because
        // leet chars like `@` and `!` are non-alphanumeric token boundaries.
        let decoded = leet_to_alpha(normalized);
        if decoded != *normalized
            && tokenize(&decoded)
                .any(|word| self.banned_words.contains(&word) || self.is_collapsed_match(&word))
        {
            return true;
        }

        false
    }

    /// Replace banned words in text with `*` characters of the same length.
    ///
    /// Mirrors the six passes in `has_banned_word`, masking each match.
    fn mask_banned_words(&self, text: &str) -> String {
        let lower = text.to_lowercase();
        // WHY: Start from original text to preserve casing. `lower` is used
        // only for matching. Byte offsets are stable because after NFKC
        // normalization the remaining chars are ASCII-safe for case folding.
        let mut result = text.to_string();

        // Pass 1: word-boundary masking
        for (start, word) in word_positions(&lower) {
            if self.banned_words.contains(&word) {
                let end = start + word.len();
                let mask = "*".repeat(word.len());
                result.replace_range(start..end, &mask);
            }
        }

        // Pass 2: squeezed pass — detect separator bypasses
        let squeezed = squeeze(&lower);
        for (_, word) in word_positions(&squeezed) {
            if self.banned_words.contains(&word) {
                result = mask_separated_word(&result, &word);
            }
        }

        // Pass 2b: squeezed + collapsed — catches "n-i-g-g-a-a-a"
        for (_, word) in word_positions(&squeezed) {
            if self.is_collapsed_match(&word) {
                result = mask_separated_word(&result, &word);
            }
        }

        // Pass 2c: leet + squeezed — catches "n-1-g-g-a", "$-h-1-t"
        // WHY: Leet decode the full text BEFORE squeezing, so `$` → `s` etc.
        let decoded_then_squeezed = squeeze(&leet_to_alpha(&lower));
        if decoded_then_squeezed != squeezed {
            for (_, word) in word_positions(&decoded_then_squeezed) {
                if self.banned_words.contains(&word) || self.is_collapsed_match(&word) {
                    result = mask_separated_word(&result, &word);
                }
            }
        }

        // Pass 3: collapsed repeats — mask "niggaaa", "kkkk" etc.
        // WHY: Only check words not already fully masked (still contain alphanumeric).
        for (start, word) in word_positions(&result) {
            if self.is_collapsed_match(&word) {
                let end = start + word.len();
                let mask = "*".repeat(word.len());
                result.replace_range(start..end, &mask);
            }
        }

        // Pass 4: leet speak — mask "n1gga", "@ss", "sh1t" etc.
        // WHY: Decode the full text first (leet chars are token boundaries),
        // then find banned words in the decoded form and mask the corresponding
        // positions in the original result.
        let decoded_result = leet_to_alpha(&result);
        if decoded_result != result {
            for (start, word) in word_positions(&decoded_result) {
                let is_match = self.banned_words.contains(&word) || self.is_collapsed_match(&word);
                if is_match {
                    let end = start + word.len();
                    let mask = "*".repeat(word.len());
                    result.replace_range(start..end, &mask);
                }
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

/// Build a compiled regex matching competitor chat platform invite links.
///
/// WHY: Single compiled regex is faster than multiple string contains checks.
/// Case-insensitive to catch `Discord.GG`, `T.ME`, etc.
#[allow(clippy::expect_used)] // WHY: Regex is a compile-time constant; panic is correct for invalid syntax.
fn build_invite_regex() -> Regex {
    Regex::new(
        r"(?i)(?:discord\.gg/|discord\.com/invite/|discordapp\.com/invite/|t\.me/|telegram\.me/|chat\.whatsapp\.com/|invite\.slack\.com/)"
    ).expect("invite regex must compile")
}

/// Full normalization pipeline applied before banned-word matching.
///
/// 1. NFKC normalize (fullwidth→ASCII, mathematical symbols→ASCII)
/// 2. NFD decompose + strip combining marks (ü→u, é→e)
/// 3. Strip zero-width characters
/// 4. Map cross-script confusables to ASCII (Cyrillic а→a, Greek ο→o, etc.)
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

    // Step 4: Map cross-script confusables to ASCII equivalents.
    // WHY: NFKC handles compatibility chars (fullwidth, math symbols) but NOT
    // cross-script homoglyphs. Cyrillic `а` and Latin `a` are distinct codepoints
    // that NFKC preserves as-is. Without this step, `аss` (Cyrillic а) bypasses
    // every word match pass.
    confusable_to_ascii(&stripped)
}

/// Map common cross-script confusable characters to their ASCII equivalents.
///
/// WHY: Covers the most frequent abuse vectors — Cyrillic and Greek letters that
/// are visually identical to Latin. This manual table handles ~50 characters
/// responsible for >99% of homoglyph attacks in chat apps. Characters already
/// ASCII are passed through unchanged (fast path).
fn confusable_to_ascii(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii() {
                return c;
            }
            match c {
                // Cyrillic → Latin
                '\u{0410}' | '\u{0430}' => 'a', // А а
                '\u{0412}' | '\u{0432}' => 'b', // В в (looks like B/b)
                '\u{0421}' | '\u{0441}' => 'c', // С с
                '\u{0415}' | '\u{0435}' => 'e', // Е е
                '\u{041D}' | '\u{043D}' => 'h', // Н н (looks like H/h)
                '\u{041A}' | '\u{043A}' => 'k', // К к
                '\u{041C}' | '\u{043C}' => 'm', // М м
                '\u{041E}' | '\u{043E}' => 'o', // О о
                '\u{0420}' | '\u{0440}' => 'p', // Р р
                '\u{0422}' | '\u{0442}' => 't', // Т т
                '\u{0425}' | '\u{0445}' => 'x', // Х х
                '\u{0423}' | '\u{0443}' => 'y', // У у
                '\u{0455}' => 's',              // ѕ (Cyrillic small letter DZE)
                '\u{0456}' => 'i', // і (Cyrillic small letter Byelorussian-Ukrainian I)
                '\u{0458}' => 'j', // ј (Cyrillic small letter JE)
                '\u{04BB}' => 'h', // һ (Cyrillic small letter SHHA)

                // Greek → Latin
                '\u{0391}' | '\u{03B1}' => 'a', // Α α
                '\u{0392}' | '\u{03B2}' => 'b', // Β β
                '\u{0395}' | '\u{03B5}' => 'e', // Ε ε
                '\u{0397}' | '\u{03B7}' => 'h', // Η η (capital looks like H)
                '\u{0399}' | '\u{03B9}' => 'i', // Ι ι
                '\u{039A}' | '\u{03BA}' => 'k', // Κ κ
                '\u{039C}' => 'm',              // Μ (Greek capital MU)
                '\u{039D}' => 'n',              // Ν (Greek capital NU — looks like N)
                '\u{03BD}' => 'v',              // ν (Greek small letter NU — looks like v)
                '\u{039F}' | '\u{03BF}' => 'o', // Ο ο
                '\u{03A1}' | '\u{03C1}' => 'p', // Ρ ρ
                '\u{03A4}' | '\u{03C4}' => 't', // Τ τ
                '\u{03A5}' | '\u{03C5}' => 'u', // Υ υ
                '\u{03A7}' | '\u{03C7}' => 'x', // Χ χ

                // Other common confusables
                '\u{0131}' => 'i', // ı (Latin small letter dotless I — Turkish)
                '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => '-', // various dashes
                _ => c,
            }
        })
        .collect()
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

/// Collapse consecutive runs of identical characters to a single character.
///
/// WHY: Catches repeated-char bypasses like `niggaaa` → `niga`, `fuuuck` → `fuck`.
fn collapse_repeats(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prev: Option<char> = None;
    for c in text.chars() {
        if prev != Some(c) {
            result.push(c);
        }
        prev = Some(c);
    }
    result
}

/// Replace common leet-speak substitutions with their alphabetic equivalents.
///
/// WHY: Catches `n1gga` → `nigga`, `@ss` → `ass`, `sh1t` → `shit`, `f4g` → `fag`.
fn leet_to_alpha(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '0' => 'o',
            '1' | '!' => 'i',
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '6' | '9' => 'g',
            '7' => 't',
            '8' => 'b',
            '+' => 't',
            '(' => 'c',
            _ => c,
        })
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
    /// Mirrors `ContentFilter::new()` logic for collapsed set construction.
    fn test_filter(words: &[&str]) -> ContentFilter {
        let banned_words: HashSet<String> = words.iter().map(|w| w.to_lowercase()).collect();
        let mut collapsed_banned_words: HashMap<String, usize> = HashMap::new();
        for word in &banned_words {
            if word.len() >= 3 {
                let collapsed = collapse_repeats(word);
                let min_len = 3.min(word.len());
                collapsed_banned_words
                    .entry(collapsed)
                    .and_modify(|existing| *existing = (*existing).min(min_len))
                    .or_insert(min_len);
            }
        }
        ContentFilter {
            banned_words,
            collapsed_banned_words,
            invite_regex: build_invite_regex(),
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
    fn soft_returns_clean_for_mixed_case_safe_text() {
        let filter = test_filter(&["slurword"]);
        // WHY: Regression — mask_banned_words previously lowercased the result,
        // so "xD" became "xd" which differed from normalized "xD", causing a
        // false Flagged verdict.
        assert!(matches!(filter.check_soft("xD"), ModerationVerdict::Clean));
        assert!(matches!(
            filter.check_soft("Hello World"),
            ModerationVerdict::Clean
        ));
        assert!(matches!(
            filter.check_soft("GG WP"),
            ModerationVerdict::Clean
        ));
    }

    #[test]
    fn soft_preserves_casing_around_masked_words() {
        let filter = test_filter(&["slurword"]);
        match filter.check_soft("Hey GUYS slurword BYE") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert_eq!(masked_content, r"Hey GUYS \*\*\*\*\*\*\*\* BYE");
            }
            ModerationVerdict::Clean => panic!("Expected Flagged"),
        }
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

    // ── B5: Invite link detection ─────────────────────────────────

    #[test]
    fn invite_blocks_discord() {
        let filter = ContentFilter::new();
        assert!(
            filter
                .check_invite_links("join us at discord.gg/abc123")
                .is_err()
        );
        assert!(
            filter
                .check_invite_links("https://discord.com/invite/xyz")
                .is_err()
        );
    }

    #[test]
    fn invite_blocks_telegram() {
        let filter = ContentFilter::new();
        assert!(filter.check_invite_links("join t.me/mychat").is_err());
        assert!(filter.check_invite_links("join telegram.me/group").is_err());
    }

    #[test]
    fn invite_blocks_whatsapp() {
        let filter = ContentFilter::new();
        assert!(
            filter
                .check_invite_links("https://chat.whatsapp.com/abc")
                .is_err()
        );
    }

    #[test]
    fn invite_blocks_slack() {
        let filter = ContentFilter::new();
        assert!(
            filter
                .check_invite_links("join invite.slack.com/shared_invite/abc")
                .is_err()
        );
    }

    #[test]
    fn invite_blocks_legacy_discord_domain() {
        let filter = ContentFilter::new();
        assert!(
            filter
                .check_invite_links("https://discordapp.com/invite/xyz")
                .is_err()
        );
    }

    #[test]
    fn invite_detected_in_longer_message() {
        let filter = ContentFilter::new();
        assert!(
            filter
                .check_invite_links(
                    "Hey everyone, come join our server at discord.gg/abc for more info!"
                )
                .is_err()
        );
    }

    #[test]
    fn invite_allows_clean_messages() {
        let filter = ContentFilter::new();
        assert!(filter.check_invite_links("hello world").is_ok());
        assert!(
            filter
                .check_invite_links("check out discord.com for more info")
                .is_ok()
        );
        assert!(filter.check_invite_links("message me on telegram").is_ok());
    }

    #[test]
    fn invite_case_insensitive() {
        let filter = ContentFilter::new();
        assert!(filter.check_invite_links("join DISCORD.GG/abc").is_err());
        assert!(filter.check_invite_links("join T.ME/group").is_err());
    }

    #[test]
    fn invite_noop_allows_all() {
        let filter = ContentFilter::noop();
        assert!(filter.check_invite_links("discord.gg/abc").is_ok());
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

    // ── Collapsed repeats (Pass 3) ──────────────────────────────────

    #[test]
    fn collapse_repeats_basic() {
        assert_eq!(collapse_repeats("niggaaa"), "niga");
        assert_eq!(collapse_repeats("fuuuck"), "fuck");
        assert_eq!(collapse_repeats("shiiiit"), "shit");
        assert_eq!(collapse_repeats("hello"), "helo");
    }

    #[test]
    fn collapse_repeats_preserves_short() {
        assert_eq!(collapse_repeats("as"), "as");
        assert_eq!(collapse_repeats("no"), "no");
    }

    #[test]
    fn hard_catches_repeated_chars() {
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("niggaaa").is_err());
        assert!(filter.check_hard("niggggga").is_err());
        assert!(filter.check_hard("nniiggaa").is_err());
    }

    #[test]
    fn hard_repeated_no_false_positive_on_short() {
        // WHY: "ass" collapsed is "as" (2 chars) — below the 3-char minimum.
        // This prevents "as" from being a false positive.
        let filter = test_filter(&["ass"]);
        assert!(filter.check_hard("as").is_ok());
    }

    #[test]
    fn soft_masks_repeated_chars() {
        let filter = test_filter(&["nigga"]);
        match filter.check_soft("hey niggaaa sup") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(
                    !masked_content.contains("niggaaa"),
                    "repeated-char bypass should be masked: {}",
                    masked_content
                );
            }
            ModerationVerdict::Clean => panic!("Expected Flagged for repeated-char bypass"),
        }
    }

    // ── Leet speak (Pass 4) ─────────────────────────────────────────

    #[test]
    fn leet_to_alpha_basic() {
        assert_eq!(leet_to_alpha("n1gga"), "nigga");
        assert_eq!(leet_to_alpha("@ss"), "ass");
        assert_eq!(leet_to_alpha("sh1t"), "shit");
        assert_eq!(leet_to_alpha("f4g"), "fag");
        assert_eq!(leet_to_alpha("hello"), "hello");
    }

    #[test]
    fn hard_catches_leet_speak() {
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("n1gga").is_err());
        assert!(filter.check_hard("n!gga").is_err());
    }

    #[test]
    fn hard_catches_leet_speak_other_words() {
        let filter = test_filter(&["ass", "shit"]);
        assert!(filter.check_hard("@ss").is_err());
        assert!(filter.check_hard("$h1t").is_err());
    }

    #[test]
    fn hard_catches_leet_plus_repeated() {
        // Combined: leet + repeated chars
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("n1ggaaa").is_err());
    }

    #[test]
    fn soft_masks_leet_speak() {
        let filter = test_filter(&["nigga"]);
        match filter.check_soft("hey n1gga sup") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(
                    !masked_content.contains("n1gga"),
                    "leet bypass should be masked: {}",
                    masked_content
                );
            }
            ModerationVerdict::Clean => panic!("Expected Flagged for leet bypass"),
        }
    }

    #[test]
    fn leet_no_false_positive() {
        // "a55" (number 55) should not match "ass" via leet
        // because leet_to_alpha("a55") = "ass" — this IS a match.
        // That's intentional: "a55" is a known leet-speak bypass for "ass".
        let filter = test_filter(&["ass"]);
        assert!(filter.check_hard("a55").is_err());
    }

    // ── P0 fix: kkk variants ────────────────────────────────────────

    #[test]
    fn hard_catches_kkk_variants() {
        let filter = test_filter(&["kkk"]);
        assert!(filter.check_hard("kkk").is_err());
        assert!(filter.check_hard("kkkk").is_err());
        assert!(filter.check_hard("kkkkkk").is_err());
    }

    // ── P1 fix: squeeze + collapse ──────────────────────────────────

    #[test]
    fn hard_catches_squeeze_plus_collapse() {
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("n-i-g-g-a-a-a").is_err());
        assert!(filter.check_hard("n.i.g.g.a.a.a").is_err());
    }

    #[test]
    fn hard_catches_squeeze_plus_collapse_other() {
        let filter = test_filter(&["fuck"]);
        assert!(filter.check_hard("f-u-u-u-c-k").is_err());
    }

    // ── P1 fix: squeeze + leet ──────────────────────────────────────

    #[test]
    fn hard_catches_squeeze_plus_leet() {
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("n-1-g-g-a").is_err());
    }

    #[test]
    fn hard_catches_squeeze_plus_leet_other() {
        let filter = test_filter(&["shit"]);
        assert!(filter.check_hard("$-h-1-t").is_err());
    }

    // ── P2 fix: leet 6→g, 9→g ───────────────────────────────────────

    #[test]
    fn leet_6_and_9_map_to_g() {
        assert_eq!(leet_to_alpha("ni6ga"), "nigga");
        assert_eq!(leet_to_alpha("ni9ga"), "nigga");
        assert_eq!(leet_to_alpha("fa6"), "fag");
    }

    #[test]
    fn hard_catches_leet_6_and_9() {
        let filter = test_filter(&["nigga", "fag"]);
        assert!(filter.check_hard("ni6ga").is_err());
        assert!(filter.check_hard("fa9").is_err());
    }

    // ── Edge cases for collapse_repeats ──────────────────────────────

    #[test]
    fn collapse_repeats_edge_cases() {
        assert_eq!(collapse_repeats(""), "");
        assert_eq!(collapse_repeats("a"), "a");
        assert_eq!(collapse_repeats("aaaa"), "a");
    }

    // ── Mixed bypass: multiple techniques in one message ─────────────

    #[test]
    fn soft_masks_mixed_bypasses() {
        let filter = test_filter(&["nigga", "fuck"]);
        match filter.check_soft("niggaaa and n1gga") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(
                    !masked_content.contains("niggaaa"),
                    "first bypass not masked: {}",
                    masked_content
                );
                assert!(
                    !masked_content.contains("n1gga"),
                    "second bypass not masked: {}",
                    masked_content
                );
            }
            ModerationVerdict::Clean => panic!("Expected Flagged for mixed bypasses"),
        }
    }

    // ── Pass 5: Substring scan (check_hard only) ────────────────────

    #[test]
    fn hard_catches_concatenated_slurs() {
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("nigganigga").is_err());
        assert!(filter.check_hard("xnigga").is_err());
        assert!(filter.check_hard("niggax").is_err());
    }

    #[test]
    fn hard_catches_concatenated_slurs_5plus_chars() {
        // WHY: "faggot" (6 chars) meets the ≥5 threshold for substring scan.
        let filter = test_filter(&["faggot"]);
        assert!(filter.check_hard("faggotfaggot").is_err());
        assert!(filter.check_hard("xfaggoty").is_err());
    }

    #[test]
    fn hard_4char_concatenated_not_caught() {
        // WHY: "fuck" (4 chars) is below the ≥5 substring threshold.
        // Concatenated forms are not caught — accepted trade-off.
        let filter = test_filter(&["fuck"]);
        assert!(filter.check_hard("fuckfuck").is_ok());
        assert!(filter.check_hard("xfucky").is_ok());
    }

    #[test]
    fn hard_catches_concatenated_leet_slurs() {
        // WHY: "n1ggan1gga" → leet decode → "nigganigga" → substring "nigga"
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("n1ggan1gga").is_err());
    }

    #[test]
    fn hard_substring_no_false_positive_short_words() {
        // WHY: Banned words < 5 chars are excluded from substring scan.
        // "ass" (3 chars) must NOT match inside "assassin" or "bassist".
        let filter = test_filter(&["ass"]);
        assert!(filter.check_hard("assassin").is_ok());
        assert!(filter.check_hard("bassist").is_ok());
    }

    #[test]
    fn hard_substring_no_false_positive_4char_scunthorpe() {
        // WHY: "coon" (4 chars) is below the ≥5 substring threshold.
        // "raccoonfan" and "scooner" must NOT be flagged by substring scan.
        // "coon" standalone IS caught by Pass 1 exact word match.
        let filter = test_filter(&["coon"]);
        assert!(filter.check_hard("raccoonfan").is_ok());
        assert!(filter.check_hard("scooner").is_ok());
        // Standalone still caught by exact match (Pass 1)
        assert!(filter.check_hard("coon").is_err());
    }

    #[test]
    fn hard_substring_still_catches_5char_slurs() {
        // WHY: "nigga" (5 chars) meets the ≥5 threshold, so substring scan
        // still catches it embedded inside longer tokens.
        let filter = test_filter(&["nigga"]);
        assert!(filter.check_hard("niggax").is_err());
        assert!(filter.check_hard("xnigga").is_err());
    }

    #[test]
    fn hard_4char_standalone_still_caught_by_exact_match() {
        // WHY: "kike" (4 chars) is below the substring threshold but
        // Pass 1 exact word match catches it as a standalone token.
        let filter = test_filter(&["kike"]);
        assert!(filter.check_hard("kike").is_err());
    }

    #[test]
    fn hard_4char_concatenated_not_caught_by_substring() {
        // WHY: "kike" (4 chars) is below the ≥5 substring threshold.
        // "kikekike" is a single token with no word boundary, so Pass 1
        // exact match won't find "kike" either. This is an accepted
        // trade-off to eliminate Scunthorpe false positives on 4-char words.
        let filter = test_filter(&["kike"]);
        assert!(filter.check_hard("kikekike").is_ok());
    }

    #[test]
    fn hard_substring_skips_exact_matches() {
        // WHY: Exact token matches are already caught by has_banned_word (Pass 1).
        // Substring scan only triggers when token.len() > banned.len().
        let filter = test_filter(&["nigga"]);
        // Exact match — caught by Pass 1, not substring scan
        assert!(filter.check_hard("nigga").is_err());
    }

    #[test]
    fn soft_does_not_use_substring_scan() {
        // WHY: Substring scan is check_hard only. check_soft should NOT flag
        // concatenated words — it would over-mask legitimate sentences.
        let filter = test_filter(&["fuck"]);
        assert!(matches!(
            filter.check_soft("fuckfuck"),
            ModerationVerdict::Clean
        ));
    }

    // ── Homoglyph / confusable detection ────────────────────────────

    #[test]
    fn confusable_to_ascii_cyrillic() {
        // Cyrillic а (U+0430) → Latin a
        assert_eq!(confusable_to_ascii("\u{0430}ss"), "ass");
        // Cyrillic с (U+0441) → Latin c, е (U+0435) → Latin e
        assert_eq!(confusable_to_ascii("fu\u{0441}k"), "fuck");
    }

    #[test]
    fn confusable_to_ascii_greek() {
        // Greek ο (U+03BF) → Latin o
        assert_eq!(confusable_to_ascii("f\u{03BF}\u{03BF}l"), "fool");
    }

    #[test]
    fn confusable_to_ascii_passthrough() {
        // Pure ASCII is unchanged
        assert_eq!(confusable_to_ascii("hello world"), "hello world");
        // Non-confusable Unicode is preserved
        assert_eq!(confusable_to_ascii("日本語"), "日本語");
    }

    #[test]
    fn hard_catches_cyrillic_homoglyph() {
        let filter = test_filter(&["ass"]);
        // "\u{0430}ss" = Cyrillic а + Latin ss → normalized to "ass"
        assert!(filter.check_hard("\u{0430}ss").is_err());
    }

    #[test]
    fn hard_catches_mixed_script_slur() {
        let filter = test_filter(&["nigga"]);
        // Mix Cyrillic and Latin to spell the word
        // n + і(U+0456) + g + g + а(U+0430)
        assert!(filter.check_hard("n\u{0456}gg\u{0430}").is_err());
    }

    #[test]
    fn soft_masks_homoglyph_bypass() {
        let filter = test_filter(&["fuck"]);
        // fu + Cyrillic с(U+0441) + k
        match filter.check_soft("hello fu\u{0441}k world") {
            ModerationVerdict::Flagged { masked_content, .. } => {
                assert!(
                    masked_content.contains(r"\*"),
                    "homoglyph bypass should be masked: {}",
                    masked_content
                );
            }
            ModerationVerdict::Clean => panic!("Expected Flagged for homoglyph bypass"),
        }
    }

    #[test]
    fn normalize_maps_confusables() {
        // Full pipeline: Cyrillic а → Latin a
        let result = normalize_text("\u{0430}bc");
        assert_eq!(result, "abc");
    }
}
