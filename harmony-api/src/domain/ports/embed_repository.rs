//! Port: message link-preview embeds + the unfurl result cache.
//!
//! One port for the whole unfurl persistence concern: embed rows are
//! written ONLY by the async unfurl worker (never inside the send
//! transaction — the unfurl must not block or fail a send), read via the
//! batched pattern mirroring `AttachmentRepository::batch_for_messages`,
//! and suppressed (not deleted) when the author removes a preview.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmbedId, MessageEmbed, MessageId, NewEmbed, UnfurledPage};

/// Intent-based repository for link-preview embeds and the unfurl cache.
#[async_trait]
pub trait EmbedRepository: Send + Sync + std::fmt::Debug {
    /// Batch-fetch NON-suppressed embeds for multiple messages.
    ///
    /// Returns a map from message ID to its embeds in insertion order.
    /// Messages with zero embeds are absent from the returned map.
    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
    ) -> Result<HashMap<MessageId, Vec<MessageEmbed>>, DomainError>;

    /// Persist the unfurl worker's results for one message. Skips URLs that
    /// already have a row (suppressed or not) so a preview the author removed
    /// never resurrects.
    async fn insert_embeds(
        &self,
        message_id: &MessageId,
        embeds: &[NewEmbed],
    ) -> Result<(), DomainError>;

    /// Mark one embed suppressed (author removed the preview). The row is
    /// kept so the URL never re-unfurls for this message.
    ///
    /// Returns `false` when no live embed matched (unknown id, wrong message,
    /// or already suppressed).
    async fn suppress(
        &self,
        message_id: &MessageId,
        embed_id: &EmbedId,
    ) -> Result<bool, DomainError>;

    /// Look up a cached unfurl result younger than `ttl_secs`.
    ///
    /// `Some(page)` may be an all-`None` page — that is a cached FAILURE
    /// (negative cache) and must NOT trigger a refetch.
    async fn get_cached(
        &self,
        normalized_url: &str,
        ttl_secs: i64,
    ) -> Result<Option<UnfurledPage>, DomainError>;

    /// Upsert an unfurl result (success or failure) into the cache,
    /// refreshing `fetched_at`.
    async fn upsert_cache(
        &self,
        normalized_url: &str,
        page: &UnfurledPage,
    ) -> Result<(), DomainError>;
}
