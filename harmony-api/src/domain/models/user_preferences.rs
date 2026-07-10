//! User preferences domain model.
//!
//! Represents per-user settings (DND mode, notification switches, future
//! expandable preferences).

use chrono::{DateTime, Utc};

use super::ids::UserId;

/// User preferences (settings controlled by the user).
#[derive(Debug, Clone)]
pub struct UserPreferences {
    pub user_id: UserId,
    pub dnd_enabled: bool,
    pub hide_profanity: bool,
    pub onboarding_completed: bool,
    pub notifications_enabled: bool,
    pub notify_messages: bool,
    pub notify_dms: bool,
    pub notify_mentions: bool,
    pub notification_sounds_enabled: bool,
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
            onboarding_completed: false,
            // WHY all true: matches today's effective behavior (notifications
            // always attempted) so the feature rollout is behavior-neutral.
            notifications_enabled: true,
            notify_messages: true,
            notify_dms: true,
            notify_mentions: true,
            notification_sounds_enabled: true,
            created_at: now,
            updated_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// WHY: A user with no preferences row must be treated as NOT onboarded —
    /// the default-when-no-row path is what makes onboarding show for fresh
    /// signups without any signup-time insert.
    #[test]
    fn default_preferences_mark_onboarding_incomplete() {
        let prefs = UserPreferences::default_for(UserId::from(Uuid::new_v4()));

        assert!(!prefs.onboarding_completed);
        assert!(!prefs.dnd_enabled);
        assert!(prefs.hide_profanity);
    }
}
