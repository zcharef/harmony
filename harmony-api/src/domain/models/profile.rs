//! Profile domain model.
//!
//! Represents a user's public-facing profile, synced from Supabase `auth.users`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::UserId;

/// User presence status.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum UserStatus {
    Online,
    Idle,
    /// Do Not Disturb — maps to `'dnd'` in Postgres.
    #[serde(rename = "dnd")]
    DoNotDisturb,
    #[default]
    Offline,
}

/// Terminal moderation state of an identity image (avatar/banner).
///
/// An identity image has no channel context (an avatar is global), so — unlike
/// [`AttachmentModerationStatus`](super::AttachmentModerationStatus) — there is
/// no `gated`/`blocked` middle ground: a flagged image is `Rejected` (never
/// revealed to other users; the previous approved image stays live).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum IdentityImageModerationStatus {
    /// A newly-set candidate is being scanned; not shown to other users.
    Pending,
    /// Cleared — this is the live, displayed image.
    #[default]
    Approved,
    /// Flagged (adult-NSFW / CSAM); never revealed. Previous image stays live.
    Rejected,
}

impl IdentityImageModerationStatus {
    /// The Postgres enum text value.
    #[must_use]
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }

    /// Parse a Postgres enum text value (unknown → `Approved`, fail-open on read
    /// so a decode hiccup never hides an already-approved image).
    #[must_use]
    pub fn from_db_str(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "rejected" => Self::Rejected,
            _ => Self::Approved,
        }
    }
}

/// Which identity image a moderation operation targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityImageKind {
    Avatar,
    Banner,
}

impl IdentityImageKind {
    /// The `image_kind` text value stored in `identity_image_scan_retry`.
    #[must_use]
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Avatar => "avatar",
            Self::Banner => "banner",
        }
    }
}

/// A user profile (public-facing data).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    /// APPROVED, displayed avatar. Every render surface reads this column.
    pub avatar_url: Option<String>,
    pub status: UserStatus,
    pub custom_status: Option<String>,
    /// Bio (markdown-lite, links only, max 190 chars).
    pub bio: Option<String>,
    /// APPROVED, displayed banner (public Storage URL, reuses the avatars bucket).
    pub banner_url: Option<String>,
    /// Not-yet-cleared avatar candidate under scan. Only the owner sees it (the
    /// API never reveals it to other users); it becomes live only when the scan
    /// promotes it into `avatar_url`.
    pub pending_avatar_url: Option<String>,
    /// Scan state of the avatar candidate.
    pub avatar_moderation_status: IdentityImageModerationStatus,
    /// Not-yet-cleared banner candidate under scan (see `pending_avatar_url`).
    pub pending_banner_url: Option<String>,
    /// Scan state of the banner candidate.
    pub banner_moderation_status: IdentityImageModerationStatus,
    /// Whether this user holds the `founding` badge (one of the first accounts).
    /// Derived from `user_badges` at read time; never mutated on the profile row.
    pub is_founding: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
