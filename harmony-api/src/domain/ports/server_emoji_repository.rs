//! Port: custom server-emoji persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, ServerEmoji, ServerId, UserId};

/// Intent-based repository for custom server emoji.
#[async_trait]
pub trait ServerEmojiRepository: Send + Sync + std::fmt::Debug {
    /// Insert a new emoji row. The unique `(server_id, name)` constraint is the
    /// concurrency backstop — a duplicate name surfaces as `DomainError::Conflict`.
    async fn create(
        &self,
        server_id: &ServerId,
        name: &str,
        url: &str,
        is_animated: bool,
        created_by: &UserId,
    ) -> Result<ServerEmoji, DomainError>;

    /// List every emoji for a server, ordered by `created_at ASC`.
    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<ServerEmoji>, DomainError>;

    /// Fetch a single emoji by id (any server), or `None` if absent.
    async fn get_by_id(&self, emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError>;

    /// Delete an emoji row. No-op if the row does not exist.
    async fn delete(&self, emoji_id: &EmojiId) -> Result<(), DomainError>;

    /// Count the emoji currently registered for a server (plan-limit gate).
    async fn count_for_server(&self, server_id: &ServerId) -> Result<i64, DomainError>;
}
