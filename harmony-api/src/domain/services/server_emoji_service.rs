//! Custom server-emoji domain service.
//!
//! Owns the create/list/delete business rules: name validation, storage-URL
//! binding, the per-plan animated gate, and the count cap. All writes flow
//! through here so the handlers stay thin.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{EmojiId, EmojiName, ServerEmoji, ServerId, UserId};
use crate::domain::ports::{PlanLimitChecker, ServerEmojiRepository};

/// DB ceiling on the stored URL (mirrors the `server_emojis_url_length` CHECK).
const MAX_EMOJI_URL_LEN: usize = 2048;

/// Service for custom server-emoji business logic.
#[derive(Debug)]
pub struct ServerEmojiService {
    repo: Arc<dyn ServerEmojiRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
    /// Normalized Supabase origin (`scheme://host[:port]`) that emoji URLs must
    /// live on. `None` = unconfigured → creation FAILS CLOSED (rejects all),
    /// same posture as attachment URL validation.
    storage_origin: Option<String>,
}

impl ServerEmojiService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn ServerEmojiRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
        storage_origin: Option<String>,
    ) -> Self {
        Self {
            repo,
            plan_checker,
            storage_origin,
        }
    }

    /// Create a custom emoji for a server.
    ///
    /// Order (mirrors `channel_service::create_channel`): validate name → bind
    /// URL to this server's bucket path → plan animated gate → count cap →
    /// insert. The unique `(server_id, name)` constraint is the concurrency
    /// backstop (surfaces as `DomainError::Conflict`).
    ///
    /// # Errors
    /// - `ValidationError` — bad name, or a URL not under this server's bucket path.
    /// - `Forbidden` — animated emoji requested on a plan that disallows them.
    /// - `LimitExceeded` — the server is at its plan's custom-emoji cap.
    /// - `Conflict` — the name already exists on the server.
    pub async fn create(
        &self,
        server_id: &ServerId,
        raw_name: &str,
        url: &str,
        is_animated: bool,
        created_by: &UserId,
    ) -> Result<ServerEmoji, DomainError> {
        let name = EmojiName::parse(raw_name)?;

        self.validate_url(server_id, url)?;

        // WHY animated gate BEFORE the count check: the two only ever both fail
        // on Free (animated disallowed AND cap 0), but keeping the explicit gate
        // is defense-in-depth for any future plan matrix.
        let limits = self.plan_checker.get_server_plan_limits(server_id).await?;
        if is_animated && !limits.emoji_animated_allowed {
            return Err(DomainError::Forbidden(
                "Animated emoji are not available on this plan".to_string(),
            ));
        }

        // WHY: TOCTOU race identical to the channel-limit race — two concurrent
        // POSTs at cap-1 may both pass and exceed by one. Accepted (billing
        // guard-rail, not a hard constraint).
        self.plan_checker.check_emoji_limit(server_id).await?;

        self.repo
            .create(server_id, name.as_str(), url, is_animated, created_by)
            .await
    }

    /// List every emoji for a server (membership is enforced by the caller).
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_server(
        &self,
        server_id: &ServerId,
    ) -> Result<Vec<ServerEmoji>, DomainError> {
        self.repo.list_for_server(server_id).await
    }

    /// Delete an emoji, enforcing the cross-server IDOR guard.
    ///
    /// # Errors
    /// - `NotFound` — no emoji with this id.
    /// - `Forbidden` — the emoji belongs to a different server than the path.
    pub async fn delete(
        &self,
        server_id: &ServerId,
        emoji_id: &EmojiId,
    ) -> Result<ServerEmoji, DomainError> {
        let emoji = self
            .repo
            .get_by_id(emoji_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "ServerEmoji",
                id: emoji_id.to_string(),
            })?;

        // WHY: an admin of server A must not delete server B's emoji by crafting
        // the id (mirrors channel_service cross-server IDOR guard).
        if emoji.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Emoji does not belong to this server".to_string(),
            ));
        }

        self.repo.delete(emoji_id).await?;
        Ok(emoji)
    }

    /// Bind the stored URL to this server's public bucket path.
    ///
    /// WHY: the bucket RLS already gates writes to admins under
    /// `{server_id}/...`, but the API must also reject a row that points at an
    /// arbitrary off-bucket URL — otherwise an admin could register any URL.
    fn validate_url(&self, server_id: &ServerId, url: &str) -> Result<(), DomainError> {
        if url.is_empty() || url.len() > MAX_EMOJI_URL_LEN {
            return Err(DomainError::ValidationError(
                "Emoji url is empty or too long".to_string(),
            ));
        }

        let base = self.storage_origin.as_deref().ok_or_else(|| {
            // Fail closed: no configured storage origin ⇒ no emoji can be created.
            DomainError::ValidationError("Emoji storage is not configured".to_string())
        })?;

        let expected_prefix = format!("{base}/storage/v1/object/public/server-emojis/{server_id}/");
        if !url.starts_with(&expected_prefix) {
            return Err(DomainError::ValidationError(
                "Emoji url must point at this server's emoji bucket".to_string(),
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    use async_trait::async_trait;
    use chrono::Utc;
    use uuid::Uuid;

    use crate::domain::models::{Plan, PlanLimits};

    fn server_id() -> ServerId {
        ServerId::new(Uuid::from_u128(1))
    }
    fn user_id() -> UserId {
        UserId::new(Uuid::from_u128(2))
    }
    const ORIGIN: &str = "https://proj.supabase.co";

    fn valid_url() -> String {
        format!(
            "{ORIGIN}/storage/v1/object/public/server-emojis/{}/abc.png",
            server_id()
        )
    }

    /// Fake emoji repo: echoes the row it was asked to create so a test can
    /// assert on the persisted name (proving lowercasing).
    #[derive(Debug)]
    struct FakeEmojiRepo;

    #[async_trait]
    impl ServerEmojiRepository for FakeEmojiRepo {
        async fn create(
            &self,
            server_id: &ServerId,
            name: &str,
            url: &str,
            is_animated: bool,
            created_by: &UserId,
        ) -> Result<ServerEmoji, DomainError> {
            Ok(ServerEmoji {
                id: EmojiId::new(Uuid::from_u128(9)),
                server_id: server_id.clone(),
                name: name.to_string(),
                url: url.to_string(),
                is_animated,
                created_by: created_by.clone(),
                created_at: Utc::now(),
            })
        }
        async fn list_for_server(
            &self,
            _server_id: &ServerId,
        ) -> Result<Vec<ServerEmoji>, DomainError> {
            Ok(vec![])
        }
        async fn get_by_id(&self, _emoji_id: &EmojiId) -> Result<Option<ServerEmoji>, DomainError> {
            Ok(None)
        }
        async fn delete(&self, _emoji_id: &EmojiId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_for_server(&self, _server_id: &ServerId) -> Result<i64, DomainError> {
            Ok(0)
        }
    }

    /// Fake plan checker: configurable plan + whether the count cap is hit.
    #[derive(Debug)]
    struct FakePlanChecker {
        plan: Plan,
        at_cap: bool,
    }

    #[async_trait]
    impl PlanLimitChecker for FakePlanChecker {
        async fn get_server_plan_limits(
            &self,
            _server_id: &ServerId,
        ) -> Result<PlanLimits, DomainError> {
            Ok(PlanLimits::for_plan(self.plan))
        }
        async fn check_emoji_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            if self.at_cap {
                Err(DomainError::LimitExceeded {
                    resource: "custom emoji",
                    plan: self.plan.to_string(),
                    limit: PlanLimits::for_plan(self.plan).max_custom_emojis,
                })
            } else {
                Ok(())
            }
        }
        // -- unused --
        async fn check_channel_limit(&self, _s: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_member_limit(&self, _s: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_owned_server_limit(&self, _u: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_joined_server_limit(&self, _u: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_voice_concurrent(&self, _s: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_invite_limit(&self, _s: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_dm_limit(&self, _u: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_attachment_count(&self, _s: &ServerId, _c: u64) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_attachment_size(&self, _s: &ServerId, _b: u64) -> Result<(), DomainError> {
            Ok(())
        }
    }

    fn service(plan: Plan, at_cap: bool) -> (ServerEmojiService, Arc<FakeEmojiRepo>) {
        let repo = Arc::new(FakeEmojiRepo);
        let svc = ServerEmojiService::new(
            repo.clone(),
            Arc::new(FakePlanChecker { plan, at_cap }),
            Some(ORIGIN.to_string()),
        );
        (svc, repo)
    }

    #[tokio::test]
    async fn create_lowercases_name_on_valid_input() {
        let (svc, _) = service(Plan::Creator, false);
        let emoji = svc
            .create(&server_id(), "Fire", &valid_url(), false, &user_id())
            .await
            .unwrap();
        // The persisted name proves lowercasing (the fake echoes what it stored).
        assert_eq!(emoji.name, "fire");
    }

    #[tokio::test]
    async fn create_rejects_animated_on_free() {
        let (svc, _) = service(Plan::Free, false);
        let err = svc
            .create(&server_id(), "party", &valid_url(), true, &user_id())
            .await
            .unwrap_err();
        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn create_rejects_at_cap() {
        let (svc, _) = service(Plan::Supporter, true);
        let err = svc
            .create(&server_id(), "party", &valid_url(), false, &user_id())
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::LimitExceeded { .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_rejects_off_bucket_url() {
        let (svc, _) = service(Plan::Creator, false);
        let bad = "https://evil.example/x.png";
        let err = svc
            .create(&server_id(), "party", bad, false, &user_id())
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_rejects_bad_name() {
        let (svc, _) = service(Plan::Creator, false);
        let err = svc
            .create(&server_id(), "Bad-Name", &valid_url(), false, &user_id())
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn create_fails_closed_without_storage_origin() {
        let svc = ServerEmojiService::new(
            Arc::new(FakeEmojiRepo),
            Arc::new(FakePlanChecker {
                plan: Plan::Creator,
                at_cap: false,
            }),
            None,
        );
        let err = svc
            .create(&server_id(), "party", &valid_url(), false, &user_id())
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }
}
