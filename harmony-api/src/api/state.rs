//! Application state shared across handlers.

use std::sync::Arc;

use jsonwebtoken::DecodingKey;
use secrecy::SecretString;
use sqlx::PgPool;

use crate::domain::ports::{BanRepository, MemberRepository, PlanLimitChecker};
use crate::domain::services::{
    ChannelService, DmService, InviteService, KeyService, MessageService, ModerationService,
    ProfileService, ServerService,
};
use crate::infra::{BroadcastEventBus, PresenceTracker};

/// Application state shared across all handlers.
///
/// Uses `Clone` (all fields are `Arc` internally or cheap-to-clone).
#[derive(Clone)]
pub struct AppState {
    /// Postgres connection pool (Supabase).
    pub pool: PgPool,
    /// Supabase JWT secret for HS256 token verification.
    pub jwt_secret: SecretString,
    /// ES256 public key from Supabase JWKS (for newer Supabase CLI versions).
    pub es256_key: Option<DecodingKey>,
    /// Session secret for signing HMAC session tokens.
    pub session_secret: SecretString,
    /// Whether the server is running in production mode.
    pub is_production: bool,
    /// Profile domain service.
    profile_service: Arc<ProfileService>,
    /// Server domain service.
    server_service: Arc<ServerService>,
    /// Message domain service.
    message_service: Arc<MessageService>,
    /// Invite domain service.
    invite_service: Arc<InviteService>,
    /// Channel domain service.
    channel_service: Arc<ChannelService>,
    /// Moderation domain service (ban/kick/unban).
    moderation_service: Arc<ModerationService>,
    /// DM domain service (create/list/close direct messages).
    dm_service: Arc<DmService>,
    /// Key distribution domain service (E2EE device keys and pre-key bundles).
    key_service: Arc<KeyService>,
    /// Member repository (accessed directly for simple queries; invite logic lives in `InviteService`).
    member_repository: Arc<dyn MemberRepository>,
    /// Ban repository (accessed directly by moderation handlers).
    ban_repository: Arc<dyn BanRepository>,
    /// Plan limit checker (self-hosted: always allowed, hosted: Postgres-backed).
    plan_limit_checker: Arc<dyn PlanLimitChecker>,
    /// In-process event bus for SSE real-time delivery.
    event_bus: Arc<BroadcastEventBus>,
    /// In-memory presence tracker (online/idle/dnd per user).
    presence_tracker: Arc<PresenceTracker>,
}

// WHY: Manual Debug because `dyn MemberRepository` needs explicit impl through Arc.
impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("pool", &"PgPool")
            .field("is_production", &self.is_production)
            .field("profile_service", &self.profile_service)
            .field("server_service", &self.server_service)
            .field("message_service", &self.message_service)
            .field("invite_service", &self.invite_service)
            .field("channel_service", &self.channel_service)
            .field("moderation_service", &self.moderation_service)
            .field("dm_service", &self.dm_service)
            .field("key_service", &self.key_service)
            .field("member_repository", &self.member_repository)
            .field("ban_repository", &self.ban_repository)
            .field("plan_limit_checker", &self.plan_limit_checker)
            .field("event_bus", &self.event_bus)
            .field("presence_tracker", &self.presence_tracker)
            .finish()
    }
}

impl AppState {
    /// Construct a new `AppState` with all services and repositories wired.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pool: PgPool,
        jwt_secret: SecretString,
        es256_key: Option<DecodingKey>,
        session_secret: SecretString,
        is_production: bool,
        profile_service: Arc<ProfileService>,
        server_service: Arc<ServerService>,
        message_service: Arc<MessageService>,
        invite_service: Arc<InviteService>,
        channel_service: Arc<ChannelService>,
        moderation_service: Arc<ModerationService>,
        dm_service: Arc<DmService>,
        key_service: Arc<KeyService>,
        member_repository: Arc<dyn MemberRepository>,
        ban_repository: Arc<dyn BanRepository>,
        plan_limit_checker: Arc<dyn PlanLimitChecker>,
        event_bus: Arc<BroadcastEventBus>,
        presence_tracker: Arc<PresenceTracker>,
    ) -> Self {
        Self {
            pool,
            jwt_secret,
            es256_key,
            session_secret,
            is_production,
            profile_service,
            server_service,
            message_service,
            invite_service,
            channel_service,
            moderation_service,
            dm_service,
            key_service,
            member_repository,
            ban_repository,
            plan_limit_checker,
            event_bus,
            presence_tracker,
        }
    }

    /// Access the profile domain service.
    #[must_use]
    pub fn profile_service(&self) -> &ProfileService {
        &self.profile_service
    }

    /// Access the server domain service.
    #[must_use]
    pub fn server_service(&self) -> &ServerService {
        &self.server_service
    }

    /// Access the message domain service.
    #[must_use]
    pub fn message_service(&self) -> &MessageService {
        &self.message_service
    }

    /// Access the invite domain service.
    #[must_use]
    pub fn invite_service(&self) -> &InviteService {
        &self.invite_service
    }

    /// Access the channel domain service.
    #[must_use]
    pub fn channel_service(&self) -> &ChannelService {
        &self.channel_service
    }

    /// Access the moderation domain service.
    #[must_use]
    pub fn moderation_service(&self) -> &ModerationService {
        &self.moderation_service
    }

    /// Access the DM domain service.
    #[must_use]
    pub fn dm_service(&self) -> &DmService {
        &self.dm_service
    }

    /// Access the key distribution domain service (E2EE).
    #[must_use]
    pub fn key_service(&self) -> &KeyService {
        &self.key_service
    }

    /// Access the member repository directly (simple queries; invite logic in `InviteService`).
    #[must_use]
    pub fn member_repository(&self) -> &dyn MemberRepository {
        &*self.member_repository
    }

    /// Access the ban repository directly (moderation handlers).
    #[must_use]
    pub fn ban_repository(&self) -> &dyn BanRepository {
        &*self.ban_repository
    }

    /// Access the plan limit checker (self-hosted: noop, hosted: enforces limits).
    #[must_use]
    pub fn plan_limit_checker(&self) -> &dyn PlanLimitChecker {
        &*self.plan_limit_checker
    }

    /// Access the event bus for publishing real-time events.
    #[must_use]
    pub fn event_bus(&self) -> &BroadcastEventBus {
        &self.event_bus
    }

    /// Access the in-memory presence tracker.
    #[must_use]
    pub fn presence_tracker(&self) -> &PresenceTracker {
        &self.presence_tracker
    }
}
