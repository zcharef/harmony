//! `PostgreSQL` adapter for voice session persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, NewVoiceSession, ServerId, UserId, VoiceSession, VoiceSessionId,
};
use crate::domain::ports::VoiceSessionRepository;

/// PostgreSQL-backed voice session repository.
#[derive(Debug, Clone)]
pub struct PgVoiceSessionRepository {
    pool: PgPool,
}

impl PgVoiceSessionRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding.
struct VoiceSessionRow {
    id: Uuid,
    user_id: Uuid,
    channel_id: Uuid,
    server_id: Uuid,
    session_id: String,
    joined_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
}

impl VoiceSessionRow {
    fn into_voice_session(self) -> VoiceSession {
        VoiceSession {
            id: VoiceSessionId::new(self.id),
            user_id: UserId::new(self.user_id),
            channel_id: ChannelId::new(self.channel_id),
            server_id: ServerId::new(self.server_id),
            session_id: self.session_id,
            joined_at: self.joined_at,
            last_seen_at: self.last_seen_at,
        }
    }
}

#[async_trait]
impl VoiceSessionRepository for PgVoiceSessionRepository {
    async fn upsert(
        &self,
        session: &NewVoiceSession,
    ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError> {
        let uid = session.user_id.0;
        let cid = session.channel_id.0;
        let sid = session.server_id.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // WHY: Fetch the existing session BEFORE the upsert so the caller can
        // emit an SSE leave event for the old channel if the user was already
        // in a different voice channel.
        let previous = sqlx::query!(
            r#"
            SELECT
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            FROM voice_sessions
            WHERE user_id = $1
            "#,
            uid,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?
        .map(|r| {
            VoiceSessionRow {
                id: r.id,
                user_id: r.user_id,
                channel_id: r.channel_id,
                server_id: r.server_id,
                session_id: r.session_id,
                joined_at: r.joined_at,
                last_seen_at: r.last_seen_at,
            }
            .into_voice_session()
        });

        let r = sqlx::query!(
            r#"
            INSERT INTO voice_sessions (user_id, channel_id, server_id, session_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE
                SET channel_id   = EXCLUDED.channel_id,
                    server_id    = EXCLUDED.server_id,
                    session_id   = EXCLUDED.session_id,
                    joined_at    = now(),
                    last_seen_at = now()
            RETURNING
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            "#,
            uid,
            cid,
            sid,
            session.session_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        let new_session = VoiceSessionRow {
            id: r.id,
            user_id: r.user_id,
            channel_id: r.channel_id,
            server_id: r.server_id,
            session_id: r.session_id,
            joined_at: r.joined_at,
            last_seen_at: r.last_seen_at,
        }
        .into_voice_session();

        Ok((new_session, previous))
    }

    async fn upsert_with_limit(
        &self,
        session: &NewVoiceSession,
        max_concurrent: u64,
        plan_name: String,
    ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError> {
        let uid = session.user_id.0;
        let cid = session.channel_id.0;
        let sid = session.server_id.0;
        #[allow(clippy::cast_possible_wrap)] // WHY: max_concurrent is a plan limit, always fits i64
        let max_i64 = max_concurrent as i64;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // WHY: Fetch existing session first for SSE leave event (same as upsert).
        let previous = sqlx::query!(
            r#"
            SELECT id, user_id, channel_id, server_id, session_id, joined_at, last_seen_at
            FROM voice_sessions
            WHERE user_id = $1
            "#,
            uid,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?
        .map(|r| {
            VoiceSessionRow {
                id: r.id,
                user_id: r.user_id,
                channel_id: r.channel_id,
                server_id: r.server_id,
                session_id: r.session_id,
                joined_at: r.joined_at,
                last_seen_at: r.last_seen_at,
            }
            .into_voice_session()
        });

        // WHY: Lock all voice_sessions rows for this server to prevent
        // concurrent inserts from both passing the count check (TOCTOU).
        // FOR UPDATE on the base rows, then count — Postgres doesn't allow
        // FOR UPDATE directly on aggregate queries.
        let count = sqlx::query_scalar!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
            FROM (
                SELECT 1 FROM voice_sessions
                WHERE server_id = $1 AND user_id != $2
                FOR UPDATE
            ) locked
            "#,
            sid,
            uid,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if count >= max_i64 {
            return Err(DomainError::LimitExceeded {
                resource: "concurrent voice participants",
                plan: plan_name,
                limit: max_concurrent,
            });
        }

        let r = sqlx::query!(
            r#"
            INSERT INTO voice_sessions (user_id, channel_id, server_id, session_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE
                SET channel_id   = EXCLUDED.channel_id,
                    server_id    = EXCLUDED.server_id,
                    session_id   = EXCLUDED.session_id,
                    joined_at    = now(),
                    last_seen_at = now()
            RETURNING
                id, user_id, channel_id, server_id, session_id, joined_at, last_seen_at
            "#,
            uid,
            cid,
            sid,
            session.session_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        let new_session = VoiceSessionRow {
            id: r.id,
            user_id: r.user_id,
            channel_id: r.channel_id,
            server_id: r.server_id,
            session_id: r.session_id,
            joined_at: r.joined_at,
            last_seen_at: r.last_seen_at,
        }
        .into_voice_session();

        Ok((new_session, previous))
    }

    async fn remove_by_user(&self, user_id: &UserId) -> Result<Option<VoiceSession>, DomainError> {
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            DELETE FROM voice_sessions
            WHERE user_id = $1
            RETURNING
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            "#,
            uid,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            VoiceSessionRow {
                id: r.id,
                user_id: r.user_id,
                channel_id: r.channel_id,
                server_id: r.server_id,
                session_id: r.session_id,
                joined_at: r.joined_at,
                last_seen_at: r.last_seen_at,
            }
            .into_voice_session()
        }))
    }

    async fn list_by_channel(
        &self,
        channel_id: &ChannelId,
    ) -> Result<Vec<VoiceSession>, DomainError> {
        let cid = channel_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            FROM voice_sessions
            WHERE channel_id = $1
            ORDER BY joined_at
            "#,
            cid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let sessions = rows
            .into_iter()
            .map(|r| {
                VoiceSessionRow {
                    id: r.id,
                    user_id: r.user_id,
                    channel_id: r.channel_id,
                    server_id: r.server_id,
                    session_id: r.session_id,
                    joined_at: r.joined_at,
                    last_seen_at: r.last_seen_at,
                }
                .into_voice_session()
            })
            .collect();

        Ok(sessions)
    }

    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<VoiceSession>, DomainError> {
        let sid = server_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            FROM voice_sessions
            WHERE server_id = $1
            ORDER BY joined_at
            "#,
            sid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let sessions = rows
            .into_iter()
            .map(|r| {
                VoiceSessionRow {
                    id: r.id,
                    user_id: r.user_id,
                    channel_id: r.channel_id,
                    server_id: r.server_id,
                    session_id: r.session_id,
                    joined_at: r.joined_at,
                    last_seen_at: r.last_seen_at,
                }
                .into_voice_session()
            })
            .collect();

        Ok(sessions)
    }

    async fn count_by_server(&self, server_id: &ServerId) -> Result<i64, DomainError> {
        let sid = server_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) as "count!"
            FROM voice_sessions
            WHERE server_id = $1
            "#,
            sid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }

    async fn delete_stale(
        &self,
        threshold: DateTime<Utc>,
    ) -> Result<Vec<VoiceSession>, DomainError> {
        let rows = sqlx::query!(
            r#"
            DELETE FROM voice_sessions
            WHERE last_seen_at < $1
            RETURNING
                id,
                user_id,
                channel_id,
                server_id,
                session_id,
                joined_at,
                last_seen_at
            "#,
            threshold,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let sessions = rows
            .into_iter()
            .map(|r| {
                VoiceSessionRow {
                    id: r.id,
                    user_id: r.user_id,
                    channel_id: r.channel_id,
                    server_id: r.server_id,
                    session_id: r.session_id,
                    joined_at: r.joined_at,
                    last_seen_at: r.last_seen_at,
                }
                .into_voice_session()
            })
            .collect();

        Ok(sessions)
    }

    async fn touch(&self, user_id: &UserId, session_id: &str) -> Result<bool, DomainError> {
        let uid = user_id.0;

        // WHY: Filter on both user_id AND session_id so that a stale device's
        // heartbeat cannot keep a replaced session alive (P1-16).
        let result = sqlx::query!(
            r#"
            UPDATE voice_sessions
            SET last_seen_at = now()
            WHERE user_id = $1 AND session_id = $2
            "#,
            uid,
            session_id,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(result.rows_affected() > 0)
    }
}
