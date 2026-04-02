//! DM (Direct Message) domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ServerId, UserId};
use crate::domain::ports::dm_repository::DmRow;
use crate::domain::ports::{
    DmRepository, MemberRepository, PlanLimitChecker, ProfileRepository, ServerRepository,
};

/// Hydrated DM conversation returned from service methods.
#[derive(Debug, Clone)]
pub struct DmConversation {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub recipient_id: UserId,
    pub recipient_username: String,
    pub recipient_display_name: Option<String>,
    pub recipient_avatar_url: Option<String>,
    pub last_message_content: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    /// When the caller joined this DM (used as cursor fallback when no messages exist).
    pub joined_at: DateTime<Utc>,
}

impl From<DmRow> for DmConversation {
    fn from(row: DmRow) -> Self {
        Self {
            server_id: row.server_id,
            channel_id: row.channel_id,
            recipient_id: row.other_user_id,
            recipient_username: row.other_username,
            recipient_display_name: row.other_display_name,
            recipient_avatar_url: row.other_avatar_url,
            last_message_content: row.last_message_content,
            last_message_at: row.last_message_at,
            joined_at: row.joined_at,
        }
    }
}

/// Service for DM-related business logic.
#[derive(Debug)]
pub struct DmService {
    dm_repo: Arc<dyn DmRepository>,
    profile_repo: Arc<dyn ProfileRepository>,
    server_repo: Arc<dyn ServerRepository>,
    member_repo: Arc<dyn MemberRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
}

impl DmService {
    #[must_use]
    pub fn new(
        dm_repo: Arc<dyn DmRepository>,
        profile_repo: Arc<dyn ProfileRepository>,
        server_repo: Arc<dyn ServerRepository>,
        member_repo: Arc<dyn MemberRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
    ) -> Self {
        Self {
            dm_repo,
            profile_repo,
            server_repo,
            member_repo,
            plan_checker,
        }
    }

    /// Create a new DM conversation or return an existing one (idempotent).
    ///
    /// # Returns
    /// `(conversation, created)` where `created` is `true` if a new DM was created.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if the caller tries to DM themselves.
    /// - `DomainError::NotFound` if the recipient profile does not exist.
    /// - `DomainError::RateLimited` if the caller has created too many DMs recently.
    /// - Repository errors on failure.
    pub async fn create_or_get_dm(
        &self,
        caller_id: &UserId,
        recipient_id: &UserId,
    ) -> Result<(DmConversation, bool), DomainError> {
        if *caller_id == *recipient_id {
            return Err(DomainError::ValidationError(
                "Cannot create a DM with yourself".to_string(),
            ));
        }

        // WHY: Both users must have profiles because server_members.user_id has a FK
        // constraint referencing profiles(id). Without this check, the INSERT into
        // server_members would fail with a FK violation if the caller hasn't called
        // syncProfile yet.
        if self.profile_repo.get_by_id(caller_id).await?.is_none() {
            return Err(DomainError::ValidationError(
                "You must sync your profile before creating a DM".to_string(),
            ));
        }

        let recipient = self
            .profile_repo
            .get_by_id(recipient_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "User",
                id: recipient_id.to_string(),
            })?;

        let now = Utc::now();

        // Check for existing DM
        if let Some((server_id, channel_id)) = self
            .dm_repo
            .find_dm_between_users(caller_id, recipient_id)
            .await?
        {
            let conversation = DmConversation {
                server_id,
                channel_id,
                recipient_id: recipient.id,
                recipient_username: recipient.username,
                recipient_display_name: recipient.display_name,
                recipient_avatar_url: recipient.avatar_url,
                last_message_content: None,
                last_message_at: None,
                // WHY: For the create-or-get path we don't have the real joined_at
                // from the DB, but this value is only used as a cursor fallback when
                // last_message_at is None. Using `now` is acceptable here because
                // create_or_get returns a single DM, not a paginated list.
                joined_at: now,
            };
            return Ok((conversation, false));
        }

        // WHY: Rate limit NEW DM creation only. Returning existing DMs is free
        // (idempotent path above). This prevents a malicious user from mass-creating
        // DM servers to pollute the database. 10 new DMs per hour is generous for
        // legitimate use while blocking automated abuse.
        const MAX_DMS_PER_HOUR: i64 = 10;
        let recent_count = self.dm_repo.count_recent_dms_for_user(caller_id).await?;

        if recent_count >= MAX_DMS_PER_HOUR {
            return Err(DomainError::RateLimited(
                "Too many DMs created recently. Please try again later.".to_string(),
            ));
        }

        self.plan_checker.check_dm_limit(caller_id).await?;

        // Create new DM
        let (server_id, channel_id) = self.dm_repo.create_dm(caller_id, recipient_id).await?;

        let conversation = DmConversation {
            server_id,
            channel_id,
            recipient_id: recipient.id,
            recipient_username: recipient.username,
            recipient_display_name: recipient.display_name,
            recipient_avatar_url: recipient.avatar_url,
            last_message_content: None,
            last_message_at: None,
            // WHY: Just created, so joined_at is effectively now.
            joined_at: now,
        };

