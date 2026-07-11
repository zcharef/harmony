//! Port: custom server-emoji persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, ServerEmoji, ServerId, UserId};

/// Intent-based repository for custom server emoji.
#[async_trait]
pub trait ServerEmojiRepository: Send + Sync + std::fmt::Debug {
    /// Insert a new emoji row in the `pending` moderation state — it is NOT shown
    /// to other members until the async image scan promotes it (scan-before-
    /// reveal). The unique `(server_id, name)` constraint is the concurrency
    /// backstop — a duplicate name surfaces as `DomainError::Conflict`.
    async fn create(
        &self,
        server_id: &ServerId,
        name: &str,
        url: &str,
        is_animated: bool,
        created_by: &UserId,
    ) -> Result<ServerEmoji, DomainError>;

    /// List every APPROVED emoji for a server, ordered by `created_at ASC`.
    /// Pending (unscanned) and rejected emoji are never returned — an emoji is
    /// invisible to members until its scan clears.
    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<ServerEmoji>, DomainError>;

    /// Fetch a single emoji by id (any server, any status), or `None` if absent.
    async fn get_by_id(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError>;

    /// Promote a `pending` emoji to `approved` (scan verdict clean), stamping the
    /// nsfw score + scan time. Returns the promoted emoji, or `None` when the row
    /// is gone or no longer pending (superseded/deleted meanwhile).
    async fn promote(
        &self,
        emoji_id: &EmojiId,
        nsfw_score: Option<f32>,
    ) -> Result<Option<ServerEmoji>, DomainError>;

    /// Reject a `pending` emoji (scan verdict flagged): DELETE the row so it never
    /// goes live. Returns the deleted row (for best-effort object cleanup), or
    /// `None` when it is gone or no longer pending.
    async fn reject(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError>;

    /// Delete an emoji row. No-op if the row does not exist.
    async fn delete(&self, emoji_id: &EmojiId) -> Result<(), DomainError>;

    /// Count the emoji currently registered for a server (plan-limit gate).
    /// Counts every status so a flood of pending emoji cannot bypass the cap.
    async fn count_for_server(&self, server_id: &ServerId) -> Result<i64, DomainError>;
}
