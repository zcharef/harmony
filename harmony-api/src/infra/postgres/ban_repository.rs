//! `PostgreSQL` adapter for server ban persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{ServerBan, ServerId, UserId};
use crate::domain::ports::BanRepository;

/// PostgreSQL-backed ban repository.
#[derive(Debug, Clone)]
pub struct PgBanRepository {
    pool: PgPool,
}

impl PgBanRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding.
struct BanRow {
    server_id: Uuid,
    user_id: Uuid,
    banned_by: Option<Uuid>,
    reason: Option<String>,
    created_at: DateTime<Utc>,
}

impl BanRow {
    fn into_ban(self) -> ServerBan {
        ServerBan {
            server_id: ServerId::new(self.server_id),
            user_id: UserId::new(self.user_id),
            banned_by: self.banned_by.map(UserId::new),
            reason: self.reason,
            created_at: self.created_at,
        }
    }
}

#[async_trait]
impl BanRepository for PgBanRepository {
    async fn ban_user(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        banned_by: &UserId,
        reason: Option<String>,
    ) -> Result<ServerBan, DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;
        let bid = banned_by.0;

        // WHY: Transaction ensures ban + member removal are atomic.
        // INSERT ban first — if already banned, abort before touching membership.
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        let row = sqlx::query!(
            r#"
            INSERT INTO server_bans (server_id, user_id, banned_by, reason)
            VALUES ($1, $2, $3, $4)
            RETURNING server_id, user_id, banned_by, reason, created_at
            "#,
            sid,
            uid,
            bid,
            reason,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                DomainError::Conflict("User is already banned from this server".to_string())
            }
            sqlx::Error::Database(ref db_err) if db_err.is_foreign_key_violation() => {
                DomainError::NotFound {
                    resource_type: "User",
                    id: uid.to_string(),
                }
            }
            other => {
                tracing::error!(error = %other, "Database query failed");
                DomainError::Internal(other.to_string())
            }
        })?;

        // Remove membership (idempotent — OK if user already left)
        sqlx::query!(
            r#"
            DELETE FROM server_members
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            uid,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        let ban = BanRow {
            server_id: row.server_id,
            user_id: row.user_id,
            banned_by: row.banned_by,
            reason: row.reason,
            created_at: row.created_at,
        };

        Ok(ban.into_ban())
    }

    async fn unban_user(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let result = sqlx::query!(
            r#"
            DELETE FROM server_bans
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
                resource_type: "ServerBan",
                id: format!("server={}, user={}", server_id, user_id),
            });
        }

        Ok(())
    }

    async fn list_bans(&self, server_id: &ServerId) -> Result<Vec<ServerBan>, DomainError> {
        let sid = server_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT server_id, user_id, banned_by, reason, created_at
            FROM server_bans
            WHERE server_id = $1
            ORDER BY created_at DESC
            "#,
            sid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let bans = rows
            .into_iter()
            .map(|r| {
                BanRow {
                    server_id: r.server_id,
                    user_id: r.user_id,
                    banned_by: r.banned_by,
                    reason: r.reason,
                    created_at: r.created_at,
                }
                .into_ban()
            })
            .collect();

        Ok(bans)
    }

    async fn list_bans_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ServerBan>, DomainError> {
        let sid = server_id.0;

        // Cursor pagination (ADR-036): filter by created_at < cursor when present.
        let rows = sqlx::query!(
            r#"
            SELECT server_id, user_id, banned_by, reason, created_at
            FROM server_bans
            WHERE server_id = $1
              AND ($2::timestamptz IS NULL OR created_at < $2)
            ORDER BY created_at DESC
            LIMIT $3
            "#,
            sid,
            cursor,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let bans = rows
            .into_iter()
            .map(|r| {
                BanRow {
                    server_id: r.server_id,
                    user_id: r.user_id,
                    banned_by: r.banned_by,
                    reason: r.reason,
                    created_at: r.created_at,
                }
                .into_ban()
            })
            .collect();

        Ok(bans)
    }

    async fn is_banned(&self, server_id: &ServerId, user_id: &UserId) -> Result<bool, DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        let result = sqlx::query!(
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
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(result.exists)
    }
}
