//! Port: dead-letter queue for failed AI moderation checks.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MessageId, ModerationRetry, ModerationRetryId, ServerId};

/// Repository for the moderation retry dead-letter queue.
///
/// Failed Tier 1 moderation checks (`OpenAI` API unreachable) are persisted
/// here and retried by a background sweep task.
#[async_trait]
pub trait ModerationRetryRepository: Send + Sync + std::fmt::Debug {
    /// Insert a new failed moderation check into the dead-letter queue.
    async fn insert(
        &self,
        message_id: &MessageId,
        server_id: &ServerId,
        channel_id: &ChannelId,
        content: &str,
        error: &str,
    ) -> Result<(), DomainError>;

    /// List pending retries (`retry_count` < 5), oldest first.
    async fn list_pending(&self, limit: i64) -> Result<Vec<ModerationRetry>, DomainError>;

    /// Increment the retry count and update the last error.
    /// Returns the new `retry_count` after the increment.
    async fn increment_retry(
        &self,
        id: &ModerationRetryId,
        error: &str,
    ) -> Result<i32, DomainError>;

    /// Delete a retry record (moderation succeeded or message was deleted).
    async fn delete(&self, id: &ModerationRetryId) -> Result<(), DomainError>;
}
