//! Profile domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId};
use crate::domain::ports::ProfileRepository;
use crate::domain::services::content_filter::ContentFilter;

/// Service for profile-related business logic.
#[derive(Debug)]
pub struct ProfileService {
    repo: Arc<dyn ProfileRepository>,
    content_filter: Arc<ContentFilter>,
}

impl ProfileService {
    #[must_use]
    pub fn new(repo: Arc<dyn ProfileRepository>, content_filter: Arc<ContentFilter>) -> Self {
        Self {
            repo,
            content_filter,
        }
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
        self.content_filter.check_hard(&username)?;
        self.repo.upsert_from_auth(user_id, email, username).await
    }

    /// Check whether a username is already taken.
    ///
    /// # Errors
    /// Returns `DomainError` if the repository operation fails.
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

    /// Update profile fields for the authenticated user.
    ///
    /// Validates inputs before delegating to the repository:
    /// - At least one field must be provided
    /// - `avatar_url` must start with `https://`
    /// - `display_name` must be 1-32 characters
    /// - `custom_status` must be at most 128 characters
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` on invalid input,
    /// or a repository error on failure.
    pub async fn update_profile(
        &self,
        user_id: &UserId,
        avatar_url: Option<String>,
        display_name: Option<String>,
        custom_status: Option<String>,
    ) -> Result<Profile, DomainError> {
        if avatar_url.is_none() && display_name.is_none() && custom_status.is_none() {
            return Err(DomainError::ValidationError(
                "At least one field must be provided".to_string(),
            ));
        }

        if let Some(ref url) = avatar_url
            && !url.starts_with("https://")
        {
            return Err(DomainError::ValidationError(
                "Avatar URL must use HTTPS".to_string(),
            ));
        }

        if let Some(ref name) = display_name {
            let len = name.len();
            if len == 0 || len > 32 {
                return Err(DomainError::ValidationError(
                    "Display name must be 1-32 characters".to_string(),
                ));
            }
            self.content_filter.check_hard(name)?;
        }

        if let Some(ref status) = custom_status {
            if status.len() > 128 {
                return Err(DomainError::ValidationError(
                    "Custom status must be at most 128 characters".to_string(),
                ));
            }
            self.content_filter.check_hard(status)?;
        }

        self.repo
            .update(user_id, avatar_url, display_name, custom_status)
            .await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── NotFound error construction ─────────────────────────────

    #[test]
    fn not_found_error_includes_user_id() {
        // WHY: Verify the error contains enough context for debugging.
        let user_id = UserId::new(Uuid::from_u128(42));
        let err = DomainError::NotFound {
            resource_type: "Profile",
            id: user_id.to_string(),
        };

        let display = format!("{err}");
        assert!(
            display.contains("Profile"),
            "Error should mention resource type: {display}"
        );
        assert!(
            display.contains(&user_id.to_string()),
            "Error should include the user ID: {display}"
        );
    }

    #[test]
    fn not_found_error_resource_type_is_profile() {
        let err = DomainError::NotFound {
            resource_type: "Profile",
            id: "test".to_string(),
        };

        match err {
            DomainError::NotFound { resource_type, .. } => {
                assert_eq!(resource_type, "Profile");
            }
            other => panic!("Expected NotFound, got {:?}", other),
        }
    }

    // ── UserId display format ───────────────────────────────────

    #[test]
    fn user_id_display_matches_uuid() {
        let raw = Uuid::from_u128(123);
        let user_id = UserId::new(raw);
        assert_eq!(user_id.to_string(), raw.to_string());
    }

    // ── Async service methods requiring repos ────────────────────
    //
    // The following business rules are enforced in async methods that
    // require repository trait objects (banned by ADR-018: no mocks):
    //
    // - upsert_from_auth: content filter on username, then repo upsert
    // - update_profile: length validation + content filter on display_name
    //   and custom_status, HTTPS-only avatar_url, then repo update
    // - get_by_id: delegates to repo + maps None to NotFound
    //
    // These are covered by integration tests with real Postgres.
}
