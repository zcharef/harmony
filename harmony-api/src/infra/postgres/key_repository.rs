//! `PostgreSQL` adapter for E2EE key persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{DeviceId, DeviceKey, DeviceKeyId, OneTimeKey, OneTimeKeyId, UserId};
use crate::domain::ports::KeyRepository;

/// PostgreSQL-backed key repository.
#[derive(Debug, Clone)]
pub struct PgKeyRepository {
    pool: PgPool,
}

impl PgKeyRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for `device_keys` sqlx decoding.
struct DeviceKeyRow {
    id: Uuid,
    user_id: Uuid,
    device_id: String,
    identity_key: String,
    signing_key: String,
    device_name: Option<String>,
    created_at: DateTime<Utc>,
    last_key_upload_at: DateTime<Utc>,
}

impl DeviceKeyRow {
    fn into_device_key(self) -> DeviceKey {
        DeviceKey {
            id: DeviceKeyId::new(self.id),
            user_id: UserId::new(self.user_id),
            device_id: DeviceId::new(self.device_id),
            identity_key: self.identity_key,
            signing_key: self.signing_key,
            device_name: self.device_name,
            created_at: self.created_at,
            last_key_upload_at: self.last_key_upload_at,
        }
    }
}

/// Intermediate row type for `one_time_keys` sqlx decoding.
struct OneTimeKeyRow {
    id: Uuid,
    user_id: Uuid,
    device_id: String,
    key_id: String,
    public_key: String,
    is_fallback: bool,
    created_at: DateTime<Utc>,
}

impl OneTimeKeyRow {
    fn into_one_time_key(self) -> OneTimeKey {
        OneTimeKey {
            id: OneTimeKeyId::new(self.id),
            user_id: UserId::new(self.user_id),
            device_id: DeviceId::new(self.device_id),
            key_id: self.key_id,
            public_key: self.public_key,
            is_fallback: self.is_fallback,
            created_at: self.created_at,
        }
    }
}

