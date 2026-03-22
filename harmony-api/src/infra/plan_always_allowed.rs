//! Always-allowed plan limit checker (self-hosted adapter).
//!
//! WHY: Self-hosted deployments have no plan restrictions.
//! This adapter satisfies the `PlanLimitChecker` port by always returning Ok.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::ServerId;
use crate::domain::ports::PlanLimitChecker;

/// Plan limit checker that always allows operations (self-hosted mode).
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
}
