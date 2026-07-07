//! Port: message reaction persistence.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiVariety, MessageId, ReactionSummary, UserId};

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

    /// Count distinct emoji on a message and whether `emoji` is already present.
    ///
    /// Used to enforce the per-message distinct-emoji cap: adding to an
    /// existing emoji never increases variety, so it stays allowed at the cap.
    async fn emoji_variety(
        &self,
        message_id: &MessageId,
        emoji: &str,
    ) -> Result<EmojiVariety, DomainError>;

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
