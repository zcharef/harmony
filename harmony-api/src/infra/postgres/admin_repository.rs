//! `PostgreSQL` adapter for platform-admin (founder) persistence.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::domain::errors::DomainError;
use crate::domain::models::{AdminUserSummary, AdminUserUsage, Plan, UserId};
use crate::domain::ports::AdminRepository;

use super::db_err;

/// Maximum rows returned by a single user search (bounds the payload).
const SEARCH_LIMIT_MAX: i64 = 50;

/// PostgreSQL-backed admin repository.
#[derive(Debug, Clone)]
pub struct PgAdminRepository {
    pool: PgPool,
}

impl PgAdminRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Parse a DB `plan` string into the domain enum, mapping an unknown value to
/// an internal error (the CHECK constraint should make this unreachable).
fn parse_plan(raw: &str, user_id: &UserId) -> Result<Plan, DomainError> {
    raw.parse::<Plan>().map_err(|e| {
        tracing::error!(user_id = %user_id, plan = %raw, "Invalid plan value in DB");
        DomainError::Internal(e)
    })
}

#[async_trait]
impl AdminRepository for PgAdminRepository {
    async fn search_users(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Vec<AdminUserSummary>, DomainError> {
        let bounded = limit.clamp(1, SEARCH_LIMIT_MAX);
        // WHY escape LIKE metacharacters: a query containing `%` or `_` must
        // match literally, not act as a wildcard. `\` is the escape char.
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");

        let rows = sqlx::query!(
            r#"
            SELECT
                p.id                AS "id!",
                p.username          AS "username!",
                p.display_name      AS "display_name",
                p.plan              AS "plan!",
                EXISTS (
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = p.id AND ub.badge = 'founding'
                ) AS "is_founding!",
                EXISTS (
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = p.id AND ub.badge = 'official'
                ) AS "is_official!"
            FROM profiles p
            WHERE p.username ILIKE $1 ESCAPE '\'
            ORDER BY p.username ASC
            LIMIT $2
            "#,
            pattern,
            bounded,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;

        rows.into_iter()
            .map(|r| {
                let id = UserId::from(r.id);
                let plan = parse_plan(&r.plan, &id)?;
                Ok(AdminUserSummary {
                    id,
                    username: r.username,
                    display_name: r.display_name,
                    plan,
                    is_founding: r.is_founding,
                    is_official: r.is_official,
                })
            })
            .collect()
    }

    async fn get_user_summary(
        &self,
        user_id: &UserId,
    ) -> Result<Option<AdminUserSummary>, DomainError> {
        let uid = user_id.0;
        let row = sqlx::query!(
            r#"
            SELECT
                p.id                AS "id!",
                p.username          AS "username!",
                p.display_name      AS "display_name",
                p.plan              AS "plan!",
                EXISTS (
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = p.id AND ub.badge = 'founding'
                ) AS "is_founding!",
                EXISTS (
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = p.id AND ub.badge = 'official'
                ) AS "is_official!"
            FROM profiles p
            WHERE p.id = $1
            "#,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;

        row.map(|r| {
            let id = UserId::from(r.id);
            let plan = parse_plan(&r.plan, &id)?;
            Ok(AdminUserSummary {
                id,
                username: r.username,
                display_name: r.display_name,
                plan,
                is_founding: r.is_founding,
                is_official: r.is_official,
            })
        })
        .transpose()
    }

    async fn set_user_plan(
        &self,
        user_id: &UserId,
        plan: Plan,
    ) -> Result<AdminUserSummary, DomainError> {
        let uid = user_id.0;
        let plan_str = plan.as_str();

        // Guard existence explicitly so a missing user is a clean 404 rather
        // than a silent zero-row UPDATE.
        let updated = sqlx::query_scalar!(
            r#"UPDATE profiles SET plan = $2, updated_at = now() WHERE id = $1 RETURNING id"#,
            uid,
            plan_str,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;

        if updated.is_none() {
            return Err(DomainError::NotFound {
                resource_type: "Profile",
                id: user_id.to_string(),
            });
        }

        self.get_user_summary(user_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Profile",
                id: user_id.to_string(),
            })
    }

    async fn get_user_usage(&self, user_id: &UserId) -> Result<AdminUserUsage, DomainError> {
        let uid = user_id.0;
        // Single round-trip: owned non-DM servers, joined non-DM servers, open
        // DMs. Mirrors the plan checker's individual COUNT queries (SSoT of the
        // usage definition) collapsed for the read-only quota view.
        let row = sqlx::query!(
            r#"
            SELECT
                (SELECT COALESCE(COUNT(*)::BIGINT, 0)
                   FROM servers
                   WHERE owner_id = $1 AND is_dm = false)          AS "owned!",
                (SELECT COALESCE(COUNT(*)::BIGINT, 0)
                   FROM server_members sm JOIN servers s ON s.id = sm.server_id
                   WHERE sm.user_id = $1 AND s.is_dm = false)      AS "joined!",
                (SELECT COALESCE(COUNT(*)::BIGINT, 0)
                   FROM server_members sm JOIN servers s ON s.id = sm.server_id
                   WHERE sm.user_id = $1 AND s.is_dm = true)       AS "dms!"
            "#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_err)?;

        #[allow(clippy::cast_sign_loss)] // WHY: COALESCE guarantees non-negative
        Ok(AdminUserUsage {
            owned_servers: row.owned as u64,
            joined_servers: row.joined as u64,
            open_dms: row.dms as u64,
        })
    }

    async fn record_action(
        &self,
        actor_id: &UserId,
        action: &str,
        target_user_id: Option<&UserId>,
        detail: serde_json::Value,
    ) -> Result<(), DomainError> {
        let actor = actor_id.0;
        let target = target_user_id.map(|u| u.0);
        sqlx::query!(
            r#"
            INSERT INTO platform_admin_audit (actor_id, action, target_user_id, detail)
            VALUES ($1, $2, $3, $4)
            "#,
            actor,
            action,
            target,
            detail,
        )
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(())
    }
}
