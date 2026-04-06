//! Port: voice session persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, NewVoiceSession, ServerId, UserId, VoiceSession};

/// Repository for ephemeral voice sessions (one per user, upsert semantics).
#[async_trait]
pub trait VoiceSessionRepository: Send + Sync + std::fmt::Debug {
    /// Return the database server's current timestamp.
    ///
    /// WHY: Heartbeat `touch()` writes `last_seen_at = now()` using the DB clock.
    /// Sweep thresholds must be computed from the same clock to avoid skew between
    /// the Rust process and Postgres (e.g. containerised deployments, NTP drift).
    async fn now(&self) -> Result<DateTime<Utc>, DomainError>;

    /// Insert a voice session. If the user already has one, replace it (auto-leave old channel).
    /// Returns the new session and the PREVIOUS session if one existed (for SSE leave event).
    async fn upsert(
        &self,
        session: &NewVoiceSession,
    ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError>;

    /// Atomically check the concurrent session count for a server and upsert a
    /// voice session. If the count (excluding this user's existing session) is
    /// at or above `max_concurrent`, returns `DomainError::LimitExceeded`.
    ///
    /// WHY: Prevents TOCTOU race where two concurrent joins could both pass
    /// the count check before either inserts, bypassing the plan limit.
    async fn upsert_with_limit(
        &self,
        session: &NewVoiceSession,
        max_concurrent: u64,
        plan_name: String,
    ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError>;

    /// Find a user's active voice session (if any). One session per user (UNIQUE constraint).
    async fn find_by_user(&self, user_id: &UserId) -> Result<Option<VoiceSession>, DomainError>;

    /// Remove a voice session by `user_id`. Returns the removed session if it existed.
    async fn remove_by_user(&self, user_id: &UserId) -> Result<Option<VoiceSession>, DomainError>;

    /// Atomically remove a voice session only if it belongs to `channel_id`.
    /// Returns the removed session if the user was in that channel, `None` if
    /// no matching row existed (user not in voice or in a different channel).
    ///
    /// WHY: Prevents TOCTOU race where a concurrent `join_voice` could move the
    /// user to a new channel between a check and a delete, causing the delete
    /// to remove the wrong session.
    async fn remove_by_user_and_channel(
        &self,
        user_id: &UserId,
        channel_id: &ChannelId,
    ) -> Result<Option<VoiceSession>, DomainError>;

    /// List all voice sessions for a channel.
    async fn list_by_channel(
        &self,
        channel_id: &ChannelId,
    ) -> Result<Vec<VoiceSession>, DomainError>;

    /// List all voice sessions for a server (across all its channels).
    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<VoiceSession>, DomainError>;

    /// Count concurrent voice sessions for a server.
    async fn count_by_server(&self, server_id: &ServerId) -> Result<i64, DomainError>;

    /// Delete stale sessions (`last_seen_at` < threshold). Returns removed sessions for SSE cleanup.
    async fn delete_stale(
        &self,
        threshold: DateTime<Utc>,
    ) -> Result<Vec<VoiceSession>, DomainError>;

    /// Delete sessions where the user has been alone in their channel for too long.
    ///
    /// Removes sessions with `alone_since IS NOT NULL AND alone_since < threshold`.
    /// Returns removed sessions for SSE cleanup.
    async fn delete_alone_in_channel(
        &self,
        threshold: DateTime<Utc>,
    ) -> Result<Vec<VoiceSession>, DomainError>;

    /// Delete AFK sessions (active users who stopped interacting).
    ///
    /// Removes sessions where `last_active_at < threshold` AND the session is
    /// still "connected" (`last_seen_at >= stale_threshold`). The `stale_threshold`
    /// guard prevents double-deletion of sessions already handled by `delete_stale`.
    async fn delete_afk(
        &self,
        threshold: DateTime<Utc>,
        stale_threshold: DateTime<Utc>,
    ) -> Result<Vec<VoiceSession>, DomainError>;

    /// Scan all voice channels and set `alone_since = now()` for sessions where
    /// the user is the only participant in their channel AND `alone_since` is NULL.
    /// Clears `alone_since` back to NULL for sessions that are no longer alone.
    ///
    /// Returns the number of rows updated.
    async fn update_alone_since(&self) -> Result<u64, DomainError>;

    /// Update `last_seen_at` for a user's session (heartbeat).
    /// When `is_active` is true, also updates `last_active_at` (user is speaking/unmuted).
    ///
    /// Returns `true` if a matching session was found and updated, `false` if no
    /// row matched (session expired, wrong device, or user not in voice).
    async fn touch(
        &self,
        user_id: &UserId,
        session_id: &str,
        is_active: bool,
    ) -> Result<bool, DomainError>;

    /// Update mute/deafen state for an active voice session.
    /// Returns the updated session (with `server_id`/`channel_id` for SSE routing).
    /// Returns `None` if no session matches `user_id` + `session_id`.
    async fn update_voice_state(
        &self,
        user_id: &UserId,
        session_id: &str,
        is_muted: bool,
        is_deafened: bool,
    ) -> Result<Option<VoiceSession>, DomainError>;

    /// Eagerly clear `alone_since` for all sessions in a channel.
    ///
    /// WHY: Called at the start of `join_voice` BEFORE the heavy pre-computation
    /// (channel fetch, membership check, plan limits, token generation). This
    /// prevents a race where the background `delete_alone_in_channel` sweep could
    /// delete the existing solo user's session during the ~50ms pre-computation
    /// window, before `upsert_with_limit` acquires its `FOR UPDATE` lock.
    async fn clear_alone_since_for_channel(
        &self,
        channel_id: &ChannelId,
    ) -> Result<(), DomainError>;
}
