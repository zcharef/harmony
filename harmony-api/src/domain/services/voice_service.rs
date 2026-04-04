//! Voice channel domain service.

use std::sync::Arc;

use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::{
    ChannelId, ChannelType, NewVoiceSession, ServerId, UserId, VoiceSession, VoiceToken,
};
use crate::domain::ports::{
    ChannelRepository, LiveKitTokenGenerator, MemberRepository, PlanLimitChecker, VoiceGrants,
    VoiceSessionRepository,
};

/// Service for voice channel business logic.
pub struct VoiceService {
    voice_repo: Arc<dyn VoiceSessionRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
    livekit: Arc<dyn LiveKitTokenGenerator>,
}

// WHY: Manual Debug because dyn trait objects need explicit impl through Arc.
impl std::fmt::Debug for VoiceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceService")
            .field("voice_repo", &self.voice_repo)
            .field("channel_repo", &self.channel_repo)
            .field("member_repo", &self.member_repo)
            .field("plan_checker", &self.plan_checker)
            .field("livekit", &self.livekit)
            .finish()
    }
}

impl VoiceService {
    #[must_use]
    pub fn new(
        voice_repo: Arc<dyn VoiceSessionRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
        livekit: Arc<dyn LiveKitTokenGenerator>,
    ) -> Self {
        Self {
            voice_repo,
            channel_repo,
            member_repo,
            plan_checker,
            livekit,
        }
    }

    /// Join a voice channel. Returns a `LiveKit` token and session metadata.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the channel does not exist.
    /// - `DomainError::ValidationError` if the channel is not a voice channel.
    /// - `DomainError::Forbidden` if the user is not a member of the server,
    ///   or lacks access to a private channel.
    /// - `DomainError::LimitExceeded` if the server has reached its concurrent voice limit.
    pub async fn join_voice(
        &self,
        user_id: &UserId,
        channel_id: &ChannelId,
    ) -> Result<VoiceToken, DomainError> {
        // 1. Fetch channel, verify it exists and is a voice channel.
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        if channel.channel_type != ChannelType::Voice {
            return Err(DomainError::ValidationError(
                "Channel is not a voice channel".to_string(),
            ));
        }

        let server_id = &channel.server_id;

        // 2. Verify user is a member of the server.
        let member = self
            .member_repo
            .get_member(server_id, user_id)
            .await?
            .ok_or_else(|| {
                DomainError::Forbidden("You are not a member of this server".to_string())
            })?;

        // 3. If private channel, verify user has explicit access.
        // WHY: Same access rules as list_for_server — admin/owner always have
        // access, member/moderator need a channel_role_access entry.
        if channel.is_private {
            let has_access = self
                .channel_repo
                .has_private_channel_access(channel_id, member.role)
                .await?;
            if !has_access {
                return Err(DomainError::Forbidden(
                    "You do not have access to this private channel".to_string(),
                ));
            }
        }

        // 4. Get plan limits (single query — used for both concurrent limit
        //    check and bitrate/duration grants, eliminating the previous
        //    duplicate get_server_limits query from check_voice_concurrent).
        let limits = self.plan_checker.get_server_plan_limits(server_id).await?;

        // 5. Build display name: prefer nickname, fall back to username.
        let display_name = member.nickname.as_deref().unwrap_or(&member.username);

        // 6. Generate LiveKit token.
        let room_name = format!("harmony_{}", channel_id);
        let grants = VoiceGrants {
            can_publish: true,
            can_subscribe: true,
            bitrate_kbps: limits.voice_bitrate_kbps,
            #[allow(clippy::cast_sign_loss)] // WHY: voice_max_duration_hours is always positive
            max_duration_secs: (limits.voice_max_duration_hours as u64).saturating_mul(3600),
        };
        let token = self
            .livekit
            .generate_token(&room_name, user_id, display_name, grants)?;
        let url = self.livekit.livekit_url().to_string();

        // 7. Atomically check concurrent limit + upsert voice session.
        // WHY: upsert_with_limit does COUNT FOR UPDATE + INSERT in one
        // transaction, preventing TOCTOU races that could bypass the plan limit.
        #[allow(clippy::cast_sign_loss)] // WHY: voice_concurrent_limit is always positive
        let max_concurrent = limits.voice_concurrent_limit as u64;
        let new_session = NewVoiceSession {
            user_id: user_id.clone(),
            channel_id: channel_id.clone(),
            server_id: server_id.clone(),
            session_id: Uuid::new_v4().to_string(),
        };
        let (_session, previous) = self
            .voice_repo
            .upsert_with_limit(
                &new_session,
                max_concurrent,
                // WHY: PlanLimits doesn't carry the plan name; the error
                // message uses this for display only. Self-hosted has a
                // 10,000 limit so this path won't trigger in practice.
                "server".to_string(),
            )
            .await?;

        let previous_channel_id = previous.as_ref().map(|p| p.channel_id.clone());
        let previous_server_id = previous.map(|p| p.server_id);

        Ok(VoiceToken {
            token,
            url,
            session_id: new_session.session_id.clone(),
            previous_channel_id,
            previous_server_id,
            server_id: server_id.clone(),
            channel_id: channel_id.clone(),
            user_id: user_id.clone(),
        })
    }

