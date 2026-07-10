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
    bio: Option<String>,
    banner_url: Option<String>,
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
            bio: self.bio,
            banner_url: self.banner_url,
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
        display_name: Option<String>,
    ) -> Result<Profile, DomainError> {
        let id = user_id.0;
        let status_str = user_status_to_str(&UserStatus::Offline);

        // WHY: `display_name` is set on INSERT only. The `ON CONFLICT (id) DO
        // UPDATE SET id = profiles.id` branch is an intentional no-op — a
        // re-login (or concurrent create) never overwrites an existing profile,
        // so a display name the user later changed in settings is preserved.
        let row = sqlx::query!(
            r#"
            INSERT INTO profiles (id, username, status, display_name)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE
                SET id = profiles.id
            RETURNING
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                bio,
                banner_url,
                created_at,
                updated_at
            "#,
            id,
            username,
            status_str,
            display_name,
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
            bio: row.bio,
            banner_url: row.banner_url,
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
                bio,
                banner_url,
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
                bio: r.bio,
                banner_url: r.banner_url,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }
            .into_profile()
        }))
    }

    async fn get_profiles_by_ids(&self, ids: &[UserId]) -> Result<Vec<Profile>, DomainError> {
        // WHY: Empty array guard — skip DB call entirely.
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let uuids: Vec<Uuid> = ids.iter().map(|id| id.0).collect();

        let rows = sqlx::query!(
            r#"
            SELECT
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                bio,
                banner_url,
                created_at,
                updated_at
            FROM profiles
            WHERE id = ANY($1::uuid[])
            "#,
            &uuids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| {
                ProfileRow {
                    id: r.id,
                    username: r.username,
                    display_name: r.display_name,
                    avatar_url: r.avatar_url,
                    status: r.status,
                    custom_status: r.custom_status,
                    bio: r.bio,
                    banner_url: r.banner_url,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                }
                .into_profile()
            })
            .collect())
    }

    async fn update(
        &self,
        user_id: &UserId,
        avatar_url: Option<Option<String>>,
        display_name: Option<Option<String>>,
        custom_status: Option<Option<String>>,
        bio: Option<Option<String>>,
        banner_url: Option<Option<String>>,
    ) -> Result<Profile, DomainError> {
        let id = user_id.0;

        // WHY CASE WHEN + provided flag: double-option patch semantics — outer
        // None = keep the column, Some(None) = clear it (explicit JSON null),
        // Some(Some(v)) = set it. COALESCE cannot express "clear". Mirrors
        // channel_repository::update_channel's `topic` handling.
        let should_update_avatar = avatar_url.is_some();
        let avatar_value = avatar_url.flatten();
        let should_update_display_name = display_name.is_some();
        let display_name_value = display_name.flatten();
        let should_update_custom_status = custom_status.is_some();
        let custom_status_value = custom_status.flatten();
        let should_update_bio = bio.is_some();
        let bio_value = bio.flatten();
        let should_update_banner = banner_url.is_some();
        let banner_value = banner_url.flatten();

        let row = sqlx::query!(
            r#"
            UPDATE profiles
            SET
                avatar_url = CASE WHEN $2 THEN $3 ELSE avatar_url END,
                display_name = CASE WHEN $4 THEN $5 ELSE display_name END,
                custom_status = CASE WHEN $6 THEN $7 ELSE custom_status END,
                bio = CASE WHEN $8 THEN $9 ELSE bio END,
                banner_url = CASE WHEN $10 THEN $11 ELSE banner_url END,
                updated_at = now()
            WHERE id = $1
            RETURNING
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                bio,
                banner_url,
                created_at,
                updated_at
            "#,
            id,
            should_update_avatar,
            avatar_value,
            should_update_display_name,
            display_name_value,
            should_update_custom_status,
            custom_status_value,
            should_update_bio,
            bio_value,
            should_update_banner,
            banner_value,
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
            bio: row.bio,
            banner_url: row.banner_url,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        Ok(profile_row.into_profile())
    }

    async fn update_username(
        &self,
        user_id: &UserId,
        username: &str,
    ) -> Result<Profile, DomainError> {
        let id = user_id.0;

        let row = sqlx::query!(
            r#"
            UPDATE profiles
            SET
                username = $2,
                updated_at = now()
            WHERE id = $1
            RETURNING
                id,
                username,
                display_name,
                avatar_url,
                status,
                custom_status,
                bio,
                banner_url,
                created_at,
                updated_at
            "#,
            id,
            username,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| match e {
            // WHY: The safe username is derived from the user's own UUID, so a
            // collision is effectively impossible — mapped for completeness,
            // mirroring upsert_from_auth.
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                DomainError::Conflict("Username is already taken".to_string())
            }
            other => super::db_err(other),
        })?
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
            bio: row.bio,
            banner_url: row.banner_url,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        Ok(profile_row.into_profile())
    }
}