#[async_trait]
impl KeyRepository for PgKeyRepository {
    async fn register_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        identity_key: &str,
        signing_key: &str,
        device_name: Option<&str>,
    ) -> Result<DeviceKey, DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        let row = sqlx::query!(
            r#"
            INSERT INTO device_keys (user_id, device_id, identity_key, signing_key, device_name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id, device_id)
            DO UPDATE SET
                identity_key = EXCLUDED.identity_key,
                signing_key = EXCLUDED.signing_key,
                device_name = EXCLUDED.device_name,
                last_key_upload_at = now()
            RETURNING
                id,
                user_id,
                device_id,
                identity_key,
                signing_key,
                device_name,
                created_at,
                last_key_upload_at
            "#,
            uid,
            did,
            identity_key,
            signing_key,
            device_name,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        let dk = DeviceKeyRow {
            id: row.id,
            user_id: row.user_id,
            device_id: row.device_id,
            identity_key: row.identity_key,
            signing_key: row.signing_key,
            device_name: row.device_name,
            created_at: row.created_at,
            last_key_upload_at: row.last_key_upload_at,
        };

        Ok(dk.into_device_key())
    }

    async fn get_devices_for_user(&self, user_id: &UserId) -> Result<Vec<DeviceKey>, DomainError> {
        let uid = user_id.0;

        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                user_id,
                device_id,
                identity_key,
                signing_key,
                device_name,
                created_at,
                last_key_upload_at
            FROM device_keys
            WHERE user_id = $1
            ORDER BY created_at
            "#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        let devices = rows
            .into_iter()
            .map(|r| {
                DeviceKeyRow {
                    id: r.id,
                    user_id: r.user_id,
                    device_id: r.device_id,
                    identity_key: r.identity_key,
                    signing_key: r.signing_key,
                    device_name: r.device_name,
                    created_at: r.created_at,
                    last_key_upload_at: r.last_key_upload_at,
                }
                .into_device_key()
            })
            .collect();

        Ok(devices)
    }

    async fn remove_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<(), DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        let result = sqlx::query!(
            r#"
            DELETE FROM device_keys
            WHERE user_id = $1 AND device_id = $2
            "#,
            uid,
            did,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;

        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound {
                resource_type: "DeviceKey",
                id: format!("{}:{}", user_id, device_id),
            });
        }

        Ok(())
    }

    async fn upload_one_time_keys(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        keys: Vec<(String, String, bool)>,
    ) -> Result<(), DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        // WHY: Batch insert via unnest for efficiency. ON CONFLICT replaces
        // existing keys (e.g., fallback key rotation).
        let key_ids: Vec<String> = keys.iter().map(|(k, _, _)| k.clone()).collect();
        let public_keys: Vec<String> = keys.iter().map(|(_, p, _)| p.clone()).collect();
        let is_fallbacks: Vec<bool> = keys.iter().map(|(_, _, f)| *f).collect();

        // WHY: Transaction ensures key insert + timestamp update are atomic.
        // Without this, a failure on the UPDATE leaves keys inserted but
        // last_key_upload_at stale.
        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        sqlx::query!(
            r#"
            INSERT INTO one_time_keys (user_id, device_id, key_id, public_key, is_fallback)
            SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), unnest($5::bool[])
            ON CONFLICT (user_id, device_id, key_id)
            DO UPDATE SET
                public_key = EXCLUDED.public_key,
                is_fallback = EXCLUDED.is_fallback
            "#,
            uid,
            did,
            &key_ids,
            &public_keys,
            &is_fallbacks,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        // WHY: Update last_key_upload_at to track key freshness.
        sqlx::query!(
            r#"
            UPDATE device_keys
            SET last_key_upload_at = now()
            WHERE user_id = $1 AND device_id = $2
            "#,
            uid,
            did,
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        Ok(())
    }

    async fn claim_one_time_key(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<Option<OneTimeKey>, DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        // WHY: Atomic DELETE...RETURNING ensures no two callers claim the same key.
        // FOR UPDATE SKIP LOCKED prevents concurrent sessions from selecting the
        // same row — a loser would see zero rows from DELETE instead of cleanly
        // skipping to the next available key.
        let row = sqlx::query!(
            r#"
            DELETE FROM one_time_keys
            WHERE id = (
                SELECT id FROM one_time_keys
                WHERE user_id = $1
                  AND device_id = $2
                  AND is_fallback = false
                ORDER BY created_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING
                id,
                user_id,
                device_id,
                key_id,
                public_key,
                is_fallback,
                created_at
            "#,
            uid,
            did,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            OneTimeKeyRow {
                id: r.id,
                user_id: r.user_id,
                device_id: r.device_id,
                key_id: r.key_id,
                public_key: r.public_key,
                is_fallback: r.is_fallback,
                created_at: r.created_at,
            }
            .into_one_time_key()
        }))
    }

    async fn get_fallback_key(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<Option<OneTimeKey>, DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                user_id,
                device_id,
                key_id,
                public_key,
                is_fallback,
                created_at
            FROM one_time_keys
            WHERE user_id = $1
              AND device_id = $2
              AND is_fallback = true
            ORDER BY created_at DESC
            LIMIT 1
            "#,
            uid,
            did,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            OneTimeKeyRow {
                id: r.id,
                user_id: r.user_id,
                device_id: r.device_id,
                key_id: r.key_id,
                public_key: r.public_key,
                is_fallback: r.is_fallback,
                created_at: r.created_at,
            }
            .into_one_time_key()
        }))
    }

    async fn count_user_devices(&self, user_id: &UserId) -> Result<i64, DomainError> {
        let uid = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM device_keys
            WHERE user_id = $1
            "#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }

    async fn count_one_time_keys(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<i64, DomainError> {
        let uid = user_id.0;
        let did = &device_id.0;

        let row = sqlx::query!(
            r#"
            SELECT COALESCE(COUNT(*)::BIGINT, 0) AS "count!"
            FROM one_time_keys
            WHERE user_id = $1
              AND device_id = $2
              AND is_fallback = false
            "#,
            uid,
            did,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.count)
    }
}
