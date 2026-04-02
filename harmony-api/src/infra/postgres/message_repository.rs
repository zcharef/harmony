//! `PostgreSQL` adapter for message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, Message, MessageId, MessageType, MessageWithAuthor, ParentMessagePreview, UserId,
};
use crate::domain::ports::MessageRepository;

/// Parse the Postgres `message_type` enum value into the domain enum.
fn parse_message_type(value: &str) -> MessageType {
    match value {
        "default" => MessageType::Default,
        "system" => MessageType::System,
        unknown => {
            tracing::warn!(
                message_type = unknown,
                "Unknown message_type from database, defaulting to Default"
            );
            MessageType::Default
        }
    }
}

/// PostgreSQL-backed message repository.
#[derive(Debug, Clone)]
pub struct PgMessageRepository {
    pool: PgPool,
}

impl PgMessageRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding (plain `Message` without author data).
///
/// Used by `find_by_id` which only needs the core message for authorization
/// checks and does not need author profile enrichment.
struct MessageRow {
    id: Uuid,
    channel_id: Uuid,
    author_id: Uuid,
    content: Option<String>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    deleted_by: Option<Uuid>,
    encrypted: bool,
    sender_device_id: Option<String>,
    message_type: String,
    system_event_key: Option<String>,
    parent_message_id: Option<Uuid>,
    moderated_at: Option<DateTime<Utc>>,
    moderation_reason: Option<String>,
    original_content: Option<String>,
    created_at: DateTime<Utc>,
}

impl MessageRow {
    fn into_message(self) -> Message {
        Message {
            id: MessageId::new(self.id),
            channel_id: ChannelId::new(self.channel_id),
            author_id: UserId::new(self.author_id),
            content: self.content.unwrap_or_default(),
            edited_at: self.edited_at,
            deleted_at: self.deleted_at,
            deleted_by: self.deleted_by.map(UserId::new),
            encrypted: self.encrypted,
            sender_device_id: self.sender_device_id,
            message_type: parse_message_type(&self.message_type),
            system_event_key: self.system_event_key,
            parent_message_id: self.parent_message_id.map(MessageId::new),
            moderated_at: self.moderated_at,
            moderation_reason: self.moderation_reason,
            original_content: self.original_content,
            created_at: self.created_at,
        }
    }
}

/// Intermediate row type for queries that JOIN `profiles` to include author data.
///
/// Used by `create`, `list_for_channel`, and `update_content` — all endpoints
/// whose responses need the author's display name and avatar.
struct MessageWithAuthorRow {
    id: Uuid,
    channel_id: Uuid,
    author_id: Uuid,
    content: Option<String>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    deleted_by: Option<Uuid>,
    encrypted: bool,
    sender_device_id: Option<String>,
    message_type: String,
    system_event_key: Option<String>,
    parent_message_id: Option<Uuid>,
    moderated_at: Option<DateTime<Utc>>,
    moderation_reason: Option<String>,
    original_content: Option<String>,
    created_at: DateTime<Utc>,
    // Author profile fields from JOIN.
    author_username: Option<String>,
    author_avatar_url: Option<String>,
    // Parent message preview fields from self-JOIN.
    parent_author_username: Option<String>,
    parent_content_preview: Option<String>,
    // WHY: Indicates whether the parent message was soft-deleted.
    // Used to show "[Original message was deleted]" in the quote block.
    parent_deleted: Option<bool>,
}

