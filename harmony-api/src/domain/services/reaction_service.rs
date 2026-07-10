//! Reaction domain service.

use std::sync::Arc;
use std::time::Duration;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MessageId, UserId};
use crate::domain::ports::{
    ChannelRepository, MemberRepository, MessageRepository, ReactionRepository,
};
use crate::domain::services::channel_access::ensure_channel_access;
use crate::domain::services::spam_guard::SpamGuard;

/// Maximum emoji length in characters.
const MAX_EMOJI_LENGTH: usize = 32;

/// Maximum DISTINCT emoji per message. Adding to an already-present emoji
/// stays allowed at the cap (it doesn't increase variety).
const MAX_DISTINCT_EMOJI_PER_MESSAGE: i64 = 20;

/// Maximum reaction additions per user within [`REACTION_RATE_WINDOW`].
const REACTION_RATE_MAX: usize = 25;

/// Window for the per-user reaction rate limit.
const REACTION_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Service for message reaction business logic.
#[derive(Debug)]
pub struct ReactionService {
    repo: Arc<dyn ReactionRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
    message_repo: Arc<dyn MessageRepository>,
    spam_guard: Arc<SpamGuard>,
}

impl ReactionService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn ReactionRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
        message_repo: Arc<dyn MessageRepository>,
        spam_guard: Arc<SpamGuard>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
            message_repo,
            spam_guard,
        }
    }

    /// Verify that a user may access the channel they are reacting in.
    ///
    /// WHY: Reactions require the same access decision as reading/posting —
    /// server membership plus the private-channel role gate. Delegates to the
    /// shared [`ensure_channel_access`] helper so this path can't drift from the
    /// message path again (it previously skipped the private-channel check,
    /// letting non-authorized members react in private channels).
    async fn verify_channel_membership(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        ensure_channel_access(&*self.channel_repo, &*self.member_repo, &channel, user_id).await
    }

    /// Verify that the message exists in the PATH channel.
    ///
    /// WHY: The channel-access check runs on the path `channel_id`, but the
    /// reaction row is keyed on `message_id` alone. Without this binding, a user
    /// could pass any channel they belong to and react to a message in a private
    /// channel or another server (cross-channel IDOR). A channel mismatch returns
    /// the same `NotFound` as a missing message so the message's existence is not
    /// leaked. Soft-deleted messages are covered too: `find_by_id` returns `None`
    /// for them (port contract).
    async fn verify_message_in_channel(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
    ) -> Result<(), DomainError> {
        let not_found = || DomainError::NotFound {
            resource_type: "Message",
            id: message_id.to_string(),
        };

        let message = self
            .message_repo
            .find_by_id(message_id)
            .await?
            .ok_or_else(not_found)?;

        if message.channel_id != *channel_id {
            return Err(not_found());
        }

        Ok(())
    }

    /// Add a reaction to a message.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the user is not a server member,
    /// `DomainError::NotFound` if the message is missing, deleted, or not in
    /// this channel, `DomainError::RateLimited` if the per-user reaction rate
    /// limit is exceeded, `DomainError::ValidationError` if the emoji is empty
    /// or too long, or if the message already carries the maximum number of
    /// distinct emoji.
    pub async fn add_reaction(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        // WHY: Authz first — a rate-limit response must not leak whether the
        // channel/message exists to users who cannot access them.
        self.verify_channel_membership(channel_id, user_id).await?;
        self.verify_message_in_channel(channel_id, message_id)
            .await?;

        // WHY: Static validation BEFORE the rate limit — malformed emoji must
        // not consume budget (25 bad requests would exhaust the window without
        // adding a single reaction). Nothing probeable: the rules are static.
        validate_emoji(emoji)?;

        self.spam_guard.check_and_record_action(
            user_id,
            "reaction",
            REACTION_RATE_MAX,
            REACTION_RATE_WINDOW,
        )?;

        // WHY: Cap DISTINCT emoji per message so a spammer can't grow a
        // message's reaction bar unboundedly. Piling onto an existing emoji
        // is always fine — variety stays constant.
        let variety = self.repo.emoji_variety(message_id, emoji).await?;
        if variety.distinct_count >= MAX_DISTINCT_EMOJI_PER_MESSAGE && !variety.emoji_present {
            return Err(DomainError::ValidationError(
                "Maximum of 20 unique reactions per message".to_string(),
            ));
        }

        self.repo.add(message_id, user_id, emoji).await
    }

    /// Remove a reaction from a message.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the user is not a server member,
    /// `DomainError::NotFound` if the message is missing, deleted, or not in
    /// this channel.
    pub async fn remove_reaction(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        self.verify_channel_membership(channel_id, user_id).await?;
        self.verify_message_in_channel(channel_id, message_id)
            .await?;
        self.repo.remove(message_id, user_id, emoji).await
    }
}

