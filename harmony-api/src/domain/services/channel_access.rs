//! Shared channel access authorization.
//!
//! WHY: Reading, posting, reacting, and joining voice in a channel all require the
//! same access decision — server membership plus, for private channels, a
//! role-based grant. That decision was copy-pasted into each service and drifted:
//! the message and reaction paths checked only server membership and silently
//! skipped the private-channel gate, so any member who learned a private channel's
//! UUID could read and post in it. This module is the single source of truth so
//! those paths cannot diverge again.

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelAccessScope, ChannelId, UserId};
use crate::domain::ports::{ChannelRepository, MemberRepository};

/// Ensure `user_id` is allowed to access `channel`.
///
/// Enforces two rules:
/// 1. The user must be a member of the channel's server.
/// 2. If the channel is private, the user's role must grant access
///    (admin/owner always; member/moderator need a `channel_role_access` entry).
///
/// # Errors
/// Returns `DomainError::Forbidden` if the user is not a server member or lacks
/// access to a private channel, or a repository error on lookup failure.
pub(crate) async fn ensure_channel_access(
    channel_repo: &dyn ChannelRepository,
    member_repo: &dyn MemberRepository,
    channel: &Channel,
    user_id: &UserId,
) -> Result<(), DomainError> {
    // WHY: get_member_role doubles as the membership check — `None` means the user
    // is not a member of the server that owns this channel.
    let role = member_repo
        .get_member_role(&channel.server_id, user_id)
        .await?
        .ok_or_else(|| {
            DomainError::Forbidden("You must be a server member to access this channel".to_string())
        })?;

    if channel.is_private
        && !channel_repo
            .has_private_channel_access(&channel.id, role)
            .await?
    {
        return Err(DomainError::Forbidden(
            "You do not have access to this private channel".to_string(),
        ));
    }

    Ok(())
}

/// Resolve the channel-access routing metadata attached to a channel's events.
///
/// Returns `None` for a PUBLIC channel (the SSE layer delivers by server
/// membership alone) and `Some(scope)` for a PRIVATE channel, where
/// `scope.authorized_roles` is the explicitly-granted set from
/// `channel_role_access` (Owner/Admin are implicit and never listed). The SSE
/// Stage-2 filter uses this to gate delivery, then redacts it before the payload
/// reaches any client.
///
/// WHY a single helper: the seven publish sites that hold a `Channel` must
/// resolve this identically — one source of truth, as with `ensure_channel_access`.
///
/// # Errors
/// Propagates repository errors from the authorized-role lookup.
pub(crate) async fn resolve_channel_access(
    channel_repo: &dyn ChannelRepository,
    channel: &Channel,
) -> Result<Option<ChannelAccessScope>, DomainError> {
    if !channel.is_private {
        return Ok(None);
    }
    let authorized_roles = channel_repo.list_authorized_roles(&channel.id).await?;
    Ok(Some(ChannelAccessScope { authorized_roles }))
}

