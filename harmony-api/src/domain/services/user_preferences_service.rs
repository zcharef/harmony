//! User preferences domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{UserId, UserPreferences};
use crate::domain::ports::{UpdatePreferences, UserPreferencesRepository};

/// Service for user preferences (DND mode, future settings).
#[derive(Debug)]
pub struct UserPreferencesService {
    repo: Arc<dyn UserPreferencesRepository>,
}

impl UserPreferencesService {
    #[must_use]
    pub fn new(repo: Arc<dyn UserPreferencesRepository>) -> Self {
        Self { repo }
    }

    /// Get preferences for a user.
    /// Returns default preferences (`dnd_enabled: false`) when no row exists.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn get(&self, user_id: &UserId) -> Result<UserPreferences, DomainError> {
        let prefs = self.repo.get(user_id).await?;
        Ok(prefs.unwrap_or_else(|| UserPreferences::default_for(user_id.clone())))
    }

    /// Update preferences for a user (partial patch).
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn update(
        &self,
        user_id: &UserId,
        patch: UpdatePreferences,
    ) -> Result<UserPreferences, DomainError> {
        self.repo.upsert(user_id, patch).await
    }
}
