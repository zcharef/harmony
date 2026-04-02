//! `PostgreSQL` adapter for Megolm session persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MegolmSession, MegolmSessionId, UserId};
use crate::domain::ports::MegolmSessionRepository;

/// PostgreSQL-backed Megolm session repository.
#[derive(Debug, Clone)]
pub struct PgMegolmSessionRepository {
    pool: PgPool,
}

impl PgMegolmSessionRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for `megolm_sessions` sqlx decoding.
struct MegolmSessionRow {
    id: Uuid,
    channel_id: Uuid,
    session_id: String,
    creator_id: Uuid,
    created_at: DateTime<Utc>,
}

impl MegolmSessionRow {
    fn into_megolm_session(self) -> MegolmSession {
        MegolmSession {
            id: MegolmSessionId::new(self.id),
            channel_id: ChannelId::new(self.channel_id),
            session_id: self.session_id,
            creator_id: UserId::new(self.creator_id),
            created_at: self.created_at,
        }
    }
}

#[async_trait]
impl MegolmSessionRepository for PgMegolmSessionRepository {
    async fn store_session(
        &self,
        channel_id: &ChannelId,
        session_id: &str,
        creator_id: &UserId,
    ) -> Result<MegolmSession, DomainError> {
        let cid = channel_id.0;
        let uid = creator_id.0;

        // WHY: Try INSERT first; ON CONFLICT DO NOTHING handles duplicates.
        let inserted = sqlx::query!(
            r#"
            INSERT INTO megolm_sessions (channel_id, session_id, creator_id)
            VALUES ($1, $2, $3)
            ON CONFLICT ON CONSTRAINT megolm_sessions_channel_session_unique DO NOTHING
            RETURNING id, channel_id, session_id, creator_id, created_at
            "#,
            cid,
            session_id,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        let row = match inserted {
            Some(r) => MegolmSessionRow {
                id: r.id,
                channel_id: r.channel_id,
                session_id: r.session_id,
                creator_id: r.creator_id,
                created_at: r.created_at,
            },
            // WHY: ON CONFLICT DO NOTHING returned no row — fetch the existing record.
            None => {
                let existing = sqlx::query!(
                    r#"
                    SELECT id, channel_id, session_id, creator_id, created_at
                    FROM megolm_sessions
                    WHERE channel_id = $1 AND session_id = $2
                    "#,
                    cid,
                    session_id,
                )
                .fetch_one(&self.pool)
                .await
                .map_err(super::db_err)?;

                MegolmSessionRow {
                    id: existing.id,
                    channel_id: existing.channel_id,
                    session_id: existing.session_id,
                    creator_id: existing.creator_id,
                    created_at: existing.created_at,
                }
            }
        };

        Ok(row.into_megolm_session())
    }
}
