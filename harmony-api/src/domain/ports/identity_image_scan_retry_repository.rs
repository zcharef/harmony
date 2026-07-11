//! Port: dead-letter queue for failed identity-image content-moderation scans.
//!
//! Mirrors [`AttachmentScanRetryRepository`](super::AttachmentScanRetryRepository)
//! but keyed by `(user_id, image_kind)`. A scan failure leaves the candidate in
//! `pending_{kind}_url` (never revealed) and lands here; the background sweep
//! retries. Fail-closed.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{IdentityImageKind, IdentityImageScanRetry, UserId};

/// Repository for the identity-image-scan dead-letter queue.
#[async_trait]
pub trait IdentityImageScanRetryRepository: Send + Sync + std::fmt::Debug {
    /// Insert (or UPSERT on the unique `(user_id, image_kind)`) a failed scan.
    async fn insert(
        &self,
        user_id: &UserId,
        kind: IdentityImageKind,
        url: &str,
        error: &str,
    ) -> Result<(), DomainError>;

    /// List pending retries (`retry_count` < 5), oldest first.
    async fn list_pending(&self, limit: i64) -> Result<Vec<IdentityImageScanRetry>, DomainError>;

    /// Delete a retry record (scan resolved or candidate superseded).
    async fn delete(&self, user_id: &UserId, kind: IdentityImageKind) -> Result<(), DomainError>;

    /// Count pending retries — the dead-letter-depth saturation signal.
    async fn count_pending(&self) -> Result<i64, DomainError>;
}
