//! `PostgreSQL` adapter for profile persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId, UserStatus};
use crate::domain::ports::ProfileRepository;

/// PostgreSQL-backed profile repository.
#[derive(Debug, Clone)]
pub struct PgProfileRepository {
    pool: PgPool,
}

impl PgProfileRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Intermediate row type for sqlx decoding (plain types, no newtypes).
struct ProfileRow {
    id: Uuid,
    username: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
    status: Option<String>,
    custom_status: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl ProfileRow {
    fn into_profile(self) -> Profile {
        Profile {
            id: UserId::new(self.id),
            username: self.username,
            display_name: self.display_name,
            avatar_url: self.avatar_url,
            status: parse_user_status(self.status.as_deref()),
            custom_status: self.custom_status,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// Parse a Postgres TEXT status value into the domain enum.
fn parse_user_status(value: Option<&str>) -> UserStatus {
    match value {
        Some("online") => UserStatus::Online,
        Some("idle") => UserStatus::Idle,
        Some("dnd") => UserStatus::DoNotDisturb,
        _ => UserStatus::Offline,
    }
}

/// Convert a `UserStatus` enum to the Postgres TEXT representation.
fn user_status_to_str(status: &UserStatus) -> &'static str {
    match status {
        UserStatus::Online => "online",
        UserStatus::Idle => "idle",
        UserStatus::DoNotDisturb => "dnd",
        UserStatus::Offline => "offline",
    }
}

#[async_trait]
impl ProfileRepository for PgProfileRepository {
    async fn upsert_from_auth(
        &self,
        user_id: UserId,
        _email: String,
        username: String,
    ) -> Result<Profile, DomainError> {
        let id = user_id.0;
        let status_str = user_status_to_str(&UserStatus::Offline);

        let row = sqlx::query!(
            r#"
            INSERT INTO profiles (id, username, status)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO UPDATE
                SET id = profiles.id
            RETURNING
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                created_at,
                updated_at
            "#,
            id,
            username,
            status_str,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                DomainError::Conflict("Username is already taken".to_string())
            }
            other => super::db_err(other),
        })?;

        let profile_row = ProfileRow {
            id: row.id,
            username: row.username,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            status: row.status,
            custom_status: row.custom_status,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        Ok(profile_row.into_profile())
    }

    async fn is_username_taken(&self, username: &str) -> Result<bool, DomainError> {
        let row = sqlx::query!(
            r#"SELECT EXISTS(SELECT 1 FROM profiles WHERE username = $1) AS "taken!""#,
            username,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.taken)
    }

    async fn get_by_id(&self, user_id: &UserId) -> Result<Option<Profile>, DomainError> {
        let id = user_id.0;

        let row = sqlx::query!(
            r#"
            SELECT
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                created_at,
                updated_at
            FROM profiles
            WHERE id = $1
            "#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(row.map(|r| {
            ProfileRow {
                id: r.id,
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                status: r.status,
                custom_status: r.custom_status,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_profile()
        }))
    }

    async fn update(
        &self,
        user_id: &UserId,
        avatar_url: Option<String>,
        display_name: Option<String>,
        custom_status: Option<String>,
    ) -> Result<Profile, DomainError> {
        let id = user_id.0;

        // WHY COALESCE: patch semantics — `None` in Rust = don't change the field.
        let row = sqlx::query!(
            r#"
            UPDATE profiles
            SET
                avatar_url = COALESCE($2, avatar_url),
                display_name = COALESCE($3, display_name),
                custom_status = COALESCE($4, custom_status),
                updated_at = now()
            WHERE id = $1
            RETURNING
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                created_at,
                updated_at
            "#,
            id,
            avatar_url,
            display_name,
            custom_status,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(super::db_err)?
        .ok_or_else(|| DomainError::NotFound {
            resource_type: "Profile",
            id: user_id.to_string(),
        })?;

        let profile_row = ProfileRow {
            id: row.id,
            username: row.username,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            status: row.status,
            custom_status: row.custom_status,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        Ok(profile_row.into_profile())
    }
}
