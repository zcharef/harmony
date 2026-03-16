//! Application state shared across handlers.

use std::sync::Arc;

use secrecy::SecretString;
use sqlx::PgPool;

use crate::domain::ports::ChannelRepository;
use crate::domain::services::{MessageService, ProfileService, ServerService};

/// Application state shared across all handlers.
///
/// Uses `Clone` (all fields are `Arc` internally or cheap-to-clone).
#[derive(Clone)]
pub struct AppState {
    /// Postgres connection pool (Supabase).
    pub pool: PgPool,
    /// Supabase JWT secret for token verification.
    pub jwt_secret: SecretString,
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
    /// Channel repository (no service layer — accessed directly per hexagonal design).
    channel_repository: Arc<dyn ChannelRepository>,
}

// WHY: Manual Debug because `dyn ChannelRepository` is Debug but Arc<dyn Trait> needs explicit impl.
impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("pool", &"PgPool")
            .field("is_production", &self.is_production)
            .field("profile_service", &self.profile_service)
            .field("server_service", &self.server_service)
            .field("message_service", &self.message_service)
            .field("channel_repository", &self.channel_repository)
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
        session_secret: SecretString,
        is_production: bool,
        profile_service: Arc<ProfileService>,
        server_service: Arc<ServerService>,
        message_service: Arc<MessageService>,
        channel_repository: Arc<dyn ChannelRepository>,
    ) -> Self {
        Self {
            pool,
            jwt_secret,
            session_secret,
            is_production,
            profile_service,
            server_service,
            message_service,
            channel_repository,
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

    /// Access the channel repository directly (no service layer needed).
    #[must_use]
    pub fn channel_repository(&self) -> &dyn ChannelRepository {
        &*self.channel_repository
    }
}
