//! In-memory anti-spam guard backed by `DashMap`.
//!
//! Provides four protections:
//! - **A1 (Duplicate detection):** Rejects exact same message content within a window.
//! - **A3 (Flood detection):** Auto-mutes users who send too many messages in a window.
//! - **A3 (Mute enforcement):** Blocks muted users from sending messages.
//! - **A4 (ASCII art detection):** Rejects text art, Zalgo text, and symbol spam.
//!
//! All state is instance-local. When Harmony scales past one instance,
//! this needs a shared store (Redis or Postgres).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ServerId, UserId};

/// Window for duplicate detection (A1). Messages with the same hash within
/// this window are rejected.
const DUPLICATE_WINDOW: Duration = Duration::from_secs(30);

/// Flood detection window (A3). If a user sends more than `FLOOD_THRESHOLD`
/// messages within this window, they get auto-muted.
const FLOOD_WINDOW: Duration = Duration::from_secs(30);

/// Number of messages in `FLOOD_WINDOW` that triggers an auto-mute (A3).
const FLOOD_THRESHOLD: usize = 15;

/// Duration of an auto-mute (A3).
const MUTE_DURATION: Duration = Duration::from_secs(300); // 5 minutes

/// Maximum number of `@` mentions per message (A3).
pub const MAX_MENTIONS: usize = 10;

/// Stateful in-memory anti-spam guard.
///
/// WHY concrete struct, not a trait: `SpamGuard` is pure in-memory state with
/// zero I/O. Same reasoning as `ContentFilter` — no polymorphism benefit.
#[derive(Debug)]
pub struct SpamGuard {
    /// A1: Recent message hashes per (user, channel). Lazy eviction.
    recent_hashes: DashMap<(UserId, ChannelId), Vec<(Instant, u64)>>,
    /// A3: Flood counter — timestamps of recent messages per (user, server).
    flood_counts: DashMap<(UserId, ServerId), Vec<Instant>>,
    /// A3: Temporary mutes per (user, server).
    muted_until: DashMap<(UserId, ServerId), Instant>,
}

impl Default for SpamGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl SpamGuard {
    #[must_use]
    pub fn new() -> Self {
        Self {
            recent_hashes: DashMap::new(),
            flood_counts: DashMap::new(),
            muted_until: DashMap::new(),
        }
    }

