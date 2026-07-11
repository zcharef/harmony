//! Port: dead-letter queue for failed image content-moderation scans.
//!
//! Mirrors [`ModerationRetryRepository`](super::ModerationRetryRepository) but
//! keyed by attachment (the text queue carries a NOT NULL `content` and is
//! text-shaped). A scan failure leaves the attachment `pending` (never
//! revealed) and lands here; the background sweep retries. Fail-closed.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{AttachmentId, AttachmentScanRetry, ChannelId, MessageId};

/// Repository for the attachment-scan dead-letter queue.
#[async_trait]
pub trait AttachmentScanRetryRepository: Send + Sync + std::fmt::Debug {
    /// Insert (or UPSERT on the unique `attachment_id`) a failed scan.
    async fn insert(
        &self,
        attachment_id: &AttachmentId,
        message_id: &MessageId,
        channel_id: &ChannelId,
        url: &str,
        mime: &str,
        error: &str,
    ) -> Result<(), DomainError>;

    /// List pending retries (`retry_count` < 5), oldest first.
    async fn list_pending(&self, limit: i64) -> Result<Vec<AttachmentScanRetry>, DomainError>;

    /// Increment the retry count and update the last error. Returns the new count.
    async fn increment_retry(
        &self,
        attachment_id: &AttachmentId,
        error: &str,
    ) -> Result<i32, DomainError>;

    /// Delete a retry record (scan succeeded or attachment gone).
    async fn delete(&self, attachment_id: &AttachmentId) -> Result<(), DomainError>;

    /// Count pending retries — the dead-letter-depth saturation signal.
    async fn count_pending(&self) -> Result<i64, DomainError>;
}
