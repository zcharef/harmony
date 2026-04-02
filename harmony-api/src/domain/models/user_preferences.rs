//! User preferences domain model.
//!
//! Represents per-user settings (DND mode, future expandable preferences).

use chrono::{DateTime, Utc};

use super::ids::UserId;

/// User preferences (settings controlled by the user).
#[derive(Debug, Clone)]
pub struct UserPreferences {
    pub user_id: UserId,
    pub dnd_enabled: bool,
    pub hide_profanity: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl UserPreferences {
    /// Return default preferences for a user who has no row yet.
    #[must_use]
    pub fn default_for(user_id: UserId) -> Self {
        let now = Utc::now();
        Self {
            user_id,
            dnd_enabled: false,
            hide_profanity: true,
            created_at: now,
            updated_at: now,
        }
    }
}
