//! Application state shared across handlers.

use std::sync::Arc;

use jsonwebtoken::DecodingKey;
use secrecy::SecretString;
use sqlx::PgPool;

use crate::domain::ports::{BanRepository, MemberRepository};
use crate::domain::services::{
    ChannelService, InviteService, MessageService, ProfileService, ServerService,
};

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
    /// Member repository (accessed directly for simple queries; invite logic lives in `InviteService`).
    member_repository: Arc<dyn MemberRepository>,
    /// Ban repository (accessed directly by moderation handlers).
    ban_repository: Arc<dyn BanRepository>,
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
            .field("member_repository", &self.member_repository)
            .field("ban_repository", &self.ban_repository)
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
        member_repository: Arc<dyn MemberRepository>,
        ban_repository: Arc<dyn BanRepository>,
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
            member_repository,
            ban_repository,
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
}
