//! `PostgreSQL` adapter for server persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Role, Server, ServerId, UserId};
use crate::domain::ports::ServerRepository;

/// PostgreSQL-backed server repository.
#[derive(Debug, Clone)]
pub struct PgServerRepository {
    pool: PgPool,
}

impl PgServerRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding (plain types, no newtypes).
struct ServerRow {
    id: Uuid,
    name: String,
    icon_url: Option<String>,
    owner_id: Uuid,
    is_dm: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ServerRow {
    fn into_server(self) -> Server {
        Server {
            id: ServerId::new(self.id),
            name: self.name,
            icon_url: self.icon_url,
            owner_id: UserId::new(self.owner_id),
            is_dm: self.is_dm,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[async_trait]
impl ServerRepository for PgServerRepository {
    async fn create_with_defaults(
        &self,
        name: String,
        owner_id: UserId,
    ) -> Result<Server, DomainError> {
        let owner_uuid = owner_id.0;

        // Transaction: insert server + server_member + #general channel atomically
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // 1. Insert the server
        let server_row = sqlx::query!(
            r#"
            INSERT INTO servers (name, owner_id)
            VALUES ($1, $2)
            RETURNING
                id,
                name,
                icon_url,
                owner_id,
                is_dm,
                created_at,
                updated_at
            "#,
            name,
            owner_uuid,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let server_id = server_row.id;

        // 2. Add the owner as a server member with 'owner' role
        sqlx::query!(
            r#"
            INSERT INTO server_members (server_id, user_id, role)
            VALUES ($1, $2, $3)
            "#,
            server_id,
            owner_uuid,
            Role::Owner.as_str(),
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        // 3. Create the default #general channel
        sqlx::query!(
            r#"
            INSERT INTO channels (server_id, name, channel_type, position)
            VALUES ($1, 'general', 'text', 0)
            "#,
            server_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        let row = ServerRow {
            id: server_row.id,
            name: server_row.name,
            icon_url: server_row.icon_url,
            owner_id: server_row.owner_id,
            is_dm: server_row.is_dm,
            created_at: server_row.created_at,
            updated_at: server_row.updated_at,
        };

        Ok(row.into_server())
    }

    async fn list_for_user(&self, user_id: &UserId) -> Result<Vec<Server>, DomainError> {
        let uid = user_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                s.id,
                s.name,
                s.icon_url,
                s.owner_id,
                s.is_dm,
                s.created_at,
                s.updated_at
            FROM servers s
            INNER JOIN server_members sm ON sm.server_id = s.id
            WHERE sm.user_id = $1
              AND s.is_dm = false
            ORDER BY s.created_at
            "#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let servers = rows
            .into_iter()
            .map(|r| {
                ServerRow {
                    id: r.id,
                    name: r.name,
                    icon_url: r.icon_url,
                    owner_id: r.owner_id,
                    is_dm: r.is_dm,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                }
                .into_server()
            })
            .collect();

        Ok(servers)
    }

    async fn list_all_memberships(&self, user_id: &UserId) -> Result<Vec<ServerId>, DomainError> {
        let uid = user_id.0;

        let rows = sqlx::query_scalar!(
            r#"
            SELECT sm.server_id
            FROM server_members sm
            WHERE sm.user_id = $1
            "#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows.into_iter().map(ServerId).collect())
    }

    async fn get_by_id(&self, server_id: &ServerId) -> Result<Option<Server>, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                name,
                icon_url,
                owner_id,
                is_dm,
                created_at,
                updated_at
            FROM servers
            WHERE id = $1
            "#,
            sid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            ServerRow {
                id: r.id,
                name: r.name,
                icon_url: r.icon_url,
                owner_id: r.owner_id,
                is_dm: r.is_dm,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_server()
        }))
    }

    async fn update_name(
        &self,
        server_id: &ServerId,
        name: String,
    ) -> Result<Option<Server>, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            UPDATE servers
            SET name = $2, updated_at = now()
            WHERE id = $1
            RETURNING
                id,
                name,
                icon_url,
                owner_id,
                is_dm,
                created_at,
                updated_at
            "#,
            sid,
            name,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            ServerRow {
                id: r.id,
                name: r.name,
                icon_url: r.icon_url,
                owner_id: r.owner_id,
                is_dm: r.is_dm,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_server()
        }))
    }
}
