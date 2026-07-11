//! Port: profile persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId};

/// Intent-based repository for user profiles.
#[async_trait]
pub trait ProfileRepository: Send + Sync + std::fmt::Debug {
    /// Create or update a profile from auth provider data (Supabase sign-up/login).
    ///
    /// Called on first login to ensure a profile row exists. `display_name` is
    /// written on INSERT only — the `ON CONFLICT` branch is a no-op, so an
    /// existing profile's display name (which the user may have changed in
    /// settings) is never overwritten by a later login.
    async fn upsert_from_auth(
        &self,
        user_id: UserId,
        email: String,
        username: String,
        display_name: Option<String>,
    ) -> Result<Profile, DomainError>;

    /// Get a profile by user ID. Returns `None` if not found.
    async fn get_by_id(&self, user_id: &UserId) -> Result<Option<Profile>, DomainError>;

    /// Check whether a username is already taken.
    async fn is_username_taken(&self, username: &str) -> Result<bool, DomainError>;

    /// Get a profile by exact (lowercase) username. Returns `None` if not found.
    ///
    /// Usernames are globally unique and lowercase, so this is the natural handle
    /// for Add-Friend-by-username (§3.1). The caller normalizes before lookup.
    async fn get_by_username(&self, username: &str) -> Result<Option<Profile>, DomainError>;

    /// Batch-fetch profiles by a list of user IDs.
    ///
    /// Returns only the profiles that exist — missing IDs are silently skipped.
    /// Order is not guaranteed.
    async fn get_profiles_by_ids(&self, ids: &[UserId]) -> Result<Vec<Profile>, DomainError>;

    /// Update a user's profile fields.
    ///
    /// Each field uses `Option<Option<String>>`: outer = "was the field
    /// provided?", inner = the new value (`Some(None)` clears the column).
    /// Same double-option contract as `ChannelRepository::update` `topic`.
    async fn update(
        &self,
        user_id: &UserId,
        avatar_url: Option<Option<String>>,
        display_name: Option<Option<String>>,
        custom_status: Option<Option<String>>,
        bio: Option<Option<String>>,
        banner_url: Option<Option<String>>,
    ) -> Result<Profile, DomainError>;

    /// Overwrite a user's username with a server-chosen safe value.
    ///
    /// Used only to remediate a username that bypassed the content filter via
    /// the signup trigger. Unlike `update`, this targets the immutable-by-user
    /// `username` column, so it is a distinct, narrowly-scoped method.
    async fn update_username(
        &self,
        user_id: &UserId,
        username: &str,
    ) -> Result<Profile, DomainError>;

    /// Count how many users currently hold `badge` (e.g. `"founding"`).
    ///
    /// Used by the founding-grant gate: the badge is issued to the first N
    /// accounts, so the number already granted is the live cursor.
    async fn count_badge_holders(&self, badge: &str) -> Result<i64, DomainError>;

    /// Idempotently grant `badge` to `user_id` (no-op if already held).
    ///
    /// Writes to the service-role-only `user_badges` table (ADR-040 RLS).
    async fn grant_badge(&self, user_id: &UserId, badge: &str) -> Result<(), DomainError>;

    /// Revoke `badge` from `user_id` (no-op if the user never held it).
    ///
    /// Writes to the service-role-only `user_badges` table (ADR-040 RLS).
    async fn revoke_badge(&self, user_id: &UserId, badge: &str) -> Result<(), DomainError>;

    /// List every user currently holding `badge` (e.g. `"official"`).
    ///
    /// Powers the lightweight official-set read the SPA caches to decorate
    /// message authors without bloating every message payload.
    async fn list_badge_holders(&self, badge: &str) -> Result<Vec<UserId>, DomainError>;
}
