//! Profile domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Profile, UserId};
use crate::domain::ports::ProfileRepository;
use crate::domain::services::content_filter::ContentFilter;

/// WHY: Prevent confusion with system roles and @mention keywords.
/// Lives in the domain layer because username policy is business logic,
/// not HTTP presentation.
const RESERVED_USERNAMES: &[&str] = &[
    "admin",
    "administrator",
    "system",
    "everyone",
    "here",
    "moderator",
    "mod",
    "harmony",
    "support",
    "deleted",
    "root",
    "bot",
    "official",
];

/// Service for profile-related business logic.
#[derive(Debug)]
pub struct ProfileService {
    repo: Arc<dyn ProfileRepository>,
    content_filter: Arc<ContentFilter>,
}

impl ProfileService {
    #[must_use]
    pub fn new(repo: Arc<dyn ProfileRepository>, content_filter: Arc<ContentFilter>) -> Self {
        Self {
            repo,
            content_filter,
        }
    }

    /// Create or update a profile from auth provider data.
    ///
    /// Owns the full username resolution chain:
    /// 1. Reserved name check → reject (user-chosen) or fallback (system-derived)
    /// 2. Content filter check → reject (user-chosen) or fallback (system-derived)
    /// 3. Persist via repository upsert
    ///
    /// # Errors
    /// Returns `DomainError::Conflict` if a user-chosen username is reserved.
    /// Returns `DomainError::ValidationError` if a user-chosen username is offensive.
    /// Returns a repository error on DB failure.
    pub async fn upsert_from_auth(
        &self,
        user_id: UserId,
        email: String,
        username: String,
        is_user_chosen: bool,
    ) -> Result<Profile, DomainError> {
        // Step 1: reserved name check
        let username = if RESERVED_USERNAMES.contains(&username.as_str()) {
            if is_user_chosen {
                return Err(DomainError::Conflict(
                    "This username is reserved".to_string(),
                ));
            }
            tracing::warn!(
                email_derived_username = %username,
                "email-derived username is reserved, using safe fallback"
            );
            generate_safe_username(&user_id)
        } else {
            username
        };

        // Step 2: content filter check
        // WHY: User-chosen names are intentional — reject with an error.
        // System-derived names (from email) are not the user's choice — generate
        // a safe fallback instead of locking out OAuth users.
        let username = match self.content_filter.check_hard(&username) {
            Ok(()) => username,
            Err(e) => {
                if is_user_chosen {
                    return Err(e);
                }
                tracing::warn!(
                    email_derived_username = %username,
                    "email-derived username failed content filter, using safe fallback"
                );
                generate_safe_username(&user_id)
            }
        };

        // Step 3: persist
        self.repo.upsert_from_auth(user_id, email, username).await
    }

    /// Check whether a username passes the content filter (no banned words).
    ///
    /// WHY: Exposed for the `check_username` handler to reject offensive
    /// usernames during the availability check, before signup.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the username contains banned words.
    pub fn validate_username_content(&self, username: &str) -> Result<(), DomainError> {
        self.content_filter.check_hard(username)
    }

    /// Check whether a username is reserved (system roles, @mention keywords).
    #[must_use]
    pub fn is_username_reserved(username: &str) -> bool {
        RESERVED_USERNAMES.contains(&username)
    }

    /// Check whether a username is already taken.
    ///
    /// # Errors
    /// Returns `DomainError` if the repository operation fails.
    pub async fn is_username_taken(&self, username: &str) -> Result<bool, DomainError> {
        self.repo.is_username_taken(username).await
    }

