//! `PostgreSQL` adapter for channel persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, Role, ServerId, UserId};
use crate::domain::ports::ChannelRepository;

/// PostgreSQL-backed channel repository.
#[derive(Debug, Clone)]
pub struct PgChannelRepository {
    pool: PgPool,
}

impl PgChannelRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding.
///
/// The DB `channel_type` is a Postgres enum (`channel_type`).
/// sqlx decodes it as `String` via the `!: String` type override.
struct ChannelRow {
    id: Uuid,
    server_id: Uuid,
    name: String,
    topic: Option<String>,
    channel_type: String,
    position: i32,
    is_private: bool,
    is_read_only: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ChannelRow {
    fn into_channel(self) -> Channel {
        Channel {
            id: ChannelId::new(self.id),
            server_id: ServerId::new(self.server_id),
            name: self.name,
            topic: self.topic,
            channel_type: parse_channel_type(&self.channel_type),
            position: self.position,
            category_id: None, // DB has no category_id column yet
            is_private: self.is_private,
            is_read_only: self.is_read_only,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Parse the Postgres `channel_type` enum value into the domain enum.
fn parse_channel_type(value: &str) -> ChannelType {
    match value {
        "voice" => ChannelType::Voice,
        // "text" and any future variants default to Text
        _ => ChannelType::Text,
    }
}

/// Convert a domain `ChannelType` to the Postgres enum string.
fn channel_type_to_str(ct: &ChannelType) -> &'static str {
    match ct {
        ChannelType::Text => "text",
        ChannelType::Voice => "voice",
    }
}

#[async_trait]
impl ChannelRepository for PgChannelRepository {
    async fn list_for_server(
        &self,
        server_id: &ServerId,
        caller_user_id: &UserId,
    ) -> Result<Vec<Channel>, DomainError> {
        let sid = server_id.0;
        let uid = caller_user_id.0;

        // WHY: Private channels must only be visible to admin+ or roles listed
        // in channel_role_access. The API uses service_role (bypasses RLS), so
        // we enforce this filter in the query itself.
        let rows = sqlx::query!(
            r#"
            SELECT
                c.id,
                c.server_id,
                c.name,
                c.topic,
                c.channel_type as "channel_type!: String",
                c.position,
                c.is_private,
                c.is_read_only,
                c.created_at,
                c.updated_at
            FROM channels c
            WHERE c.server_id = $1
              AND (
                  c.is_private = false
                  OR EXISTS (
                      SELECT 1 FROM server_members sm
                      WHERE sm.server_id = c.server_id
                        AND sm.user_id = $2
                        AND (
                            sm.role IN ($3, $4)
                            OR EXISTS (
                                SELECT 1 FROM channel_role_access cra
                                WHERE cra.channel_id = c.id AND cra.role = sm.role
                            )
                        )
                  )
              )
            ORDER BY c.position
            "#,
            sid,
            uid,
            Role::Owner.as_str(),
            Role::Admin.as_str(),
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let channels = rows
            .into_iter()
            .map(|r| {
                ChannelRow {
                    id: r.id,
                    server_id: r.server_id,
                    name: r.name,
                    topic: r.topic,
                    channel_type: r.channel_type,
                    position: r.position,
                    is_private: r.is_private,
                    is_read_only: r.is_read_only,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                }
                .into_channel()
            })
            .collect();

        Ok(channels)
    }

    async fn get_by_id(&self, channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
        let cid = channel_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                server_id,
                name,
                topic,
                channel_type as "channel_type!: String",
                position,
                is_private,
                is_read_only,
                created_at,
                updated_at
            FROM channels
            WHERE id = $1
            "#,
            cid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            ChannelRow {
                id: r.id,
                server_id: r.server_id,
                name: r.name,
                topic: r.topic,
                channel_type: r.channel_type,
                position: r.position,
                is_private: r.is_private,
                is_read_only: r.is_read_only,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_channel()
        }))
    }

    async fn create(&self, channel: &Channel) -> Result<Channel, DomainError> {
        let id = channel.id.0;
        let server_id = channel.server_id.0;
        let channel_type_str = channel_type_to_str(&channel.channel_type);

        let r = sqlx::query!(
            r#"
            INSERT INTO channels (id, server_id, name, topic, channel_type, position, created_at)
            VALUES ($1, $2, $3, $4, $5::text::channel_type, $6, $7)
            RETURNING
                id,
                server_id,
                name,
                topic,
                channel_type as "channel_type!: String",
                position,
                is_private,
                is_read_only,
                created_at,
                updated_at
            "#,
            id,
            server_id,
            channel.name,
            channel.topic,
            channel_type_str,
            channel.position,
            channel.created_at,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(ChannelRow {
            id: r.id,
            server_id: r.server_id,
            name: r.name,
            topic: r.topic,
            channel_type: r.channel_type,
            position: r.position,
            is_private: r.is_private,
            is_read_only: r.is_read_only,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
        .into_channel())
    }

    async fn update(
        &self,
        channel_id: &ChannelId,
        name: Option<String>,
        topic: Option<Option<String>>,
    ) -> Result<Channel, DomainError> {
        let cid = channel_id.0;
        // $3: whether topic was provided at all
        let should_update_topic = topic.is_some();
        // $4: the new topic value (None = clear topic)
        let topic_value = topic.flatten();

        let row = sqlx::query!(
            r#"
            UPDATE channels
            SET name = COALESCE($2, name),
                topic = CASE WHEN $3 THEN $4 ELSE topic END
            WHERE id = $1
            RETURNING
                id,
                server_id,
                name,
                topic,
                channel_type as "channel_type!: String",
                position,
                is_private,
                is_read_only,
                created_at,
                updated_at
            "#,
            cid,
            name,
            should_update_topic,
            topic_value,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        let r = row.ok_or_else(|| DomainError::NotFound {
            resource_type: "Channel",
            id: channel_id.to_string(),
        })?;

        Ok(ChannelRow {
            id: r.id,
            server_id: r.server_id,
            name: r.name,
            topic: r.topic,
            channel_type: r.channel_type,
            position: r.position,
            is_private: r.is_private,
            is_read_only: r.is_read_only,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
        .into_channel())
    }

    async fn delete_if_not_last(&self, channel_id: &ChannelId) -> Result<(), DomainError> {
        let cid = channel_id.0;

        // WHY: Atomic check-and-delete prevents TOCTOU race where two concurrent
        // requests both pass a separate count check and both delete, leaving zero channels.
        let result = sqlx::query!(
            r#"
            DELETE FROM channels
            WHERE id = $1
              AND (
                SELECT COUNT(*)
                FROM channels c2
                WHERE c2.server_id = (SELECT server_id FROM channels WHERE id = $1)
              ) > 1
            "#,
            cid,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            // Either channel doesn't exist, or it's the last one — check which.
            let exists = self.get_by_id(channel_id).await?;
            if exists.is_some() {
                return Err(DomainError::ValidationError(
                    "Cannot delete the last channel in a server".to_string(),
                ));
            }
            return Err(DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            });
        }

        Ok(())
    }

    async fn count_for_server(&self, server_id: &ServerId) -> Result<i64, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*), 0) as "count!" FROM channels WHERE server_id = $1
            "#,
            sid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
