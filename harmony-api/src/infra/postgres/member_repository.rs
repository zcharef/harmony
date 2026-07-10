//! `PostgreSQL` adapter for server member persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, MentionedUser, Role, ServerId, ServerMember, UserId};
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
    display_name: Option<String>,
    avatar_url: Option<String>,
    nickname: Option<String>,
    role: String,
    is_founding: bool,
    joined_at: DateTime<Utc>,
}

impl MemberRow {
    fn into_member(self) -> Result<ServerMember, DomainError> {
        Ok(ServerMember {
            user_id: UserId::new(self.user_id),
            server_id: ServerId::new(self.server_id),
            username: self.username,
            display_name: self.display_name,
            avatar_url: self.avatar_url,
            nickname: self.nickname,
            role: parse_role(&self.role)?,
            is_founding: self.is_founding,
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
                p.display_name,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                EXISTS(
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = sm.user_id AND ub.badge = 'founding'
                ) AS "is_founding!",
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
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    role: r.role,
                    is_founding: r.is_founding,
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
                p.display_name,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                EXISTS(
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = sm.user_id AND ub.badge = 'founding'
                ) AS "is_founding!",
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
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    role: r.role,
                    is_founding: r.is_founding,
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
                p.display_name,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                EXISTS(
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = sm.user_id AND ub.badge = 'founding'
                ) AS "is_founding!",
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
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                nickname: r.nickname,
                role: r.role,
                is_founding: r.is_founding,
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

        // WHY: A ban and this membership INSERT must serialize, or a banned user
        // gets (re-)added. Most visibly on the auto-join path: auto_join_official
        // _server runs on every profile sync, and once ban_user removed the
        // membership, is_member is false, so auto-join would re-insert it while the
        // server_bans row still exists (a deterministic ban evasion, no race even
        // needed). A bare INSERT also can't see a concurrent ban's uncommitted row.
        // Take the same per-(server, user) advisory lock ban_user takes and
        // re-check the ban inside it. Mirrors invite_repository::complete_join.
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            format!("member_ban:{sid}:{uid}")
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let banned = sqlx::query!(
            r#"
            SELECT EXISTS (
                SELECT 1
                FROM server_bans
                WHERE server_id = $1 AND user_id = $2
            ) AS "exists!"
            "#,
            sid,
            uid,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if banned.exists {
            return Err(DomainError::Forbidden(
                "User is banned from this server".to_string(),
            ));
        }

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
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

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

        let count = sqlx::query_scalar!(
            r#"SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!" FROM server_members WHERE server_id = $1"#,
            sid
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(count)
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

    async fn filter_mentionable(
        &self,
        channel: &Channel,
        user_ids: &[UserId],
    ) -> Result<Vec<UserId>, DomainError> {
        // WHY: Empty input needs no round-trip (the common no-mention path).
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sid = channel.server_id.0;
        let cid = channel.id.0;
        let ids: Vec<Uuid> = user_ids.iter().map(|u| u.0).collect();

        // Mirrors ensure_channel_access / has_private_channel_access: server
        // membership, plus for private channels admin/owner OR a channel_role_access
        // grant for the member's role. $5 = 'admin', $6 = 'owner'.
        let rows = sqlx::query_scalar!(
            r#"
            SELECT sm.user_id
            FROM server_members sm
            WHERE sm.server_id = $1
              AND sm.user_id = ANY($2)
              AND (
                  $3 = false
                  OR sm.role IN ($5, $6)
                  OR EXISTS (
                      SELECT 1 FROM channel_role_access cra
                      WHERE cra.channel_id = $4 AND cra.role = sm.role
                  )
              )
            "#,
            sid,
            &ids,
            channel.is_private,
            cid,
            Role::Admin.as_str(),
            Role::Owner.as_str(),
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows.into_iter().map(UserId::new).collect())
    }

    async fn resolve_mentioned_users(
        &self,
        server_id: &ServerId,
        user_ids: &[UserId],
    ) -> Result<Vec<MentionedUser>, DomainError> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sid = server_id.0;
        let ids: Vec<Uuid> = user_ids.iter().map(|u| u.0).collect();

        // profiles is the driving table: users who LEFT the server still resolve
        // (nickname NULL via LEFT JOIN); deleted accounts (no profile row) drop out.
        let rows = sqlx::query!(
            r#"
            SELECT
                p.id AS "id!",
                p.username AS "username!",
                p.display_name,
                sm.nickname
            FROM profiles p
            LEFT JOIN server_members sm
                ON sm.user_id = p.id AND sm.server_id = $1
            WHERE p.id = ANY($2)
            "#,
            sid,
            &ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| MentionedUser {
                user_id: UserId::new(r.id),
                username: r.username,
                display_name: r.display_name,
                nickname: r.nickname,
            })
            .collect())
    }

    async fn search_by_server(
        &self,
        server_id: &ServerId,
        q: &str,
        limit: i64,
    ) -> Result<Vec<ServerMember>, DomainError> {
        let sid = server_id.0;
        // WHY: Escape LIKE wildcards so a literal % or _ in the query matches
        // literally (default ILIKE escape char is backslash).
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let substring = format!("%{escaped}%");
        let prefix = format!("{escaped}%");

        // Substring match across username/display_name/nickname; prefix matches
        // ranked first. YAGNI: top-N, no pagination (nextCursor is always null).
        let rows = sqlx::query!(
            r#"
            SELECT
                sm.user_id,
                sm.server_id,
                p.username,
                p.display_name,
                p.avatar_url,
                sm.nickname,
                sm.role as "role!",
                EXISTS(
                    SELECT 1 FROM user_badges ub
                    WHERE ub.user_id = sm.user_id AND ub.badge = 'founding'
                ) AS "is_founding!",
                sm.joined_at
            FROM server_members sm
            INNER JOIN profiles p ON p.id = sm.user_id
            WHERE sm.server_id = $1
              AND (
                  p.username ILIKE $2
                  OR p.display_name ILIKE $2
                  OR sm.nickname ILIKE $2
              )
            ORDER BY (p.username ILIKE $3) DESC, sm.joined_at ASC
            LIMIT $4
            "#,
            sid,
            substring,
            prefix,
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
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    role: r.role,
                    is_founding: r.is_founding,
                    joined_at: r.joined_at,
                }
                .into_member()
            })
            .collect()
    }
}