    /// Leave a voice channel. If `expected_channel_id` is provided, validates
    /// the user is actually in that channel before removing the session.
    ///
    /// # Errors
    /// - `DomainError::Conflict` if `expected_channel_id` is set but the user
    ///   is in a different channel (or not in voice at all).
    /// - Repository error on DB failure.
    pub async fn leave_voice(
        &self,
        user_id: &UserId,
        expected_channel_id: Option<&ChannelId>,
    ) -> Result<Option<VoiceSession>, DomainError> {
        if let Some(expected) = expected_channel_id {
            // WHY: Atomic check+delete in one SQL statement prevents TOCTOU
            // race where a concurrent join_voice could move the user to a
            // different channel between a read and a delete.
            let removed = self
                .voice_repo
                .remove_by_user_and_channel(user_id, expected)
                .await?;

            if removed.is_none() {
                return Err(DomainError::Conflict(
                    "You are not in the specified voice channel".to_string(),
                ));
            }

            return Ok(removed);
        }

        self.voice_repo.remove_by_user(user_id).await
    }

    /// List all participants currently in a voice channel.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the channel does not exist.
    /// - `DomainError::Forbidden` if the user is not a member of the channel's server.
    /// - Repository error on DB failure.
    pub async fn list_participants(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Vec<VoiceSession>, DomainError> {
        // WHY: Without this check, any authenticated user could enumerate voice
        // participants in ANY channel across server boundaries.
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
                "You must be a server member to list voice participants".to_string(),
            ));
        }

        self.voice_repo.list_by_channel(channel_id).await
    }

    /// List all voice sessions across all channels in a server.
    ///
    /// WHY: Needed before server deletion to snapshot sessions that will be
    /// CASCADE-deleted, so the handler can emit VoiceStateUpdate(Left) events.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_server_sessions(
        &self,
        server_id: &ServerId,
    ) -> Result<Vec<VoiceSession>, DomainError> {
        self.voice_repo.list_by_server(server_id).await
    }

    /// Update the heartbeat timestamp for a user's active voice session.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if no session matches the user + session pair
    ///   (session expired, replaced by another device, or user not in voice).
    /// - Repository error on DB failure.
    pub async fn heartbeat(&self, user_id: &UserId, session_id: &str) -> Result<(), DomainError> {
        let updated = self.voice_repo.touch(user_id, session_id).await?;

        if !updated {
            tracing::warn!(
                user_id = %user_id,
                session_id = session_id,
                "voice heartbeat for non-existent session"
            );
            return Err(DomainError::NotFound {
                resource_type: "VoiceSession",
                id: session_id.to_string(),
            });
        }

        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::{DateTime, Utc};
    use std::collections::HashMap;
    use tokio::sync::Mutex;

    use crate::domain::models::{
        Channel, ChannelType, PlanLimits, Role, ServerMember, VoiceSessionId,
    };

    // ── ID helpers ──────────────────────────────────────────────────

    fn user_id(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }

    fn server_id(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }

    fn channel_id(n: u128) -> ChannelId {
        ChannelId::new(Uuid::from_u128(n))
    }

    // ── In-memory fakes ─────────────────────────────────────────────
    // WHY: Hexagonal architecture enables testing domain logic via in-memory
    // port implementations. These are NOT mocks (no mockall/automock) — they
    // are minimal fakes that implement the port traits with HashMap state.

    // -- InMemoryChannelRepo --

    #[derive(Debug)]
    struct InMemoryChannelRepo {
        channels: Mutex<HashMap<ChannelId, Channel>>,
    }

    impl InMemoryChannelRepo {
        fn new() -> Self {
            Self {
                channels: Mutex::new(HashMap::new()),
            }
        }

        async fn insert(&self, channel: Channel) {
            self.channels
                .lock()
                .await
                .insert(channel.id.clone(), channel);
        }
    }

    #[async_trait]
    impl ChannelRepository for InMemoryChannelRepo {
        async fn get_by_id(&self, channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
            Ok(self.channels.lock().await.get(channel_id).cloned())
        }

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

        async fn has_private_channel_access(
            &self,
            _channel_id: &ChannelId,
            member_role: Role,
        ) -> Result<bool, DomainError> {
            // WHY: In tests, admin/owner always have access. Member/moderator
            // do not (no channel_role_access table in the in-memory fake).
            Ok(member_role == Role::Admin || member_role == Role::Owner)
        }
    }

    // -- InMemoryMemberRepo --

    #[derive(Debug)]
    struct InMemoryMemberRepo {
        members: Mutex<HashMap<(ServerId, UserId), ServerMember>>,
    }

    impl InMemoryMemberRepo {
        fn new() -> Self {
            Self {
                members: Mutex::new(HashMap::new()),
            }
        }

        async fn insert(&self, member: ServerMember) {
            self.members
                .lock()
                .await
                .insert((member.server_id.clone(), member.user_id.clone()), member);
        }
    }

    #[async_trait]
    impl MemberRepository for InMemoryMemberRepo {
        async fn get_member(
            &self,
            server_id: &ServerId,
            user_id: &UserId,
        ) -> Result<Option<ServerMember>, DomainError> {
            Ok(self
                .members
                .lock()
                .await
                .get(&(server_id.clone(), user_id.clone()))
                .cloned())
        }

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
            server_id: &ServerId,
            user_id: &UserId,
        ) -> Result<bool, DomainError> {
            Ok(self
                .members
                .lock()
                .await
                .contains_key(&(server_id.clone(), user_id.clone())))
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

        async fn get_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<Role>, DomainError> {
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

    // -- InMemoryVoiceSessionRepo --

    #[derive(Debug)]
    struct InMemoryVoiceSessionRepo {
        /// Keyed by `user_id` — one session per user (upsert semantics).
        sessions: Mutex<HashMap<UserId, VoiceSession>>,
    }

    impl InMemoryVoiceSessionRepo {
        fn new() -> Self {
            Self {
                sessions: Mutex::new(HashMap::new()),
            }
        }
    }

    #[async_trait]
    impl VoiceSessionRepository for InMemoryVoiceSessionRepo {
        async fn upsert(
            &self,
            session: &NewVoiceSession,
        ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError> {
            let mut sessions = self.sessions.lock().await;
            let previous = sessions.remove(&session.user_id);
            let now = Utc::now();
            let new_session = VoiceSession {
                id: VoiceSessionId::new(Uuid::new_v4()),
                user_id: session.user_id.clone(),
                channel_id: session.channel_id.clone(),
                server_id: session.server_id.clone(),
                session_id: session.session_id.clone(),
                joined_at: now,
                last_seen_at: now,
            };
            sessions.insert(session.user_id.clone(), new_session.clone());
            Ok((new_session, previous))
        }

        async fn upsert_with_limit(
            &self,
            session: &NewVoiceSession,
            max_concurrent: u64,
            plan_name: String,
        ) -> Result<(VoiceSession, Option<VoiceSession>), DomainError> {
            let sessions = self.sessions.lock().await;
            #[allow(clippy::cast_possible_wrap)]
            let count = sessions
                .values()
                .filter(|s| s.server_id == session.server_id && s.user_id != session.user_id)
                .count() as u64;
            if count >= max_concurrent {
                return Err(DomainError::LimitExceeded {
                    resource: "concurrent voice participants",
                    plan: plan_name,
                    limit: max_concurrent,
                });
            }
            drop(sessions);
            self.upsert(session).await
        }

        async fn remove_by_user(
            &self,
            user_id: &UserId,
        ) -> Result<Option<VoiceSession>, DomainError> {
            Ok(self.sessions.lock().await.remove(user_id))
        }

        async fn remove_by_user_and_channel(
            &self,
            user_id: &UserId,
            channel_id: &ChannelId,
        ) -> Result<Option<VoiceSession>, DomainError> {
            let mut sessions = self.sessions.lock().await;
            if sessions
                .get(user_id)
                .is_some_and(|s| s.channel_id == *channel_id)
            {
                Ok(sessions.remove(user_id))
            } else {
                Ok(None)
            }
        }

        async fn list_by_channel(
            &self,
            channel_id: &ChannelId,
        ) -> Result<Vec<VoiceSession>, DomainError> {
            Ok(self
                .sessions
                .lock()
                .await
                .values()
                .filter(|s| s.channel_id == *channel_id)
                .cloned()
                .collect())
        }

        async fn list_by_server(
            &self,
            server_id: &ServerId,
        ) -> Result<Vec<VoiceSession>, DomainError> {
            Ok(self
                .sessions
                .lock()
                .await
                .values()
                .filter(|s| s.server_id == *server_id)
                .cloned()
                .collect())
        }

        async fn count_by_server(&self, server_id: &ServerId) -> Result<i64, DomainError> {
            let count = self
                .sessions
                .lock()
                .await
                .values()
                .filter(|s| s.server_id == *server_id)
                .count();
            #[allow(clippy::cast_possible_wrap)] // WHY: session count will never approach i64::MAX
            Ok(count as i64)
        }

        async fn delete_stale(
            &self,
            _threshold: DateTime<Utc>,
        ) -> Result<Vec<VoiceSession>, DomainError> {
            Ok(vec![])
        }

        async fn touch(&self, user_id: &UserId, session_id: &str) -> Result<bool, DomainError> {
            let sessions = self.sessions.lock().await;
            Ok(sessions
                .get(user_id)
                .is_some_and(|s| s.session_id == session_id))
        }
    }

    // -- FakePlanChecker --

    #[derive(Debug)]
    struct FakePlanChecker {
        /// When Some, `check_voice_concurrent` returns this error.
        voice_error: Option<DomainError>,
    }

    impl FakePlanChecker {
        fn allowed() -> Self {
            Self { voice_error: None }
        }

        fn limit_exceeded() -> Self {
            Self {
                voice_error: Some(DomainError::LimitExceeded {
                    resource: "concurrent voice participants",
                    plan: "free".to_string(),
                    limit: 5,
                }),
            }
        }
    }

    #[async_trait]
    impl PlanLimitChecker for FakePlanChecker {
        async fn check_channel_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }

        async fn check_member_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }

        async fn get_server_plan_limits(
            &self,
            _server_id: &ServerId,
        ) -> Result<PlanLimits, DomainError> {
            Ok(PlanLimits::for_plan(crate::domain::models::Plan::Free))
        }

        async fn check_owned_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }

        async fn check_joined_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }

        async fn check_voice_concurrent(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            match &self.voice_error {
                Some(err) => Err(DomainError::LimitExceeded {
                    resource: match err {
                        DomainError::LimitExceeded { resource, .. } => resource,
                        _ => "voice",
                    },
                    plan: match err {
                        DomainError::LimitExceeded { plan, .. } => plan.clone(),
                        _ => "free".to_string(),
                    },
                    limit: match err {
                        DomainError::LimitExceeded { limit, .. } => *limit,
                        _ => 0,
                    },
                }),
                None => Ok(()),
            }
        }

        async fn check_invite_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }

        async fn check_dm_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
    }

    // -- FakeLiveKit --

    #[derive(Debug)]
    struct FakeLiveKit {
        /// When true, `generate_token` returns `VoiceDisabled` error.
        disabled: bool,
    }

    impl FakeLiveKit {
        fn enabled() -> Self {
            Self { disabled: false }
        }

        fn disabled() -> Self {
            Self { disabled: true }
        }
    }

    impl LiveKitTokenGenerator for FakeLiveKit {
        fn generate_token(
            &self,
            room_name: &str,
            user_id: &UserId,
            _display_name: &str,
            _grants: VoiceGrants,
        ) -> Result<String, DomainError> {
            if self.disabled {
                return Err(DomainError::VoiceDisabled);
            }
            Ok(format!("fake-token-{}-{}", room_name, user_id))
        }

        fn livekit_url(&self) -> &str {
            "wss://livekit.test.local"
        }
    }

    // ── Test fixture builder ────────────────────────────────────────

    fn make_voice_channel(ch_id: ChannelId, srv_id: ServerId) -> Channel {
        let now = Utc::now();
        Channel {
            id: ch_id,
            server_id: srv_id,
            name: "voice-test".to_string(),
            topic: None,
            channel_type: ChannelType::Voice,
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

    fn make_text_channel(ch_id: ChannelId, srv_id: ServerId) -> Channel {
        let now = Utc::now();
        Channel {
            id: ch_id,
            server_id: srv_id,
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

    fn make_member(uid: UserId, srv_id: ServerId) -> ServerMember {
        ServerMember {
            user_id: uid,
            server_id: srv_id,
            username: "testuser".to_string(),
            avatar_url: None,
            nickname: None,
            role: Role::Member,
            joined_at: Utc::now(),
        }
    }

    struct TestHarness {
        channel_repo: Arc<InMemoryChannelRepo>,
        member_repo: Arc<InMemoryMemberRepo>,
        voice_repo: Arc<InMemoryVoiceSessionRepo>,
        service: VoiceService,
    }

    fn build_harness(plan_checker: FakePlanChecker, livekit: FakeLiveKit) -> TestHarness {
        let channel_repo = Arc::new(InMemoryChannelRepo::new());
        let member_repo = Arc::new(InMemoryMemberRepo::new());
        let voice_repo = Arc::new(InMemoryVoiceSessionRepo::new());

        let service = VoiceService::new(
            Arc::clone(&voice_repo) as Arc<dyn VoiceSessionRepository>,
            Arc::clone(&channel_repo) as Arc<dyn ChannelRepository>,
            Arc::clone(&member_repo) as Arc<dyn MemberRepository>,
            Arc::new(plan_checker),
            Arc::new(livekit),
        );

        TestHarness {
            channel_repo,
            member_repo,
            voice_repo,
            service,
        }
    }

    fn build_default_harness() -> TestHarness {
        build_harness(FakePlanChecker::allowed(), FakeLiveKit::enabled())
    }

    // ── Tests ───────────────────────────────────────────────────────

    // 1. join_voice with a valid voice channel returns token + url
    #[tokio::test]
    async fn join_voice_valid_channel_returns_token_and_url() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_voice_channel(cid.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        let result = h.service.join_voice(&uid, &cid).await;
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);

        let token = result.unwrap();
        assert!(!token.token.is_empty(), "Token must not be empty");
        assert_eq!(token.url, "wss://livekit.test.local");
        assert_eq!(token.channel_id, cid);
        assert_eq!(token.server_id, sid);
        assert_eq!(token.user_id, uid);
        assert!(
            token.previous_channel_id.is_none(),
            "No previous channel on first join"
        );
    }

    // 2. join_voice with a text channel returns ValidationError
    #[tokio::test]
    async fn join_voice_text_channel_returns_validation_error() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_text_channel(cid.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        let result = h.service.join_voice(&uid, &cid).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(msg, "Channel is not a voice channel");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    // 3. join_voice when user is not a member returns Forbidden
    #[tokio::test]
    async fn join_voice_not_a_member_returns_forbidden() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_voice_channel(cid.clone(), sid.clone()))
            .await;
        // No member inserted — user is not a member.

        let result = h.service.join_voice(&uid, &cid).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::Forbidden(msg) => {
                assert_eq!(msg, "You are not a member of this server");
            }
            other => panic!("Expected Forbidden, got {:?}", other),
        }
    }

    // 4. join_voice when at plan limit returns LimitExceeded
    // WHY: The concurrent limit check now happens atomically inside
    // upsert_with_limit, so we pre-populate the repo with enough sessions
    // to reach the free plan's voice_concurrent_limit (5).
    #[tokio::test]
    async fn join_voice_at_plan_limit_returns_limit_exceeded() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_voice_channel(cid.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        // Pre-populate 5 other users already in voice (free limit = 5).
        for i in 2..=6 {
            let other_uid = user_id(i);
            h.member_repo
                .insert(make_member(other_uid.clone(), sid.clone()))
                .await;
            let session = NewVoiceSession {
                user_id: other_uid,
                channel_id: cid.clone(),
                server_id: sid.clone(),
                session_id: format!("sess-{i}"),
            };
            h.voice_repo.upsert(&session).await.unwrap();
        }

        let result = h.service.join_voice(&uid, &cid).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::LimitExceeded {
                resource, limit, ..
            } => {
                assert_eq!(resource, "concurrent voice participants");
                assert_eq!(limit, 5);
            }
            other => panic!("Expected LimitExceeded, got {:?}", other),
        }
    }

    // 5. join_voice when voice is disabled returns VoiceDisabled
    #[tokio::test]
    async fn join_voice_disabled_returns_voice_disabled() {
        let h = build_harness(FakePlanChecker::allowed(), FakeLiveKit::disabled());
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_voice_channel(cid.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        let result = h.service.join_voice(&uid, &cid).await;
        assert!(result.is_err());
        assert!(
            matches!(result.unwrap_err(), DomainError::VoiceDisabled),
            "Expected VoiceDisabled error"
        );
    }

    // 6. leave_voice when in voice returns the session
    #[tokio::test]
    async fn leave_voice_when_connected_returns_session() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid = channel_id(100);

        h.channel_repo
            .insert(make_voice_channel(cid.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        // Join first.
        h.service.join_voice(&uid, &cid).await.unwrap();

        // Leave.
        let result = h.service.leave_voice(&uid, None).await;
        assert!(result.is_ok());
        let session = result.unwrap();
        assert!(session.is_some(), "Expected Some(session) when leaving");
        let session = session.unwrap();
        assert_eq!(session.user_id, uid);
        assert_eq!(session.channel_id, cid);
    }

    // 7. leave_voice when not in voice returns None
    #[tokio::test]
    async fn leave_voice_when_not_connected_returns_none() {
        let h = build_default_harness();
        let uid = user_id(1);

        let result = h.service.leave_voice(&uid, None).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_none(), "Expected None when not in voice");
    }

    // 8. Auto-leave: join channel A, then join channel B, previous session has channel A
    #[tokio::test]
    async fn join_voice_auto_leaves_previous_channel() {
        let h = build_default_harness();
        let uid = user_id(1);
        let sid = server_id(10);
        let cid_a = channel_id(100);
        let cid_b = channel_id(200);

        h.channel_repo
            .insert(make_voice_channel(cid_a.clone(), sid.clone()))
            .await;
        h.channel_repo
            .insert(make_voice_channel(cid_b.clone(), sid.clone()))
            .await;
        h.member_repo
            .insert(make_member(uid.clone(), sid.clone()))
            .await;

        // Join channel A.
        let first = h.service.join_voice(&uid, &cid_a).await.unwrap();
        assert!(
            first.previous_channel_id.is_none(),
            "First join should have no previous channel"
        );

        // Join channel B — should auto-leave A.
        let second = h.service.join_voice(&uid, &cid_b).await.unwrap();
        assert_eq!(
            second.previous_channel_id,
            Some(cid_a),
            "Previous channel should be A after switching to B"
        );
        assert_eq!(second.channel_id, cid_b);

        // Verify only one session exists (in channel B).
        let participants_a = h
            .voice_repo
            .list_by_channel(&channel_id(100))
            .await
            .unwrap();
        assert!(
            participants_a.is_empty(),
            "Channel A should have no participants after auto-leave"
        );
        let participants_b = h.voice_repo.list_by_channel(&cid_b).await.unwrap();
        assert_eq!(
            participants_b.len(),
            1,
            "Channel B should have exactly one participant"
        );
    }
}
