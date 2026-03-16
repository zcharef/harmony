//! `PostgreSQL` adapter for channel persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, ServerId};
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
/// The DB has no `updated_at` or `category_id` columns — we set
/// `updated_at = created_at` and `category_id = None` in the mapping.
struct ChannelRow {
    id: Uuid,
    server_id: Uuid,
    name: String,
    topic: Option<String>,
    channel_type: String,
    position: i32,
    created_at: DateTime<Utc>,
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
            created_at: self.created_at,
            updated_at: self.created_at, // DB has no updated_at column; use created_at
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

#[async_trait]
impl ChannelRepository for PgChannelRepository {
    async fn list_for_server(&self, server_id: &ServerId) -> Result<Vec<Channel>, DomainError> {
        let sid = server_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                server_id,
                name,
                topic,
                channel_type as "channel_type!: String",
                position,
                created_at
            FROM channels
            WHERE server_id = $1
            ORDER BY position
            "#,
            sid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DomainError::Internal(e.to_string()))?;

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
                    created_at: r.created_at,
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
                created_at
            FROM channels
            WHERE id = $1
            "#,
            cid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(row.map(|r| {
            ChannelRow {
                id: r.id,
                server_id: r.server_id,
                name: r.name,
                topic: r.topic,
                channel_type: r.channel_type,
                position: r.position,
                created_at: r.created_at,
            }
            .into_channel()
        }))
    }
}
