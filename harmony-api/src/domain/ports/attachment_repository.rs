//! Port: message attachment reads.
//!
//! WHY read-only: attachment rows are WRITTEN inside the
//! `MessageRepository::send_to_channel` transaction (atomicity — no orphan
//! message, no orphan rows). This port only covers the batched read path,
//! mirroring `ReactionRepository::batch_for_messages`.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Attachment, AttachmentId, AttachmentModerationStatus, MessageId};

/// Intent-based repository for message attachment reads + moderation writes.
///
/// WHY moderation is the ONE write here (attachment rows are otherwise written
/// inside `MessageRepository::send_to_channel`): the async scan task resolves a
/// verdict AFTER the message commits, so it needs a targeted status write that
/// the send transaction cannot carry.
#[async_trait]
pub trait AttachmentRepository: Send + Sync + std::fmt::Debug {
    /// Batch-fetch attachments for multiple messages.
    ///
    /// Returns a map from message ID to its attachments in insertion order.
    /// Messages with zero attachments are absent from the returned map.
    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
    ) -> Result<HashMap<MessageId, Vec<Attachment>>, DomainError>;

    /// Fetch the still-`pending` attachments of one message (the scan work set).
    async fn list_pending_for_message(
        &self,
        message_id: &MessageId,
    ) -> Result<Vec<Attachment>, DomainError>;

    /// Write the terminal moderation verdict for one attachment. `nsfw_score`
    /// is persisted server-side only (never shipped to clients).
    async fn update_moderation(
        &self,
        attachment_id: &AttachmentId,
        status: AttachmentModerationStatus,
        nsfw_score: Option<f32>,
        reason: Option<&str>,
    ) -> Result<(), DomainError>;
}