/// Resolve channel-access metadata when the caller holds only the channel ID.
///
/// Fetches the channel, then delegates to [`resolve_channel_access`]. Returns
/// `Ok(None)` when the channel no longer exists (treat as public / fail-open) —
/// which is why `delete_channel`/`delete_server` must snapshot the scope
/// BEFORE deleting the row.
///
/// WHY: The moderation-delete paths (async moderation, retry sweep) emit
/// `MessageDeleted` without the `Channel` in hand.
///
/// Error policy (ADR-027, one policy for every caller of both helpers):
/// - POST-mutation publish sites fail OPEN — `unwrap_or_else(warn + None)` and
///   keep publishing. Losing the event (a public channel vanishing from every
///   sidebar, a ghost voice participant) is worse than a private one reaching
///   a few extra members for one event; REST stays the authoritative gate.
/// - PRE-mutation handler sites propagate with `?` — the request fails cleanly
///   before any state change, and the client retries.
///
/// # Errors
/// Propagates repository errors from the channel fetch or role lookup.
pub async fn resolve_channel_access_by_id(
    channel_repo: &dyn ChannelRepository,
    channel_id: &ChannelId,
) -> Result<Option<ChannelAccessScope>, DomainError> {
    match channel_repo.get_by_id(channel_id).await? {
        Some(channel) => resolve_channel_access(channel_repo, &channel).await,
        None => Ok(None),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use uuid::Uuid;

    use crate::domain::models::{ChannelId, ChannelType, Role, ServerId, ServerMember};

    fn user_id(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }
    fn server_id(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }
    fn channel_id(n: u128) -> ChannelId {
        ChannelId::new(Uuid::from_u128(n))
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

        // -- unused by ensure_channel_access --
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

    /// Minimal `ChannelRepository` fake. `has_private_channel_access` mirrors the
    /// real semantics: admin/owner always pass; member/moderator pass only when
    /// `grant_extra` is set (simulating a `channel_role_access` entry).
    #[derive(Debug, Default)]
    struct FakeChannelRepo {
        grant_extra: bool,
        authorized_roles: Vec<Role>,
    }

    #[async_trait]
    impl ChannelRepository for FakeChannelRepo {
        async fn has_private_channel_access(
            &self,
            _channel_id: &ChannelId,
            member_role: Role,
        ) -> Result<bool, DomainError> {
            Ok(member_role == Role::Admin || member_role == Role::Owner || self.grant_extra)
        }

        async fn list_authorized_roles(
            &self,
            _channel_id: &ChannelId,
        ) -> Result<Vec<Role>, DomainError> {
            Ok(self.authorized_roles.clone())
        }

        async fn replace_role_access(
            &self,
            _channel_id: &ChannelId,
            _roles: &[Role],
        ) -> Result<(), DomainError> {
            Ok(())
        }

        // -- unused by ensure_channel_access --
        async fn list_for_server(
            &self,
            _server_id: &ServerId,
            _caller_user_id: &UserId,
        ) -> Result<Vec<Channel>, DomainError> {
            Ok(vec![])
        }
        async fn get_by_id(&self, _channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
            Ok(None)
        }
        async fn get_moderation_context(
            &self,
            _channel_id: &ChannelId,
        ) -> Result<Option<crate::domain::models::ChannelModerationContext>, DomainError> {
            Ok(None)
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
        let srv = server_id(1);
        let channel = make_channel(srv, is_private);
        let channel_repo = FakeChannelRepo {
            grant_extra,
            authorized_roles: vec![],
        };
        let member_repo = FakeMemberRepo { member };
        ensure_channel_access(&channel_repo, &member_repo, &channel, &user_id(42)).await
    }

    /// A non-member is rejected regardless of channel privacy.
    #[tokio::test]
    async fn non_member_is_forbidden() {
        let err = run(None, false, false).await.unwrap_err();
        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
    }

    /// Any member may access a public channel.
    #[tokio::test]
    async fn member_may_access_public_channel() {
        assert!(run(Some(Role::Member), false, false).await.is_ok());
    }

    /// A plain member WITHOUT an explicit grant is denied a private channel.
    /// This is the IDOR the sweep found (H1/M1) — the regression guard.
    #[tokio::test]
    async fn member_without_grant_is_denied_private_channel() {
        let err = run(Some(Role::Member), true, false).await.unwrap_err();
        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
    }

    /// An admin always accesses a private channel.
    #[tokio::test]
    async fn admin_may_access_private_channel() {
        assert!(run(Some(Role::Admin), true, false).await.is_ok());
    }

    /// A member WITH an explicit `channel_role_access` grant may access it.
    #[tokio::test]
    async fn member_with_grant_may_access_private_channel() {
        assert!(run(Some(Role::Member), true, true).await.is_ok());
    }

    /// A PUBLIC channel resolves to `None` (deliver by server membership) and
    /// never queries the role table.
    #[tokio::test]
    async fn resolve_public_channel_is_none() {
        let channel = make_channel(server_id(1), false);
        let repo = FakeChannelRepo {
            authorized_roles: vec![Role::Moderator],
            ..Default::default()
        };
        let scope = resolve_channel_access(&repo, &channel).await.unwrap();
        assert!(scope.is_none());
    }

    /// A PRIVATE channel resolves to the explicitly-granted role set.
    #[tokio::test]
    async fn resolve_private_channel_carries_authorized_roles() {
        let channel = make_channel(server_id(1), true);
        let repo = FakeChannelRepo {
            authorized_roles: vec![Role::Moderator, Role::Member],
            ..Default::default()
        };
        let scope = resolve_channel_access(&repo, &channel)
            .await
            .unwrap()
            .expect("private channel must carry a scope");
        assert_eq!(scope.authorized_roles, vec![Role::Moderator, Role::Member]);
    }
}
