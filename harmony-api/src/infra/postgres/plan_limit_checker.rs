//! `PostgreSQL` plan limit checker (hosted service adapter).
//!
//! WHY: Hosted deployments enforce server-level resource limits.
//! Reads the `servers.plan` column and counts existing resources.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{Plan, PlanLimits, ResourceKind, ServerId};
use crate::domain::ports::PlanLimitChecker;

use super::db_err;

/// Plan limit checker backed by Postgres COUNT queries.
#[derive(Debug)]
pub struct PgPlanLimitChecker {
    pool: PgPool,
}

impl PgPlanLimitChecker {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Read the server's plan from the DB and return its limits.
    async fn get_server_limits(
        &self,
        server_id: &ServerId,
    ) -> Result<(Plan, PlanLimits), DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(r#"SELECT plan as "plan!" FROM servers WHERE id = $1"#, sid)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })?;

        let plan: Plan = row.plan.parse().map_err(|e: String| {
            tracing::error!(server_id = %server_id, plan = %row.plan, "Invalid plan value in DB");
            DomainError::Internal(e)
        })?;

        Ok((plan, PlanLimits::for_plan(plan)))
    }

    /// Generic limit check: count current resources and compare to plan limit.
    async fn check_limit(
        &self,
        server_id: &ServerId,
        resource: ResourceKind,
        current_count: u64,
    ) -> Result<(), DomainError> {
        let (plan, limits) = self.get_server_limits(server_id).await?;
        let max = limits.limit_for(resource);

        if current_count >= max {
            return Err(DomainError::LimitExceeded {
                resource: resource.display_name(),
                plan: plan.to_string(),
                limit: max,
            });
        }

        Ok(())
    }
}

#[async_trait]
impl PlanLimitChecker for PgPlanLimitChecker {
    async fn check_channel_limit(&self, server_id: &ServerId) -> Result<(), DomainError> {
        let sid = server_id.0;

        // WHY: COUNT on channels is fast -- small set per server, indexed by server_id.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM channels WHERE server_id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_limit(server_id, ResourceKind::Channels, count as u64)
            .await
    }

    async fn check_member_limit(&self, server_id: &ServerId) -> Result<(), DomainError> {
        let sid = server_id.0;

        // WHY: Use denormalized member_count from servers table for performance.
        // Avoids COUNT(*) on potentially large server_members table.
        let count = sqlx::query_scalar!(
            r#"SELECT member_count as "member_count!" FROM servers WHERE id = $1"#,
            sid
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| DomainError::NotFound {
            resource_type: "Server",
            id: server_id.to_string(),
        })?;

        #[allow(clippy::cast_sign_loss)] // WHY: member_count is non-negative by DB constraint
        self.check_limit(server_id, ResourceKind::Members, count as u64)
            .await
    }
}
