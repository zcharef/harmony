//! In-memory anti-spam guard backed by `DashMap`.
//!
//! Provides three protections:
//! - **A1 (Duplicate detection):** Rejects exact same message content within a window.
//! - **A3 (Flood detection):** Auto-mutes users who send too many messages in a window.
//! - **A3 (Mute enforcement):** Blocks muted users from sending messages.
//!
//! All state is instance-local. Same limitation as `PresenceTracker`: when Harmony
//! scales past one instance, this needs a shared store (Redis).

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
    /// Follows the `PresenceTracker::sweep_stale` pattern.
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
}
