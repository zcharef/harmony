//! `PostgreSQL` adapter for message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, Message, MessageId, MessageType, MessageWithAuthor, UserId,
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
    created_at: DateTime<Utc>,
    // Author profile fields from JOIN.
    author_username: Option<String>,
    author_avatar_url: Option<String>,
}

impl MessageWithAuthorRow {
    fn into_message_with_author(self) -> MessageWithAuthor {
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
        }
    }
}

#[async_trait]
impl MessageRepository for PgMessageRepository {
    async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            WITH inserted AS (
                INSERT INTO messages (channel_id, author_id, content)
                VALUES ($1, $2, $3)
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
                i.created_at as "created_at!",
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?"
            FROM inserted i
            LEFT JOIN profiles p ON p.id = i.author_id
            "#,
            cid,
            aid,
            content,
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
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
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
                m.created_at,
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?"
            FROM messages m
            LEFT JOIN profiles p ON p.id = m.author_id
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
                    created_at: r.created_at,
                    author_username: r.author_username,
                    author_avatar_url: r.author_avatar_url,
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
                created_at: r.created_at,
            }
            .into_message()
        }))
    }

    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        let mid = message_id.0;

        let row = sqlx::query!(
            r#"
            WITH updated AS (
                UPDATE messages
                SET content = $2, is_edited = true, edited_at = now()
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
                u.created_at as "created_at!",
                p.username AS "author_username?",
                p.avatar_url AS "author_avatar_url?"
            FROM updated u
            LEFT JOIN profiles p ON p.id = u.author_id
            "#,
            mid,
            content,
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
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
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
            created_at: row.created_at,
            author_username: row.author_username,
            author_avatar_url: row.author_avatar_url,
        };

        Ok(msg.into_message_with_author())
    }
}
