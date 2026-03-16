//! Port: profile persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId};

/// Intent-based repository for user profiles.
#[async_trait]
pub trait ProfileRepository: Send + Sync + std::fmt::Debug {
    /// Create or update a profile from auth provider data (Supabase sign-up/login).
    ///
    /// Called on first login to ensure a profile row exists. Subsequent calls
    /// update the email-derived username if needed.
    async fn upsert_from_auth(
        &self,
        user_id: UserId,
        email: String,
        username: String,
    ) -> Result<Profile, DomainError>;

    /// Get a profile by user ID. Returns `None` if not found.
    async fn get_by_id(&self, user_id: &UserId) -> Result<Option<Profile>, DomainError>;
}
