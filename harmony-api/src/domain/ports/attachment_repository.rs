//! Port: message attachment reads.
//!
//! WHY read-only: attachment rows are WRITTEN inside the
//! `MessageRepository::send_to_channel` transaction (atomicity — no orphan
//! message, no orphan rows). This port only covers the batched read path,
//! mirroring `ReactionRepository::batch_for_messages`.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Attachment, MessageId};

/// Intent-based repository for message attachment reads.
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
}
