//! `PostgreSQL` adapter for server member persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{ServerId, ServerMember, UserId};
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

/// Intermediate row type for sqlx decoding (plain types, no newtypes).
struct MemberRow {
    user_id: Uuid,
    server_id: Uuid,
    username: String,
    avatar_url: Option<String>,
    nickname: Option<String>,
    joined_at: DateTime<Utc>,
}

impl MemberRow {
    fn into_member(self) -> ServerMember {
        ServerMember {
            user_id: UserId::new(self.user_id),
            server_id: ServerId::new(self.server_id),
            username: self.username,
            avatar_url: self.avatar_url,
            nickname: self.nickname,
            joined_at: self.joined_at,
        }
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
        .map_err(|e| DomainError::Internal(e.to_string()))?;

        let members = rows
            .into_iter()
            .map(|r| {
                MemberRow {
                    user_id: r.user_id,
                    server_id: r.server_id,
                    username: r.username,
                    avatar_url: r.avatar_url,
                    nickname: r.nickname,
                    joined_at: r.joined_at,
                }
                .into_member()
            })
            .collect();

        Ok(members)
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
        .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(result.exists)
    }

    async fn add_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        sqlx::query!(
            r#"
            INSERT INTO server_members (server_id, user_id)
            VALUES ($1, $2)
            "#,
            sid,
            uid,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(())
    }

    async fn remove_member(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let sid = server_id.0;
        let uid = user_id.0;

        sqlx::query!(
            r#"
            DELETE FROM server_members
            WHERE server_id = $1 AND user_id = $2
            "#,
            sid,
            uid,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(())
    }
}
