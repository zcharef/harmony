//! Port: message persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, Message, MessageId, MessageWithAuthor, NewAttachment, ServerId, UserId,
};

/// Result of [`MessageRepository::list_around`]: the centered window plus a
/// signal for whether older history remains *below* it.
///
/// The window is two-sided, so its total row count is short whenever EITHER
/// half is short. That makes `rows.len() == limit` useless for deriving the
/// backward-paging cursor — a full older half with a short newer half (anchor
/// near the present) would wrongly look "exhausted". `has_more_older` reports
/// the older half's fill state directly so the handler can set `nextCursor`
/// correctly.
#[derive(Debug)]
pub struct AroundWindow {
    /// The centered page, `created_at DESC` (same shape as `list_for_channel`).
    pub messages: Vec<MessageWithAuthor>,
    /// True when the older sub-window was filled to `before_limit` rows — more
    /// history may exist below the window, so backward paging must stay armed.
    pub has_more_older: bool,
}

/// Structured search filters (parsed client-side, §5.3). All optional.
#[derive(Debug, Clone)]
pub struct MessageSearchFilters {
    /// Restrict to one channel (the `in:` filter). When None, search every
    /// channel of the server the caller can access.
    pub channel_id: Option<ChannelId>,
    /// Restrict to one author (the `from:` filter).
    pub author_id: Option<UserId>,
    /// `has:link` — message content contains a URL.
    pub has_link: bool,
    /// `has:image` — message content contains an image URL (URL ending in an
    /// image extension). URL-based until attachments (T1.3) land; then this
    /// should switch to an attachments join (§10).
    pub has_image: bool,
}

/// Intent-based repository for messages.
#[async_trait]
pub trait MessageRepository: Send + Sync + std::fmt::Debug {
    /// Send a new message to a channel.
    ///
    /// When `slow_mode_seconds > 0`, the implementation atomically checks the
    /// user's last message time inside the same transaction as the INSERT,
    /// using `pg_advisory_xact_lock` to prevent TOCTOU double-send races.
    /// Returns `DomainError::RateLimited` if the cooldown has not elapsed.
    /// When `slow_mode_seconds == 0`, the check is skipped (no tx overhead).
    #[allow(clippy::too_many_arguments)]
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
        // Server-validated mention targets to persist in `mentioned_user_ids`.
        mentioned_user_ids: Vec<UserId>,
        // Validated attachments inserted in the SAME transaction as the message
        // (atomicity — no orphan message, no orphan rows). Empty = no tx overhead.
        attachments: Vec<NewAttachment>,
        slow_mode_seconds: i32,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// List messages in a channel with cursor-based pagination (ADR-036).
    ///
    /// Returns messages older than `cursor` (if provided), limited to `limit` rows.
    async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError>;

    /// Find a message by ID (returns `None` if not found OR soft-deleted).
    async fn find_by_id(&self, message_id: &MessageId) -> Result<Option<Message>, DomainError>;

    /// Find a message by ID WITH author + parent-preview joins (returns `None`
    /// if not found OR soft-deleted). Reactions/attachments/mentions are left
    /// empty for the caller to enrich — used to rebuild a `MessagePayload` for a
    /// `MessageUpdated` SSE after an async attachment-moderation verdict.
    async fn find_with_author(
        &self,
        message_id: &MessageId,
    ) -> Result<Option<MessageWithAuthor>, DomainError>;

    /// Fetch a window of messages centered on `anchor_id` (jump-to-message).
    ///
    /// Returns up to `before_limit` strictly-older rows, the anchor itself, and
    /// up to `after_limit` strictly-newer rows, all ordered `created_at DESC`
    /// (same shape as [`list_for_channel`](Self::list_for_channel) so the client
    /// reverse keeps working). Soft-deleted rows are excluded EXCEPT the anchor,
    /// which is always included so a jump can land on a tombstone.
    ///
    /// Returns `None` when `anchor_id` does not exist or does not belong to
    /// `channel_id` — the service maps that to `NotFound`.
    async fn list_around(
        &self,
        channel_id: &ChannelId,
        anchor_id: &MessageId,
        before_limit: i64,
        after_limit: i64,
    ) -> Result<Option<AroundWindow>, DomainError>;

