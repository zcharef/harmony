//! `PostgreSQL` adapter for invite persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Invite, InviteCode, ServerId, UserId};
use crate::domain::ports::InviteRepository;

/// PostgreSQL-backed invite repository.
#[derive(Debug, Clone)]
pub struct PgInviteRepository {
    pool: PgPool,
}

impl PgInviteRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding (plain types, no newtypes).
struct InviteRow {
    code: String,
    server_id: Uuid,
    creator_id: Uuid,
    max_uses: Option<i32>,
    use_count: i32,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

impl InviteRow {
    fn into_invite(self) -> Invite {
        Invite {
            code: InviteCode::new(self.code),
            server_id: ServerId::new(self.server_id),
            creator_id: UserId::new(self.creator_id),
            max_uses: self.max_uses,
            use_count: self.use_count,
            expires_at: self.expires_at,
            created_at: self.created_at,
        }
    }
}

#[async_trait]
impl InviteRepository for PgInviteRepository {
    async fn create(&self, invite: &Invite) -> Result<Invite, DomainError> {
        let code = &invite.code.0;
        let server_id = invite.server_id.0;
        let creator_id = invite.creator_id.0;
        let max_uses = invite.max_uses;
        let expires_at = invite.expires_at;

        let row = sqlx::query!(
            r#"
            INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING
                code,
                server_id,
                creator_id,
                max_uses,
                use_count,
                expires_at,
                created_at
            "#,
            code,
            server_id,
            creator_id,
            max_uses,
            expires_at,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let invite_row = InviteRow {
            code: row.code,
            server_id: row.server_id,
            creator_id: row.creator_id,
            max_uses: row.max_uses,
            use_count: row.use_count,
            expires_at: row.expires_at,
            created_at: row.created_at,
        };

        Ok(invite_row.into_invite())
    }

    async fn get_by_code(&self, code: &InviteCode) -> Result<Option<Invite>, DomainError> {
        let code_str = &code.0;

        let row = sqlx::query!(
            r#"
            SELECT
                code,
                server_id,
                creator_id,
                max_uses,
                use_count,
                expires_at,
                created_at
            FROM invites
            WHERE code = $1
            "#,
            code_str,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            InviteRow {
                code: r.code,
                server_id: r.server_id,
                creator_id: r.creator_id,
                max_uses: r.max_uses,
                use_count: r.use_count,
                expires_at: r.expires_at,
                created_at: r.created_at,
            }
            .into_invite()
        }))
    }

    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<Invite>, DomainError> {
        let sid = server_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                code,
                server_id,
                creator_id,
                max_uses,
                use_count,
                expires_at,
                created_at
            FROM invites
            WHERE server_id = $1
            ORDER BY created_at DESC
            "#,
            sid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let invites = rows
            .into_iter()
            .map(|r| {
                InviteRow {
                    code: r.code,
                    server_id: r.server_id,
                    creator_id: r.creator_id,
                    max_uses: r.max_uses,
                    use_count: r.use_count,
                    expires_at: r.expires_at,
                    created_at: r.created_at,
                }
                .into_invite()
            })
            .collect();

        Ok(invites)
    }

    async fn complete_join(
        &self,
        code: &InviteCode,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let code_str = &code.0;
        let sid = server_id.0;
        let uid = user_id.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // WHY: Atomic increment — fails if invite is exhausted
        let result = sqlx::query!(
            r#"
            UPDATE invites
            SET use_count = use_count + 1
            WHERE code = $1
              AND (max_uses IS NULL OR use_count < max_uses)
            RETURNING code
            "#,
            code_str,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if result.is_none() {
            return Err(DomainError::Conflict(
                "invite has reached its maximum number of uses".to_string(),
            ));
        }

        sqlx::query!(
            r#"
            INSERT INTO server_members (server_id, user_id)
            VALUES ($1, $2)
            "#,
            sid,
            uid,
        )
        .execute(&mut *tx)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                DomainError::Conflict("User is already a member of this server".to_string())
            }
            other => super::db_err(other),
        })?;

        tx.commit().await.map_err(super::db_err)?;

        Ok(())
    }

    async fn delete_by_code(&self, code: &InviteCode) -> Result<(), DomainError> {
        let code_str = &code.0;

        sqlx::query!(
            r#"
            DELETE FROM invites
            WHERE code = $1
            "#,
            code_str,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }
}
