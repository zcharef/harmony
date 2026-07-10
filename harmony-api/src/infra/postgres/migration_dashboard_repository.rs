//! `PostgreSQL` adapter for the member-migration dashboard (growth-plan §14.1).
//!
//! Read-only. Every figure comes straight from the §5/§10 analytics views —
//! `analytics.metrics_server_alive` (the alive verdict) and
//! `analytics.server_member_cohort` (per-member follow-through). No metric is
//! re-derived here.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{
    MemberCohortPage, MemberFollowThrough, NotYetActiveMember, ServerAliveSnapshot, ServerId,
    UserId,
};
use crate::domain::ports::MigrationDashboardRepository;

/// PostgreSQL-backed migration dashboard reader.
#[derive(Debug, Clone)]
pub struct PgMigrationDashboardRepository {
    pool: sqlx::PgPool,
}

impl PgMigrationDashboardRepository {
    #[must_use]
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl MigrationDashboardRepository for PgMigrationDashboardRepository {
    async fn alive_snapshot(
        &self,
        server_id: &ServerId,
    ) -> Result<ServerAliveSnapshot, DomainError> {
        let sid = server_id.0;

        // metrics_server_alive holds one row per eligible server. A missing row
        // (excluded / self-hosted / never analytics-eligible) is not an error —
        // it is an all-zero, unknown-verdict snapshot.
        let row = sqlx::query!(
            r#"
            SELECT
                members_joined_week1   AS "members_joined_week1!",
                non_owner_active_week1 AS "non_owner_active_week1!",
                messages_week1         AS "messages_week1!",
                distinct_senders_week1 AS "distinct_senders_week1!",
                active_days_week1      AS "active_days_week1!",
                is_alive               AS "is_alive?"
            FROM analytics.metrics_server_alive
            WHERE server_id = $1
            "#,
            sid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(
            row.map_or_else(ServerAliveSnapshot::empty, |r| ServerAliveSnapshot {
                members_joined_week1: r.members_joined_week1,
                non_owner_active_week1: r.non_owner_active_week1,
                messages_week1: r.messages_week1,
                distinct_senders_week1: r.distinct_senders_week1,
                active_days_week1: r.active_days_week1,
                is_alive: r.is_alive,
            }),
        )
    }

    async fn follow_through(
        &self,
        server_id: &ServerId,
    ) -> Result<MemberFollowThrough, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                COUNT(*)                                  AS "members_joined!",
                COUNT(*) FILTER (WHERE is_active)         AS "members_active!",
                COUNT(*) FILTER (WHERE has_sent_message)  AS "members_sent_message!",
                COUNT(*) FILTER (WHERE NOT is_active)     AS "not_yet_active!"
            FROM analytics.server_member_cohort
            WHERE server_id = $1
            "#,
            sid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(MemberFollowThrough {
            members_joined: row.members_joined,
            members_active: row.members_active,
            members_sent_message: row.members_sent_message,
            not_yet_active: row.not_yet_active,
        })
    }

    async fn not_yet_active_members(
        &self,
        server_id: &ServerId,
        before: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<MemberCohortPage, DomainError> {
        let sid = server_id.0;

        // Newest joiners first (warmest to nudge). Cursor paginates backward on
        // joined_at (ADR-036: cursor, never OFFSET), mirroring the members-list
        // handler. The secondary user_id sort makes the row order deterministic
        // when joined_at ties; the joined_at-only cursor is the same accepted
        // v1 simplification list_members uses (joined_at is microsecond-precise
        // in production, so boundary ties are vanishingly rare).
        let rows = sqlx::query!(
            r#"
            SELECT
                user_id       AS "user_id!",
                username      AS "username!",
                display_name,
                avatar_url,
                nickname,
                joined_at     AS "joined_at!",
                has_sent_message AS "has_sent_message!"
            FROM analytics.server_member_cohort
            WHERE server_id = $1
              AND is_active = false
              AND ($2::timestamptz IS NULL OR joined_at < $2)
            ORDER BY joined_at DESC, user_id DESC
            LIMIT $3
            "#,
            sid,
            before,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let total = sqlx::query_scalar!(
            r#"
            SELECT COUNT(*) AS "total!"
            FROM analytics.server_member_cohort
            WHERE server_id = $1 AND is_active = false
            "#,
            sid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let items = rows
            .into_iter()
            .map(|r| NotYetActiveMember {
                user_id: UserId::new(r.user_id),
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                nickname: r.nickname,
                joined_at: r.joined_at,
                has_sent_message: r.has_sent_message,
            })
            .collect();

        Ok(MemberCohortPage { items, total })
    }
}
