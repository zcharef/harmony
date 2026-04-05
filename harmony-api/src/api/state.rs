//! Application state shared across handlers.

use std::sync::Arc;

use jsonwebtoken::DecodingKey;
use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::domain::models::ServerId;
use crate::domain::ports::{
    BanRepository, ContentModerator, DesktopAuthRepository, EventBus, MegolmSessionRepository,
    MemberRepository, MessageRepository, ModerationRetryRepository, PlanLimitChecker,
    ServerRepository, VoiceSessionRepository,
};
use crate::domain::services::{
    ChannelService, DmService, InviteService, KeyService, MessageService, ModerationService,
    NotificationSettingsService, ProfileService, ReactionService, ReadStateService, ServerService,
    SpamGuard, UserPreferencesService, VoiceService,
};
use crate::infra::PresenceTracker;
use crate::infra::safe_browsing::SafeBrowsingClient;

/// Maximum concurrent async moderation tasks (`OpenAI` + Safe Browsing).
/// WHY: Prevents unbounded `tokio::spawn` from overwhelming external APIs
/// or exhausting memory under message floods.
const MAX_CONCURRENT_MODERATIONS: usize = 50;

/// Application state shared across all handlers.
///
/// Uses `Clone` (all fields are `Arc` internally or cheap-to-clone).
#[derive(Clone)]
pub struct AppState {
    /// Postgres connection pool (Supabase).
    /// WHY: Private — only exposed via `pool()` accessor for the health check.
    pool: PgPool,
    /// Supabase JWT secret for HS256 token verification.
    pub jwt_secret: secrecy::SecretString,
    /// ES256 public key from Supabase JWKS (for newer Supabase CLI versions).
    pub es256_key: Option<DecodingKey>,
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
    /// Reaction domain service (add/remove message reactions).
    reaction_service: Arc<ReactionService>,
    /// Read state domain service (mark read, list unread counts).
    read_state_service: Arc<ReadStateService>,
    /// Notification settings domain service (per-channel notification preferences).
    notification_settings_service: Arc<NotificationSettingsService>,
    /// User preferences domain service (DND mode, user-controlled settings).
    user_preferences_service: Arc<UserPreferencesService>,
    /// Member repository (accessed directly for simple queries; invite logic lives in `InviteService`).
    member_repository: Arc<dyn MemberRepository>,
    /// Ban repository (accessed directly by moderation handlers).
    ban_repository: Arc<dyn BanRepository>,
    /// Plan limit checker (self-hosted: always allowed, hosted: Postgres-backed).
    plan_limit_checker: Arc<dyn PlanLimitChecker>,
    /// In-process event bus for SSE real-time delivery.
    event_bus: Arc<dyn EventBus>,
    /// In-memory presence tracker (online/idle/dnd per user).
    presence_tracker: Arc<PresenceTracker>,
    /// Megolm session repository (E2EE channel sessions).
    megolm_session_repository: Arc<dyn MegolmSessionRepository>,
    /// Desktop auth repository (PKCE exchange codes).
    desktop_auth_repository: Arc<dyn DesktopAuthRepository>,
    /// In-memory anti-spam guard (duplicate detection, flood muting).
    spam_guard: Arc<SpamGuard>,
    /// Async content moderator (`OpenAI` Moderation API). None = disabled.
    content_moderator: Option<Arc<dyn ContentModerator>>,
    /// Google Safe Browsing URL scanner. None = disabled.
    safe_browsing: Option<Arc<SafeBrowsingClient>>,
    /// Message repository for async moderation soft-delete.
    message_repository: Arc<dyn MessageRepository>,
    /// Server repository for fetching moderation categories inside `tokio::spawn`.
    server_repository: Arc<dyn ServerRepository>,
    /// Bounds concurrent async moderation tasks to avoid overwhelming external APIs.
    moderation_semaphore: Arc<Semaphore>,
    /// Dead-letter queue for failed AI moderation checks (Tier 1 safety).
    moderation_retry_repository: Arc<dyn ModerationRetryRepository>,
    /// Voice domain service. None = `LiveKit` not configured.
    voice_service: Option<Arc<VoiceService>>,
    /// Voice session repository for sweep background task. None = voice disabled.
    voice_session_repository: Option<Arc<dyn VoiceSessionRepository>>,
    /// Official Harmony server ID. When set, `sync_profile` auto-joins new users.
    official_server_id: Option<ServerId>,
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
            .field("reaction_service", &self.reaction_service)
            .field("read_state_service", &self.read_state_service)
            .field(
                "notification_settings_service",
                &self.notification_settings_service,
            )
            .field("user_preferences_service", &self.user_preferences_service)
            .field("member_repository", &self.member_repository)
            .field("ban_repository", &self.ban_repository)
            .field("plan_limit_checker", &self.plan_limit_checker)
            .field("event_bus", &self.event_bus)
            .field("presence_tracker", &self.presence_tracker)
            .field("megolm_session_repository", &self.megolm_session_repository)
            .field("desktop_auth_repository", &self.desktop_auth_repository)
            .field("spam_guard", &self.spam_guard)
            .field("content_moderator", &self.content_moderator.is_some())
            .field("safe_browsing", &self.safe_browsing.is_some())
            .field("server_repository", &self.server_repository)
            .field("moderation_semaphore", &self.moderation_semaphore)
            .field(
                "moderation_retry_repository",
                &self.moderation_retry_repository,
            )
            .field("voice_service", &self.voice_service.is_some())
            .field(
                "voice_session_repository",
                &self.voice_session_repository.is_some(),
            )
            .field("official_server_id", &self.official_server_id)
            .finish()
    }
}

