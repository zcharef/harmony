//! Port: plan limit enforcement.
//!
//! WHY: Abstracts plan limit checking behind a trait so self-hosted deployments
//! can use `AlwaysAllowedChecker` while the hosted service uses `PgPlanLimitChecker`.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::ServerId;

/// Checks whether a server has reached its plan limit for a given resource.
///
/// Implementations:
/// - `AlwaysAllowedChecker`: always returns `Ok(())` (self-hosted)
/// - `PgPlanLimitChecker`: reads `servers.plan` column and does COUNT queries (hosted)
#[async_trait]
pub trait PlanLimitChecker: Send + Sync + std::fmt::Debug {
    /// Check if the server can add another channel.
    ///
    /// Returns `DomainError::LimitExceeded` if the limit is reached.
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the channel count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_channel_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    /// Check if the server can add another member.
    ///
    /// Returns `DomainError::LimitExceeded` if the limit is reached.
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the member count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_member_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    // ── TODO: implement when RoleService is created (Phase 2 roadmap) ──
    //
    // async fn check_role_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from RoleService::create_role AFTER validation, BEFORE repo.create().
    // Free: 20 roles, Pro: 250 roles. See PlanLimits in domain/models/plan.rs.

    // ── TODO: implement when file upload is added (Phase 3 roadmap) ────
    //
    // async fn check_storage_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    // async fn check_file_size(&self, server_id: &ServerId, file_bytes: u64) -> Result<(), DomainError>;
    //
    // check_storage_limit: compare SUM(file_size) from message_attachments against plan total.
    //   Free: 1 GB, Pro: 50 GB. See PlanLimits in domain/models/plan.rs.
    // check_file_size: compare individual file size against plan max_file_size_bytes.
    //   Free: 8 MB, Pro: 50 MB. See PlanLimits in domain/models/plan.rs.
    // Call from the attachment upload handler BEFORE storing in Supabase Storage.
}
