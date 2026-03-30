//! Port: message reaction persistence.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{MessageId, ReactionSummary, UserId};

/// Intent-based repository for message reactions.
#[async_trait]
pub trait ReactionRepository: Send + Sync + std::fmt::Debug {
    /// Add a reaction (idempotent — ON CONFLICT DO NOTHING).
    async fn add(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError>;

    /// Remove a reaction. No-op if the reaction does not exist.
    async fn remove(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError>;

    /// Batch-fetch reaction summaries for multiple messages.
    ///
    /// Returns a map from message ID to its reaction summaries (aggregated by emoji).
    /// The `viewer_id` is used to compute `reacted_by_me` for each summary.
    /// Messages with zero reactions are absent from the returned map.
    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
        viewer_id: &UserId,
    ) -> Result<HashMap<MessageId, Vec<ReactionSummary>>, DomainError>;
}
