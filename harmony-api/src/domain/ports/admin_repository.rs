//! Port: platform-admin (founder) persistence.
//!
//! Backs the founder-only admin endpoints: user search, plan management, quota
//! reads, and the append-only audit trail. All access is gated at the HTTP
//! layer by the resolved founder identity — this port assumes the caller is
//! already authorized.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{AdminUserSummary, AdminUserUsage, Plan, UserId};

/// Intent-based repository for founder admin operations.
#[async_trait]
pub trait AdminRepository: Send + Sync + std::fmt::Debug {
    /// Search users whose username contains `query` (case-insensitive),
    /// newest-first, bounded by `limit`. Returns a compact admin summary
    /// (plan + badges) per match.
    async fn search_users(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Vec<AdminUserSummary>, DomainError>;

    /// Fetch a single user's admin summary. `None` if no such user exists.
    async fn get_user_summary(
        &self,
        user_id: &UserId,
    ) -> Result<Option<AdminUserSummary>, DomainError>;

    /// Set a user's plan (`profiles.plan`) and return the updated summary.
    ///
    /// Returns `DomainError::NotFound` if the user does not exist.
    async fn set_user_plan(
        &self,
        user_id: &UserId,
        plan: Plan,
    ) -> Result<AdminUserSummary, DomainError>;

    /// Count a user's current usage against their per-user caps (owned/joined
    /// servers, open DMs). Mirrors the plan checker's pre-POST COUNT queries.
    async fn get_user_usage(&self, user_id: &UserId) -> Result<AdminUserUsage, DomainError>;

    /// Append an audit row for a founder action (best-effort at the call site).
    ///
    /// `action` is a stable machine key (e.g. `"user_plan_set"`); `detail` is a
    /// JSON object with action-specific extras.
    async fn record_action(
        &self,
        actor_id: &UserId,
        action: &str,
        target_user_id: Option<&UserId>,
        detail: serde_json::Value,
    ) -> Result<(), DomainError>;
}