    /// Check if a user is currently auto-muted in a server (A3).
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::RateLimited`] if the user is currently muted.
    pub fn check_muted(&self, user_id: &UserId, server_id: &ServerId) -> Result<(), DomainError> {
        let key = (user_id.clone(), server_id.clone());
        if let Some(entry) = self.muted_until.get(&key)
            && Instant::now() < *entry
        {
            return Err(DomainError::RateLimited(
                "You have been temporarily muted for flooding".to_string(),
            ));
        }
        // WHY: Atomic remove-if-expired avoids TOCTOU race between the get()
        // above and this remove. A concurrent record_message could insert a
        // fresh mute between the two calls — remove_if only removes if still expired.
        self.muted_until
            .remove_if(&key, |_, until| Instant::now() >= *until);
        Ok(())
    }

    /// Check if this message is a duplicate of a recently sent message (A1).
    ///
    /// Skips the check if `skip` is true (for encrypted messages where
    /// duplicate detection is meaningless — Megolm ratchet produces different
    /// ciphertexts for identical plaintexts).
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::RateLimited`] if a duplicate is detected.
    pub fn check_duplicate(
        &self,
        user_id: &UserId,
        channel_id: &ChannelId,
        content: &str,
        skip: bool,
    ) -> Result<(), DomainError> {
        if skip {
            return Ok(());
        }

        let hash = hash_content(content);
        let key = (user_id.clone(), channel_id.clone());
        let now = Instant::now();

        if let Some(mut entry) = self.recent_hashes.get_mut(&key) {
            // Lazy eviction: remove expired entries
            entry.retain(|(ts, _)| now.duration_since(*ts) < DUPLICATE_WINDOW);

            if entry.iter().any(|(_, h)| *h == hash) {
                return Err(DomainError::RateLimited(
                    "Duplicate message — please wait before resending".to_string(),
                ));
            }
        }

        Ok(())
    }

    /// Record a successfully sent message for duplicate detection (A1)
    /// and flood tracking (A3).
    ///
    /// Call this **after** the message is persisted to the database.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::RateLimited`] if the flood threshold is exceeded (auto-mute applied).
    pub fn record_message(
        &self,
        user_id: &UserId,
        channel_id: &ChannelId,
        server_id: &ServerId,
        content: &str,
        encrypted: bool,
    ) -> Result<(), DomainError> {
        let now = Instant::now();

        // A1: Record hash (skip for encrypted — different ciphertext each time)
        if !encrypted {
            let hash = hash_content(content);
            let key = (user_id.clone(), channel_id.clone());
            self.recent_hashes
                .entry(key)
                .and_modify(|entries| {
                    entries.retain(|(ts, _)| now.duration_since(*ts) < DUPLICATE_WINDOW);
                    entries.push((now, hash));
                })
                .or_insert_with(|| vec![(now, hash)]);
        }

        // A3: Record for flood detection
        // WHY: Consume flood_key in .entry() (hot path). Only clone for muted_until
        // insert (cold path — flood mute triggers on ~0.01% of messages).
        let flood_key = (user_id.clone(), server_id.clone());
        let mut flood_count = 0;
        self.flood_counts
            .entry(flood_key)
            .and_modify(|timestamps| {
                timestamps.retain(|ts| now.duration_since(*ts) < FLOOD_WINDOW);
                timestamps.push(now);
                flood_count = timestamps.len();
            })
            .or_insert_with(|| {
                flood_count = 1;
                vec![now]
            });

        // A3: Check flood threshold
        if flood_count >= FLOOD_THRESHOLD {
            let mute_until = now + MUTE_DURATION;
            let mute_key = (user_id.clone(), server_id.clone());
            self.muted_until.insert(mute_key, mute_until);
            tracing::warn!(
                user_id = %user_id,
                server_id = %server_id,
                message_count = flood_count,
                mute_seconds = MUTE_DURATION.as_secs(),
                "User auto-muted for flooding"
            );
            return Err(DomainError::RateLimited(
                "Too many messages — you have been temporarily muted".to_string(),
            ));
        }

        Ok(())
    }

    /// Remove all expired state: mutes, stale hash entries, and stale flood counters.
    /// Call periodically from a background sweep task.
    ///
    /// Follows the `PgPresenceTracker::sweep_stale` pattern.
    pub fn sweep_expired(&self) {
        let now = Instant::now();

        // Sweep mutes
        let mute_before = self.muted_until.len();
        self.muted_until.retain(|_, until| now < *until);
        // WHY: saturating_sub avoids underflow if a concurrent insert happens
        // between retain() and this .len() call.
        let mutes_removed = mute_before.saturating_sub(self.muted_until.len());

        // Sweep stale hash entries (entries with all timestamps expired)
        let hash_before = self.recent_hashes.len();
        self.recent_hashes.retain(|_, entries| {
            entries.retain(|(ts, _)| now.duration_since(*ts) < DUPLICATE_WINDOW);
            !entries.is_empty()
        });
        let hashes_removed = hash_before.saturating_sub(self.recent_hashes.len());

        // Sweep stale flood counters (entries with all timestamps expired)
        let flood_before = self.flood_counts.len();
        self.flood_counts.retain(|_, timestamps| {
            timestamps.retain(|ts| now.duration_since(*ts) < FLOOD_WINDOW);
            !timestamps.is_empty()
        });
        let floods_removed = flood_before.saturating_sub(self.flood_counts.len());

        if mutes_removed > 0 || hashes_removed > 0 || floods_removed > 0 {
            tracing::debug!(
                mutes_removed,
                hashes_removed,
                floods_removed,
                "Swept expired SpamGuard entries"
            );
        }
    }
}

