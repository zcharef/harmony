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

/// A user profile (public-facing data).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub status: UserStatus,
    pub custom_status: Option<String>,
    /// Bio (markdown-lite, links only, max 190 chars).
    pub bio: Option<String>,
    /// Banner image URL (public Storage URL, reuses the avatars bucket).
    pub banner_url: Option<String>,
    /// Whether this user holds the `founding` badge (one of the first accounts).
    /// Derived from `user_badges` at read time; never mutated on the profile row.
    pub is_founding: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
