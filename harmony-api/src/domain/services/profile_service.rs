//! Profile domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId};
use crate::domain::ports::ProfileRepository;

/// Service for profile-related business logic.
#[derive(Debug)]
pub struct ProfileService {
    repo: Arc<dyn ProfileRepository>,
}

impl ProfileService {
    #[must_use]
    pub fn new(repo: Arc<dyn ProfileRepository>) -> Self {
        Self { repo }
    }

    /// Create or update a profile from auth provider data.
    ///
    /// # Errors
    /// Returns `DomainError` if the repository operation fails.
    pub async fn upsert_from_auth(
        &self,
        user_id: UserId,
        email: String,
        username: String,
    ) -> Result<Profile, DomainError> {
        self.repo.upsert_from_auth(user_id, email, username).await
    }

    /// Check whether a username is already taken.
    ///
    /// # Errors
    /// Returns `DomainError` on repository failure.
    pub async fn is_username_taken(&self, username: &str) -> Result<bool, DomainError> {
        self.repo.is_username_taken(username).await
    }

    /// Get a profile by user ID.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the profile does not exist,
    /// or a repository error on failure.
    pub async fn get_by_id(&self, user_id: &UserId) -> Result<Profile, DomainError> {
        self.repo
            .get_by_id(user_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Profile",
                id: user_id.to_string(),
            })
    }
}
