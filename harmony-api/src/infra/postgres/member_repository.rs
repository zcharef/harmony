//! `PostgreSQL` adapter for server member persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Role, ServerId, ServerMember, UserId};
use crate::domain::ports::MemberRepository;

/// PostgreSQL-backed member repository.
#[derive(Debug, Clone)]
pub struct PgMemberRepository {
    pool: PgPool,
}

impl PgMemberRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Parse a role string from the DB into a `Role` enum.
///
/// WHY: The DB stores roles as TEXT. We parse at the boundary so the domain
/// layer never sees raw strings. Returns `DomainError::Internal` on unknown
/// values, which signals data corruption rather than silently defaulting.
fn parse_role(raw: &str) -> Result<Role, DomainError> {
    raw.parse::<Role>()
        .map_err(|e| DomainError::Internal(format!("Corrupt role in DB: {e}")))
}

/// Intermediate row type for sqlx decoding (plain types, no newtypes).
struct MemberRow {
    user_id: Uuid,
    server_id: Uuid,
    username: String,
    avatar_url: Option<String>,
    nickname: Option<String>,
    role: String,
    joined_at: DateTime<Utc>,
}

impl MemberRow {
    fn into_member(self) -> Result<ServerMember, DomainError> {
        Ok(ServerMember {
            user_id: UserId::new(self.user_id),
            server_id: ServerId::new(self.server_id),
            username: self.username,
            avatar_url: self.avatar_url,
            nickname: self.nickname,
            role: parse_role(&self.role)?,
            joined_at: self.joined_at,
        })
    }
}

#[async_trait]
impl MemberRepository for PgMemberRepository {
    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<ServerMember>, DomainError> {
        let sid = server_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                sm.user_id,
                sm.server_id,
                p.username,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                sm.joined_at
            FROM server_members sm
            INNER JOIN profiles p ON p.id = sm.user_id
            WHERE sm.server_id = $1
            ORDER BY sm.joined_at
            "#,
            sid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        rows.into_iter()
            .map(|r| {
                MemberRow {
                    user_id: r.user_id,
                    server_id: r.server_id,
                    username: r.username,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    role: r.role,
                    joined_at: r.joined_at,
                }
                .into_member()
            })
            .collect()
    }

    async fn list_by_server_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ServerMember>, DomainError> {
        let sid = server_id.0;

        // Cursor pagination (ADR-036): filter by joined_at < cursor when present.
        let rows = sqlx::query!(
            r#"
            SELECT
                sm.user_id,
                sm.server_id,
                p.username,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                sm.joined_at
            FROM server_members sm
            INNER JOIN profiles p ON p.id = sm.user_id
            WHERE sm.server_id = $1
              AND ($2::timestamptz IS NULL OR sm.joined_at < $2)
            ORDER BY sm.joined_at DESC
            LIMIT $3
            "#,
            sid,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        rows.into_iter()
            .map(|r| {
                MemberRow {
                    user_id: r.user_id,
                    server_id: r.server_id,
                    username: r.username,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    role: r.role,
                    joined_at: r.joined_at,
                }
                .into_member()
            })
            .collect()
    }

    async fn get_member(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Option<ServerMember>, DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                sm.user_id,
                sm.server_id,
                p.username,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                sm.joined_at
            FROM server_members sm
            INNER JOIN profiles p ON p.id = sm.user_id
            WHERE sm.server_id = $1 AND sm.user_id = $2
            "#,
            sid,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        row.map(|r| {
            MemberRow {
                user_id: r.user_id,
                server_id: r.server_id,
                username: r.username,
                avatar_url: r.avatar_url,
                nickname: r.nickname,
                role: r.role,
                joined_at: r.joined_at,
            }
            .into_member()
        })
        .transpose()
    }

    async fn is_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<bool, DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let result = sqlx::query!(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM server_members
                WHERE server_id = $1 AND user_id = $2
            ) AS "exists!"
            "#,
            sid,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(result.exists)
    }

    async fn add_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        sqlx::query!(
            r#"
            INSERT INTO server_members (server_id, user_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (server_id, user_id) DO NOTHING
            "#,
            sid,
            uid,
            Role::Member.as_str(),
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }

    async fn remove_member(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let result = sqlx::query!(
            r#"
            DELETE FROM server_members
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            uid,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, user_id),
            });
        }

        Ok(())
    }

    async fn get_member_role(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Option<Role>, DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT role as "role!"
            FROM server_members
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        row.map(|r| parse_role(&r.role)).transpose()
    }

    async fn update_member_role(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        new_role: Role,
    ) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let result = sqlx::query!(
            r#"
            UPDATE server_members
            SET role = $3
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            uid,
            new_role.as_str(),
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, user_id),
            });
        }

        Ok(())
    }

    async fn count_by_server(&self, server_id: &ServerId) -> Result<i64, DomainError> {
        let sid = server_id.0;

        // WHY: Use denormalized member_count from servers table for performance.
        // Avoids COUNT(*) on potentially large server_members table.
        // Same pattern as PgPlanLimitChecker::check_member_limit.
        let count = sqlx::query_scalar!(
            r#"SELECT member_count as "member_count!" FROM servers WHERE id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(i64::from(count))
    }

    async fn transfer_ownership(
        &self,
        server_id: &ServerId,
        old_owner_id: &UserId,
        new_owner_id: &UserId,
    ) -> Result<(), DomainError> {
        let sid = server_id.0;
        let old_uid = old_owner_id.0;
        let new_uid = new_owner_id.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // WHY: FOR UPDATE lock on the server row prevents concurrent ownership
        // transfers from interleaving. Only one transfer can proceed at a time.
        let lock_result = sqlx::query!(
            r#"
            SELECT id FROM servers WHERE id = $1 FOR UPDATE
            "#,
            sid,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if lock_result.is_none() {
            return Err(DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            });
        }

        // 1. Set new owner's role to 'owner'
        let result = sqlx::query!(
            r#"
            UPDATE server_members
            SET role = $3
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            new_uid,
            Role::Owner.as_str(),
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, new_owner_id),
            });
        }

        // 2. Demote old owner to 'admin'
        let result = sqlx::query!(
            r#"
            UPDATE server_members
            SET role = $3
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            old_uid,
            Role::Admin.as_str(),
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "ServerMember",
                id: format!("server={}, user={}", server_id, old_owner_id),
            });
        }

        // 3. Update servers.owner_id
        let result = sqlx::query!(
            r#"
            UPDATE servers
            SET owner_id = $2, updated_at = NOW()
            WHERE id = $1
            "#,
            sid,
            new_uid,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            });
        }

        tx.commit().await.map_err(super::db_err)?;

        Ok(())
    }
}
