//! `PostgreSQL` adapter for message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    Attachment, AttachmentId, ChannelId, Message, MessageId, MessageType, MessageWithAuthor,
    NewAttachment, ParentMessagePreview, Role, ServerId, UserId,
};
use crate::domain::ports::{AroundWindow, MessageRepository, MessageSearchFilters};

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
    mentioned_user_ids: Vec<Uuid>,
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
            mentioned_user_ids: self
                .mentioned_user_ids
                .into_iter()
                .map(UserId::new)
                .collect(),
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
    mentioned_user_ids: Vec<Uuid>,
    created_at: DateTime<Utc>,
    // Author profile fields from JOIN.
    author_username: Option<String>,
    author_display_name: Option<String>,
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
            mentioned_user_ids: self
                .mentioned_user_ids
                .into_iter()
                .map(UserId::new)
                .collect(),
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
            author_display_name: self.author_display_name,
            author_avatar_url: self.author_avatar_url,
            // WHY: Reactions are populated by MessageService after batch-fetching,
            // not by the repository query. Default to empty here.
            reactions: vec![],
            parent_message,
            // WHY: Mentions are resolved by MessageService from
            // message.mentioned_user_ids, not by the repository query.
            mentions: vec![],
            // WHY: Attachments are set by the send_to_channel transaction on
            // write and batch-fetched by MessageService on read paths.
            attachments: vec![],
        }
    }
}