impl MessageWithAuthorRow {
    fn into_message_with_author(self) -> MessageWithAuthor {
        // WHY: Check parent_deleted FIRST. When a parent is deleted AND
        // its author profile is also deleted, parent_author_username is
        // None — matching on username first would skip the preview entirely
        // instead of showing "[deleted]".
        let parent_message = match (self.parent_message_id, self.parent_deleted.unwrap_or(false)) {
            (Some(pid), true) => Some(ParentMessagePreview {
                id: MessageId::new(pid),
                deleted: true,
                author_username: String::new(),
                content_preview: String::new(),
            }),
            (Some(pid), false) => {
                self.parent_author_username
                    .map(|username| ParentMessagePreview {
                        id: MessageId::new(pid),
                        deleted: false,
                        author_username: username,
                        content_preview: self.parent_content_preview.unwrap_or_default(),
                    })
            }
            _ => None,
        };

        let message = Message {
            id: MessageId::new(self.id),
            channel_id: ChannelId::new(self.channel_id),
            author_id: UserId::new(self.author_id),
            content: self.content.unwrap_or_default(),
            edited_at: self.edited_at,
            deleted_at: self.deleted_at,
            deleted_by: self.deleted_by.map(UserId::new),
            encrypted: self.encrypted,
            sender_device_id: self.sender_device_id,
            message_type: parse_message_type(&self.message_type),
            system_event_key: self.system_event_key,
            parent_message_id: self.parent_message_id.map(MessageId::new),
            moderated_at: self.moderated_at,
            moderation_reason: self.moderation_reason,
            original_content: self.original_content,
            created_at: self.created_at,
        };

        MessageWithAuthor {
            message,
            // WHY: LEFT JOIN means username may be NULL if the profile was
            // deleted. Fall back to "Unknown" so the API never returns an
            // empty author_username field.
            author_username: self
                .author_username
                .unwrap_or_else(|| "Unknown".to_string()),
            author_avatar_url: self.author_avatar_url,
            // WHY: Reactions are populated by MessageService after batch-fetching,
            // not by the repository query. Default to empty here.
            reactions: vec![],
            parent_message,
        }
    }
}

#[async_trait]
impl MessageRepository for PgMessageRepository {
    async fn send_to_channel(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
        encrypted: bool,
        sender_device_id: Option<String>,
        parent_message_id: Option<MessageId>,
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
    ) -> Result<MessageWithAuthor, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;
        let pmid = parent_message_id.map(|id| id.0);
        let mod_at = moderated_at;
        let mod_reason = moderation_reason;
        let orig_content = original_content;

        let row = sqlx::query!(
            r#"
            WITH inserted AS (
                INSERT INTO messages (channel_id, author_id, content, encrypted, sender_device_id, parent_message_id, moderated_at, moderation_reason, original_content)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING
                    id,
                    channel_id,
                    author_id,
                    content,
                    edited_at,
                    deleted_at,
                    deleted_by,
                    encrypted,
                    sender_device_id,
                    message_type,
                    system_event_key,
                    parent_message_id,
                    moderated_at,
                    moderation_reason,
                    original_content,
                    created_at
            )
            SELECT
                i.id as "id!",
                i.channel_id as "channel_id!",
                i.author_id as "author_id!",
                i.content,
                i.edited_at,
                i.deleted_at,
                i.deleted_by,
                i.encrypted as "encrypted!",
                i.sender_device_id,
                i.message_type as "message_type!: String",
                i.system_event_key,
                i.parent_message_id,
                i.moderated_at,
                i.moderation_reason,
                i.original_content,
                i.created_at as "created_at!",
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM inserted i
            LEFT JOIN profiles p ON p.id = i.author_id
            LEFT JOIN messages parent_m ON parent_m.id = i.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            "#,
            cid,
            aid,
            content,
            encrypted,
            sender_device_id,
            pmid,
            mod_at,
            mod_reason,
            orig_content,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let msg = MessageWithAuthorRow {
            id: row.id,
            channel_id: row.channel_id,
            author_id: row.author_id,
            content: row.content,
            edited_at: row.edited_at,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by,
            encrypted: row.encrypted,
            sender_device_id: row.sender_device_id,
            message_type: row.message_type,
            system_event_key: row.system_event_key,
            parent_message_id: row.parent_message_id,
            moderated_at: row.moderated_at,
            moderation_reason: row.moderation_reason,
            original_content: row.original_content,
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
            parent_author_username: row.parent_author_username,
            parent_content_preview: row.parent_content_preview,
            parent_deleted: row.parent_deleted,
        };

        Ok(msg.into_message_with_author())
    }

    async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let cid = channel_id.0;

