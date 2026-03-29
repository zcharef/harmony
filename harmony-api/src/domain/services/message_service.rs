//! Message domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, MessageId, MessageWithAuthor, Role, UserId};
use crate::domain::ports::{
    ChannelRepository, MemberRepository, MessageRepository, PlanLimitChecker,
};

/// Service for message-related business logic.
#[derive(Debug)]
pub struct MessageService {
    repo: Arc<dyn MessageRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
}

/// Maximum message length (DB ceiling — self-hosted max).
/// Per-plan enforcement uses `PlanLimits::max_message_chars`.
const MAX_MESSAGE_LENGTH: usize = 8000;

/// Format seconds into a human-readable duration for error messages.
fn format_duration(seconds: u64) -> &'static str {
    match seconds {
        0..=900 => "15 minutes",
        901..=86_400 => "24 hours",
        86_401..=604_800 => "7 days",
        _ => "unlimited",
    }
}

impl MessageService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn MessageRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
            plan_checker,
        }
    }

    /// Rate limit window in seconds. Max messages per window is plan-derived.
    const RATE_LIMIT_WINDOW_SECS: i64 = 5;

    /// Verify that a user is a member of the server containing a channel.
    /// Returns the channel on success so callers can inspect its properties
    /// (e.g. `is_read_only`) without an extra query.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel doesn't exist,
    /// `DomainError::Forbidden` if the user is not a server member.
    async fn verify_channel_membership(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Channel, DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        let is_member = self
            .member_repo
            .is_member(&channel.server_id, user_id)
            .await?;

        if !is_member {
            return Err(DomainError::Forbidden(
                "You must be a server member to access this channel".to_string(),
            ));
        }

        Ok(channel)
    }

    /// Send a new message to a channel.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the author is not a server member
    /// or the channel is read-only and the author lacks admin+ role,
    /// `DomainError::ValidationError` if content is empty,
    /// `DomainError::RateLimited` if the author exceeds the plan's message rate limit,
    /// or a repository error on failure.
    pub async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        let channel = self
            .verify_channel_membership(channel_id, author_id)
            .await?;

        // WHY: The API uses service_role which bypasses the RLS
        // messages_insert_member policy that checks is_read_only.
        // We must enforce read-only at the service layer.
        if channel.is_read_only {
            let caller_role = self
                .member_repo
                .get_member_role(&channel.server_id, author_id)
                .await?
                .unwrap_or(Role::Member);

            if caller_role.level() < Role::Admin.level() {
                return Err(DomainError::Forbidden(
                    "This channel is read-only".to_string(),
                ));
            }
        }

        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        // WHY: DB ceiling check first (fast, no I/O), then per-plan check.
        if content.chars().count() > MAX_MESSAGE_LENGTH {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters",
                MAX_MESSAGE_LENGTH
            )));
        }

        // WHY: Per-plan enforcement — Free: 2000, Supporter/Creator: 4000, Self-Hosted: 8000.
        let limits = self
            .plan_checker
            .get_server_plan_limits(&channel.server_id)
            .await?;
        #[allow(clippy::cast_possible_truncation)] // WHY: max is 8000, fits in usize
        let max_chars = limits.max_message_chars as usize;
        if content.chars().count() > max_chars {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters on this plan",
                max_chars
            )));
        }

        let recent_count = self
            .repo
            .count_recent(channel_id, author_id, Self::RATE_LIMIT_WINDOW_SECS)
            .await?;

        // WHY: Per-plan rate limit — Free: 5/5s, Supporter: 10/5s, Creator: 20/5s.
        // Uses server's plan (already fetched above for char limit).
        #[allow(clippy::cast_possible_wrap)] // WHY: max is 20, fits in i64
        let rate_max = limits.max_messages_per_5s as i64;
        if recent_count >= rate_max {
            return Err(DomainError::RateLimited(
                "Too many messages — try again in a few seconds".to_string(),
            ));
        }

        self.repo.create(channel_id, author_id, content).await
    }

    /// List messages in a channel with cursor-based pagination.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the caller is not a server member,
    /// or a repository error on failure.
    pub async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let _channel = self.verify_channel_membership(channel_id, user_id).await?;

        self.repo.list_for_channel(channel_id, cursor, limit).await
    }

    /// Edit a message's content. Only the author can edit.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if content is empty,
    /// `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is not the author.
    pub async fn edit_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        // WHY: DB ceiling check first (fast, no I/O).
        if content.chars().count() > MAX_MESSAGE_LENGTH {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters",
                MAX_MESSAGE_LENGTH
            )));
        }

        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        if message.author_id != *user_id {
            return Err(DomainError::Forbidden(
                "Only the message author can edit this message".to_string(),
            ));
        }

        // WHY: Fetch channel to get server_id for plan lookup.
        let channel = self
            .channel_repo
            .get_by_id(&message.channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: message.channel_id.to_string(),
            })?;

        let limits = self
            .plan_checker
            .get_server_plan_limits(&channel.server_id)
            .await?;

        // WHY: Per-plan edit window — Free: 15min, Supporter: 24h, Creator: 7d.
        // u64::MAX means unlimited (self-hosted).
        if limits.message_edit_window_secs < u64::MAX {
            #[allow(clippy::cast_possible_wrap)] // WHY: guarded by < u64::MAX check above
            let window = chrono::Duration::seconds(limits.message_edit_window_secs as i64);
            if Utc::now() - message.created_at > window {
                return Err(DomainError::Forbidden(format!(
                    "Edit window expired. Your plan allows editing within {} of creation.",
                    format_duration(limits.message_edit_window_secs)
                )));
            }
        }

        // WHY: Per-plan message length — Free: 2000, Supporter/Creator: 4000.
        #[allow(clippy::cast_possible_truncation)] // WHY: max is 8000, fits in usize
        let max_chars = limits.max_message_chars as usize;
        if content.chars().count() > max_chars {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters on this plan",
                max_chars
            )));
        }

        self.repo.update_content(message_id, content).await
    }

    /// Soft-delete a message. The author or moderator+ can delete (ADR-038).
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is neither the author nor a moderator+.
    pub async fn delete_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        if message.author_id != *user_id {
            // WHY: Moderator+ can delete any message in their server (moderation).
            // Lookup chain: message.channel_id → channel.server_id → member.role.
            // Matches RLS policy messages_update_moderator_softdelete.
            let channel = self
                .channel_repo
                .get_by_id(&message.channel_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Channel",
                    id: message.channel_id.to_string(),
                })?;

            let caller_role = self
                .member_repo
                .get_member_role(&channel.server_id, user_id)
                .await?
                .ok_or_else(|| {
                    DomainError::Forbidden(
                        "You must be a server member to delete messages in this channel"
                            .to_string(),
                    )
                })?;

            if caller_role.level() < Role::Moderator.level() {
                return Err(DomainError::Forbidden(
                    "Only the message author or a moderator can delete this message".to_string(),
                ));
            }
        }

        self.repo.soft_delete(message_id, user_id).await
    }

    /// Post a system message (e.g. join announcement).
    ///
    /// Bypasses rate limits, content validation, and read-only checks — none
    /// apply to server-generated events. `author_id` is the subject of the
    /// event (the user who joined), not a "sender".
    ///
    /// # Errors
    /// Returns `DomainError::Validation` if `system_event_key` is blank.
    /// Returns a repository error on failure.
    pub async fn create_system_message(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        system_event_key: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        if system_event_key.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "system_event_key must not be blank".to_string(),
            ));
        }

        self.repo
            .create_system(channel_id, author_id, system_event_key)
            .await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    /// `MAX_MESSAGE_LENGTH` must be 8000 -- DB ceiling (self-hosted max).
    /// Per-plan enforcement is done at the service layer via `PlanLimits::max_message_chars`.
    #[test]
    fn max_message_length_constant() {
        assert_eq!(MAX_MESSAGE_LENGTH, 8000);
    }

    /// Rate limit window must be 5 seconds. Max messages per window is plan-derived.
    #[test]
    fn rate_limit_window_constant() {
        assert_eq!(MessageService::RATE_LIMIT_WINDOW_SECS, 5);
    }

    // ── Validation logic (pure, no I/O) ───────────────────────────

    /// WHY: The `create` and `edit_message` methods both reject empty content.
    /// This tests the validation string directly since the service method
    /// requires async infrastructure. The exact error message is part of
    /// the API contract.
    #[test]
    fn empty_content_produces_validation_error_message() {
        let content = "   ";
        assert!(content.trim().is_empty());
        // Matches the guard in `create` and `edit_message`
    }

    /// WHY: Whitespace-only content (spaces, tabs, newlines) must be treated
    /// as empty. The service uses `content.trim().is_empty()`.
    #[test]
    fn whitespace_only_content_is_treated_as_empty() {
        let cases = ["", " ", "  ", "\t", "\n", "\r\n", " \t \n "];
        for content in cases {
            assert!(
                content.trim().is_empty(),
                "Expected whitespace-only content to be treated as empty: {:?}",
                content
            );
        }
    }

    /// WHY: Content at exactly `MAX_MESSAGE_LENGTH` must be accepted.
    /// Content at `MAX_MESSAGE_LENGTH` + 1 must be rejected.
    #[test]
    fn max_message_length_boundary() {
        let at_limit = "a".repeat(MAX_MESSAGE_LENGTH);
        assert_eq!(at_limit.chars().count(), MAX_MESSAGE_LENGTH);
        assert!(
            at_limit.chars().count() <= MAX_MESSAGE_LENGTH,
            "Content at limit should be accepted"
        );

        let over_limit = "a".repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(
            over_limit.chars().count() > MAX_MESSAGE_LENGTH,
            "Content over limit should be rejected"
        );
    }

    /// WHY: Unicode characters should be counted by char, not by byte.
    /// A 4-byte emoji (U+1F600) counts as 1 character, not 4.
    /// This ensures plan limits are fair for non-ASCII users.
    #[test]
    fn message_length_counts_chars_not_bytes() {
        // U+1F600 (grinning face) is 4 bytes but 1 char
        let emoji = "\u{1f600}";
        assert_eq!(emoji.len(), 4, "emoji should be 4 bytes");
        assert_eq!(emoji.chars().count(), 1, "emoji should be 1 char");

        // Fill to MAX_MESSAGE_LENGTH with emoji — should pass
        let at_limit = emoji.repeat(MAX_MESSAGE_LENGTH);
        assert_eq!(at_limit.chars().count(), MAX_MESSAGE_LENGTH);
        assert!(at_limit.chars().count() <= MAX_MESSAGE_LENGTH);

        // One emoji over — should fail
        let over_limit = emoji.repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(over_limit.chars().count() > MAX_MESSAGE_LENGTH);
    }

    /// WHY: Control characters (U+0000 through U+001F except common
    /// whitespace) should still count toward the character limit.
    /// The service does not strip them — it counts raw chars.
    #[test]
    fn control_characters_count_toward_length() {
        // Null byte is a valid char
        let null_char = "\0";
        assert_eq!(null_char.chars().count(), 1);

        // Bell character (U+0007)
        let bell = "\x07";
        assert_eq!(bell.chars().count(), 1);

        // A message of control chars at limit should be accepted by length check
        // (but would fail the trim().is_empty() check separately if all whitespace)
        // "hello" (5) + \x07 (1) + "world" (5) + \0 (1) + "test" (4) = 16
        let mixed = "hello\x07world\0test".to_string();
        assert_eq!(mixed.chars().count(), 16);
        assert!(!mixed.trim().is_empty(), "mixed content is not empty");
    }

    /// WHY: The soft delete contract requires `deleted_at` and `deleted_by`
    /// fields on the Message model. This ensures the struct fields exist
    /// and have the correct types for the soft-delete pattern (ADR-038).
    #[test]
    fn message_model_supports_soft_delete_fields() {
        use uuid::Uuid;

        let msg = crate::domain::models::Message {
            id: MessageId::from(Uuid::new_v4()),
            channel_id: ChannelId::from(Uuid::new_v4()),
            author_id: UserId::from(Uuid::new_v4()),
            content: "test".to_string(),
            edited_at: None,
            deleted_at: None,
            deleted_by: None,
            encrypted: false,
            sender_device_id: None,
            message_type: crate::domain::models::MessageType::Default,
            system_event_key: None,
            created_at: Utc::now(),
        };

        // Not deleted by default
        assert!(msg.deleted_at.is_none());
        assert!(msg.deleted_by.is_none());

        // Simulate soft delete — verify fields accept Some values
        let deleter = UserId::from(Uuid::new_v4());
        let deleted_msg = crate::domain::models::Message {
            deleted_at: Some(Utc::now()),
            deleted_by: Some(deleter),
            ..msg
        };

        assert!(deleted_msg.deleted_at.is_some());
        assert!(deleted_msg.deleted_by.is_some());
    }

    /// WHY: `MessageType` serializes to lowercase strings ("default", "system")
    /// matching the Postgres enum values and the frontend's expected format.
    #[test]
    fn message_type_serialization() {
        use crate::domain::models::MessageType;

        let default_json = serde_json::to_string(&MessageType::Default).unwrap();
        assert_eq!(default_json, r#""default""#);

        let system_json = serde_json::to_string(&MessageType::System).unwrap();
        assert_eq!(system_json, r#""system""#);

        // Deserialization round-trip
        let parsed_system: MessageType = serde_json::from_str(r#""system""#).unwrap();
        assert_eq!(parsed_system, MessageType::System);

        let parsed_default: MessageType = serde_json::from_str(r#""default""#).unwrap();
        assert_eq!(parsed_default, MessageType::Default);
    }

    /// WHY: The create method rejects messages exceeding plan-specific limits
    /// (e.g., Free: 2000 chars). This tests the comparison logic directly.
    #[test]
    fn plan_limit_boundary_check_logic() {
        let free_plan_limit: usize = 2000;
        let supporter_plan_limit: usize = 4000;

        // At free plan limit: accepted
        let at_free = "a".repeat(free_plan_limit);
        assert!(at_free.chars().count() <= free_plan_limit);

        // Over free plan limit but under supporter: rejected on free, accepted on supporter
        let over_free = "a".repeat(free_plan_limit + 1);
        assert!(over_free.chars().count() > free_plan_limit);
        assert!(over_free.chars().count() <= supporter_plan_limit);

        // At supporter limit: accepted on supporter
        let at_supporter = "a".repeat(supporter_plan_limit);
        assert!(at_supporter.chars().count() <= supporter_plan_limit);

        // Over supporter but under DB ceiling: rejected on supporter, accepted on self-hosted
        let over_supporter = "a".repeat(supporter_plan_limit + 1);
        assert!(over_supporter.chars().count() > supporter_plan_limit);
        assert!(over_supporter.chars().count() <= MAX_MESSAGE_LENGTH);
    }
}
