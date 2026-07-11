//! `PostgreSQL` adapter for message link-preview embeds + the unfurl cache.
//!
//! Embed rows are written ONLY by the async unfurl worker (never inside
//! `send_to_channel` — unfurl must never block a send); reads mirror
//! `PgAttachmentRepository::batch_for_messages`.

use std::collections::HashMap;

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmbedId, MessageEmbed, MessageId, NewEmbed, UnfurledPage};
use crate::domain::ports::EmbedRepository;

/// PostgreSQL-backed embed repository.
#[derive(Debug, Clone)]
pub struct PgEmbedRepository {
    pool: PgPool,
}

impl PgEmbedRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl EmbedRepository for PgEmbedRepository {
    async fn batch_for_messages(
        &self,
        message_ids: &[MessageId],
    ) -> Result<HashMap<MessageId, Vec<MessageEmbed>>, DomainError> {
        // WHY: Empty array guard — skip DB call entirely.
        if message_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let ids: Vec<Uuid> = message_ids.iter().map(|id| id.0).collect();

        // WHY ORDER BY created_at, id: rows are inserted in content order by a
        // single worker pass; `id` is a deterministic tiebreak (mirrors the
        // attachments batch query).
        let rows = sqlx::query!(
            r#"
            SELECT id, message_id, url, title, description, site_name, image_url, created_at
            FROM message_embeds
            WHERE message_id = ANY($1::uuid[]) AND suppressed = false
            ORDER BY created_at, id
            "#,
            &ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let mut result: HashMap<MessageId, Vec<MessageEmbed>> = HashMap::new();
        for row in rows {
            let msg_id = MessageId::new(row.message_id);
            let embed = MessageEmbed {
                id: EmbedId::new(row.id),
                message_id: msg_id.clone(),
                url: row.url,
                title: row.title,
                description: row.description,
                site_name: row.site_name,
                image_url: row.image_url,
                created_at: row.created_at,
            };
            result.entry(msg_id).or_default().push(embed);
        }

        Ok(result)
    }

    async fn insert_embeds(
        &self,
        message_id: &MessageId,
        embeds: &[NewEmbed],
    ) -> Result<(), DomainError> {
        // WHY per-row insert (bounded at 3 by the worker) with a NOT EXISTS
        // guard on (message_id, url): a suppressed preview must never
        // resurrect, and a concurrent duplicate worker run stays idempotent.
        for embed in embeds {
            sqlx::query!(
                r#"
                INSERT INTO message_embeds (message_id, url, title, description, site_name, image_url)
                SELECT $1, $2, $3, $4, $5, $6
                WHERE NOT EXISTS (
                    SELECT 1 FROM message_embeds
                    WHERE message_id = $1 AND url = $2
                )
                "#,
                message_id.0,
                embed.url,
                embed.page.title.as_deref(),
                embed.page.description.as_deref(),
                embed.page.site_name.as_deref(),
                embed.page.image_url.as_deref(),
            )
            .execute(&self.pool)
            .await
            .map_err(super::db_err)?;
        }

        Ok(())
    }

    async fn suppress(
        &self,
        message_id: &MessageId,
        embed_id: &EmbedId,
    ) -> Result<bool, DomainError> {
        // WHY bind BOTH ids: the embed must belong to the path message —
        // an id guessed across messages must not match (same path-scope
        // binding posture as edit_message).
        let result = sqlx::query!(
            r#"
            UPDATE message_embeds
            SET suppressed = true
            WHERE id = $1 AND message_id = $2 AND suppressed = false
            "#,
            embed_id.0,
            message_id.0,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(result.rows_affected() > 0)
    }

    async fn get_cached(
        &self,
        normalized_url: &str,
        ttl_secs: i64,
    ) -> Result<Option<UnfurledPage>, DomainError> {
        let row = sqlx::query!(
            r#"
            SELECT title, description, site_name, image_url
            FROM link_unfurl_cache
            WHERE normalized_url = $1
              AND fetched_at > now() - make_interval(secs => $2::double precision)
            "#,
            normalized_url,
            ttl_secs as f64,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| UnfurledPage {
            title: r.title,
            description: r.description,
            site_name: r.site_name,
            image_url: r.image_url,
        }))
    }

    async fn upsert_cache(
        &self,
        normalized_url: &str,
        page: &UnfurledPage,
    ) -> Result<(), DomainError> {
        sqlx::query!(
            r#"
            INSERT INTO link_unfurl_cache (normalized_url, title, description, site_name, image_url, fetched_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (normalized_url) DO UPDATE
            SET title = EXCLUDED.title,
                description = EXCLUDED.description,
                site_name = EXCLUDED.site_name,
                image_url = EXCLUDED.image_url,
                fetched_at = EXCLUDED.fetched_at
            "#,
            normalized_url,
            page.title.as_deref(),
            page.description.as_deref(),
            page.site_name.as_deref(),
            page.image_url.as_deref(),
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(())
    }
}
