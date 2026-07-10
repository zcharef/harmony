//! `PostgreSQL` adapter for message attachment reads.
//!
//! Writes happen inside the `send_to_channel` transaction (see
//! `message_repository.rs`); this adapter only serves the batched read path,
//! mirroring `PgReactionRepository::batch_for_messages`.

use std::collections::HashMap;

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Attachment, AttachmentId, MessageId};
use crate::domain::ports::AttachmentRepository;

/// PostgreSQL-backed attachment repository (read side).
#[derive(Debug, Clone)]
pub struct PgAttachmentRepository {
    pool: PgPool,
}

impl PgAttachmentRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AttachmentRepository for PgAttachmentRepository {
    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
    ) -> Result<HashMap<MessageId, Vec<Attachment>>, DomainError> {
        // WHY: Empty array guard — skip DB call entirely.
        if message_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let ids: Vec<Uuid> = message_ids.iter().map(|id| id.0).collect();

        // WHY ORDER BY created_at, id: the insert stamps clock_timestamp() per
        // row (strictly increasing within one message), so created_at preserves
        // insertion order; `id` is a deterministic tiebreak for equal timestamps.
        let rows = sqlx::query!(
            r#"
            SELECT id, message_id, url, mime, size, width, height, created_at
            FROM message_attachments
            WHERE message_id = ANY($1::uuid[])
            ORDER BY created_at, id
            "#,
            &ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let mut result: HashMap<MessageId, Vec<Attachment>> = HashMap::new();
        for row in rows {
            let msg_id = MessageId::new(row.message_id);
            let attachment = Attachment {
                id: AttachmentId::new(row.id),
                message_id: msg_id.clone(),
                url: row.url,
                mime: row.mime,
                size: row.size,
                width: row.width,
                height: row.height,
                created_at: row.created_at,
            };
            result.entry(msg_id).or_default().push(attachment);
        }

        Ok(result)
    }
}
