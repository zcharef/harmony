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
    /// `display_name` (optional, from signup metadata) is validated FAIL-SOFT:
    /// unlike the user-chosen username, an invalid display name never blocks
    /// signup — it silently degrades to `None` (the profile then renders as the
    /// username). It is written on INSERT only; the repository's `ON CONFLICT`
    /// no-op preserves a display name the user later changed in settings.
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
        display_name: Option<String>,
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

        // Step 3: validate the optional display name FAIL-SOFT (never blocks signup)
        let display_name = self.sanitize_signup_display_name(display_name);

        // Step 4: persist
        self.repo
            .upsert_from_auth(user_id, email, username, display_name)
            .await
    }

    /// Re-validate a freshly-chosen username on the `sync_profile` hot path (F7).
    ///
    /// The signup DB trigger `handle_new_user()` honors `user_metadata.username`
    /// but cannot run the compile-time-embedded content filter, so a direct
    /// `POST /auth/v1/signup` bypasses `check_hard` entirely. This closes that
    /// gap: when the stored username was chosen at THIS signup (JWT metadata
    /// matches the stored value) and is reserved or offensive, it is silently
    /// replaced with the deterministic safe username and persisted.
    ///
    /// Grandfathered usernames are NEVER touched: `metadata_username` absent
    /// (email-derived) or different from the stored value (renamed / pre-filter
    /// account) returns the profile unchanged — the same contract the
    /// `sync_profile` early return protects.
    ///
    /// # Errors
    /// Returns a repository error if persisting the regenerated username fails.
    /// Deliberately NOT swallowed: a silent failure would leave the offensive
    /// username persisted (ADR-027) — the client retries on next login.
    pub async fn remediate_bypassed_username(
        &self,
        profile: Profile,
        metadata_username: Option<&str>,
    ) -> Result<Profile, DomainError> {
        let Some(meta_username) = metadata_username else {
            return Ok(profile);
        };

        // WHY lowercased: the JWT carries the raw client value (may be
        // mixed-case) while the trigger stores lower(...); the stored username
        // is always lowercase (DB CHECK constraint).
        if meta_username.to_lowercase() != profile.username {
            return Ok(profile);
        }

        // WHY reserved here too: defense-in-depth against drift between the
        // SQL v_reserved copy (trigger) and this Rust list.
        let is_reserved = RESERVED_USERNAMES.contains(&profile.username.as_str());
        if !is_reserved && self.content_filter.check_hard(&profile.username).is_ok() {
            return Ok(profile);
        }

        // WHY the username is never logged: it is the abusive content itself
        // (same discipline as the content filter's rejection reasons).
        tracing::warn!(
            user_id = %profile.id,
            "chosen username bypassed signup validation (reserved or offensive), regenerating"
        );

        let safe_username = generate_safe_username(&profile.id);
        self.repo.update_username(&profile.id, &safe_username).await
    }

    /// Validate an optional signup display name, FAIL-SOFT.
    ///
    /// Mirrors the `update_profile` display-name rules (trim, 1-32 chars,
    /// content filter) but never errors: because a display name at registration
    /// is optional, any invalid value degrades to `None` instead of locking the
    /// user out of signup. Returns the trimmed name when valid, else `None`.
    fn sanitize_signup_display_name(&self, raw: Option<String>) -> Option<String> {
        let trimmed = raw?.trim().to_string();
        if trimmed.is_empty() {
            return None;
        }
        // WHY chars not bytes: a 32-char accented/CJK name is valid even though
        // it exceeds 32 bytes in UTF-8 (mirrors update_profile).
        if trimmed.chars().count() > 32 {
            tracing::warn!("signup display_name exceeds 32 chars, dropping (renders as username)");
            return None;
        }
        if let Err(error) = self.content_filter.check_hard(&trimmed) {
            tracing::warn!(
                ?error,
                "signup display_name failed content filter, dropping (renders as username)"
            );
            return None;
        }
        Some(trimmed)
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

    /// Batch-fetch profiles by a list of user IDs.
    ///
    /// Returns only the profiles that exist — missing IDs are silently skipped.
    /// Order is not guaranteed.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn get_profiles_by_ids(&self, ids: &[UserId]) -> Result<Vec<Profile>, DomainError> {
        self.repo.get_profiles_by_ids(ids).await
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
    /// Each field is double-optional: outer `None` = not provided (unchanged),
    /// `Some(None)` = explicit `null` (clears the column), `Some(Some(v))` = set.
    ///
    /// Validates inputs before delegating to the repository:
    /// - At least one field must be provided (an explicit `null` counts)
    /// - `avatar_url` must start with `https://` and be at most 2048 characters
    /// - `display_name` must be 1-32 characters
    /// - `custom_status` must be at most 128 characters
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` on invalid input,
    /// or a repository error on failure.
    pub async fn update_profile(
        &self,
        user_id: &UserId,
        avatar_url: Option<Option<String>>,
        display_name: Option<Option<String>>,
        custom_status: Option<Option<String>>,
    ) -> Result<Profile, DomainError> {
        if avatar_url.is_none() && display_name.is_none() && custom_status.is_none() {
            return Err(DomainError::ValidationError(
                "At least one field must be provided".to_string(),
            ));
        }

        if let Some(Some(ref url)) = avatar_url {
            if !url.starts_with("https://") {
                return Err(DomainError::ValidationError(
                    "Avatar URL must use HTTPS".to_string(),
                ));
            }
            // WHY: 2048 is the conventional browser URL ceiling — anything
            // longer is not a fetchable avatar, just column bloat.
            if url.len() > 2048 {
                return Err(DomainError::ValidationError(
                    "Avatar URL must be at most 2048 characters".to_string(),
                ));
            }
        }

        if let Some(Some(ref name)) = display_name {
            // WHY: Count chars, not bytes — a 32-char accented or CJK name is a
            // valid display name even though it exceeds 32 bytes in UTF-8.
            let len = name.chars().count();
            if len == 0 || len > 32 {
                return Err(DomainError::ValidationError(
                    "Display name must be 1-32 characters".to_string(),
                ));
            }
            self.content_filter.check_hard(name)?;
        }

        if let Some(Some(ref status)) = custom_status {
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

    // ── update_profile input validation ──────────────────────────
    //
    // Uses a hand-rolled fake repository (ADR-018 bans mockall, not fakes —
    // same pattern as reaction_service tests). The persistence paths of
    // upsert_from_auth / update_profile / get_by_id remain covered by
    // integration tests with real Postgres.

    use async_trait::async_trait;
    use chrono::Utc;

    use crate::domain::models::{Profile, UserStatus};
    use crate::domain::ports::ProfileRepository;

    /// Minimal `ProfileRepository` fake: `update` succeeds with a dummy
    /// profile; the tests assert on the validation gate, not persistence.
    /// `update_username_calls` counts remediation writes so tests can assert
    /// the no-op paths never touch the repository.
    #[derive(Debug, Default)]
    struct FakeProfileRepo {
        update_username_calls: std::sync::atomic::AtomicUsize,
    }

    fn dummy_profile(user_id: &UserId) -> Profile {
        let now = Utc::now();
        Profile {
            id: user_id.clone(),
            username: "tester".to_string(),
            display_name: None,
            avatar_url: None,
            status: UserStatus::Offline,
            custom_status: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[async_trait]
    impl ProfileRepository for FakeProfileRepo {
        async fn update(
            &self,
            user_id: &UserId,
            _avatar_url: Option<Option<String>>,
            _display_name: Option<Option<String>>,
            _custom_status: Option<Option<String>>,
        ) -> Result<Profile, DomainError> {
            Ok(dummy_profile(user_id))
        }

        async fn upsert_from_auth(
            &self,
            user_id: UserId,
            _email: String,
            _username: String,
            display_name: Option<String>,
        ) -> Result<Profile, DomainError> {
            // WHY: Echo the display_name the service decided to persist so the
            // fail-soft tests can assert the outcome (valid → Some, invalid → None).
            // This models the INSERT path; the ON CONFLICT no-op is a DB property
            // verified against real Postgres, not this fake.
            let mut profile = dummy_profile(&user_id);
            profile.display_name = display_name;
            Ok(profile)
        }
        async fn update_username(
            &self,
            user_id: &UserId,
            username: &str,
        ) -> Result<Profile, DomainError> {
            self.update_username_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // WHY: Echo the new username so remediation tests can assert the
            // regenerated value flows back out of the service.
            let mut profile = dummy_profile(user_id);
            profile.username = username.to_string();
            Ok(profile)
        }

        // -- unused by update_profile --
        async fn get_by_id(&self, _user_id: &UserId) -> Result<Option<Profile>, DomainError> {
            Ok(None)
        }
        async fn is_username_taken(&self, _username: &str) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn get_profiles_by_ids(&self, _ids: &[UserId]) -> Result<Vec<Profile>, DomainError> {
            Ok(vec![])
        }
    }

    fn profile_service() -> ProfileService {
        ProfileService::new(
            Arc::new(FakeProfileRepo::default()),
            Arc::new(ContentFilter::noop()),
        )
    }

    #[tokio::test]
    async fn update_profile_rejects_avatar_url_over_2048_chars() {
        let svc = profile_service();
        // 8 ("https://") + 2041 = 2049 chars — one over the cap
        let too_long = format!("https://{}", "a".repeat(2041));

        let err = svc
            .update_profile(
                &UserId::new(Uuid::from_u128(1)),
                Some(Some(too_long)),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_profile_accepts_avatar_url_at_2048_chars() {
        let svc = profile_service();
        // 8 ("https://") + 2040 = exactly 2048 chars — at the cap, allowed
        let at_limit = format!("https://{}", "a".repeat(2040));

        assert!(
            svc.update_profile(
                &UserId::new(Uuid::from_u128(1)),
                Some(Some(at_limit)),
                None,
                None
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn update_profile_accepts_display_name_at_32_multibyte_chars() {
        let svc = profile_service();
        // U+00E9 (é) is 2 bytes in UTF-8 — 32 chars = 64 bytes. A byte-based
        // check would reject this; the char-based check must accept it.
        let name = "é".repeat(32);
        assert_eq!(name.chars().count(), 32);
        assert!(
            name.len() > 32,
            "must exceed 32 bytes to prove chars-not-bytes"
        );

        assert!(
            svc.update_profile(
                &UserId::new(Uuid::from_u128(1)),
                None,
                Some(Some(name)),
                None
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn update_profile_rejects_display_name_over_32_chars() {
        let svc = profile_service();
        let too_long = "a".repeat(33);

        let err = svc
            .update_profile(
                &UserId::new(Uuid::from_u128(1)),
                None,
                Some(Some(too_long)),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_profile_rejects_empty_display_name() {
        let svc = profile_service();

        let err = svc
            .update_profile(
                &UserId::new(Uuid::from_u128(1)),
                None,
                Some(Some(String::new())),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_profile_rejects_non_https_avatar_url() {
        let svc = profile_service();

        let err = svc
            .update_profile(
                &UserId::new(Uuid::from_u128(1)),
                Some(Some("http://example.com/a.png".to_string())),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_profile_accepts_explicit_null_to_clear_avatar() {
        let svc = profile_service();

        // WHY: Some(None) = client sent `"avatarUrl": null` — must pass the
        // "at least one field" gate and skip URL validation (nothing to validate).
        assert!(
            svc.update_profile(&UserId::new(Uuid::from_u128(1)), Some(None), None, None)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn update_profile_accepts_explicit_null_display_name_and_status() {
        let svc = profile_service();

        assert!(
            svc.update_profile(
                &UserId::new(Uuid::from_u128(1)),
                None,
                Some(None),
                Some(None)
            )
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn update_profile_rejects_all_fields_missing() {
        let svc = profile_service();

        let err = svc
            .update_profile(&UserId::new(Uuid::from_u128(1)), None, None, None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    // ── upsert_from_auth display_name (signup) ───────────────────
    //
    // The FakeProfileRepo echoes back the display_name the service passed to
    // the repo, so these tests assert the FAIL-SOFT validation outcome. The
    // ON CONFLICT no-op that preserves an existing profile's display name on
    // re-login is a Postgres property, exercised by compile-time sqlx + real DB.

    /// Service backed by a filter that rejects the synthetic word `"slurword"`,
    /// to exercise the content-filter fail-soft branch (`profile_service()` uses
    /// a no-op filter that never rejects).
    fn profile_service_rejecting_slurword() -> ProfileService {
        ProfileService::new(
            Arc::new(FakeProfileRepo::default()),
            Arc::new(ContentFilter::from_words(&["slurword"])),
        )
    }

    #[tokio::test]
    async fn upsert_from_auth_sets_valid_display_name() {
        let svc = profile_service();

        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some("Cool Name".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(profile.display_name.as_deref(), Some("Cool Name"));
    }

    #[tokio::test]
    async fn upsert_from_auth_trims_display_name() {
        let svc = profile_service();

        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some("  Cool Name  ".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(profile.display_name.as_deref(), Some("Cool Name"));
    }

    #[tokio::test]
    async fn upsert_from_auth_none_display_name_stays_none() {
        let svc = profile_service();

        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                None,
            )
            .await
            .unwrap();

        assert_eq!(profile.display_name, None);
    }

    #[tokio::test]
    async fn upsert_from_auth_blank_display_name_degrades_to_none() {
        let svc = profile_service();

        // WHY: A whitespace-only display name is treated as "not provided" →
        // NULL → renders as the username (per the LOCKED render chain).
        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some("   ".to_string()),
            )
            .await
            .unwrap();

        assert_eq!(profile.display_name, None);
    }

    #[tokio::test]
    async fn upsert_from_auth_oversize_display_name_degrades_to_none_without_error() {
        let svc = profile_service();

        // 33 chars — one over the 32-char cap. FAIL-SOFT: must NOT block signup.
        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some("a".repeat(33)),
            )
            // FAIL-SOFT: unwrap proves it returned Ok — signup was not blocked.
            .await
            .unwrap();

        assert_eq!(profile.display_name, None);
    }

    #[tokio::test]
    async fn upsert_from_auth_accepts_display_name_at_32_multibyte_chars() {
        let svc = profile_service();

        // 32 chars of é = 64 bytes: a byte cap would reject, the char cap accepts.
        let name = "é".repeat(32);
        assert!(
            name.len() > 32,
            "must exceed 32 bytes to prove chars-not-bytes"
        );

        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some(name.clone()),
            )
            .await
            .unwrap();

        assert_eq!(profile.display_name.as_deref(), Some(name.as_str()));
    }

    #[tokio::test]
    async fn upsert_from_auth_offensive_display_name_degrades_to_none_without_error() {
        let svc = profile_service_rejecting_slurword();

        // WHY: An offensive display name (unlike a user-chosen username) must
        // NOT lock the user out of signup — it silently degrades to None.
        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "tester".to_string(),
                true,
                Some("slurword".to_string()),
            )
            // FAIL-SOFT: unwrap proves it returned Ok — signup was not blocked.
            .await
            .unwrap();

        assert_eq!(profile.display_name, None);
    }

    #[tokio::test]
    async fn upsert_from_auth_offensive_display_name_does_not_affect_username() {
        // WHY: A valid user-chosen username must still succeed even when the
        // accompanying display name is rejected by the content filter.
        let svc = profile_service_rejecting_slurword();

        let profile = svc
            .upsert_from_auth(
                UserId::new(Uuid::from_u128(1)),
                "a@b.com".to_string(),
                "goodname".to_string(),
                true,
                Some("slurword".to_string()),
            )
            // Valid username + offensive display_name → still Ok, display_name dropped.
            .await
            .unwrap();

        assert_eq!(profile.display_name, None);
    }

    // ── remediate_bypassed_username (F7 signup-bypass hot-path check) ─────
    //
    // A direct POST /auth/v1/signup skips check-username; the DB trigger
    // stores the chosen name unfiltered. These tests pin the remediation
    // decision logic: regenerate ONLY when the stored username was chosen at
    // this signup (metadata matches) AND is reserved/offensive — grandfathered
    // names (metadata absent or different) are never touched.

    use std::sync::atomic::Ordering;

    /// Service + repo handle so tests can assert whether the remediation
    /// write actually reached the repository.
    fn remediation_fixture(filter: ContentFilter) -> (ProfileService, Arc<FakeProfileRepo>) {
        let repo = Arc::new(FakeProfileRepo::default());
        let svc = ProfileService::new(repo.clone(), Arc::new(filter));
        (svc, repo)
    }

    fn profile_named(user_id: &UserId, username: &str) -> Profile {
        let mut profile = dummy_profile(user_id);
        profile.username = username.to_string();
        profile
    }

    #[tokio::test]
    async fn remediate_regenerates_when_metadata_matches_and_filter_fails() {
        let (svc, repo) = remediation_fixture(ContentFilter::from_words(&["slurword"]));
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "slurword"), Some("slurword"))
            .await
            .unwrap();

        assert!(
            profile.username.starts_with("user_"),
            "must be regenerated to the safe fallback: {}",
            profile.username
        );
        let len = profile.username.len();
        assert!(
            (3..=32).contains(&len)
                && profile
                    .username
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
            "regenerated username must pass format validation: {}",
            profile.username
        );
        assert_eq!(repo.update_username_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remediate_noop_when_metadata_absent() {
        // Grandfathered email-derived name: metadata.username never existed.
        let (svc, repo) = remediation_fixture(ContentFilter::from_words(&["slurword"]));
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "slurword"), None)
            .await
            .unwrap();

        assert_eq!(profile.username, "slurword", "must be returned untouched");
        assert_eq!(
            repo.update_username_calls.load(Ordering::SeqCst),
            0,
            "no-op path must never write"
        );
    }

    #[tokio::test]
    async fn remediate_noop_when_metadata_differs() {
        // Grandfathered user who renamed since signup: stored != metadata.
        let (svc, repo) = remediation_fixture(ContentFilter::from_words(&["slurword"]));
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "slurword"), Some("otherbadname"))
            .await
            .unwrap();

        assert_eq!(profile.username, "slurword", "must be returned untouched");
        assert_eq!(repo.update_username_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn remediate_noop_when_clean() {
        let (svc, repo) = remediation_fixture(ContentFilter::from_words(&["slurword"]));
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "goodname"), Some("goodname"))
            .await
            .unwrap();

        assert_eq!(profile.username, "goodname", "clean name must pass through");
        assert_eq!(
            repo.update_username_calls.load(Ordering::SeqCst),
            0,
            "clean happy path must not touch the repository"
        );
    }

    #[tokio::test]
    async fn remediate_regenerates_when_reserved() {
        // Noop filter: proves the reserved branch fires independently of the
        // content filter (defense-in-depth against SQL/Rust list drift).
        let (svc, repo) = remediation_fixture(ContentFilter::noop());
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "admin"), Some("admin"))
            .await
            .unwrap();

        assert!(
            profile.username.starts_with("user_"),
            "reserved name must be regenerated: {}",
            profile.username
        );
        assert_eq!(repo.update_username_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remediate_case_insensitive_match() {
        // The JWT carries the raw client value (mixed-case); the trigger stores
        // lower(...). The comparison must mirror that lowering.
        let (svc, repo) = remediation_fixture(ContentFilter::from_words(&["slurword"]));
        let user_id = UserId::new(Uuid::from_u128(1));

        let profile = svc
            .remediate_bypassed_username(profile_named(&user_id, "slurword"), Some("SLURWORD"))
            .await
            .unwrap();

        assert!(
            profile.username.starts_with("user_"),
            "case-mismatched metadata must still trigger remediation: {}",
            profile.username
        );
        assert_eq!(repo.update_username_calls.load(Ordering::SeqCst), 1);
    }
}
