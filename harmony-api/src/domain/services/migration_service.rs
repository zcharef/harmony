//! Member-migration command-center service (growth-plan §14.1).
//!
//! Orchestrates the owner-facing migration dashboard: enforces that ONLY the
//! server owner can read their server's people-metrics (the app-layer twin of
//! RLS — the analytics views are read via the schema-owner connection, so the
//! authorization decision lives here), then reads the §5/§10 metrics and
//! derives the single owner-actionable next step from the playbook.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ALIVE_MIN_NON_OWNER_ACTIVE, MemberCohortPage, MemberFollowThrough, MigrationProgress,
    RecommendedAction, Server, ServerAliveSnapshot, ServerId, UserId,
};
use crate::domain::ports::{MigrationDashboardRepository, ServerRepository};

/// Owner-facing migration dashboard business logic.
#[derive(Debug, Clone)]
pub struct MigrationService {
    server_repository: Arc<dyn ServerRepository>,
    dashboard_repository: Arc<dyn MigrationDashboardRepository>,
}

impl MigrationService {
    #[must_use]
    pub fn new(
        server_repository: Arc<dyn ServerRepository>,
        dashboard_repository: Arc<dyn MigrationDashboardRepository>,
    ) -> Self {
        Self {
            server_repository,
            dashboard_repository,
        }
    }

    /// The full migration-progress payload for the owner's server.
    ///
    /// # Errors
    /// `NotFound` if the server does not exist; `Forbidden` if the caller is
    /// not its owner; repository errors otherwise.
    pub async fn progress(
        &self,
        server_id: &ServerId,
        caller: &UserId,
    ) -> Result<MigrationProgress, DomainError> {
        self.authorize_owner(server_id, caller).await?;

        let alive = self.dashboard_repository.alive_snapshot(server_id).await?;
        let follow_through = self.dashboard_repository.follow_through(server_id).await?;
        let recommended_action = Self::recommend(&alive, &follow_through);

        Ok(MigrationProgress {
            server_id: server_id.clone(),
            alive,
            follow_through,
            recommended_action,
        })
    }

    /// One cursor page of not-yet-active members (the intervention targets).
    ///
    /// # Errors
    /// `NotFound` if the server does not exist; `Forbidden` if the caller is
    /// not its owner; repository errors otherwise.
    pub async fn not_yet_active_cohort(
        &self,
        server_id: &ServerId,
        caller: &UserId,
        before: Option<chrono::DateTime<chrono::Utc>>,
        limit: i64,
    ) -> Result<MemberCohortPage, DomainError> {
        self.authorize_owner(server_id, caller).await?;
        self.dashboard_repository
            .not_yet_active_members(server_id, before, limit)
            .await
    }

    /// Fetch the server and assert the caller owns it.
    async fn authorize_owner(
        &self,
        server_id: &ServerId,
        caller: &UserId,
    ) -> Result<Server, DomainError> {
        let server = self.server_repository.get_by_id(server_id).await?;
        Self::assert_owner(server, server_id, caller)
    }

