//! Port: dead-letter queue for failed custom-emoji image content-moderation
//! scans.
//!
//! Mirrors [`IdentityImageScanRetryRepository`](super::IdentityImageScanRetryRepository)
//! but keyed by `emoji_id`. A scan failure leaves the emoji `pending` (never
//! revealed to other members) and lands here; the background sweep retries.
//! Fail-closed.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, EmojiImageScanRetry};

/// Repository for the emoji-image-scan dead-letter queue.
#[async_trait]
pub trait EmojiImageScanRetryRepository: Send + Sync + std::fmt::Debug {
    /// Insert (or UPSERT on the unique `emoji_id`) a failed scan.
    async fn insert(&self, emoji_id: &EmojiId, url: &str, error: &str) -> Result<(), DomainError>;

    /// List pending retries (`retry_count` < 5), oldest first.
    async fn list_pending(&self, limit: i64) -> Result<Vec<EmojiImageScanRetry>, DomainError>;

    /// Delete a retry record (scan resolved or emoji gone).
    async fn delete(&self, emoji_id: &EmojiId) -> Result<(), DomainError>;

    /// Count pending retries — the dead-letter-depth saturation signal.
    async fn count_pending(&self) -> Result<i64, DomainError>;
}
