//! `PostgreSQL` plan limit checker (hosted service adapter).
//!
//! WHY: Hosted deployments enforce server-level resource limits.
//! Reads the `servers.plan` column and counts existing resources.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{Plan, PlanLimits, ResourceKind, ServerId, UserId};
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

    /// Read the user's plan from profiles and return its limits.
    async fn get_user_limits(&self, user_id: &UserId) -> Result<(Plan, PlanLimits), DomainError> {
        let uid = user_id.0;

        let row = sqlx::query!(r#"SELECT plan as "plan!" FROM profiles WHERE id = $1"#, uid)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Profile",
                id: user_id.to_string(),
            })?;

        let plan: Plan = row.plan.parse().map_err(|e: String| {
            tracing::error!(user_id = %user_id, plan = %row.plan, "Invalid plan value in DB");
            DomainError::Internal(e)
        })?;

        Ok((plan, PlanLimits::for_plan(plan)))
    }

    /// Generic user-level limit check: count resources and compare to user's plan limit.
    async fn check_user_limit(
        &self,
        user_id: &UserId,
        resource: ResourceKind,
        current_count: u64,
    ) -> Result<(), DomainError> {
        let (plan, limits) = self.get_user_limits(user_id).await?;
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

    async fn get_server_plan_limits(
        &self,
        server_id: &ServerId,
    ) -> Result<PlanLimits, DomainError> {
        let (_plan, limits) = self.get_server_limits(server_id).await?;
        Ok(limits)
    }

    async fn check_owned_server_limit(&self, user_id: &UserId) -> Result<(), DomainError> {
        let uid = user_id.0;

        // WHY: COUNT non-DM servers owned by this user.
        // DM servers are auto-created and don't count toward the owned server limit.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
               FROM servers
               WHERE owner_id = $1 AND is_dm = false"#,
            uid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_user_limit(user_id, ResourceKind::OwnedServers, count as u64)
            .await
    }

    async fn check_voice_concurrent(&self, server_id: &ServerId) -> Result<(), DomainError> {
        let sid = server_id.0;

        // WHY: COUNT active voice sessions in this server.
        // voice_sessions rows are removed on disconnect, so all rows are active.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM voice_sessions WHERE server_id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_limit(server_id, ResourceKind::VoiceConcurrent, count as u64)
            .await
    }

    async fn check_invite_limit(&self, server_id: &ServerId) -> Result<(), DomainError> {
        let sid = server_id.0;

        // WHY: COUNT active invites (not expired AND not exhausted).
        // Matches Invite::is_valid() logic from domain model.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
               FROM invites
               WHERE server_id = $1
                 AND (expires_at IS NULL OR expires_at > NOW())
                 AND (max_uses IS NULL OR use_count < max_uses)"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_limit(server_id, ResourceKind::ActiveInvites, count as u64)
            .await
    }

    async fn check_dm_limit(&self, user_id: &UserId) -> Result<(), DomainError> {
        let uid = user_id.0;

        // WHY: COUNT DM servers the user is a member of (is_dm = true).
        // DM servers are 1:1 conversations modeled as servers with is_dm flag.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
               FROM server_members sm
               JOIN servers s ON s.id = sm.server_id
               WHERE sm.user_id = $1 AND s.is_dm = true"#,
            uid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_user_limit(user_id, ResourceKind::OpenDms, count as u64)
            .await
    }

    async fn check_joined_server_limit(&self, user_id: &UserId) -> Result<(), DomainError> {
        let uid = user_id.0;

        // WHY: COUNT non-DM servers the user is a member of.
        // DM servers are auto-created and don't count toward the joined server limit.
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
               FROM server_members sm
               JOIN servers s ON s.id = sm.server_id
               WHERE sm.user_id = $1 AND s.is_dm = false"#,
            uid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_user_limit(user_id, ResourceKind::JoinedServers, count as u64)
            .await
    }
}