    /// Get a profile by user ID if it exists, without treating absence as an error.
    ///
    /// WHY: Used by `sync_profile` to short-circuit validation for existing users.
    /// Grandfathered users (created before content filter existed) may have usernames
    /// that now fail validation — skipping the chain for existing profiles prevents lockout.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn get_by_id_optional(
        &self,
        user_id: &UserId,
    ) -> Result<Option<Profile>, DomainError> {
        self.repo.get_by_id(user_id).await
    }

    /// Get a profile by user ID.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the profile does not exist,
    /// or a repository error on failure.
    pub async fn get_by_id(&self, user_id: &UserId) -> Result<Profile, DomainError> {
        self.repo
            .get_by_id(user_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Profile",
                id: user_id.to_string(),
            })
    }

    /// Update profile fields for the authenticated user.
    ///
    /// Validates inputs before delegating to the repository:
    /// - At least one field must be provided
    /// - `avatar_url` must start with `https://`
    /// - `display_name` must be 1-32 characters
    /// - `custom_status` must be at most 128 characters
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` on invalid input,
    /// or a repository error on failure.
    pub async fn update_profile(
        &self,
        user_id: &UserId,
        avatar_url: Option<String>,
        display_name: Option<String>,
        custom_status: Option<String>,
    ) -> Result<Profile, DomainError> {
        if avatar_url.is_none() && display_name.is_none() && custom_status.is_none() {
            return Err(DomainError::ValidationError(
                "At least one field must be provided".to_string(),
            ));
        }

        if let Some(ref url) = avatar_url
            && !url.starts_with("https://")
        {
            return Err(DomainError::ValidationError(
                "Avatar URL must use HTTPS".to_string(),
            ));
        }

        if let Some(ref name) = display_name {
            let len = name.len();
            if len == 0 || len > 32 {
                return Err(DomainError::ValidationError(
                    "Display name must be 1-32 characters".to_string(),
                ));
            }
            self.content_filter.check_hard(name)?;
        }

        if let Some(ref status) = custom_status {
            if status.len() > 128 {
                return Err(DomainError::ValidationError(
                    "Custom status must be at most 128 characters".to_string(),
                ));
            }
            self.content_filter.check_hard(status)?;
        }

        self.repo
            .update(user_id, avatar_url, display_name, custom_status)
            .await
    }
}

/// Generate a safe fallback username from the user's UUID.
///
/// WHY: OAuth users don't choose their email. If the email-derived username
/// is offensive or reserved, we generate a deterministic safe alternative
/// instead of locking them out. The user can rename later via profile settings.
///
/// Format: `user_<first 12 hex chars of UUID>` → e.g. `user_a1b2c3d4e5f6`
/// 12 hex chars = 48 bits of entropy (~281 trillion combinations), making
/// collisions effectively impossible for fallback usernames.
fn generate_safe_username(user_id: &UserId) -> String {
    let hex = user_id.0.as_simple().to_string();
    format!("user_{}", &hex[..12])
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── NotFound error construction ─────────────────────────────

    #[test]
    fn not_found_error_includes_user_id() {
        // WHY: Verify the error contains enough context for debugging.
        let user_id = UserId::new(Uuid::from_u128(42));
        let err = DomainError::NotFound {
            resource_type: "Profile",
            id: user_id.to_string(),
        };

        let display = format!("{err}");
        assert!(
            display.contains("Profile"),
            "Error should mention resource type: {display}"
        );
        assert!(
            display.contains(&user_id.to_string()),
            "Error should include the user ID: {display}"
        );
    }

    #[test]
    fn not_found_error_resource_type_is_profile() {
        let err = DomainError::NotFound {
            resource_type: "Profile",
            id: "test".to_string(),
        };

        match err {
            DomainError::NotFound { resource_type, .. } => {
                assert_eq!(resource_type, "Profile");
            }
            other => panic!("Expected NotFound, got {:?}", other),
        }
    }

    // ── UserId display format ───────────────────────────────────

    #[test]
    fn user_id_display_matches_uuid() {
        let raw = Uuid::from_u128(123);
        let user_id = UserId::new(raw);
        assert_eq!(user_id.to_string(), raw.to_string());
    }

    // ── Reserved username check ─────────────────────────────────

    #[test]
    fn reserved_usernames_list_is_lowercase() {
        for name in RESERVED_USERNAMES {
            assert_eq!(
                *name,
                name.to_lowercase(),
                "reserved name must be lowercase"
            );
        }
    }

    #[test]
    fn is_username_reserved_detects_reserved() {
        assert!(ProfileService::is_username_reserved("admin"));
        assert!(ProfileService::is_username_reserved("system"));
        assert!(!ProfileService::is_username_reserved("zayd"));
    }

    // ── Safe username generation ────────────────────────────────

    #[test]
    fn safe_username_has_valid_format() {
        let user_id = UserId::new(Uuid::from_u128(0x550e_8400_e29b_41d4_a716_4466_5544_0000));
        let safe = generate_safe_username(&user_id);
        let len = safe.len();
        assert!(
            (3..=32).contains(&len)
                && safe
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
            "safe username must pass format validation: {safe}"
        );
        assert!(
            safe.starts_with("user_"),
            "must start with user_ prefix: {safe}"
        );
    }

    #[test]
    fn safe_username_is_deterministic() {
        let user_id = UserId::new(Uuid::from_u128(42));
        let a = generate_safe_username(&user_id);
        let b = generate_safe_username(&user_id);
        assert_eq!(a, b, "same user_id must produce same fallback username");
    }

    #[test]
    fn safe_username_differs_per_user() {
        let a = generate_safe_username(&UserId::new(Uuid::from_u128(
            0x1000_0000_0000_0000_0000_0000_0000_0000,
        )));
        let b = generate_safe_username(&UserId::new(Uuid::from_u128(
            0x2000_0000_0000_0000_0000_0000_0000_0000,
        )));
        assert_ne!(a, b, "different user_ids must produce different usernames");
    }

    // ── Async service methods requiring repos ────────────────────
    //
    // The following business rules are enforced in async methods that
    // require repository trait objects (banned by ADR-018: no mocks):
    //
    // - upsert_from_auth: reserved check + content filter + fallback + repo upsert
    // - update_profile: length validation + content filter on display_name
    //   and custom_status, HTTPS-only avatar_url, then repo update
    // - get_by_id: delegates to repo + maps None to NotFound
    //
    // These are covered by integration tests with real Postgres.
}
