//! Always-allowed plan limit checker (self-hosted adapter).
//!
//! WHY: Self-hosted deployments have no plan restrictions.
//! This adapter satisfies the `PlanLimitChecker` port by always returning Ok.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{PlanLimits, ServerId, UserId};
use crate::domain::ports::PlanLimitChecker;

/// Plan limit checker that always allows operations (self-hosted mode).
///
/// COUNT-based checks return `Ok(())` (no enforcement).
/// Value-based queries return `SELF_HOSTED_LIMITS` (high but finite defaults).
#[derive(Debug)]
pub struct AlwaysAllowedChecker;

#[async_trait]
impl PlanLimitChecker for AlwaysAllowedChecker {
    async fn check_channel_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn check_member_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn get_server_plan_limits(
        &self,
        _server_id: &ServerId,
    ) -> Result<PlanLimits, DomainError> {
        Ok(PlanLimits::for_self_hosted())
    }

    async fn check_owned_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn check_voice_concurrent(&self, _server_id: &ServerId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn check_invite_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn check_dm_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
        Ok(())
    }

    async fn check_joined_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
        Ok(())
    }
}
