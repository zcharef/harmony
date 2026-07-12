//! `PostgreSQL` plan limit checker (hosted service adapter).
//!
//! WHY: Hosted deployments enforce server-level resource limits.
//! Reads the `servers.plan` column and counts existing resources.

use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    AnalyticsEvent, Plan, PlanLimits, ResourceKind, SELF_HOSTED_LIMITS, ServerId, UserId,
};
use crate::domain::ports::{AnalyticsRecorder, PlanLimitChecker};

use super::db_err;

/// Plan limit checker backed by Postgres COUNT queries.
#[derive(Debug)]
pub struct PgPlanLimitChecker {
    pool: PgPool,
    /// WHY: `plan_limit_hit` is the monetization funnel's top — every gate
    /// rejection is recorded HERE (the single place all checks converge),
    /// so hits are counted even when no client renders the paywall.
    analytics: Arc<dyn AnalyticsRecorder>,
    /// The platform founder (owner of the official server), resolved once at
    /// startup. When the relevant owner/user is the founder, every limit
    /// resolves to `SELF_HOSTED_LIMITS` (no paywall). `None` on self-hosted/dev.
    /// SECURITY: keyed only off the resolved founder `UserId`.
    founder_id: Option<UserId>,
}

impl PgPlanLimitChecker {
    #[must_use]
    pub fn new(pool: PgPool, analytics: Arc<dyn AnalyticsRecorder>) -> Self {
        Self {
            pool,
            analytics,
            founder_id: None,
        }
    }

    /// Set the resolved platform founder (owner of the official server).
    #[must_use]
    pub fn with_founder(mut self, founder_id: Option<UserId>) -> Self {
        self.founder_id = founder_id;
        self
    }

    /// Whether `user_id` is the resolved platform founder.
    fn is_founder(&self, user_id: &UserId) -> bool {
        matches!(&self.founder_id, Some(founder) if founder == user_id)
    }

    /// Build the rejection error and emit `plan_limit_hit` (fire-and-forget).
    fn reject(
        &self,
        resource: ResourceKind,
        plan: Plan,
        limit: u64,
        server_id: Option<&ServerId>,
        user_id: Option<&UserId>,
    ) -> DomainError {
        // WHY the shared constructor: the atomic voice gate emits the same
        // `plan_limit_hit` shape from `PgVoiceSessionRepository::upsert_with_limit`
        // — building it in one place keeps the two rejection sites in sync.
        let mut event = AnalyticsEvent::plan_limit_hit(resource, plan, limit);
        if let Some(server_id) = server_id {
            event = event.server(server_id.clone());
        }
        if let Some(user_id) = user_id {
            event = event.user(user_id.clone());
        }

        // WHY spawn: analytics must never fail or slow down the rejection
        // path (ADR-027) — same contract as the API-layer `track` helper.
        let recorder = Arc::clone(&self.analytics);
        tokio::spawn(async move {
            let name = event.name;
            if let Err(error) = recorder.record(event).await {
                tracing::warn!(
                    event = %name,
                    error = %error,
                    "analytics event insert failed — event dropped"
                );
            }
        });

        DomainError::LimitExceeded {
            resource,
            plan: Some(plan),
            limit,
        }
    }

    /// Read the server's plan from the DB and return its limits.
    async fn get_server_limits(
        &self,
        server_id: &ServerId,
    ) -> Result<(Plan, PlanLimits), DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"SELECT plan as "plan!", owner_id as "owner_id!" FROM servers WHERE id = $1"#,
            sid
        )
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

        // Founder bypass: a server OWNED BY the founder never hits a paywall —
        // resolve its limits to `SELF_HOSTED_LIMITS`. The real `plan` is still
        // returned (used only for the rejection event, which never fires here).
        if self.is_founder(&UserId::from(row.owner_id)) {
            return Ok((plan, SELF_HOSTED_LIMITS));
        }

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
            return Err(self.reject(resource, plan, max, Some(server_id), None));
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

        // Founder bypass: the founder's own account never hits a per-user
        // paywall — resolve to `SELF_HOSTED_LIMITS`.
        if self.is_founder(user_id) {
            return Ok((plan, SELF_HOSTED_LIMITS));
        }

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
            return Err(self.reject(resource, plan, max, None, Some(user_id)));
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

        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM server_members WHERE server_id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COUNT is non-negative
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

    async fn get_server_plan(&self, server_id: &ServerId) -> Result<Option<Plan>, DomainError> {
        let (plan, _limits) = self.get_server_limits(server_id).await?;
        Ok(Some(plan))
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

    async fn check_emoji_limit(&self, server_id: &ServerId) -> Result<(), DomainError> {
        let sid = server_id.0;

        // WHY: COUNT custom emoji for the server — small, indexed set. Free's cap
        // is 0, so this always trips on Free (custom emoji is a paid feature).
        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM server_emojis WHERE server_id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        self.check_limit(server_id, ResourceKind::CustomEmoji, count as u64)
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

    async fn check_attachment_count(
        &self,
        server_id: &ServerId,
        count: u64,
    ) -> Result<(), DomainError> {
        // WHY no COUNT query: the candidate count comes from the request being
        // validated, not from existing rows. Reject when it EXCEEDS the cap
        // (a message carrying exactly the cap is allowed).
        let (plan, limits) = self.get_server_limits(server_id).await?;
        let max = limits.max_attachments_per_message;
        if count > max {
            return Err(self.reject(
                ResourceKind::AttachmentsPerMessage,
                plan,
                max,
                Some(server_id),
                None,
            ));
        }
        Ok(())
    }

    async fn check_attachment_size(
        &self,
        server_id: &ServerId,
        size_bytes: u64,
    ) -> Result<(), DomainError> {
        let (plan, limits) = self.get_server_limits(server_id).await?;
        let max = limits.max_attachment_size_bytes;
        if size_bytes > max {
            return Err(self.reject(
                ResourceKind::AttachmentSize,
                plan,
                max,
                Some(server_id),
                None,
            ));
        }
        Ok(())
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