        // Cursor pagination (ADR-036): filter by created_at < cursor when present.
        // Soft deletes (ADR-038): exclude messages where deleted_at IS NOT NULL.
        let rows = sqlx::query!(
            r#"
            SELECT
                m.id,
                m.channel_id,
                m.author_id,
                m.content,
                m.edited_at,
                m.deleted_at,
                m.deleted_by,
                m.encrypted,
                m.sender_device_id,
                m.message_type as "message_type!: String",
                m.system_event_key,
                m.parent_message_id,
                m.moderated_at,
                m.moderation_reason,
                m.original_content,
                m.created_at,
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM messages m
            LEFT JOIN profiles p ON p.id = m.author_id
            LEFT JOIN messages parent_m ON parent_m.id = m.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            WHERE m.channel_id = $1
              AND m.deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR m.created_at < $2)
            ORDER BY m.created_at DESC
            LIMIT $3
            "#,
            cid,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let messages = rows
            .into_iter()
            .map(|r| {
                MessageWithAuthorRow {
                    id: r.id,
                    channel_id: r.channel_id,
                    author_id: r.author_id,
                    content: r.content,
                    edited_at: r.edited_at,
                    deleted_at: r.deleted_at,
                    deleted_by: r.deleted_by,
                    encrypted: r.encrypted,
                    sender_device_id: r.sender_device_id,
                    message_type: r.message_type,
                    system_event_key: r.system_event_key,
                    parent_message_id: r.parent_message_id,
                    moderated_at: r.moderated_at,
                    moderation_reason: r.moderation_reason,
                    original_content: r.original_content,
                    created_at: r.created_at,
                    author_username: r.author_username,
                    author_avatar_url: r.author_avatar_url,
                    parent_author_username: r.parent_author_username,
                    parent_content_preview: r.parent_content_preview,
                    parent_deleted: r.parent_deleted,
                }
                .into_message_with_author()
            })
            .collect();

