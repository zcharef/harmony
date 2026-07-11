//! `PostgreSQL` adapter for server persistence.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{DiscoveryCursor, DiscoveryServer, Role, Server, ServerId, UserId};
use crate::domain::ports::ServerRepository;

/// Escape LIKE/ILIKE wildcards in a user-supplied search substring.
///
/// WHY: `%` and `_` in raw input would act as pattern operators — a search
/// for `%` would match every server instead of names containing a percent.
fn escape_like(raw: &str) -> String {
    raw.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

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
    discoverable: bool,
    discovery_category: Option<String>,
    discovery_description: Option<String>,
    discovery_featured: bool,
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
            discoverable: self.discoverable,
            discovery_category: self.discovery_category,
            discovery_description: self.discovery_description,
            discovery_featured: self.discovery_featured,
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
                discoverable,
                discovery_category,
                discovery_description,
                discovery_featured,
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
            discoverable: server_row.discoverable,
            discovery_category: server_row.discovery_category,
            discovery_description: server_row.discovery_description,
            discovery_featured: server_row.discovery_featured,
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
                s.discoverable,
                s.discovery_category,
                s.discovery_description,
                s.discovery_featured,
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
                    discoverable: r.discoverable,
                    discovery_category: r.discovery_category,
                    discovery_description: r.discovery_description,
                    discovery_featured: r.discovery_featured,
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

    async fn list_all_memberships_with_roles(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<(ServerId, Role)>, DomainError> {
        let uid = user_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT sm.server_id, sm.role
            FROM server_members sm
            WHERE sm.user_id = $1
            "#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        // WHY: An unparseable role means schema drift. Default to Member
        // (least privilege) rather than dropping the membership — dropping it
        // would silently deny the user ALL events for that server, including
        // public channels. Member keeps public channels working while denying
        // private ones the corrupt role can't be shown to grant.
        let mut memberships = Vec::with_capacity(rows.len());
        for r in rows {
            let role = r.role.parse::<Role>().unwrap_or_else(|e| {
                tracing::warn!(
                    server_id = %r.server_id,
                    role = %r.role,
                    error = %e,
                    "Unknown role in server_members, defaulting to Member"
                );
                Role::Member
            });
            memberships.push((ServerId::new(r.server_id), role));
        }
        Ok(memberships)
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
                discoverable,
                discovery_category,
                discovery_description,
                discovery_featured,
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
                discoverable: r.discoverable,
                discovery_category: r.discovery_category,
                discovery_description: r.discovery_description,
                discovery_featured: r.discovery_featured,
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
                discoverable,
                discovery_category,
                discovery_description,
                discovery_featured,
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
                discoverable: r.discoverable,
                discovery_category: r.discovery_category,
                discovery_description: r.discovery_description,
                discovery_featured: r.discovery_featured,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_server()
        }))
    }

    async fn delete(&self, server_id: &ServerId) -> Result<bool, DomainError> {
        let sid = server_id.0;

        let result = sqlx::query!(
            r#"
            DELETE FROM servers
            WHERE id = $1
            "#,
            sid,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(result.rows_affected() > 0)
    }

    async fn get_moderation_categories(
        &self,
        server_id: &ServerId,
    ) -> Result<HashMap<String, bool>, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            SELECT moderation_categories
            FROM servers
            WHERE id = $1
            "#,
            sid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        let row = row.ok_or_else(|| DomainError::NotFound {
            resource_type: "Server",
            id: server_id.to_string(),
        })?;

        let json_value = row.moderation_categories;

        // WHY: Corrupted JSONB should not take down the endpoint. Log and degrade
        // gracefully by returning empty (= all Tier 2 categories OFF).
        serde_json::from_value::<HashMap<String, bool>>(json_value).or_else(|e| {
            tracing::error!(
                server_id = %server_id,
                error = %e,
                "Corrupted moderation_categories JSONB, returning empty"
            );
            Ok(HashMap::new())
        })
    }

    async fn update_moderation_categories(
        &self,
        server_id: &ServerId,
        categories: HashMap<String, bool>,
    ) -> Result<(), DomainError> {
        let sid = server_id.0;
        let json_value = serde_json::to_value(categories)
            .map_err(|e| DomainError::Internal(format!("Failed to serialize categories: {e}")))?;

        let result = sqlx::query!(
            r#"
            UPDATE servers
            SET moderation_categories = $1, updated_at = now()
            WHERE id = $2
            "#,
            json_value,
            sid,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            });
        }

        Ok(())
    }

    async fn update_discovery(
        &self,
        server_id: &ServerId,
        discoverable: bool,
        category: Option<String>,
        description: Option<String>,
    ) -> Result<Option<Server>, DomainError> {
        let sid = server_id.0;

        // WHY `is_dm = false`: a DM "server" must never be listable, even if
        // a crafted request reaches this layer.
        let row = sqlx::query!(
            r#"
            UPDATE servers
            SET discoverable = $2,
                discovery_category = $3,
                discovery_description = $4,
                updated_at = now()
            WHERE id = $1
              AND is_dm = false
            RETURNING
                id,
                name,
                icon_url,
                owner_id,
                is_dm,
                discoverable,
                discovery_category,
                discovery_description,
                discovery_featured,
                created_at,
                updated_at
            "#,
            sid,
            discoverable,
            category,
            description,
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
                discoverable: r.discoverable,
                discovery_category: r.discovery_category,
                discovery_description: r.discovery_description,
                discovery_featured: r.discovery_featured,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_server()
        }))
    }

    async fn list_discoverable(
        &self,
        category: Option<&str>,
        search: Option<&str>,
        cursor: Option<DiscoveryCursor>,
        limit: i64,
    ) -> Result<Vec<DiscoveryServer>, DomainError> {
        let pattern = search.map(|q| format!("%{}%", escape_like(q)));
        let (cursor_featured, cursor_count, cursor_id) = match cursor {
            Some(c) => (Some(c.featured), Some(c.member_count), Some(c.id)),
            None => (None, None, None),
        };

        // WHY the subquery: the keyset predicate compares against the
        // computed member_count, which is only nameable one level up.
        // WHY `discoverable = true AND is_dm = false` INSIDE the inner query:
        // this is the only listing path — a non-discoverable or DM server can
        // never appear regardless of category/search/cursor combinations.
        let rows = sqlx::query!(
            r#"
            SELECT
                d.id AS "id!",
                d.name AS "name!",
                d.icon_url,
                d.member_count AS "member_count!",
                d.discovery_category,
                d.discovery_description,
                d.discovery_featured AS "discovery_featured!"
            FROM (
                SELECT
                    s.id,
                    s.name,
                    s.icon_url,
                    s.discovery_category,
                    s.discovery_description,
                    s.discovery_featured,
                    (
                        SELECT COALESCE(COUNT(*)::BIGINT, 0)
                        FROM server_members sm
                        WHERE sm.server_id = s.id
                    ) AS member_count
                FROM servers s
                WHERE s.discoverable = true
                  AND s.is_dm = false
                  AND ($1::text IS NULL OR s.discovery_category = $1)
                  AND ($2::text IS NULL OR s.name ILIKE $2)
            ) d
            WHERE $3::boolean IS NULL
               OR (d.discovery_featured, d.member_count, d.id) < ($3, $4, $5)
            ORDER BY d.discovery_featured DESC, d.member_count DESC, d.id DESC
            LIMIT $6
            "#,
            category,
            pattern.as_deref(),
            cursor_featured,
            cursor_count,
            cursor_id,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| DiscoveryServer {
                id: ServerId::new(r.id),
                name: r.name,
                icon_url: r.icon_url,
                member_count: r.member_count,
                category: r.discovery_category,
                description: r.discovery_description,
                featured: r.discovery_featured,
            })
            .collect())
    }

    async fn count_discoverable(
        &self,
        category: Option<&str>,
        search: Option<&str>,
    ) -> Result<i64, DomainError> {
        let pattern = search.map(|q| format!("%{}%", escape_like(q)));

        let count = sqlx::query_scalar!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM servers s
            WHERE s.discoverable = true
              AND s.is_dm = false
              AND ($1::text IS NULL OR s.discovery_category = $1)
              AND ($2::text IS NULL OR s.name ILIKE $2)
            "#,
            category,
            pattern.as_deref(),
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(count)
    }
}