    /// Pure ownership check: `Some(server)` owned by `caller` → `Ok(server)`;
    /// `None` → `NotFound`; wrong owner → `Forbidden`.
    ///
    /// WHY a not-found server and a not-owned one both hide behind their own
    /// status (404 vs 403): the owner dashboard is not an existence oracle for
    /// arbitrary server IDs, but leaking 403-vs-404 here is acceptable because
    /// server existence is already public via the invite/preview surface.
    fn assert_owner(
        server: Option<Server>,
        server_id: &ServerId,
        caller: &UserId,
    ) -> Result<Server, DomainError> {
        let Some(server) = server else {
            return Err(DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            });
        };
        if server.owner_id != *caller {
            return Err(DomainError::Forbidden(
                "Only the server owner can view the migration dashboard".to_string(),
            ));
        }
        Ok(server)
    }

    /// Derive the single owner-actionable next step from the metrics, per the
    /// member-migration playbook. Pure function of the two metric snapshots.
    ///
    /// Ordering encodes the playbook's escalation:
    /// 1. nobody joined            → invite your top members (Issue 1)
    /// 2. joined but < the alive   → seed conversation / run an event (Issue 2)
    ///    bar of genuine actives
    /// 3. the server is alive      → share the progress as social proof
    /// 4. otherwise (dormant tail) → nudge the not-yet-active members
    #[must_use]
    fn recommend(
        alive: &ServerAliveSnapshot,
        follow_through: &MemberFollowThrough,
    ) -> RecommendedAction {
        if follow_through.members_joined == 0 {
            return RecommendedAction::InviteMembers;
        }
        if follow_through.members_active < ALIVE_MIN_NON_OWNER_ACTIVE {
            return RecommendedAction::SeedConversation;
        }
        if alive.is_alive == Some(true) {
            return RecommendedAction::ShareProgress;
        }
        if follow_through.not_yet_active > 0 {
            return RecommendedAction::NudgeInactive;
        }
        RecommendedAction::ShareProgress
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::domain::models::Server;

    fn server_owned_by(owner: &UserId) -> Server {
        let now = Utc::now();
        Server {
            id: ServerId::new(Uuid::new_v4()),
            name: "Maya's Community".to_string(),
            icon_url: None,
            owner_id: owner.clone(),
            is_dm: false,
            created_at: now,
            updated_at: now,
        }
    }

    fn alive(is_alive: Option<bool>, non_owner_active: i64) -> ServerAliveSnapshot {
        ServerAliveSnapshot {
            members_joined_week1: 5,
            non_owner_active_week1: non_owner_active,
            messages_week1: 60,
            distinct_senders_week1: 4,
            active_days_week1: 3,
            is_alive,
        }
    }

    fn follow_through(joined: i64, active: i64, not_yet_active: i64) -> MemberFollowThrough {
        MemberFollowThrough {
            members_joined: joined,
            members_active: active,
            members_sent_message: active,
            not_yet_active,
        }
    }

    // ── Ownership guard (the app-layer RLS twin) ──────────────────────────

    #[test]
    fn owner_is_authorized() {
        let owner = UserId::new(Uuid::new_v4());
        let server = server_owned_by(&owner);
        let sid = server.id.clone();
        let result = MigrationService::assert_owner(Some(server), &sid, &owner);
        assert!(result.is_ok(), "the owner must see their own server");
    }

    #[test]
    fn non_owner_is_forbidden() {
        let owner = UserId::new(Uuid::new_v4());
        let intruder = UserId::new(Uuid::new_v4());
        let server = server_owned_by(&owner);
        let sid = server.id.clone();
        let result = MigrationService::assert_owner(Some(server), &sid, &intruder);
        assert!(
            matches!(result, Err(DomainError::Forbidden(_))),
            "a non-owner must be forbidden, got {result:?}"
        );
    }

    #[test]
    fn missing_server_is_not_found() {
        let caller = UserId::new(Uuid::new_v4());
        let sid = ServerId::new(Uuid::new_v4());
        let result = MigrationService::assert_owner(None, &sid, &caller);
        assert!(
            matches!(result, Err(DomainError::NotFound { .. })),
            "a missing server must be 404, got {result:?}"
        );
    }

    // ── Recommended-action derivation (playbook escalation) ───────────────

    #[test]
    fn no_members_recommends_inviting() {
        let action = MigrationService::recommend(&alive(None, 0), &follow_through(0, 0, 0));
        assert_eq!(action, RecommendedAction::InviteMembers);
    }

    #[test]
    fn joined_but_few_active_recommends_seeding() {
        // 10 joined, only 2 genuinely active (< the 3-active alive bar).
        let action = MigrationService::recommend(&alive(None, 2), &follow_through(10, 2, 8));
        assert_eq!(action, RecommendedAction::SeedConversation);
    }

    #[test]
    fn alive_server_recommends_sharing_progress() {
        let action = MigrationService::recommend(&alive(Some(true), 4), &follow_through(20, 6, 14));
        assert_eq!(action, RecommendedAction::ShareProgress);
    }

    #[test]
    fn active_base_with_dormant_tail_recommends_nudging() {
        // Past the active bar but the window is still open and a tail is dormant.
        let action = MigrationService::recommend(&alive(None, 4), &follow_through(20, 4, 16));
        assert_eq!(action, RecommendedAction::NudgeInactive);
    }
}