        Ok(messages)
    }

    async fn find_by_id(&self, message_id: &MessageId) -> Result<Option<Message>, DomainError> {
        let mid = message_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                channel_id,
                author_id,
                content,
                edited_at,
                deleted_at,
                deleted_by,
                encrypted,
                sender_device_id,
                message_type as "message_type!: String",
                system_event_key,
                parent_message_id,
                moderated_at,
                moderation_reason,
                original_content,
                created_at
            FROM messages
            WHERE id = $1 AND deleted_at IS NULL
            "#,
            mid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            MessageRow {
                id: r.id,
                channel_id: r.channel_id,
                author_id: r.author_id,
                content: r.content,
                edited_at: r.edited_at,
                deleted_at: r.deleted_at,
                deleted_by: r.deleted_by,
                encrypted: r.encrypted,
                sender_device_id: r.sender_device_id,
                message_type: r.message_type,
                system_event_key: r.system_event_key,
                parent_message_id: r.parent_message_id,
                moderated_at: r.moderated_at,
                moderation_reason: r.moderation_reason,
                original_content: r.original_content,
                created_at: r.created_at,
            }
            .into_message()
        }))
    }

    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
    ) -> Result<MessageWithAuthor, DomainError> {
        let mid = message_id.0;
        let mod_at = moderated_at;
        let mod_reason = moderation_reason;
        let orig_content = original_content;

        let row = sqlx::query!(
            r#"
            WITH updated AS (
                UPDATE messages
                SET content = $2, is_edited = true, edited_at = now(), moderated_at = $3, moderation_reason = $4, original_content = $5
                WHERE id = $1 AND deleted_at IS NULL
                RETURNING
                    id,
                    channel_id,
                    author_id,
                    content,
                    edited_at,
                    deleted_at,
                    deleted_by,
                    encrypted,
                    sender_device_id,
                    message_type,
                    system_event_key,
                    parent_message_id,
                    moderated_at,
                    moderation_reason,
                    original_content,
                    created_at
            )
            SELECT
                u.id as "id!",
                u.channel_id as "channel_id!",
                u.author_id as "author_id!",
                u.content,
                u.edited_at,
                u.deleted_at,
                u.deleted_by,
                u.encrypted as "encrypted!",
                u.sender_device_id,
                u.message_type as "message_type!: String",
                u.system_event_key,
                u.parent_message_id,
                u.moderated_at,
                u.moderation_reason,
                u.original_content,
                u.created_at as "created_at!",
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM updated u
            LEFT JOIN profiles p ON p.id = u.author_id
            LEFT JOIN messages parent_m ON parent_m.id = u.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            "#,
            mid,
            content,
            mod_at,
            mod_reason,
            orig_content,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?
        .ok_or_else(|| DomainError::NotFound {
            resource_type: "Message",
            id: message_id.to_string(),
        })?;

        let msg = MessageWithAuthorRow {
            id: row.id,
            channel_id: row.channel_id,
            author_id: row.author_id,
            content: row.content,
            edited_at: row.edited_at,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by,
            encrypted: row.encrypted,
            sender_device_id: row.sender_device_id,
            message_type: row.message_type,
            system_event_key: row.system_event_key,
            parent_message_id: row.parent_message_id,
            moderated_at: row.moderated_at,
            moderation_reason: row.moderation_reason,
            original_content: row.original_content,
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
            parent_author_username: row.parent_author_username,
            parent_content_preview: row.parent_content_preview,
            parent_deleted: row.parent_deleted,
        };

        Ok(msg.into_message_with_author())
    }

    async fn soft_delete(
        &self,
        message_id: &MessageId,
        deleted_by: &UserId,
    ) -> Result<(), DomainError> {
        let mid = message_id.0;
        let dby = deleted_by.0;

        let result = sqlx::query!(
            r#"
            UPDATE messages
            SET deleted_at = now(), deleted_by = $2
            WHERE id = $1 AND deleted_at IS NULL
            "#,
            mid,
            dby,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            });
        }

        Ok(())
    }

    async fn count_recent(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        window_secs: i64,
    ) -> Result<i64, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM messages
            WHERE channel_id = $1
              AND author_id = $2
              AND deleted_at IS NULL
              AND created_at > now() - make_interval(secs => $3::double precision)
            "#,
            cid,
            aid,
            window_secs as f64,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }

    async fn create_system(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        system_event_key: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            WITH inserted AS (
                INSERT INTO messages (channel_id, author_id, content, message_type, system_event_key)
                VALUES ($1, $2, '', 'system'::message_type, $3)
                RETURNING
                    id,
                    channel_id,
                    author_id,
                    content,
                    edited_at,
                    deleted_at,
                    deleted_by,
                    encrypted,
                    sender_device_id,
                    message_type,
                    system_event_key,
                    parent_message_id,
                    moderated_at,
                    moderation_reason,
                    original_content,
                    created_at
            )
            SELECT
                i.id as "id!",
                i.channel_id as "channel_id!",
                i.author_id as "author_id!",
                i.content,
                i.edited_at,
                i.deleted_at,
                i.deleted_by,
                i.encrypted as "encrypted!",
                i.sender_device_id,
                i.message_type as "message_type!: String",
                i.system_event_key,
                i.parent_message_id,
                i.moderated_at,
                i.moderation_reason,
                i.original_content,
                i.created_at as "created_at!",
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?"
            FROM inserted i
            LEFT JOIN profiles p ON p.id = i.author_id
            "#,
            cid,
            aid,
            system_event_key,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let msg = MessageWithAuthorRow {
            id: row.id,
            channel_id: row.channel_id,
            author_id: row.author_id,
            content: row.content,
            edited_at: row.edited_at,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by,
            encrypted: row.encrypted,
            sender_device_id: row.sender_device_id,
            message_type: row.message_type,
            system_event_key: row.system_event_key,
            parent_message_id: row.parent_message_id,
            moderated_at: row.moderated_at,
            moderation_reason: row.moderation_reason,
            original_content: row.original_content,
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
            // WHY: System messages never have parent replies.
            parent_author_username: None,
            parent_content_preview: None,
            parent_deleted: None,
        };

        Ok(msg.into_message_with_author())
    }
}
