//! Message link-preview embed model.
//!
//! One row per unfurled URL preview under a message (Open Graph /
//! twitter-card metadata). Rows are written by the async unfurl worker
//! AFTER the message commits — never on the send hot path — and read via
//! the same batched pattern as attachments/reactions.

use chrono::{DateTime, Utc};

use crate::domain::models::ids::{EmbedId, MessageId};

/// A link preview attached to a message.
///
/// Suppressed rows (author removed the preview) are never returned by
/// read queries — they exist only so the URL never re-unfurls.
#[derive(Debug, Clone, PartialEq)]
pub struct MessageEmbed {
    pub id: EmbedId,
    pub message_id: MessageId,
    /// The URL that was unfurled (as it appeared in the message).
    pub url: String,
    /// Page title (`og:title` → `twitter:title` → `<title>`).
    pub title: Option<String>,
    /// Page description (`og:description` → `twitter:description` → meta description).
    pub description: Option<String>,
    /// Site name (`og:site_name`, falls back to the URL host client-side).
    pub site_name: Option<String>,
    /// Thumbnail URL (`og:image` → `twitter:image`), absolute http(s) only.
    pub image_url: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Unfurled page metadata awaiting insertion (pre-persist form). Also the
/// cached shape in `link_unfurl_cache` — an entry with every field `None`
/// records a FAILED unfurl (negative cache, prevents refetch storms).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UnfurledPage {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
}

impl UnfurledPage {
    /// A preview card needs at least a title to be worth rendering.
    #[must_use]
    pub fn has_content(&self) -> bool {
        self.title.is_some()
    }
}

/// A validated embed awaiting insertion, paired with its source URL.
#[derive(Debug, Clone, PartialEq)]
pub struct NewEmbed {
    pub url: String,
    pub page: UnfurledPage,
}
