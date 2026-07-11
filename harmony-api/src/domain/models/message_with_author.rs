//! Message-with-author view model.
//!
//! A read-optimised projection joining `messages` with `profiles` so that
//! API consumers receive the author's username and avatar alongside the
//! message payload.  Follows the same pattern as [`ServerMember`] — a
//! domain view model that aggregates data from two tables.
//!
//! The core [`Message`] entity remains unchanged.

use crate::domain::models::Attachment;
use crate::domain::models::MentionedUser;
use crate::domain::models::Message;
use crate::domain::models::MessageEmbed;
use crate::domain::models::ParentMessagePreview;
use crate::domain::models::ReactionSummary;

/// A message enriched with author profile data (username + avatar).
///
/// Returned by repository queries that JOIN `profiles`. Write-side
/// operations (`soft_delete`, `count_recent`) do not need this and
/// continue to work with `Message` or primitives directly.
#[derive(Debug, Clone)]
pub struct MessageWithAuthor {
    /// The underlying message entity.
    pub message: Message,
    /// Author's display username (from `profiles.username`).
    pub author_username: String,
    /// Author's display name (from `profiles.display_name`), if set.
    pub author_display_name: Option<String>,
    /// Author's avatar URL (from `profiles.avatar_url`), if set.
    pub author_avatar_url: Option<String>,
    /// Aggregated reaction summaries (populated by `MessageService`, not the repository).
    pub reactions: Vec<ReactionSummary>,
    /// Preview of the parent message when this is a reply.
    pub parent_message: Option<ParentMessagePreview>,
    /// Server-resolved mentioned users (the Discord `mentions` array). Populated
    /// by `MessageService` (not the repository), resolved from
    /// `message.mentioned_user_ids` at read time so pill labels stay current.
    pub mentions: Vec<MentionedUser>,
    /// Files attached to this message, insertion order. Populated by the
    /// `send_to_channel` transaction on write and by
    /// `AttachmentRepository::batch_for_messages` on read (mirrors `reactions`).
    pub attachments: Vec<Attachment>,
    /// Link previews unfurled from URLs in the content, insertion order.
    /// Written by the async unfurl worker AFTER the message commits; read via
    /// `EmbedRepository::batch_for_messages` (mirrors `attachments`).
    /// Suppressed previews are never present.
    pub embeds: Vec<MessageEmbed>,
}
