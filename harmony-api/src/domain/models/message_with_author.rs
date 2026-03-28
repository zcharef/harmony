//! Message-with-author view model.
//!
//! A read-optimised projection joining `messages` with `profiles` so that
//! API consumers receive the author's username and avatar alongside the
//! message payload.  Follows the same pattern as [`ServerMember`] — a
//! domain view model that aggregates data from two tables.
//!
//! The core [`Message`] entity remains unchanged.

use crate::domain::models::Message;

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
    /// Author's avatar URL (from `profiles.avatar_url`), if set.
    pub author_avatar_url: Option<String>,
}