    /// Update message content. Sets `is_edited=true`, `edited_at=now()`.
    /// Returns the updated message.
    ///
    /// `mentioned_user_ids`: `Some` = plaintext edit re-parse result (overwrites
    /// the column); `None` = encrypted edit (leaves the column unchanged via
    /// `COALESCE`).
    async fn update_content(
        &self,
        message_id: &MessageId,
        content: String,
        moderated_at: Option<DateTime<Utc>>,
        moderation_reason: Option<String>,
        original_content: Option<String>,
        mentioned_user_ids: Option<Vec<UserId>>,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// Soft-delete a message (ADR-038). Sets `deleted_at=now()` and `deleted_by`.
    ///
    /// When `checked_at` is `Some(ts)`, the UPDATE includes an atomic stale-content
    /// guard: `AND COALESCE(edited_at, created_at) = ts`. If the message was edited
    /// after `ts`, the UPDATE matches zero rows and the method returns `Ok(())`
    /// (stale moderation result — skip silently). When `checked_at` is `None`,
    /// the guard is skipped (user-initiated deletes always proceed).
    async fn soft_delete(
        &self,
        message_id: &MessageId,
        deleted_by: &UserId,
        checked_at: Option<DateTime<Utc>>,
    ) -> Result<(), DomainError>;

    /// Count non-deleted messages by an author in a channel within the last `window_secs` seconds.
    ///
    /// Used for per-channel rate limiting in `MessageService::create`.
    async fn count_recent(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        window_secs: i64,
    ) -> Result<i64, DomainError>;

    /// Get the timestamp of the last non-deleted message by this author in this channel.
    ///
    /// NOTE: Slow mode enforcement now uses an atomic check inside `send_to_channel`
    /// (with `pg_advisory_xact_lock`) to prevent TOCTOU races. This method remains
    /// available for read-only queries that don't need transactional guarantees.
    async fn get_last_message_time(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
    ) -> Result<Option<DateTime<Utc>>, DomainError>;

    /// Full-text search messages within a server, gated by per-channel access.
    ///
    /// Access model mirrors `channel_repository::list_for_server`
    /// (channel_repository.rs:117-133): a channel is searchable when it is public,
    /// OR the caller's role is owner/admin, OR their role has a `channel_role_access`
    /// grant. Encrypted channels are always excluded (`content_tsv` is NULL there and
    /// `c.encrypted` is filtered). This method is the single source of truth for the access gate —
    /// integration tests pin it against the same fixtures as `ensure_channel_access`
    /// (§7.2), exactly as `filter_mentionable` is pinned for mentions.
    ///
    /// Returns messages older than `cursor` (keyset pagination, ADR-036), newest
    /// first, limited to `limit` rows. Enrichment (reactions, mention resolution)
    /// is done by the service layer, identical to `list_for_channel`.
    async fn search_in_server(
        &self,
        server_id: &ServerId,
        caller_user_id: &UserId,
        query_text: &str,
        filters: &MessageSearchFilters,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError>;

    /// Pin or unpin a message, writing the `is_pinned` flag and its provenance
    /// atomically in one `UPDATE`.
    ///
    /// Pin (`pinned = true`) sets `is_pinned = true, pinned_by = $pinned_by,
    /// pinned_at = now()`; unpin (`pinned = false`) clears all three
    /// (`is_pinned = false, pinned_by = NULL, pinned_at = NULL`). Scoped to
    /// non-deleted rows (`deleted_at IS NULL`). This single write path is the
    /// `SSoT` for the `is_pinned ⟺ pinned_at IS NOT NULL AND pinned_by IS NOT NULL`
    /// invariant (no CHECK constraint — spec §2).
    ///
    /// Returns the updated message WITH author/parent joins so the handler can
    /// build the SSE payload without a refetch. Returns `NotFound` if the
    /// message does not exist or is soft-deleted.
    async fn set_pinned(
        &self,
        message_id: &MessageId,
        pinned_by: &UserId,
        pinned: bool,
    ) -> Result<MessageWithAuthor, DomainError>;

    /// Count currently-pinned (non-deleted) messages in a channel. Drives the
    /// per-channel pin cap.
    async fn count_pinned(&self, channel_id: &ChannelId) -> Result<i64, DomainError>;

    /// List the channel's pinned (non-deleted) messages, most-recently-pinned
    /// first (`pinned_at DESC`), capped at `limit`. Same author/parent joins as
    /// [`list_for_channel`](Self::list_for_channel); the service enriches
    /// reactions/mentions/attachments identically.
    async fn list_pinned(
        &self,
        channel_id: &ChannelId,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError>;

    /// Create a system message (e.g. join announcement).
    ///
    /// `author_id` is the subject of the event (the user who joined, left, etc.)
    /// — NOT a "sender". Content is empty; the frontend renders localized text
    /// from `system_event_key`.
    async fn create_system(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        system_event_key: String,
    ) -> Result<MessageWithAuthor, DomainError>;
}