        Ok((conversation, true))
    }

    /// List all DM conversations for a user with cursor-based pagination.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_dms(
        &self,
        caller_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<DmConversation>, DomainError> {
        let rows = self
            .dm_repo
            .list_dms_for_user(caller_id, cursor, limit)
            .await?;

        Ok(rows.into_iter().map(DmConversation::from).collect())
    }

    /// Close (leave) a DM conversation.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::ValidationError` if the server is not a DM.
    /// - `DomainError::Forbidden` if the caller is not a member.
    pub async fn close_dm(
        &self,
        caller_id: &UserId,
        server_id: &ServerId,
    ) -> Result<(), DomainError> {
        let server = self
            .server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "DM",
                id: server_id.to_string(),
            })?;

        if !server.is_dm {
            return Err(DomainError::ValidationError(
                "Server is not a DM conversation".to_string(),
            ));
        }

        let is_member = self.member_repo.is_member(server_id, caller_id).await?;
        if !is_member {
            return Err(DomainError::Forbidden(
                "You are not a member of this DM conversation".to_string(),
            ));
        }

        self.member_repo.remove_member(server_id, caller_id).await
    }
}

/// Validate that a DM is not being created with oneself.
///
/// WHY: Extracted from `create_or_get_dm` for unit testing without repos.
fn validate_dm_participants(caller_id: &UserId, recipient_id: &UserId) -> Result<(), DomainError> {
    if *caller_id == *recipient_id {
        return Err(DomainError::ValidationError(
            "Cannot create a DM with yourself".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── Helper ───────────────────────────────────────────────────

    fn user_id(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }

    fn server_id(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }

    fn channel_id(n: u128) -> ChannelId {
        ChannelId::new(Uuid::from_u128(n))
    }

    // ── Self-DM rejection ────────────────────────────────────────

    #[test]
    fn self_dm_rejected() {
        let user = user_id(1);
        let result = validate_dm_participants(&user, &user);
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(msg, "Cannot create a DM with yourself");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn different_users_dm_allowed() {
        let alice = user_id(1);
        let bob = user_id(2);
        assert!(validate_dm_participants(&alice, &bob).is_ok());
    }

    #[test]
    fn dm_validation_is_symmetric() {
        let alice = user_id(1);
        let bob = user_id(2);
        // Both directions should succeed.
        assert!(validate_dm_participants(&alice, &bob).is_ok());
        assert!(validate_dm_participants(&bob, &alice).is_ok());
    }

    // ── DmConversation::from(DmRow) ─────────────────────────────

    #[test]
    fn dm_conversation_from_row_maps_all_fields() {
        let now = Utc::now();
        let row = DmRow {
            server_id: server_id(10),
            channel_id: channel_id(20),
            other_user_id: user_id(30),
            other_username: "alice".to_string(),
            other_display_name: Some("Alice Wonderland".to_string()),
            other_avatar_url: Some("https://example.com/avatar.png".to_string()),
            last_message_content: Some("Hello!".to_string()),
            last_message_at: Some(now),
            joined_at: now,
        };

        let conversation = DmConversation::from(row);

        assert_eq!(conversation.server_id, server_id(10));
        assert_eq!(conversation.channel_id, channel_id(20));
        assert_eq!(conversation.recipient_id, user_id(30));
        assert_eq!(conversation.recipient_username, "alice");
        assert_eq!(
            conversation.recipient_display_name.as_deref(),
            Some("Alice Wonderland")
        );
        assert_eq!(
            conversation.recipient_avatar_url.as_deref(),
            Some("https://example.com/avatar.png")
        );
        assert_eq!(conversation.last_message_content.as_deref(), Some("Hello!"));
        assert_eq!(conversation.last_message_at, Some(now));
        assert_eq!(conversation.joined_at, now);
    }

    #[test]
    fn dm_conversation_from_row_handles_none_fields() {
        let now = Utc::now();
        let row = DmRow {
            server_id: server_id(10),
            channel_id: channel_id(20),
            other_user_id: user_id(30),
            other_username: "bob".to_string(),
            other_display_name: None,
            other_avatar_url: None,
            last_message_content: None,
            last_message_at: None,
            joined_at: now,
        };

        let conversation = DmConversation::from(row);

        assert!(conversation.recipient_display_name.is_none());
        assert!(conversation.recipient_avatar_url.is_none());
        assert!(conversation.last_message_content.is_none());
        assert!(conversation.last_message_at.is_none());
    }

    // ── Async service methods requiring repos ────────────────────
    //
    // The following business rules are enforced in async methods that
    // require repository trait objects (banned by ADR-018: no mocks):
    //
    // - create_or_get_dm: profile existence, rate limiting, idempotent create
    // - close_dm: DM server validation, membership check
    // - list_dms: cursor pagination
    //
    // These are covered by integration tests with real Postgres.
}