impl AppState {
    /// Construct a new `AppState` with all services and repositories wired.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pool: PgPool,
        jwt_secret: secrecy::SecretString,
        es256_key: Option<DecodingKey>,
        is_production: bool,
        profile_service: Arc<ProfileService>,
        server_service: Arc<ServerService>,
        message_service: Arc<MessageService>,
        invite_service: Arc<InviteService>,
        channel_service: Arc<ChannelService>,
        moderation_service: Arc<ModerationService>,
        dm_service: Arc<DmService>,
        key_service: Arc<KeyService>,
        reaction_service: Arc<ReactionService>,
        read_state_service: Arc<ReadStateService>,
        notification_settings_service: Arc<NotificationSettingsService>,
        user_preferences_service: Arc<UserPreferencesService>,
        member_repository: Arc<dyn MemberRepository>,
        ban_repository: Arc<dyn BanRepository>,
        plan_limit_checker: Arc<dyn PlanLimitChecker>,
        event_bus: Arc<dyn EventBus>,
        presence_tracker: Arc<PresenceTracker>,
        megolm_session_repository: Arc<dyn MegolmSessionRepository>,
        desktop_auth_repository: Arc<dyn DesktopAuthRepository>,
        spam_guard: Arc<SpamGuard>,
        content_moderator: Option<Arc<dyn ContentModerator>>,
        safe_browsing: Option<Arc<SafeBrowsingClient>>,
        message_repository_for_moderation: Arc<dyn MessageRepository>,
        server_repository_for_moderation: Arc<dyn ServerRepository>,
        moderation_retry_repository: Arc<dyn ModerationRetryRepository>,
        voice_service: Option<Arc<VoiceService>>,
        voice_session_repository: Option<Arc<dyn VoiceSessionRepository>>,
        official_server_id: Option<ServerId>,
    ) -> Self {
        Self {
            pool,
            jwt_secret,
            es256_key,
            is_production,
            profile_service,
            server_service,
            message_service,
            invite_service,
            channel_service,
            moderation_service,
            dm_service,
            key_service,
            reaction_service,
            read_state_service,
            notification_settings_service,
            user_preferences_service,
            member_repository,
            ban_repository,
            plan_limit_checker,
            event_bus,
            presence_tracker,
            megolm_session_repository,
            desktop_auth_repository,
            spam_guard,
            content_moderator,
            safe_browsing,
            message_repository: message_repository_for_moderation,
            server_repository: server_repository_for_moderation,
            moderation_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_MODERATIONS)),
            moderation_retry_repository,
            voice_service,
            voice_session_repository,
            official_server_id,
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

    /// Access the reaction domain service.
    #[must_use]
    pub fn reaction_service(&self) -> &ReactionService {
        &self.reaction_service
    }

    /// Access the read state domain service.
    #[must_use]
    pub fn read_state_service(&self) -> &ReadStateService {
        &self.read_state_service
    }

    /// Access the notification settings domain service.
    #[must_use]
    pub fn notification_settings_service(&self) -> &NotificationSettingsService {
        &self.notification_settings_service
    }

    /// Access the user preferences domain service.
    #[must_use]
    pub fn user_preferences_service(&self) -> &UserPreferencesService {
        &self.user_preferences_service
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
    pub fn event_bus(&self) -> &dyn EventBus {
        &*self.event_bus
    }

    /// Access the event bus as a cloneable `Arc` (for `tokio::spawn` captures).
    #[must_use]
    pub fn event_bus_arc(&self) -> &Arc<dyn EventBus> {
        &self.event_bus
    }

    /// Access the in-memory presence tracker.
    #[must_use]
    pub fn presence_tracker(&self) -> &PresenceTracker {
        &self.presence_tracker
    }

    /// Access the Megolm session repository (E2EE channel sessions).
    #[must_use]
    pub fn megolm_session_repository(&self) -> &dyn MegolmSessionRepository {
        &*self.megolm_session_repository
    }

    /// Access the desktop auth repository (PKCE exchange codes).
    #[must_use]
    pub fn desktop_auth_repository(&self) -> &dyn DesktopAuthRepository {
        &*self.desktop_auth_repository
    }

    /// Access the in-memory anti-spam guard (duplicate detection, flood muting).
    #[must_use]
    pub fn spam_guard(&self) -> &Arc<SpamGuard> {
        &self.spam_guard
    }

    /// Access the async content moderator (`OpenAI`). None = disabled.
    #[must_use]
    pub fn content_moderator(&self) -> Option<&Arc<dyn ContentModerator>> {
        self.content_moderator.as_ref()
    }

    /// Access the Safe Browsing URL scanner. None = disabled.
    #[must_use]
    pub fn safe_browsing(&self) -> Option<&Arc<SafeBrowsingClient>> {
        self.safe_browsing.as_ref()
    }

    /// Access the message repository for async moderation soft-delete.
    #[must_use]
    pub fn message_repository_for_moderation(&self) -> &Arc<dyn MessageRepository> {
        &self.message_repository
    }

    /// Access the server repository for fetching moderation categories inside `tokio::spawn`.
    #[must_use]
    pub fn server_repository_for_moderation(&self) -> &Arc<dyn ServerRepository> {
        &self.server_repository
    }

    /// Access the semaphore that bounds concurrent async moderation tasks.
    #[must_use]
    pub fn moderation_semaphore(&self) -> &Arc<Semaphore> {
        &self.moderation_semaphore
    }

    /// Access the moderation retry repository (dead-letter queue for failed AI checks).
    #[must_use]
    pub fn moderation_retry_repository(&self) -> &Arc<dyn ModerationRetryRepository> {
        &self.moderation_retry_repository
    }

    /// Access the voice domain service. None = `LiveKit` not configured.
    #[must_use]
    pub fn voice_service(&self) -> Option<&Arc<VoiceService>> {
        self.voice_service.as_ref()
    }

    /// Access the voice session repository for sweep tasks. None = voice disabled.
    #[must_use]
    pub fn voice_session_repository(&self) -> Option<&Arc<dyn VoiceSessionRepository>> {
        self.voice_session_repository.as_ref()
    }

    /// Access the official Harmony server ID. None = not configured (self-hosted).
    #[must_use]
    pub fn official_server_id(&self) -> Option<&ServerId> {
        self.official_server_id.as_ref()
    }

    /// Access the Postgres connection pool.
    ///
    /// WHY: Only exposed for the health check (infra ping). All data access
    /// MUST go through repository ports.
    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}