/// Fast, non-cryptographic hash of message content for duplicate detection.
fn hash_content(content: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// Count `@` mentions in message content using the `<@uuid>` format.
///
/// Returns the number of mention markers found (not deduplicated). Used for A3 mention limits.
#[must_use]
pub fn count_mentions(content: &str) -> usize {
    // WHY: Simple substring scan instead of regex — avoids regex dependency
    // for a fixed pattern. The <@ prefix is unambiguous in message content.
    content.matches("<@").count()
}

// ── ASCII art / text art detection ─────────────────────────────────

/// Minimum content length (after stripping code blocks) to trigger ASCII art
/// detection. Messages shorter than this are exempt — avoids false positives
/// on kaomoji, casual special chars, and short decorative text.
const ASCII_ART_MIN_LENGTH: usize = 200;

/// Score threshold for rejecting a message as ASCII art / text art.
/// A message is rejected when accumulated score >= this value.
const ASCII_ART_SCORE_THRESHOLD: u32 = 3;

/// Maximum combining marks per base character before it's considered Zalgo.
/// Normal accented text (Vietnamese, Arabic diacritics, IPA) rarely exceeds 2.
const ZALGO_MARKS_PER_CHAR: usize = 3;

/// Minimum Zalgo-affected base characters to trigger the Zalgo signal.
const ZALGO_MIN_AFFECTED: usize = 5;

/// Minimum text-art Unicode characters to trigger the text-art signal.
const TEXTART_MIN_CHARS: usize = 15;

/// Minimum ratio of text-art chars to non-whitespace chars (0.0–1.0).
const TEXTART_MIN_RATIO: f64 = 0.20;

/// Special character density threshold (0.0–1.0). "Special" excludes
/// alphanumeric, whitespace, and common punctuation (`.,:;!?'"-`).
const SPECIAL_DENSITY_THRESHOLD: f64 = 0.40;

/// A single run of identical special characters longer than this triggers the
/// repeated-run signal on its own.
const REPEATED_RUN_INSTANT: usize = 8;

/// Number of distinct runs of `REPEATED_RUN_CLUSTER` length that collectively
/// trigger the repeated-run signal.
const REPEATED_RUN_CLUSTER_COUNT: usize = 3;

/// Minimum run length counted toward the cluster threshold.
const REPEATED_RUN_CLUSTER_LEN: usize = 5;

/// Minimum number of "art-like" lines to trigger the line-pattern signal.
const ART_LINES_MIN: usize = 5;

/// Check if message content contains ASCII art, text art, or Zalgo text.
///
/// Uses a multi-signal scoring heuristic: each detected pattern adds points,
/// and the message is rejected when the total reaches [`ASCII_ART_SCORE_THRESHOLD`].
///
/// Content inside markdown fenced code blocks (` ``` `) is exempt.
/// Messages shorter than [`ASCII_ART_MIN_LENGTH`] (after stripping code blocks)
/// are exempt.
///
/// # Errors
///
/// Returns [`DomainError::ValidationError`] if ASCII art patterns are detected.
#[must_use = "caller must propagate the rejection to the user"]
pub fn check_ascii_art(content: &str) -> Result<(), DomainError> {
    let stripped = strip_code_blocks(content);

    // WHY: Zalgo check runs BEFORE the length gate because even a short Zalgo
    // string (e.g., 5 stacked chars = ~105 codepoints) is visually disruptive
    // and has zero legitimate chat use. Other signals are gated by length
    // because short kaomoji/emoji/decorative text is harmless.
    if count_zalgo_chars(&stripped) >= ZALGO_MIN_AFFECTED {
        return Err(DomainError::ValidationError(
            "Message blocked — detected as text art or symbol spam".to_string(),
        ));
    }

    if stripped.chars().count() < ASCII_ART_MIN_LENGTH {
        return Ok(());
    }

    let mut score: u32 = 0;

    // Signal 2: Text-art Unicode ranges (box-drawing, block, braille, geometric) — +3.
    let textart_count = count_textart_chars(&stripped);
    let non_ws_count = stripped.chars().filter(|c| !c.is_whitespace()).count();
    if non_ws_count > 0 && textart_count >= TEXTART_MIN_CHARS {
        #[allow(clippy::cast_precision_loss)] // WHY: counts are << f64 max
        let ratio = textart_count as f64 / non_ws_count as f64;
        if ratio > TEXTART_MIN_RATIO {
            score += 3;
        }
    }

    if score >= ASCII_ART_SCORE_THRESHOLD {
        return Err(DomainError::ValidationError(
            "Message blocked — detected as text art or symbol spam".to_string(),
        ));
    }

    // Signal 3: High special-character density — +2 (or +3 if extreme).
    // WHY: Strip URL-like substrings first to avoid false positives on links.
    let url_stripped = strip_urls(&stripped);
    let (special_count, eligible_count) = count_special_chars(&url_stripped);
    if eligible_count > 0 {
        #[allow(clippy::cast_precision_loss)]
        let density = special_count as f64 / eligible_count as f64;
        if density >= 0.70 {
            // WHY: > 70% special chars is extreme — virtually no legitimate
            // message has this ratio. Score +3 for instant reject.
            score += 3;
        } else if density > SPECIAL_DENSITY_THRESHOLD {
            score += 2;
        }
    }

    // Signal 4: Repeated special-character runs — +2.
    let (max_run, cluster_count) = repeated_char_runs(&stripped, REPEATED_RUN_CLUSTER_LEN);
    if max_run > REPEATED_RUN_INSTANT || cluster_count >= REPEATED_RUN_CLUSTER_COUNT {
        score += 2;
    }

    if score >= ASCII_ART_SCORE_THRESHOLD {
        return Err(DomainError::ValidationError(
            "Message blocked — detected as text art or symbol spam".to_string(),
        ));
    }

    // Signal 5: Line-based pattern (many lines with high non-alnum density) — +1.
    if count_art_lines(&stripped) >= ART_LINES_MIN {
        score += 1;
    }

    if score >= ASCII_ART_SCORE_THRESHOLD {
        return Err(DomainError::ValidationError(
            "Message blocked — detected as text art or symbol spam".to_string(),
        ));
    }

    Ok(())
}

/// Strip fenced code blocks (` ``` `) from content.
///
/// Replaces code block content (including fences) with a single space to
/// preserve rough character count without polluting signal detection.
/// Unpaired fences are left as-is (treated as non-code).
fn strip_code_blocks(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut rest = content;

    while let Some(open_pos) = rest.find("```") {
        result.push_str(&rest[..open_pos]);

        let after_open = &rest[open_pos + 3..];
        let after_lang = match after_open.find('\n') {
            Some(nl) => &after_open[nl + 1..],
            None => {
                // WHY: No newline means the fence is at EOF — can't be paired
                result.push_str(&rest[open_pos..]);
                return result;
            }
        };

        match after_lang.find("```") {
            Some(close_pos) => {
                let after_close = &after_lang[close_pos + 3..];
                result.push(' ');
                rest = after_close;
            }
            None => {
                // WHY: Unpaired fences are ambiguous — preserve as literal text
                result.push_str(&rest[open_pos..]);
                return result;
            }
        }
    }

    result.push_str(rest);
    result
}

/// Count base characters that have more than [`ZALGO_MARKS_PER_CHAR`] combining
/// marks stacked on them.
fn count_zalgo_chars(text: &str) -> usize {
    let mut zalgo_count = 0;
    let mut combining_count = 0;

    for c in text.chars() {
        if unicode_normalization::char::is_combining_mark(c) {
            combining_count += 1;
        } else {
            if combining_count > ZALGO_MARKS_PER_CHAR {
                zalgo_count += 1;
            }
            combining_count = 0;
        }
    }

    if combining_count > ZALGO_MARKS_PER_CHAR {
        zalgo_count += 1;
    }

    zalgo_count
}

/// Check if a character belongs to a text-art Unicode range.
fn is_textart_char(c: char) -> bool {
    matches!(c,
        '\u{2500}'..='\u{257F}' // Box-drawing characters
        | '\u{2580}'..='\u{259F}' // Block elements
        | '\u{2800}'..='\u{28FF}' // Braille patterns
        | '\u{25A0}'..='\u{25FF}' // Geometric shapes
    )
}

/// Count characters in text-art Unicode ranges.
fn count_textart_chars(text: &str) -> usize {
    text.chars().filter(|c| is_textart_char(*c)).count()
}

/// Count "special" characters and eligible (non-whitespace) characters.
///
/// "Special" = not alphanumeric, not whitespace, not common punctuation, not emoji.
/// Common punctuation and emoji are excluded to avoid false positives on
/// normal prose and emoji-heavy messages.
///
/// Returns `(special_count, eligible_count)` where eligible = non-whitespace chars.
fn count_special_chars(text: &str) -> (usize, usize) {
    let mut special = 0;
    let mut eligible = 0;

    for c in text.chars() {
        if c.is_whitespace() {
            continue;
        }
        eligible += 1;
        if !c.is_alphanumeric() && !is_common_punctuation(c) && !is_emoji(c) {
            special += 1;
        }
    }

    (special, eligible)
}

/// Check if a character falls within common emoji Unicode ranges.
///
/// WHY: Emoji are content (emotional expression), not decorative symbols.
/// Without this exclusion, emoji-heavy messages would inflate the special-char
/// density score and trigger false positives.
fn is_emoji(c: char) -> bool {
    matches!(c,
        '\u{1F600}'..='\u{1F64F}' // Emoticons
        | '\u{1F300}'..='\u{1F5FF}' // Miscellaneous Symbols and Pictographs
        | '\u{1F680}'..='\u{1F6FF}' // Transport and Map Symbols
        | '\u{1F900}'..='\u{1F9FF}' // Supplemental Symbols and Pictographs
        | '\u{1FA00}'..='\u{1FA6F}' // Chess Symbols
        | '\u{1FA70}'..='\u{1FAFF}' // Symbols and Pictographs Extended-A
        | '\u{2702}'..='\u{27B0}'   // Dingbats
        | '\u{FE00}'..='\u{FE0F}'   // Variation Selectors
        | '\u{200D}'                // ZWJ (emoji sequences)
        | '\u{20E3}'                // Combining Enclosing Keycap
        | '\u{E0020}'..='\u{E007F}' // Tags (flag sequences)
    )
}

/// Common punctuation that should NOT count as "special" for density scoring.
fn is_common_punctuation(c: char) -> bool {
    matches!(
        c,
        '.' | ',' | ':' | ';' | '!' | '?' | '\'' | '"' | '-' | '(' | ')' | '[' | ']'
    )
}

/// Strip URL-like substrings from text to avoid false positives on links.
///
/// WHY: URLs contain many special characters (`://`, `?`, `&`, `=`, `%`, `#`)
/// that would inflate the special-character density score.
fn strip_urls(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(pos) = rest.find("http") {
        let candidate = &rest[pos..];
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            result.push_str(&rest[..pos]);
            let url_end = candidate
                .find(char::is_whitespace)
                .unwrap_or(candidate.len());
            result.push(' ');
            rest = &candidate[url_end..];
        } else {
            result.push_str(&rest[..pos + 4]);
            rest = &rest[pos + 4..];
        }
    }

    result.push_str(rest);
    result
}