/// Insert the message row (with author + parent-preview JOINs) on the given
/// connection.
///
/// WHY a shared helper on `&mut PgConnection`: the same INSERT runs on three
/// paths (slow-mode transaction, attachments transaction, plain fast path) —
/// previously the query was duplicated verbatim per path.
#[allow(clippy::too_many_arguments)]
async fn insert_message_row(
    conn: &mut sqlx::PgConnection,
    channel_id: Uuid,
    author_id: Uuid,
    content: &str,
    encrypted: bool,
    sender_device_id: Option<&str>,
    parent_message_id: Option<Uuid>,
    moderated_at: Option<DateTime<Utc>>,
    moderation_reason: Option<&str>,
    original_content: Option<&str>,
    mentioned_user_ids: &[Uuid],
) -> Result<MessageWithAuthorRow, DomainError> {
    let row = sqlx::query!(
        r#"
        WITH inserted AS (
            INSERT INTO messages (channel_id, author_id, content, encrypted, sender_device_id, parent_message_id, moderated_at, moderation_reason, original_content, mentioned_user_ids)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
                mentioned_user_ids,
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
            i.mentioned_user_ids as "mentioned_user_ids!",
            i.created_at as "created_at!",
            p.username AS "author_username?",
            p.display_name AS "author_display_name?",
            p.avatar_url AS "author_avatar_url?",
            parent_p.username AS "parent_author_username?",
            LEFT(parent_m.content, 100) AS "parent_content_preview?",
            (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
        FROM inserted i
        LEFT JOIN profiles p ON p.id = i.author_id
        LEFT JOIN messages parent_m ON parent_m.id = i.parent_message_id
        LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
        "#,
        channel_id,
        author_id,
        content,
        encrypted,
        sender_device_id,
        parent_message_id,
        moderated_at,
        moderation_reason,
        original_content,
        mentioned_user_ids,
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(super::db_err)?;

    Ok(MessageWithAuthorRow {
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
        mentioned_user_ids: row.mentioned_user_ids,
        created_at: row.created_at,
        author_username: row.author_username,
        author_display_name: row.author_display_name,
        author_avatar_url: row.author_avatar_url,
        parent_author_username: row.parent_author_username,
        parent_content_preview: row.parent_content_preview,
        parent_deleted: row.parent_deleted,
    })
}

/// Bulk-insert attachment rows for a message on the given connection
/// (single `UNNEST` statement), returning them in insertion order.
///
/// WHY `now() + ord µs`: `now()` is transaction-stable, so every row would
/// share one timestamp and the `ORDER BY created_at, id` read path could not
/// reconstruct insertion order (`id` is a random uuid — useless tiebreak).
/// Adding the UNNEST ordinality as microseconds makes `created_at` strictly
/// increasing and DETERMINISTIC — unlike `clock_timestamp()`, which can
/// repeat within one clock tick.
async fn insert_attachments(
    conn: &mut sqlx::PgConnection,
    message_id: Uuid,
    attachments: &[NewAttachment],
) -> Result<Vec<Attachment>, DomainError> {
    if attachments.is_empty() {
        return Ok(Vec::new());
    }

    let urls: Vec<String> = attachments.iter().map(|a| a.url.clone()).collect();
    let mimes: Vec<String> = attachments.iter().map(|a| a.mime.clone()).collect();
    let sizes: Vec<i64> = attachments.iter().map(|a| a.size).collect();
    let widths: Vec<Option<i32>> = attachments.iter().map(|a| a.width).collect();
    let heights: Vec<Option<i32>> = attachments.iter().map(|a| a.height).collect();

    let rows = sqlx::query!(
        r#"
        INSERT INTO message_attachments (message_id, url, mime, size, width, height, created_at)
        SELECT $1, u.url, u.mime, u.size, u.width, u.height,
               now() + make_interval(secs => (u.ord - 1)::double precision / 1e6)
        FROM UNNEST($2::text[], $3::text[], $4::bigint[], $5::int[], $6::int[])
             WITH ORDINALITY AS u(url, mime, size, width, height, ord)
        RETURNING id, message_id, url, mime, size, width, height, created_at
        "#,
        message_id,
        &urls,
        &mimes,
        &sizes,
        &widths as &[Option<i32>],
        &heights as &[Option<i32>],
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(super::db_err)?;

    // WHY sort: RETURNING row order is not guaranteed by SQL — created_at
    // encodes the insertion order deterministically, so sorting restores it
    // for the response/SSE payload regardless of executor ordering.
    let mut rows = rows;
    rows.sort_by_key(|row| row.created_at);
    Ok(rows
        .into_iter()
        .map(|row| Attachment {
            id: AttachmentId::new(row.id),
            message_id: MessageId::new(row.message_id),
            url: row.url,
            mime: row.mime,
            size: row.size,
            width: row.width,
            height: row.height,
            // Freshly inserted rows carry the DB `DEFAULT 'pending'` — the async
            // scan flips them. The INSERT does not touch the column, so this
            // mirrors the row state (scan-before-reveal, spec §c.1).
            moderation_status: crate::domain::models::AttachmentModerationStatus::Pending,
            created_at: row.created_at,
        })
        .collect())
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
        mentioned_user_ids: Vec<UserId>,
        attachments: Vec<NewAttachment>,
        slow_mode_seconds: i32,
    ) -> Result<MessageWithAuthor, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;
        let pmid = parent_message_id.map(|id| id.0);
        let mentions: Vec<Uuid> = mentioned_user_ids.into_iter().map(|u| u.0).collect();

        // Fast path: no slow mode and no attachments — single INSERT, no
        // transaction overhead.
        if slow_mode_seconds == 0 && attachments.is_empty() {
            let mut conn = self.pool.acquire().await.map_err(super::db_err)?;
            let row = insert_message_row(
                &mut conn,
                cid,
                aid,
                &content,
                encrypted,
                sender_device_id.as_deref(),
                pmid,
                moderated_at,
                moderation_reason.as_deref(),
                original_content.as_deref(),
                &mentions,
            )
            .await?;
            return Ok(row.into_message_with_author());
        }

        // Transactional path: the slow-mode TOCTOU lock and/or the atomic
        // message+attachments write (no orphan message, no orphan rows).
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // WHY: When slow_mode_seconds > 0, we must atomically check the user's last
        // message time AND insert in the same transaction, using pg_advisory_xact_lock
        // to serialize concurrent sends from the same (user, channel) pair. Without
        // this, two concurrent requests can both pass the elapsed check before either
        // INSERT commits — a TOCTOU race that bypasses slow mode entirely.
        if slow_mode_seconds > 0 {
            // WHY: hashtext(user_id || channel_id) produces a stable int4 hash.
            // pg_advisory_xact_lock serializes only sends from the SAME user to
            // the SAME channel — zero contention for different user/channel pairs.
            // The lock auto-releases when the transaction commits or rolls back.
            sqlx::query!(
                r#"SELECT pg_advisory_xact_lock(hashtext($1 || $2))"#,
                aid.to_string(),
                cid.to_string(),
            )
            .execute(&mut *tx)
            .await
            .map_err(super::db_err)?;

            // WHY: Re-check last message time INSIDE the lock. Any concurrent
            // request from the same user+channel is blocked until this tx commits,
            // so the SELECT and INSERT are effectively atomic.
            // Matches get_last_message_time: only count 'default' messages (system
            // messages like join/leave announcements should not trigger slow mode).
            let last_msg = sqlx::query!(
                r#"
            SELECT created_at
            FROM messages
            WHERE channel_id = $1
              AND author_id = $2
              AND deleted_at IS NULL
              AND message_type = 'default'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
                cid,
                aid,
            )
            .fetch_optional(&mut *tx)
            .await
            .map_err(super::db_err)?;

            if let Some(last) = last_msg {
                let elapsed = (Utc::now() - last.created_at).num_seconds();
                if elapsed < i64::from(slow_mode_seconds) {
                    let remaining = i64::from(slow_mode_seconds) - elapsed;
                    // WHY: tx is dropped here, which rolls back and releases the lock.
                    return Err(DomainError::RateLimited(format!(
                        "Slow mode active — wait {} seconds before sending another message",
                        remaining
                    )));
                }
            }
        }

        let row = insert_message_row(
            &mut tx,
            cid,
            aid,
            &content,
            encrypted,
            sender_device_id.as_deref(),
            pmid,
            moderated_at,
            moderation_reason.as_deref(),
            original_content.as_deref(),
            &mentions,
        )
        .await?;

        // Atomic with the message INSERT: a failure here rolls the whole
        // transaction back, so no orphan message and no orphan rows.
        let inserted_attachments = insert_attachments(&mut tx, row.id, &attachments).await?;

        tx.commit().await.map_err(super::db_err)?;

        let mut msg = row.into_message_with_author();
        msg.attachments = inserted_attachments;
        Ok(msg)
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
                m.mentioned_user_ids as "mentioned_user_ids!",
                m.created_at,
                p.username AS "author_username?",
                p.display_name AS "author_display_name?",
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
                    mentioned_user_ids: r.mentioned_user_ids,
                    created_at: r.created_at,
                    author_username: r.author_username,
                    author_display_name: r.author_display_name,
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

    async fn search_in_server(
        &self,
        server_id: &ServerId,
        caller_user_id: &UserId,
        query_text: &str,
        filters: &MessageSearchFilters,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let sid = server_id.0;
        let uid = caller_user_id.0;
        // Nullable filter binds — `$n::uuid IS NULL` short-circuits the predicate.
        let channel_filter: Option<uuid::Uuid> = filters.channel_id.as_ref().map(|c| c.0);
        let author_filter: Option<uuid::Uuid> = filters.author_id.as_ref().map(|a| a.0);

        // FTS search (ADR-036 keyset pagination). The `content_tsv @@ ...`
        // predicate uses the GIN index; the access EXISTS mirrors
        // channel_repository::list_for_server so search cannot diverge from the
        // channel-visibility gate. Encrypted channels/messages are excluded
        // (content_tsv is NULL there anyway — belt + suspenders).
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
                m.mentioned_user_ids as "mentioned_user_ids!",
                m.created_at,
                p.username AS "author_username?",
                p.display_name AS "author_display_name?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM messages m
            JOIN channels c ON c.id = m.channel_id
            LEFT JOIN profiles p ON p.id = m.author_id
            LEFT JOIN messages parent_m ON parent_m.id = m.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            WHERE c.server_id = $1
              AND c.encrypted = false
              AND m.encrypted = false
              AND m.deleted_at IS NULL
              AND m.message_type != 'system'
              AND m.content_tsv @@ websearch_to_tsquery('english', $3)
              AND (
                  c.is_private = false
                  OR EXISTS (
                      SELECT 1 FROM server_members sm
                      WHERE sm.server_id = c.server_id
                        AND sm.user_id = $2
                        AND (
                            sm.role IN ($4, $5)
                            OR EXISTS (
                                SELECT 1 FROM channel_role_access cra
                                WHERE cra.channel_id = c.id AND cra.role = sm.role
                            )
                        )
                  )
              )
              AND ($6::uuid IS NULL OR m.channel_id = $6)
              AND ($7::uuid IS NULL OR m.author_id = $7)
              AND ($8 = false OR m.content ~* 'https?://')
              AND ($9 = false OR m.content ~* '(?i)https?://\S+\.(png|jpe?g|gif|webp|bmp|svg)(\?\S*)?')
              AND ($10::timestamptz IS NULL OR m.created_at < $10)
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT $11
            "#,
            sid,
            uid,
            query_text,
            Role::Owner.as_str(),
            Role::Admin.as_str(),
            channel_filter,
            author_filter,
            filters.has_link,
            filters.has_image,
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
                    mentioned_user_ids: r.mentioned_user_ids,
                    created_at: r.created_at,
                    author_username: r.author_username,
                    author_display_name: r.author_display_name,
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
                mentioned_user_ids,
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
                mentioned_user_ids: r.mentioned_user_ids,
                created_at: r.created_at,
            }
            .into_message()
        }))
    }

    async fn find_with_author(
        &self,
        message_id: &MessageId,
    ) -> Result<Option<MessageWithAuthor>, DomainError> {
        let mid = message_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                m.id as "id!",
                m.channel_id as "channel_id!",
                m.author_id as "author_id!",
                m.content,
                m.edited_at,
                m.deleted_at,
                m.deleted_by,
                m.encrypted as "encrypted!",
                m.sender_device_id,
                m.message_type as "message_type!: String",
                m.system_event_key,
                m.parent_message_id,
                m.moderated_at,
                m.moderation_reason,
                m.original_content,
                m.mentioned_user_ids as "mentioned_user_ids!",
                m.created_at as "created_at!",
                p.username AS "author_username?",
                p.display_name AS "author_display_name?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM messages m
            LEFT JOIN profiles p ON p.id = m.author_id
            LEFT JOIN messages parent_m ON parent_m.id = m.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            WHERE m.id = $1 AND m.deleted_at IS NULL
            "#,
            mid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|row| {
            MessageWithAuthorRow {
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
                mentioned_user_ids: row.mentioned_user_ids,
                created_at: row.created_at,
                author_username: row.author_username,
                author_display_name: row.author_display_name,
                author_avatar_url: row.author_avatar_url,
                parent_author_username: row.parent_author_username,
                parent_content_preview: row.parent_content_preview,
                parent_deleted: row.parent_deleted,
            }
            .into_message_with_author()
        }))
    }

    async fn list_around(
        &self,
        channel_id: &ChannelId,
        anchor_id: &MessageId,
        before_limit: i64,
        after_limit: i64,
    ) -> Result<Option<AroundWindow>, DomainError> {
        let cid = channel_id.0;
        let aid = anchor_id.0;

        // WHY a dedicated anchor lookup that ignores deleted_at: jump-to-message
        // must land on a soft-deleted tombstone (ticket §3.2), and we need the
        // anchor's created_at to split the window. Scoped to the channel so an
        // anchor from another channel yields None → NotFound at the service.
        let Some(anchor) = sqlx::query!(
            r#"SELECT created_at FROM messages WHERE id = $1 AND channel_id = $2"#,
            aid,
            cid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?
        else {
            return Ok(None);
        };
        let anchor_at = anchor.created_at;

        // WHY the target_ids CTE: apply independent LIMITs to the older and
        // newer half around the anchor, then re-join the SAME projection as
        // list_for_channel so parent-preview/author columns stay identical.
        // The anchor id is unioned in unconditionally (may be deleted); the two
        // windows use strict < / > so it is never double-counted. Final order is
        // created_at DESC to match list_for_channel's client-side reverse.
        let rows = sqlx::query!(
            r#"
            WITH target_ids AS (
                (SELECT id FROM messages
                    WHERE channel_id = $1 AND deleted_at IS NULL AND created_at < $2
                    ORDER BY created_at DESC LIMIT $3)
                UNION ALL
                (SELECT id FROM messages
                    WHERE channel_id = $1 AND deleted_at IS NULL AND created_at > $2
                    ORDER BY created_at ASC LIMIT $4)
                UNION ALL
                SELECT $5::uuid AS id
            )
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
                m.mentioned_user_ids as "mentioned_user_ids!",
                m.created_at,
                p.username AS "author_username?",
                p.display_name AS "author_display_name?",
                p.avatar_url AS "author_avatar_url?",
                parent_p.username AS "parent_author_username?",
                LEFT(parent_m.content, 100) AS "parent_content_preview?",
                (parent_m.deleted_at IS NOT NULL) AS "parent_deleted?"
            FROM messages m
            JOIN target_ids ti ON ti.id = m.id
            LEFT JOIN profiles p ON p.id = m.author_id
            LEFT JOIN messages parent_m ON parent_m.id = m.parent_message_id
            LEFT JOIN profiles parent_p ON parent_p.id = parent_m.author_id
            WHERE m.channel_id = $1
            ORDER BY m.created_at DESC
            "#,
            cid,
            anchor_at,
            before_limit,
            after_limit,
            aid,
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
                    mentioned_user_ids: r.mentioned_user_ids,
                    created_at: r.created_at,
                    author_username: r.author_username,
                    author_display_name: r.author_display_name,
                    author_avatar_url: r.author_avatar_url,
                    parent_author_username: r.parent_author_username,
                    parent_content_preview: r.parent_content_preview,
                    parent_deleted: r.parent_deleted,
                }
                .into_message_with_author()
            })
            .collect::<Vec<_>>();

        // WHY count strictly-older rows: the older sub-window is the only source
        // of `created_at < anchor_at` rows (the anchor sits at `anchor_at`, the
        // newer half strictly above). If that count hit `before_limit`, the half
        // was capped and more history may exist below — the handler must keep the
        // backward cursor armed. This drives `nextCursor`, NOT the total row count
        // (a two-sided window is short whenever either half is short).
        let older_count = messages
            .iter()
            .filter(|m| m.message.created_at < anchor_at)
            .count();
        let has_more_older =
            before_limit > 0 && older_count == usize::try_from(before_limit).unwrap_or(usize::MAX);

        Ok(Some(AroundWindow {
            messages,
            has_more_older,
        }))
    }

    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
        mentioned_user_ids: Option<Vec<UserId>>,
    ) -> Result<MessageWithAuthor, DomainError> {
        let mid = message_id.0;
        let mod_at = moderated_at;
        let mod_reason = moderation_reason;
        let orig_content = original_content;
        // WHY: None = encrypted edit → leave the column untouched via COALESCE.
        // Some = plaintext re-parse → overwrite. The `$6::uuid[]` cast is required
        // so Postgres can type the NULL branch.
        let mentioned_opt: Option<Vec<Uuid>> =
            mentioned_user_ids.map(|v| v.into_iter().map(|u| u.0).collect());

        let row = sqlx::query!(
            r#"
            WITH updated AS (
                UPDATE messages
                SET content = $2, is_edited = true, edited_at = now(), moderated_at = $3, moderation_reason = $4, original_content = $5, mentioned_user_ids = COALESCE($6::uuid[], mentioned_user_ids)
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
                    mentioned_user_ids,
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
                u.mentioned_user_ids as "mentioned_user_ids!",
                u.created_at as "created_at!",
                p.username AS "author_username?",
                p.display_name AS "author_display_name?",
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
            mentioned_opt.as_deref(),
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
            mentioned_user_ids: row.mentioned_user_ids,
            created_at: row.created_at,
            author_username: row.author_username,
            author_display_name: row.author_display_name,
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
        checked_at: Option<DateTime<Utc>>,
    ) -> Result<(), DomainError> {
        let mid = message_id.0;
        let dby = deleted_by.0;

        let result = sqlx::query!(
            r#"
            UPDATE messages
            SET deleted_at = now(), deleted_by = $2
            WHERE id = $1
              AND deleted_at IS NULL
              AND ($3::timestamptz IS NULL OR COALESCE(edited_at, created_at) = $3)
            "#,
            mid,
            dby,
            checked_at,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            // WHY: When checked_at is Some, zero rows could mean either
            // "already deleted" or "edited since moderation check" (stale).
            // For stale moderation, return Ok(()) — the content changed,
            // so the moderation verdict no longer applies.
            if checked_at.is_some() {
                // Distinguish stale-edit from already-deleted by checking existence.
                let exists = sqlx::query_scalar!(
                    r#"SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND deleted_at IS NULL) AS "exists!""#,
                    mid,
                )
                .fetch_one(&self.pool)
                .await
                .map_err(super::db_err)?;

                if exists {
                    // Message exists but COALESCE(edited_at, created_at) != checked_at
                    // → content was edited after moderation captured it. Skip silently.
                    tracing::info!(
                        message_id = %message_id,
                        "Stale moderation delete skipped — message was edited since check"
                    );
                    return Ok(());
                }
            }

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

    async fn get_last_message_time(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
    ) -> Result<Option<DateTime<Utc>>, DomainError> {
        let cid = channel_id.0;
        let aid = author_id.0;

        let row = sqlx::query!(
            r#"
            SELECT created_at
            FROM messages
            WHERE channel_id = $1
              AND author_id = $2
              AND deleted_at IS NULL
              AND message_type = 'default'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
            cid,
            aid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| r.created_at))
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
                p.display_name AS "author_display_name?",
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
            // WHY: System messages never mention anyone; the create_system query
            // does not select the column, so default to empty.
            mentioned_user_ids: Vec::new(),
            created_at: row.created_at,
            author_username: row.author_username,
            author_display_name: row.author_display_name,
            author_avatar_url: row.author_avatar_url,
            // WHY: System messages never have parent replies.
            parent_author_username: None,
            parent_content_preview: None,
            parent_deleted: None,
        };

        Ok(msg.into_message_with_author())
    }
}
