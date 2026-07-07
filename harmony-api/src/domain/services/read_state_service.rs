//! Read state domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ChannelReadState, MessageId, UserId};
use crate::domain::ports::{ChannelRepository, MemberRepository, ReadStateRepository};
use crate::domain::services::channel_access::ensure_channel_access;

/// Service for channel read state business logic.
#[derive(Debug)]
pub struct ReadStateService {
    repo: Arc<dyn ReadStateRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl ReadStateService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn ReadStateRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
        }
    }

    /// Verify that a user may access the channel they are marking as read.
    ///
    /// WHY: `mark_read` previously wrote read state for ANY authenticated user
    /// on ANY channel UUID — no membership check at all. Delegates to the
    /// shared [`ensure_channel_access`] helper (server membership plus the
    /// private-channel role gate) so this path can't drift from the message
    /// and reaction paths.
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

    /// Mark a channel as read up to a specific message.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel doesn't exist,
    /// `DomainError::Forbidden` if the user is not a server member or lacks
    /// access to a private channel, or a repository error on failure.
    pub async fn mark_read(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        last_message_id: &MessageId,
    ) -> Result<(), DomainError> {
        self.verify_channel_membership(channel_id, user_id).await?;
        self.repo
            .mark_read(channel_id, user_id, last_message_id)
            .await
    }

    /// List channels with unread messages across all servers the user belongs to.
    /// Used by the SSE `unread.sync` initial snapshot.
    ///
    /// # Errors
    /// Returns `DomainError` on repository failure.
    pub async fn list_all_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<ChannelReadState>, DomainError> {
        self.repo.list_all_for_user(user_id).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use uuid::Uuid;

    use crate::domain::models::{Channel, ChannelType, Role, ServerId, ServerMember};

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

    fn make_channel(srv: ServerId, is_private: bool) -> Channel {
        let now = Utc::now();
        Channel {
            id: channel_id(100),
            server_id: srv,
            name: "general".to_string(),
            topic: None,
            channel_type: ChannelType::Text,
            position: 0,
            category_id: None,
            is_private,
            is_read_only: false,
            encrypted: false,
            slow_mode_seconds: 0,
            created_at: now,
            updated_at: now,
        }
    }

    /// Minimal `ReadStateRepository` fake: records nothing, always succeeds.
    /// The tests assert on the authorization gate, not on persistence.
    #[derive(Debug)]
    struct FakeReadStateRepo;

    #[async_trait]
    impl ReadStateRepository for FakeReadStateRepo {
        async fn mark_read(
            &self,
            _channel_id: &ChannelId,
            _user_id: &UserId,
            _last_message_id: &MessageId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn list_all_for_user(
            &self,
            _user_id: &UserId,
        ) -> Result<Vec<ChannelReadState>, DomainError> {
            Ok(vec![])
        }
    }

    /// Minimal `MemberRepository` fake: returns a fixed role for the one member,
    /// `None` for everyone else. Only `get_member_role` is exercised here.
    #[derive(Debug)]
    struct FakeMemberRepo {
        member: Option<Role>,
    }

    #[async_trait]
    impl MemberRepository for FakeMemberRepo {
        async fn get_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<Role>, DomainError> {
            Ok(self.member)
        }

        // -- unused by mark_read --
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
            Ok(self.member.is_some())
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
    }

    /// Minimal `ChannelRepository` fake. `get_by_id` returns the stored channel;
    /// `has_private_channel_access` mirrors the real semantics: admin/owner
    /// always pass; member/moderator pass only when `grant_extra` is set
    /// (simulating a `channel_role_access` entry).
    #[derive(Debug)]
    struct FakeChannelRepo {
        channel: Channel,
        grant_extra: bool,
    }

    #[async_trait]
    impl ChannelRepository for FakeChannelRepo {
        async fn get_by_id(&self, _channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
            Ok(Some(self.channel.clone()))
        }
        async fn has_private_channel_access(
            &self,
            _channel_id: &ChannelId,
            member_role: Role,
        ) -> Result<bool, DomainError> {
            Ok(member_role == Role::Admin || member_role == Role::Owner || self.grant_extra)
        }

        // -- unused by mark_read --
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

    async fn run(
        member: Option<Role>,
        is_private: bool,
        grant_extra: bool,
    ) -> Result<(), DomainError> {
        let channel = make_channel(server_id(1), is_private);
        let service = ReadStateService::new(
            Arc::new(FakeReadStateRepo),
            Arc::new(FakeChannelRepo {
                channel,
                grant_extra,
            }),
            Arc::new(FakeMemberRepo { member }),
        );
        service
            .mark_read(&channel_id(100), &user_id(42), &message_id(7))
            .await
    }

    /// A non-member cannot mark any channel as read.
    #[tokio::test]
    async fn non_member_cannot_mark_read() {
        let err = run(None, false, false).await.unwrap_err();
        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
    }

    /// Any member may mark a public channel as read.
    #[tokio::test]
    async fn member_may_mark_read_public_channel() {
        assert!(run(Some(Role::Member), false, false).await.is_ok());
    }

    /// A plain member WITHOUT an explicit grant cannot mark a private channel
    /// as read — the regression guard for the missing-membership-check IDOR.
    #[tokio::test]
    async fn member_without_grant_cannot_mark_read_private_channel() {
        let err = run(Some(Role::Member), true, false).await.unwrap_err();
        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
    }
}