/// Find repeated runs of identical non-alphanumeric, non-whitespace characters.
///
/// Returns `(max_run_length, count_of_runs_over_threshold)`.
fn repeated_char_runs(text: &str, run_threshold: usize) -> (usize, usize) {
    let mut max_run: usize = 0;
    let mut cluster_count: usize = 0;
    let mut current_char: Option<char> = None;
    let mut current_run: usize = 0;

    for c in text.chars() {
        if c.is_alphanumeric() || c.is_whitespace() {
            if current_run > max_run {
                max_run = current_run;
            }
            if current_run >= run_threshold {
                cluster_count += 1;
            }
            current_char = None;
            current_run = 0;
            continue;
        }

        if current_char == Some(c) {
            current_run += 1;
        } else {
            if current_run > max_run {
                max_run = current_run;
            }
            if current_run >= run_threshold {
                cluster_count += 1;
            }
            current_char = Some(c);
            current_run = 1;
        }
    }

    if current_run > max_run {
        max_run = current_run;
    }
    if current_run >= run_threshold {
        cluster_count += 1;
    }

    (max_run, cluster_count)
}

/// Count lines where > 50% of non-whitespace characters are non-alphanumeric.
fn count_art_lines(text: &str) -> usize {
    text.lines()
        .filter(|line| {
            // WHY: Single-pass fold avoids per-line Vec<char> heap allocation.
            let (non_ws, non_alnum) = line.chars().fold((0usize, 0usize), |(nw, na), c| {
                if c.is_whitespace() {
                    (nw, na)
                } else if c.is_alphanumeric() {
                    (nw + 1, na)
                } else {
                    (nw + 1, na + 1)
                }
            });
            if non_ws == 0 {
                return false;
            }
            #[allow(clippy::cast_precision_loss)]
            let ratio = non_alnum as f64 / non_ws as f64;
            ratio > 0.5
        })
        .count()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn user(n: u32) -> UserId {
        UserId::new(uuid::Uuid::from_u128(u128::from(n)))
    }

    fn channel(n: u32) -> ChannelId {
        ChannelId::new(uuid::Uuid::from_u128(u128::from(n)))
    }

    fn server(n: u32) -> ServerId {
        ServerId::new(uuid::Uuid::from_u128(u128::from(n)))
    }

    // ── A1: Duplicate detection ─────────────────────────────────────

    #[test]
    fn duplicate_detected_within_window() {
        let guard = SpamGuard::new();
        let u = user(1);
        let c = channel(1);
        let s = server(1);

        // First message: allowed
        assert!(guard.check_duplicate(&u, &c, "hello", false).is_ok());
        guard.record_message(&u, &c, &s, "hello", false).unwrap();

        // Same content: rejected
        assert!(guard.check_duplicate(&u, &c, "hello", false).is_err());
    }

    #[test]
    fn different_content_allowed() {
        let guard = SpamGuard::new();
        let u = user(1);
        let c = channel(1);
        let s = server(1);

        guard.record_message(&u, &c, &s, "hello", false).unwrap();
        assert!(guard.check_duplicate(&u, &c, "world", false).is_ok());
    }

    #[test]
    fn different_channel_allowed() {
        let guard = SpamGuard::new();
        let u = user(1);
        let c1 = channel(1);
        let c2 = channel(2);
        let s = server(1);

        guard.record_message(&u, &c1, &s, "hello", false).unwrap();
        // Same content, different channel: allowed
        assert!(guard.check_duplicate(&u, &c2, "hello", false).is_ok());
    }

    #[test]
    fn different_user_allowed() {
        let guard = SpamGuard::new();
        let u1 = user(1);
        let u2 = user(2);
        let c = channel(1);
        let s = server(1);

        guard.record_message(&u1, &c, &s, "hello", false).unwrap();
        // Same content, different user: allowed
        assert!(guard.check_duplicate(&u2, &c, "hello", false).is_ok());
    }

    #[test]
    fn encrypted_messages_skip_duplicate_check() {
        let guard = SpamGuard::new();
        let u = user(1);
        let c = channel(1);
        let s = server(1);

        guard.record_message(&u, &c, &s, "hello", true).unwrap();
        // Skip=true bypasses the check entirely
        assert!(guard.check_duplicate(&u, &c, "hello", true).is_ok());
    }

    // ── A3: Flood detection ─────────────────────────────────────────

    #[test]
    fn flood_triggers_auto_mute() {
        let guard = SpamGuard::new();
        let u = user(1);
        let c = channel(1);
        let s = server(1);

        // Send FLOOD_THRESHOLD - 1 messages (all allowed)
        for i in 0..FLOOD_THRESHOLD - 1 {
            assert!(
                guard
                    .check_duplicate(&u, &c, &format!("msg-{i}"), false)
                    .is_ok()
            );
            assert!(
                guard
                    .record_message(&u, &c, &s, &format!("msg-{i}"), false)
                    .is_ok(),
                "Message {i} should be allowed"
            );
        }

        // The FLOOD_THRESHOLD-th message triggers mute
        let msg = format!("msg-{}", FLOOD_THRESHOLD - 1);
        assert!(guard.check_duplicate(&u, &c, &msg, false).is_ok());
        let result = guard.record_message(&u, &c, &s, &msg, false);
        assert!(result.is_err(), "Should trigger flood mute");

        // Now the user is muted
        assert!(guard.check_muted(&u, &s).is_err());
    }

    #[test]
    fn unmuted_user_passes_check() {
        let guard = SpamGuard::new();
        assert!(guard.check_muted(&user(1), &server(1)).is_ok());
    }

    #[test]
    fn expired_mute_lazily_cleaned_by_check() {
        let guard = SpamGuard::new();
        let u = user(1);
        let s = server(1);

        // Insert an already-expired mute
        guard.muted_until.insert(
            (u.clone(), s.clone()),
            Instant::now() - Duration::from_secs(1),
        );

        // check_muted should pass (mute expired) and lazily clean up the entry
        assert!(guard.check_muted(&u, &s).is_ok());
        assert!(
            guard.muted_until.is_empty(),
            "Expired mute should be lazily removed"
        );
    }

    // ── A3: Mention counting ────────────────────────────────────────

    #[test]
    fn count_mentions_basic() {
        assert_eq!(count_mentions("hello <@abc-def> and <@xyz-123>"), 2);
    }

    #[test]
    fn count_mentions_none() {
        assert_eq!(count_mentions("hello world"), 0);
    }

    #[test]
    fn count_mentions_at_sign_without_bracket() {
        // Plain @ signs are NOT mentions (only <@ format)
        assert_eq!(count_mentions("hello @everyone"), 0);
    }

    // ── Sweep ───────────────────────────────────────────────────────

    #[test]
    fn sweep_removes_expired_mutes() {
        let guard = SpamGuard::new();
        let key = (user(1), server(1));

        // Insert an already-expired mute
        guard
            .muted_until
            .insert(key, Instant::now() - Duration::from_secs(1));

        guard.sweep_expired();
        assert!(guard.muted_until.is_empty());
    }

    #[test]
    fn sweep_keeps_active_mutes() {
        let guard = SpamGuard::new();
        let key = (user(1), server(1));

        // Insert a mute that expires in the future
        guard
            .muted_until
            .insert(key, Instant::now() + Duration::from_secs(300));

        guard.sweep_expired();
        assert_eq!(guard.muted_until.len(), 1);
    }

    #[test]
    fn sweep_removes_stale_hash_entries() {
        let guard = SpamGuard::new();
        let key = (user(1), channel(1));

        // Insert an entry with an expired timestamp
        guard
            .recent_hashes
            .insert(key, vec![(Instant::now() - Duration::from_secs(60), 12345)]);

        guard.sweep_expired();
        assert!(guard.recent_hashes.is_empty());
    }

    #[test]
    fn sweep_removes_stale_flood_entries() {
        let guard = SpamGuard::new();
        let key = (user(1), server(1));

        // Insert an entry with an expired timestamp
        guard
            .flood_counts
            .insert(key, vec![Instant::now() - Duration::from_secs(60)]);

        guard.sweep_expired();
        assert!(guard.flood_counts.is_empty());
    }

    // ── A4: ASCII art detection ────────────────────────────────────

    /// Helper: pad a string to at least 200 chars so it isn't exempt.
    fn pad(s: &str) -> String {
        let char_count = s.chars().count();
        if char_count >= ASCII_ART_MIN_LENGTH {
            return s.to_string();
        }
        let padding_needed = ASCII_ART_MIN_LENGTH - char_count;
        format!("{s}{}", " a]".repeat(padding_needed / 3 + 1))
    }

    #[test]
    fn ascii_art_short_message_exempt() {
        // Under 200 chars — always passes, even with heavy special chars
        assert!(check_ascii_art("( ^_^)/  ┊  ★  ┊  \\(^_^ )").is_ok());
        assert!(check_ascii_art("═══════════════════").is_ok());
    }

    #[test]
    fn ascii_art_normal_text_passes() {
        let text = pad(
            "Hello, how are you doing today? I'm fine, thanks for asking! \
            Let me tell you about my day. It was really interesting because I went to \
            the store and found some great deals on groceries.",
        );
        assert!(check_ascii_art(&text).is_ok());
    }

    #[test]
    fn ascii_art_markdown_formatting_passes() {
        let text = pad("**Bold text** and *italic text* and ~~strikethrough~~ and \
            `inline code` and [a link](https://example.com) with some normal text \
            to make it long enough for the check.");
        assert!(check_ascii_art(&text).is_ok());
    }

    #[test]
    fn ascii_art_urls_pass() {
        let text = pad(
            "Check out https://example.com/path?foo=bar&baz=qux#section \
            and also https://another.site/api/v2?key=val&other=123%20test for more \
            info about the project.",
        );
        assert!(check_ascii_art(&text).is_ok());
    }

    #[test]
    fn ascii_art_emoji_heavy_passes() {
        // WHY: Emoji are content, not decoration — a message with many emoji
        // should not trigger the special-char density signal.
        let emoji_msg = pad(
            "So excited about this release! \u{1F600}\u{1F600}\u{1F600}\u{1F389}\u{1F389}\
            \u{1F525}\u{1F525}\u{1F525}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}\
            \u{1F60D}\u{1F60D}\u{1F60D}\u{1F60D}\u{1F60D}\u{1F60D}\u{1F60D}\u{1F60D}\
            \u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}",
        );
        assert!(
            check_ascii_art(&emoji_msg).is_ok(),
            "Emoji-heavy messages should pass"
        );
    }

    #[test]
    fn ascii_art_code_block_exempt() {
        let text = format!(
            "Here is a TUI example:\n```\n{}\n```\nPretty cool right? {}",
            "┌───────────┐\n│  Hello    │\n│  World    │\n│  Test     │\n│  Line     │\n└───────────┘",
            "a ".repeat(100)
        );
        assert!(check_ascii_art(&text).is_ok());
    }

    #[test]
    fn ascii_art_braille_art_rejected() {
        let braille = "\
            ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣀⣀⣀⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀\n\
            ⠀⠀⠀⠀⠀⠀⢀⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⡀⠀⠀⠀⠀⠀⠀\n\
            ⠀⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀⠀⠀⠀⠀\n\
            ⠀⠀⠀⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀\n\
            ⠀⢀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀⠀\n\
            ⠀⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀\n\
            ⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇\n\
            ⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀";
        assert!(
            check_ascii_art(braille).is_err(),
            "Braille pixel art should be rejected"
        );
    }

    #[test]
    fn ascii_art_box_drawing_rejected() {
        let box_art = "\
            ╔══════════════════════════════════════╗\n\
            ║                                      ║\n\
            ║         ASCII ART IS HERE            ║\n\
            ║                                      ║\n\
            ║     This is a big decorative box     ║\n\
            ║     that spans multiple lines and    ║\n\
            ║     takes up lots of space           ║\n\
            ║                                      ║\n\
            ╚══════════════════════════════════════╝";
        assert!(
            check_ascii_art(box_art).is_err(),
            "Box-drawing wall should be rejected"
        );
    }

    #[test]
    fn ascii_art_zalgo_rejected() {
        // Each base char has 20+ combining marks
        let zalgo = "H\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}\u{0307}\u{0308}\u{0309}\u{030A}\u{030B}\u{030C}\u{030D}\u{030E}\u{030F}\u{0310}\u{0311}\u{0312}\u{0313}\
            e\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}\u{0307}\u{0308}\u{0309}\u{030A}\u{030B}\u{030C}\u{030D}\u{030E}\u{030F}\u{0310}\u{0311}\u{0312}\u{0313}\
            l\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}\u{0307}\u{0308}\u{0309}\u{030A}\u{030B}\u{030C}\u{030D}\u{030E}\u{030F}\u{0310}\u{0311}\u{0312}\u{0313}\
            l\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}\u{0307}\u{0308}\u{0309}\u{030A}\u{030B}\u{030C}\u{030D}\u{030E}\u{030F}\u{0310}\u{0311}\u{0312}\u{0313}\
            o\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\u{0306}\u{0307}\u{0308}\u{0309}\u{030A}\u{030B}\u{030C}\u{030D}\u{030E}\u{030F}\u{0310}\u{0311}\u{0312}\u{0313}";
        let padded = format!("{zalgo}{}", " a".repeat(100));
        assert!(
            check_ascii_art(&padded).is_err(),
            "Zalgo text should be rejected"
        );
    }

    #[test]
    fn ascii_art_short_zalgo_rejected() {
        // WHY: Zalgo runs before the 200-char length gate because even short
        // Zalgo text is visually disruptive and has zero legitimate use.
        let short_zalgo = "H\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\
            e\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\
            l\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\
            l\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}\
            o\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\u{0305}";
        assert!(
            short_zalgo.chars().count() < ASCII_ART_MIN_LENGTH,
            "Test setup: must be under 200 chars"
        );
        assert!(
            check_ascii_art(short_zalgo).is_err(),
            "Short Zalgo text should still be rejected"
        );
    }

    #[test]
    fn ascii_art_repeated_symbol_wall_rejected() {
        let wall = format!("{}\n{}\n{}", "═".repeat(70), "░".repeat(70), "═".repeat(70));
        assert!(
            check_ascii_art(&wall).is_err(),
            "Repeated symbol wall should be rejected"
        );
    }

    #[test]
    fn ascii_art_symbol_spam_rejected() {
        let spam = "$#@!%^&*()".repeat(25); // 250 chars of pure symbol spam
        assert!(
            check_ascii_art(&spam).is_err(),
            "Pure symbol spam should be rejected"
        );
    }

    #[test]
    fn ascii_art_block_elements_rejected() {
        let blocks = "\
            ████████████████████████████████████████\n\
            ██████████░░░░░░░░░░░░░░░░████████████\n\
            ██████████░░░░░░░░░░░░░░░░████████████\n\
            ██████████░░░░░░░░░░░░░░░░████████████\n\
            ██████████░░░░░░░░░░░░░░░░████████████\n\
            ████████████████████████████████████████";
        assert!(
            check_ascii_art(blocks).is_err(),
            "Block element art should be rejected"
        );
    }

    #[test]
    fn ascii_art_markdown_table_passes() {
        let table = pad("Here is a data table:\n\
            | Column 1 | Column 2 | Column 3 | Column 4 |\n\
            |----------|----------|----------|----------|\n\
            | value 1  | value 2  | value 3  | value 4  |\n\
            | value 5  | value 6  | value 7  | value 8  |\n\
            | value 9  | value 10 | value 11 | value 12 |");
        assert!(
            check_ascii_art(&table).is_ok(),
            "Markdown tables should pass"
        );
    }

    // ── Helper function tests ──────────────────────────────────────

    #[test]
    fn strip_code_blocks_removes_fenced() {
        let input = "before\n```rust\nfn main() {}\n```\nafter";
        let result = strip_code_blocks(input);
        assert!(
            !result.contains("fn main"),
            "Code block content should be stripped"
        );
        assert!(result.contains("before"), "Text before should remain");
        assert!(result.contains("after"), "Text after should remain");
    }

    #[test]
    fn strip_code_blocks_unpaired_fence() {
        let input = "before\n```rust\nfn main() {}";
        let result = strip_code_blocks(input);
        // Unpaired fence — everything preserved
        assert!(
            result.contains("fn main"),
            "Unpaired fence should not strip"
        );
    }

    #[test]
    fn count_zalgo_chars_normal_text() {
        assert_eq!(count_zalgo_chars("Hello world"), 0);
        // Single accent (1 combining mark per base) — not Zalgo
        assert_eq!(count_zalgo_chars("caf\u{0301}e"), 0);
    }

    #[test]
    fn count_zalgo_chars_heavy_zalgo() {
        // 5 base chars each with 5 combining marks
        let zalgo = "a\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\
            b\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\
            c\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\
            d\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}\
            e\u{0300}\u{0301}\u{0302}\u{0303}\u{0304}";
        assert_eq!(count_zalgo_chars(zalgo), 5);
    }

    #[test]
    fn is_textart_char_ranges() {
        assert!(is_textart_char('─')); // U+2500 box-drawing
        assert!(is_textart_char('█')); // U+2588 block element
        assert!(is_textart_char('⠀')); // U+2800 braille
        assert!(is_textart_char('■')); // U+25A0 geometric
        assert!(!is_textart_char('A'));
        assert!(!is_textart_char('!'));
    }

    #[test]
    fn repeated_char_runs_basic() {
        let (max, clusters) = repeated_char_runs("hello═══════════world", 5);
        assert!(max >= 9, "Should detect run of ═ chars, got {max}");
        assert!(clusters >= 1);
    }

    #[test]
    fn repeated_char_runs_no_specials() {
        let (max, clusters) = repeated_char_runs("hello world", 5);
        assert_eq!(max, 0);
        assert_eq!(clusters, 0);
    }

    #[test]
    fn strip_urls_removes_links() {
        let input = "Visit https://example.com/path?q=1&r=2 for info";
        let result = strip_urls(input);
        assert!(!result.contains("example.com"), "URL should be stripped");
        assert!(result.contains("Visit"), "Non-URL text should remain");
    }

    #[test]
    fn count_special_chars_normal_text() {
        let (special, eligible) = count_special_chars("Hello, world! How are you?");
        // Common punctuation (,!?) doesn't count as special
        assert_eq!(special, 0);
        assert!(eligible > 0);
    }

    #[test]
    fn count_art_lines_normal_text() {
        let text = "Hello world\nThis is normal\nJust chatting";
        assert_eq!(count_art_lines(text), 0);
    }

    #[test]
    fn count_art_lines_art_heavy() {
        let text = "═══════\n░░░░░░░\n▓▓▓▓▓▓▓\n███████\n╔═════╗\nnormal line";
        assert_eq!(count_art_lines(text), 5);
    }
}