/// Validate emoji format: non-empty and within length limit.
fn validate_emoji(emoji: &str) -> Result<(), DomainError> {
    if emoji.trim().is_empty() {
        return Err(DomainError::ValidationError(
            "Emoji must not be empty".to_string(),
        ));
    }
    if emoji.chars().count() > MAX_EMOJI_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Emoji must not exceed {} characters",
            MAX_EMOJI_LENGTH
        )));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use uuid::Uuid;

    use crate::domain::models::{
        Channel, ChannelType, EmojiVariety, Message, MessageType, MessageWithAuthor,
        ReactionSummary, Role, ServerId, ServerMember,
    };

    fn user_id(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }
    fn server_id(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }
    fn channel_id(n: u128) -> ChannelId {
        ChannelId::new(Uuid::from_u128(n))
    }
    fn message_id(n: u128) -> MessageId {
        MessageId::new(Uuid::from_u128(n))
    }

    fn make_channel(srv: ServerId) -> Channel {
        let now = Utc::now();
        Channel {
            id: channel_id(100),
            server_id: srv,
            name: "general".to_string(),
            topic: None,
            channel_type: ChannelType::Text,
            position: 0,
            category_id: None,
            is_private: false,
            is_read_only: false,
            encrypted: false,
            slow_mode_seconds: 0,
            created_at: now,
            updated_at: now,
        }
    }

    fn make_message(in_channel: ChannelId) -> Message {
        Message {
            id: message_id(7),
            channel_id: in_channel,
            author_id: user_id(1),
            content: "hello".to_string(),
            edited_at: None,
            deleted_at: None,
            deleted_by: None,
            encrypted: false,
            sender_device_id: None,
            message_type: MessageType::Default,
            system_event_key: None,
            parent_message_id: None,
            moderated_at: None,
            moderation_reason: None,
            original_content: None,
            mentioned_user_ids: vec![],
            created_at: Utc::now(),
        }
    }

    /// Minimal `ReactionRepository` fake: records nothing, always succeeds.
    /// The tests assert on the authorization/limit gates, not on persistence.
    /// `variety` configures what `emoji_variety` reports (variety-cap tests).
    #[derive(Debug)]
    struct FakeReactionRepo {
        variety: EmojiVariety,
    }

    impl Default for FakeReactionRepo {
        fn default() -> Self {
            Self {
                variety: EmojiVariety {
                    distinct_count: 0,
                    emoji_present: false,
                },
            }
        }
    }

    #[async_trait]
    impl ReactionRepository for FakeReactionRepo {
        async fn add(
            &self,
            _message_id: &MessageId,
            _user_id: &UserId,
            _emoji: &str,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn emoji_variety(
            &self,
            _message_id: &MessageId,
            _emoji: &str,
        ) -> Result<EmojiVariety, DomainError> {
            Ok(self.variety)
        }
        async fn remove(
            &self,
            _message_id: &MessageId,
            _user_id: &UserId,
            _emoji: &str,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn batch_for_messages(
            &self,
            _message_ids: &[MessageId],
            _viewer_id: &UserId,
        ) -> Result<HashMap<MessageId, Vec<ReactionSummary>>, DomainError> {
            Ok(HashMap::new())
        }
    }

    /// Minimal `MemberRepository` fake: caller is always a plain member.
    /// Membership rejection paths are covered by the `channel_access` tests.
    #[derive(Debug)]
    struct FakeMemberRepo;

    #[async_trait]
    impl MemberRepository for FakeMemberRepo {
        async fn get_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<Role>, DomainError> {
            Ok(Some(Role::Member))
        }

        // -- unused by add/remove_reaction --
        async fn list_by_server(
            &self,
            _server_id: &ServerId,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
        async fn list_by_server_paginated(
            &self,
            _server_id: &ServerId,
            _cursor: Option<DateTime<Utc>>,
            _limit: i64,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
        async fn is_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<bool, DomainError> {
            Ok(true)
        }
        async fn add_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn remove_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn get_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<ServerMember>, DomainError> {
            Ok(None)
        }
        async fn update_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
            _new_role: Role,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_by_server(&self, _server_id: &ServerId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn transfer_ownership(
            &self,
            _server_id: &ServerId,
            _old_owner_id: &UserId,
            _new_owner_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn filter_mentionable(
            &self,
            _channel: &Channel,
            _user_ids: &[UserId],
        ) -> Result<Vec<UserId>, DomainError> {
            Ok(vec![])
        }
        async fn resolve_mentioned_users(
            &self,
            _server_id: &ServerId,
            _user_ids: &[UserId],
        ) -> Result<Vec<crate::domain::models::MentionedUser>, DomainError> {
            Ok(vec![])
        }
        async fn search_by_server(
            &self,
            _server_id: &ServerId,
            _q: &str,
            _limit: i64,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
    }

    /// Minimal `ChannelRepository` fake: the path channel exists and is public.
    #[derive(Debug)]
    struct FakeChannelRepo {
        channel: Channel,
    }

    #[async_trait]
    impl ChannelRepository for FakeChannelRepo {
        async fn get_by_id(&self, _channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
            Ok(Some(self.channel.clone()))
        }
        async fn has_private_channel_access(
            &self,
            _channel_id: &ChannelId,
            _member_role: Role,
        ) -> Result<bool, DomainError> {
            Ok(true)
        }
        async fn list_authorized_roles(
            &self,
            _channel_id: &ChannelId,
        ) -> Result<Vec<Role>, DomainError> {
            Ok(vec![])
        }

        async fn replace_role_access(
            &self,
            _channel_id: &ChannelId,
            _roles: &[Role],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        // -- unused by add/remove_reaction --
        async fn list_for_server(
            &self,
            _server_id: &ServerId,
            _caller_user_id: &UserId,
        ) -> Result<Vec<Channel>, DomainError> {
            Ok(vec![])
        }
        async fn create_channel(&self, channel: &Channel) -> Result<Channel, DomainError> {
            Ok(channel.clone())
        }
        async fn update_channel(
            &self,
            _channel_id: &ChannelId,
            _name: Option<String>,
            _topic: Option<Option<String>>,
            _is_private: Option<bool>,
            _is_read_only: Option<bool>,
            _encrypted: Option<bool>,
            _slow_mode_seconds: Option<i32>,
        ) -> Result<Channel, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn delete_if_not_last(&self, _channel_id: &ChannelId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_for_server(&self, _server_id: &ServerId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn find_default_for_server(
            &self,
            _server_id: &ServerId,
        ) -> Result<Option<Channel>, DomainError> {
            Ok(None)
        }
    }

    /// Minimal `MessageRepository` fake. `find_by_id` returns the configured
    /// message; `None` models both a missing and a soft-deleted message (the
    /// real adapter filters `deleted_at IS NULL`, so deleted rows come back as
    /// `None` — same port contract).
    #[derive(Debug)]
    struct FakeMessageRepo {
        message: Option<Message>,
    }

    #[async_trait]
    impl MessageRepository for FakeMessageRepo {
        async fn find_by_id(
            &self,
            _message_id: &MessageId,
        ) -> Result<Option<Message>, DomainError> {
            Ok(self.message.clone())
        }

        // -- unused by add/remove_reaction --
        #[allow(clippy::too_many_arguments)]
        async fn send_to_channel(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _content: String,
            _encrypted: bool,
            _sender_device_id: Option<String>,
            _parent_message_id: Option<MessageId>,
            _moderated_at: Option<DateTime<Utc>>,
            _moderation_reason: Option<String>,
            _original_content: Option<String>,
            _mentioned_user_ids: Vec<UserId>,
            _attachments: Vec<crate::domain::models::NewAttachment>,
            _slow_mode_seconds: i32,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn list_for_channel(
            &self,
            _channel_id: &ChannelId,
            _cursor: Option<DateTime<Utc>>,
            _limit: i64,
        ) -> Result<Vec<MessageWithAuthor>, DomainError> {
            Ok(vec![])
        }
        async fn update_content(
            &self,
            _message_id: &MessageId,
            _content: String,
            _moderated_at: Option<DateTime<Utc>>,
            _moderation_reason: Option<String>,
            _original_content: Option<String>,
            _mentioned_user_ids: Option<Vec<UserId>>,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn soft_delete(
            &self,
            _message_id: &MessageId,
            _deleted_by: &UserId,
            _checked_at: Option<DateTime<Utc>>,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_recent(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _window_secs: i64,
        ) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn get_last_message_time(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
        ) -> Result<Option<DateTime<Utc>>, DomainError> {
            Ok(None)
        }
        async fn create_system(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _system_event_key: String,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
    }

    fn service(message: Option<Message>) -> ReactionService {
        service_with_variety(message, FakeReactionRepo::default())
    }

    fn service_with_variety(message: Option<Message>, repo: FakeReactionRepo) -> ReactionService {
        ReactionService::new(
            Arc::new(repo),
            Arc::new(FakeChannelRepo {
                channel: make_channel(server_id(1)),
            }),
            Arc::new(FakeMemberRepo),
            Arc::new(FakeMessageRepo { message }),
            Arc::new(SpamGuard::new()),
        )
    }

    fn assert_message_not_found(err: &DomainError) {
        assert!(
            matches!(
                err,
                DomainError::NotFound {
                    resource_type: "Message",
                    ..
                }
            ),
            "got {err:?}"
        );
    }

    /// A message living in ANOTHER channel is rejected as `NotFound` — the
    /// cross-channel IDOR regression guard. `NotFound` (not `Forbidden`) so the
    /// message's existence is not leaked.
    #[tokio::test]
    async fn add_reaction_to_message_in_another_channel_is_not_found() {
        let svc = service(Some(make_message(channel_id(999))));
        let err = svc
            .add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
            .await
            .unwrap_err();
        assert_message_not_found(&err);
    }

    /// `remove_reaction` enforces the same message↔channel binding as add.
    #[tokio::test]
    async fn remove_reaction_from_message_in_another_channel_is_not_found() {
        let svc = service(Some(make_message(channel_id(999))));
        let err = svc
            .remove_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
            .await
            .unwrap_err();
        assert_message_not_found(&err);
    }

    /// A missing message is `NotFound`. This also covers soft-deleted messages:
    /// the repository's `find_by_id` returns `None` for `deleted_at IS NOT NULL`.
    #[tokio::test]
    async fn add_reaction_to_missing_or_deleted_message_is_not_found() {
        let svc = service(None);
        let err = svc
            .add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
            .await
            .unwrap_err();
        assert_message_not_found(&err);
    }

    /// Happy path: member reacting to a live message in the path channel.
    #[tokio::test]
    async fn add_and_remove_reaction_happy_path() {
        let svc = service(Some(make_message(channel_id(100))));
        assert!(
            svc.add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                .await
                .is_ok()
        );
        assert!(
            svc.remove_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                .await
                .is_ok()
        );
    }

    /// The per-user reaction rate limit rejects the 26th add within the window.
    #[tokio::test]
    async fn add_reaction_over_rate_limit_is_rate_limited() {
        let svc = service(Some(make_message(channel_id(100))));
        for i in 0..REACTION_RATE_MAX {
            assert!(
                svc.add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                    .await
                    .is_ok(),
                "reaction {i} should be allowed"
            );
        }

        let err = svc
            .add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
            .await
            .unwrap_err();
        assert!(matches!(err, DomainError::RateLimited(_)), "got {err:?}");
    }

    /// `remove_reaction` is not rate limited — undo must always work, even for
    /// a user who just exhausted their add budget.
    #[tokio::test]
    async fn remove_reaction_is_not_rate_limited() {
        let svc = service(Some(make_message(channel_id(100))));
        for _ in 0..REACTION_RATE_MAX {
            svc.add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                .await
                .unwrap();
        }

        assert!(
            svc.remove_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                .await
                .is_ok()
        );
    }

    /// A NOVEL emoji on a message already at the distinct-emoji cap is rejected.
    #[tokio::test]
    async fn add_novel_emoji_at_variety_cap_is_rejected() {
        let svc = service_with_variety(
            Some(make_message(channel_id(100))),
            FakeReactionRepo {
                variety: EmojiVariety {
                    distinct_count: MAX_DISTINCT_EMOJI_PER_MESSAGE,
                    emoji_present: false,
                },
            },
        );

        let err = svc
            .add_reaction(&channel_id(100), &message_id(7), &user_id(42), "🆕")
            .await
            .unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    /// Piling onto an EXISTING emoji stays allowed at the cap — variety is unchanged.
    #[tokio::test]
    async fn add_existing_emoji_at_variety_cap_is_allowed() {
        let svc = service_with_variety(
            Some(make_message(channel_id(100))),
            FakeReactionRepo {
                variety: EmojiVariety {
                    distinct_count: MAX_DISTINCT_EMOJI_PER_MESSAGE,
                    emoji_present: true,
                },
            },
        );

        assert!(
            svc.add_reaction(&channel_id(100), &message_id(7), &user_id(42), "👍")
                .await
                .is_ok()
        );
    }

    /// Below the cap, a novel emoji is allowed.
    #[tokio::test]
    async fn add_novel_emoji_below_variety_cap_is_allowed() {
        let svc = service_with_variety(
            Some(make_message(channel_id(100))),
            FakeReactionRepo {
                variety: EmojiVariety {
                    distinct_count: MAX_DISTINCT_EMOJI_PER_MESSAGE - 1,
                    emoji_present: false,
                },
            },
        );

        assert!(
            svc.add_reaction(&channel_id(100), &message_id(7), &user_id(42), "🆕")
                .await
                .is_ok()
        );
    }

    #[test]
    fn validate_emoji_rejects_empty() {
        assert!(validate_emoji("").is_err());
        assert!(validate_emoji("   ").is_err());
    }

    #[test]
    fn validate_emoji_rejects_too_long() {
        let long_emoji = "a".repeat(MAX_EMOJI_LENGTH + 1);
        assert!(validate_emoji(&long_emoji).is_err());
    }

    #[test]
    fn validate_emoji_accepts_valid() {
        assert!(validate_emoji("👍").is_ok());
        assert!(validate_emoji("🎉").is_ok());
        assert!(validate_emoji("+1").is_ok());
    }

    #[test]
    fn validate_emoji_at_boundary() {
        let at_limit = "a".repeat(MAX_EMOJI_LENGTH);
        assert!(validate_emoji(&at_limit).is_ok());
    }
}
