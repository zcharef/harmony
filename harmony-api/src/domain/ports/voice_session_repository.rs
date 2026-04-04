//! Port: voice session persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, NewVoiceSession, ServerId, UserId, VoiceSession};

/// Repository for ephemeral voice sessions (one per user, upsert semantics).
#[async_trait]
pub trait VoiceSessionRepository: Send + Sync + std::fmt::Debug {
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

    /// Remove a voice session by `user_id`. Returns the removed session if it existed.
    async fn remove_by_user(&self, user_id: &UserId) -> Result<Option<VoiceSession>, DomainError>;

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

    /// Update `last_seen_at` for a user's session (heartbeat).
    ///
    /// Returns `true` if a matching session was found and updated, `false` if no
    /// row matched (session expired, wrong device, or user not in voice).
    async fn touch(&self, user_id: &UserId, session_id: &str) -> Result<bool, DomainError>;
}
