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
    // ProfileService methods are thin repository pass-throughs:
    // - upsert_from_auth: delegates entirely to repo
    // - get_by_id: delegates to repo + maps None to NotFound
    //
    // No domain validation exists to unit-test. Integration tests
    // with real Postgres cover the actual behavior (ADR-018).
}
