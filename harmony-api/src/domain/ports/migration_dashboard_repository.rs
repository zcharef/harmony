//! Port: read-only member-migration dashboard queries (growth-plan §14.1).
//!
//! Backed by the analytics schema (`metrics_server_alive` +
//! `server_member_cohort`). Read-only: this port never writes. Ownership is
//! enforced one layer up, in `MigrationService` — the repository trusts the
//! `server_id` it is handed.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{MemberCohortPage, MemberFollowThrough, ServerAliveSnapshot, ServerId};

/// Reads owner-facing migration metrics from the analytics views.
#[async_trait]
pub trait MigrationDashboardRepository: Send + Sync + std::fmt::Debug {
    /// The §5 week-1 "alive server" snapshot for one server. Returns an
    /// all-zero / unknown snapshot when the server has no analytics row
    /// (e.g. excluded), never an error for a missing row.
    async fn alive_snapshot(
        &self,
        server_id: &ServerId,
    ) -> Result<ServerAliveSnapshot, DomainError>;

    /// All-time member-follow-through counts for one server.
    async fn follow_through(
        &self,
        server_id: &ServerId,
    ) -> Result<MemberFollowThrough, DomainError>;

    /// One cursor page of not-yet-active members (joined, never performed a
    /// genuine action), newest joiners first. `before` paginates backward on
    /// `joined_at`; `limit` bounds the page.
    async fn not_yet_active_members(
        &self,
        server_id: &ServerId,
        before: Option<chrono::DateTime<chrono::Utc>>,
        limit: i64,
    ) -> Result<MemberCohortPage, DomainError>;
}
