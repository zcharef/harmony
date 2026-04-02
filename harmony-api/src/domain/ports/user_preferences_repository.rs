//! Port: user preferences persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{UserId, UserPreferences};

/// Partial update payload for user preferences.
#[derive(Debug, Clone)]
pub struct UpdatePreferences {
    pub dnd_enabled: Option<bool>,
    pub hide_profanity: Option<bool>,
}

/// Intent-based repository for user preferences.
#[async_trait]
pub trait UserPreferencesRepository: Send + Sync + std::fmt::Debug {
    /// Get user preferences by user ID.
    /// Returns `None` when no row exists (caller should default).
    async fn get(&self, user_id: &UserId) -> Result<Option<UserPreferences>, DomainError>;

    /// Insert or update user preferences (partial patch via COALESCE).
    async fn upsert(
        &self,
        user_id: &UserId,
        patch: UpdatePreferences,
    ) -> Result<UserPreferences, DomainError>;
}
