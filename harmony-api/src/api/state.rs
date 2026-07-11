//! Application state shared across handlers.

use std::sync::Arc;

use jsonwebtoken::DecodingKey;
use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::domain::models::ServerId;
use crate::domain::ports::{
    AnalyticsRecorder, AttachmentRepository, AttachmentScanRetryRepository, BanRepository,
    ChannelRepository, ContentModerator, CsamMatcher, DesktopAuthRepository,
    EmojiImageScanRetryRepository, EventBus, IdentityImageScanRetryRepository, ImageClassifier,
    MegolmSessionRepository, MemberRepository, MessageRepository, ModerationLogRepository,
    ModerationRetryRepository, PlanLimitChecker, ServerRepository, StorageObjectRemover,
    VoiceSessionRepository,
};
use crate::domain::services::{
    ChannelService, DmService, FriendshipService, InviteService, KeyService, MessageService,
    MigrationService, ModerationService, NotificationSettingsService, ProfileService,
    ReactionService, ReadStateService, ServerEmojiService, ServerService, SpamGuard,
    UserPreferencesService, VoiceService,
};
use crate::infra::PgPresenceTracker;
use crate::infra::klipy::KlipyClient;
use crate::infra::noop_storage_object_remover::NoopStorageObjectRemover;
use crate::infra::postgres::{
    PgEmojiImageScanRetryRepository, PgIdentityImageScanRetryRepository,
    PgMigrationDashboardRepository, PgModerationLogRepository,
};
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
    /// Friendship domain service (friend requests, unfriend, blocks).
    friendship_service: Arc<FriendshipService>,
    /// Custom server-emoji domain service (create/list/delete).
    server_emoji_service: Arc<ServerEmojiService>,
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
    /// Member-migration command-center service (owner dashboard, §14.1).
    migration_service: Arc<MigrationService>,
    /// Member repository (accessed directly for simple queries; invite logic lives in `InviteService`).
    member_repository: Arc<dyn MemberRepository>,
    /// Channel repository (accessed directly by handlers that call the shared
    /// `ensure_channel_access` gate, e.g. Megolm session registration).
    channel_repository: Arc<dyn ChannelRepository>,
    /// Ban repository (accessed directly by moderation handlers).
    ban_repository: Arc<dyn BanRepository>,
    /// Plan limit checker (self-hosted: always allowed, hosted: Postgres-backed).
    plan_limit_checker: Arc<dyn PlanLimitChecker>,
    /// In-process event bus for SSE real-time delivery.
    event_bus: Arc<dyn EventBus>,
    /// PG-backed presence tracker (online/idle/dnd per user).
    presence_tracker: Arc<PgPresenceTracker>,
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
    /// Klipy GIF proxy client. None = `KLIPY_API_KEY` unset (feature disabled).
    klipy: Option<Arc<KlipyClient>>,
    /// Message repository for async moderation soft-delete.
    message_repository: Arc<dyn MessageRepository>,
    /// Server repository for fetching moderation categories inside `tokio::spawn`.
    server_repository: Arc<dyn ServerRepository>,
    /// Bounds concurrent async moderation tasks to avoid overwhelming external APIs.
    moderation_semaphore: Arc<Semaphore>,
    /// Dead-letter queue for failed AI moderation checks (Tier 1 safety).
    moderation_retry_repository: Arc<dyn ModerationRetryRepository>,
    /// Audit-log writer used by the async automod delete path (§3.2). The
    /// moderation service holds its own handle for member/message actions.
    moderation_log_repository: Arc<dyn ModerationLogRepository>,
    /// Adult-NSFW image classifier (Phase 1: Noop). Never `None` — the Noop is
    /// always wired so the scan pipeline runs uniformly.
    image_classifier: Arc<dyn ImageClassifier>,
    /// CSAM hash matcher (Phase 1: Noop). Never `None`.
    csam_matcher: Arc<dyn CsamMatcher>,
    /// Attachment repository — the async scan task's moderation-status writer.
    attachment_repository: Arc<dyn AttachmentRepository>,
    /// Dead-letter queue for failed image scans (fail-closed retry).
    attachment_scan_retry_repository: Arc<dyn AttachmentScanRetryRepository>,
    /// Dead-letter queue for failed identity-image (avatar/banner) scans.
    identity_image_scan_retry_repository: Arc<dyn IdentityImageScanRetryRepository>,
    /// Dead-letter queue for failed custom-emoji image scans.
    emoji_image_scan_retry_repository: Arc<dyn EmojiImageScanRetryRepository>,
    /// Deletes a flagged identity-image object from its bucket on rejection
    /// (best-effort; Noop until a service-role adapter lands).
    storage_object_remover: Arc<dyn StorageObjectRemover>,
    /// Refuse image attachments when no real CSAM matcher is configured
    /// (fail-closed hard gate). Default false while invite-only.
    attachments_require_csam_scan: bool,
    /// Voice domain service. None = `LiveKit` not configured.
    voice_service: Option<Arc<VoiceService>>,
    /// Voice session repository for sweep background task. None = voice disabled.
    voice_session_repository: Option<Arc<dyn VoiceSessionRepository>>,
    /// Official Harmony server ID. When set, `sync_profile` auto-joins new users.
    official_server_id: Option<ServerId>,
    /// Append-only analytics event recorder (growth-plan §10 funnel).
    analytics_recorder: Arc<dyn AnalyticsRecorder>,
    /// Normalized Supabase origin (`scheme://host[:port]`) that attachment
    /// URLs must live on. Derived from `SUPABASE_URL` at startup. `None` =
    /// unconfigured → attachment validation FAILS CLOSED (rejects all).
    attachment_url_origin: Option<String>,
    /// Shared secret authenticating trusted proxies that forward the original
    /// client IP for unauth rate limiting (see `api::client_ip`). None =
    /// forwarded IPs are never trusted.
    trusted_proxy_secret: Option<secrecy::SecretString>,
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
            .field("friendship_service", &self.friendship_service)
            .field("server_emoji_service", &self.server_emoji_service)
            .field("key_service", &self.key_service)
            .field("reaction_service", &self.reaction_service)
            .field("read_state_service", &self.read_state_service)
            .field(
                "notification_settings_service",
                &self.notification_settings_service,
            )
            .field("user_preferences_service", &self.user_preferences_service)
            .field("migration_service", &self.migration_service)
            .field("member_repository", &self.member_repository)
            .field("channel_repository", &self.channel_repository)
            .field("ban_repository", &self.ban_repository)
            .field("plan_limit_checker", &self.plan_limit_checker)
            .field("event_bus", &self.event_bus)
            .field("presence_tracker", &self.presence_tracker)
            .field("megolm_session_repository", &self.megolm_session_repository)
            .field("desktop_auth_repository", &self.desktop_auth_repository)
            .field("spam_guard", &self.spam_guard)
            .field("content_moderator", &self.content_moderator.is_some())
            .field("safe_browsing", &self.safe_browsing.is_some())
            .field("klipy", &self.klipy.is_some())
            .field("server_repository", &self.server_repository)
            .field("moderation_semaphore", &self.moderation_semaphore)
            .field(
                "moderation_retry_repository",
                &self.moderation_retry_repository,
            )
            .field("moderation_log_repository", &self.moderation_log_repository)
            .field("image_classifier", &self.image_classifier)
            .field("csam_matcher", &self.csam_matcher)
            .field("attachment_repository", &self.attachment_repository)
            .field(
                "attachment_scan_retry_repository",
                &self.attachment_scan_retry_repository,
            )
            .field(
                "identity_image_scan_retry_repository",
                &self.identity_image_scan_retry_repository,
            )
            .field(
                "emoji_image_scan_retry_repository",
                &self.emoji_image_scan_retry_repository,
            )
            .field("storage_object_remover", &self.storage_object_remover)
            .field(
                "attachments_require_csam_scan",
                &self.attachments_require_csam_scan,
            )
            .field("voice_service", &self.voice_service.is_some())
            .field(
                "voice_session_repository",
                &self.voice_session_repository.is_some(),
            )
            .field("official_server_id", &self.official_server_id)
            .field("analytics_recorder", &self.analytics_recorder)
            .field("attachment_url_origin", &self.attachment_url_origin)
            .field(
                "trusted_proxy_secret",
                &self.trusted_proxy_secret.as_ref().map(|_| "[REDACTED]"),
            )
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
        friendship_service: Arc<FriendshipService>,
        key_service: Arc<KeyService>,
        reaction_service: Arc<ReactionService>,
        read_state_service: Arc<ReadStateService>,
        notification_settings_service: Arc<NotificationSettingsService>,
        user_preferences_service: Arc<UserPreferencesService>,
        member_repository: Arc<dyn MemberRepository>,
        channel_repository: Arc<dyn ChannelRepository>,
        ban_repository: Arc<dyn BanRepository>,
        plan_limit_checker: Arc<dyn PlanLimitChecker>,
        event_bus: Arc<dyn EventBus>,
        presence_tracker: Arc<PgPresenceTracker>,
        megolm_session_repository: Arc<dyn MegolmSessionRepository>,
        desktop_auth_repository: Arc<dyn DesktopAuthRepository>,
        spam_guard: Arc<SpamGuard>,
        content_moderator: Option<Arc<dyn ContentModerator>>,
        safe_browsing: Option<Arc<SafeBrowsingClient>>,
        klipy: Option<Arc<KlipyClient>>,
        message_repository_for_moderation: Arc<dyn MessageRepository>,
        server_repository_for_moderation: Arc<dyn ServerRepository>,
        moderation_retry_repository: Arc<dyn ModerationRetryRepository>,
        image_classifier: Arc<dyn ImageClassifier>,
        csam_matcher: Arc<dyn CsamMatcher>,
        attachment_repository: Arc<dyn AttachmentRepository>,
        attachment_scan_retry_repository: Arc<dyn AttachmentScanRetryRepository>,
        attachments_require_csam_scan: bool,
        voice_service: Option<Arc<VoiceService>>,
        voice_session_repository: Option<Arc<dyn VoiceSessionRepository>>,
        official_server_id: Option<ServerId>,
        analytics_recorder: Arc<dyn AnalyticsRecorder>,
        attachment_url_origin: Option<String>,
        trusted_proxy_secret: Option<secrecy::SecretString>,
    ) -> Self {
        // WHY constructed here (not a positional param): the owner-migration
        // dashboard needs only the server repository (ownership check) and a
        // read-only analytics reader over the same pool — wiring it internally
        // keeps the already-large constructor signature stable.
        let migration_service = Arc::new(MigrationService::new(
            server_repository_for_moderation.clone(),
            Arc::new(PgMigrationDashboardRepository::new(pool.clone())),
        ));

        // WHY constructed here (not a positional param): the emoji service needs
        // only a Postgres repo over the same pool, the shared plan checker, and
        // the already-derived storage origin — wiring it internally keeps the
        // large constructor signature (and its many test call sites) stable.
        let server_emoji_service = Arc::new(ServerEmojiService::new(
            Arc::new(crate::infra::postgres::PgServerEmojiRepository::new(
                pool.clone(),
            )),
            plan_limit_checker.clone(),
            attachment_url_origin.clone(),
            // Reuse the server service's config-driven filter so emoji names are
            // moderated by the same policy as server/channel/profile names.
            server_service.content_filter().clone(),
        ));

        // WHY constructed here (not a positional param): only the async automod
        // delete path needs a bare handle — a Postgres repo over the same pool.
        // Keeps the already-large constructor signature (and its test call
        // sites) stable, mirroring migration_service/server_emoji_service.
        let moderation_log_repository: Arc<dyn ModerationLogRepository> =
            Arc::new(PgModerationLogRepository::new(pool.clone()));

        // WHY constructed here (not a positional param): the identity-image scan
        // dead-letter queue needs only a Postgres repo over the same pool, and
        // deletion of flagged objects is a best-effort Noop until a service-role
        // Storage adapter lands. Keeps the large constructor signature (and its
        // test call sites) stable, mirroring server_emoji_service above.
        let identity_image_scan_retry_repository: Arc<dyn IdentityImageScanRetryRepository> =
            Arc::new(PgIdentityImageScanRetryRepository::new(pool.clone()));
        let emoji_image_scan_retry_repository: Arc<dyn EmojiImageScanRetryRepository> =
            Arc::new(PgEmojiImageScanRetryRepository::new(pool.clone()));
        let storage_object_remover: Arc<dyn StorageObjectRemover> =
            Arc::new(NoopStorageObjectRemover);

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
            friendship_service,
            server_emoji_service,
            key_service,
            reaction_service,
            read_state_service,
            notification_settings_service,
            user_preferences_service,
            migration_service,
            member_repository,
            channel_repository,
            ban_repository,
            plan_limit_checker,
            event_bus,
            presence_tracker,
            megolm_session_repository,
            desktop_auth_repository,
            spam_guard,
            content_moderator,
            safe_browsing,
            klipy,
            message_repository: message_repository_for_moderation,
            server_repository: server_repository_for_moderation,
            moderation_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_MODERATIONS)),
            moderation_retry_repository,
            moderation_log_repository,
            image_classifier,
            csam_matcher,
            attachment_repository,
            attachment_scan_retry_repository,
            identity_image_scan_retry_repository,
            emoji_image_scan_retry_repository,
            storage_object_remover,
            attachments_require_csam_scan,
            voice_service,
            voice_session_repository,
            official_server_id,
            analytics_recorder,
            attachment_url_origin,
            trusted_proxy_secret,
        }
    }

    /// Normalized Supabase origin attachment URLs are pinned to.
    /// `None` = unconfigured — `NewAttachment::try_new` then fails closed.
    #[must_use]
    pub fn attachment_url_origin(&self) -> Option<&str> {
        self.attachment_url_origin.as_deref()
    }

    /// Access the profile domain service.
    #[must_use]
    pub fn profile_service(&self) -> &ProfileService {
        &self.profile_service
    }

    /// Cloneable handle to the profile service (for `tokio::spawn` scan tasks).
    #[must_use]
    pub fn profile_service_arc(&self) -> &Arc<ProfileService> {
        &self.profile_service
    }

    /// Cloneable handle to the server service (for `tokio::spawn` scan tasks).
    #[must_use]
    pub fn server_service_arc(&self) -> &Arc<ServerService> {
        &self.server_service
    }

    /// Cloneable handle to the emoji service (for `tokio::spawn` scan tasks).
    #[must_use]
    pub fn server_emoji_service_arc(&self) -> &Arc<ServerEmojiService> {
        &self.server_emoji_service
    }

    /// Identity-image scan dead-letter queue (fail-closed retry).
    #[must_use]
    pub fn identity_image_scan_retry_repository(
        &self,
    ) -> &Arc<dyn IdentityImageScanRetryRepository> {
        &self.identity_image_scan_retry_repository
    }

    /// Emoji-image scan dead-letter queue (fail-closed retry).
    #[must_use]
    pub fn emoji_image_scan_retry_repository(&self) -> &Arc<dyn EmojiImageScanRetryRepository> {
        &self.emoji_image_scan_retry_repository
    }

    /// Best-effort remover of flagged identity-image objects.
    #[must_use]
    pub fn storage_object_remover(&self) -> &Arc<dyn StorageObjectRemover> {
        &self.storage_object_remover
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

    /// Access the friendship domain service.
    #[must_use]
    pub fn friendship_service(&self) -> &FriendshipService {
        &self.friendship_service
    }

    /// Access the custom server-emoji domain service.
    #[must_use]
    pub fn server_emoji_service(&self) -> &ServerEmojiService {
        &self.server_emoji_service
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

    /// Access the member-migration command-center service (owner dashboard).
    #[must_use]
    pub fn migration_service(&self) -> &MigrationService {
        &self.migration_service
    }

    /// Access the member repository directly (simple queries; invite logic in `InviteService`).
    #[must_use]
    pub fn member_repository(&self) -> &dyn MemberRepository {
        &*self.member_repository
    }

    /// Access the channel repository directly (handlers calling the shared
    /// `ensure_channel_access` gate).
    #[must_use]
    pub fn channel_repository(&self) -> &dyn ChannelRepository {
        &*self.channel_repository
    }

    /// Access the channel repository as a cloneable `Arc` (for `tokio::spawn`
    /// captures, e.g. resolving channel-access scope in async moderation).
    #[must_use]
    pub fn channel_repository_arc(&self) -> &Arc<dyn ChannelRepository> {
        &self.channel_repository
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

    /// Access the PG-backed presence tracker.
    #[must_use]
    pub fn presence_tracker(&self) -> &PgPresenceTracker {
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

    /// Access the Klipy GIF proxy client. None = feature disabled (no key).
    #[must_use]
    pub fn klipy(&self) -> Option<&Arc<KlipyClient>> {
        self.klipy.as_ref()
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

    /// Access the moderation audit-log repository (async automod delete path).
    #[must_use]
    pub fn moderation_log_repository(&self) -> &Arc<dyn ModerationLogRepository> {
        &self.moderation_log_repository
    }

    /// Access the adult-NSFW image classifier (Phase 1: Noop).
    #[must_use]
    pub fn image_classifier(&self) -> &Arc<dyn ImageClassifier> {
        &self.image_classifier
    }

    /// Access the CSAM hash matcher (Phase 1: Noop).
    #[must_use]
    pub fn csam_matcher(&self) -> &Arc<dyn CsamMatcher> {
        &self.csam_matcher
    }

    /// Access the attachment repository (moderation-status writer + reads).
    #[must_use]
    pub fn attachment_repository(&self) -> &Arc<dyn AttachmentRepository> {
        &self.attachment_repository
    }

    /// Access the image-scan dead-letter queue.
    #[must_use]
    pub fn attachment_scan_retry_repository(&self) -> &Arc<dyn AttachmentScanRetryRepository> {
        &self.attachment_scan_retry_repository
    }

    /// Whether image attachments must be refused when no real CSAM matcher is
    /// configured (fail-closed hard gate). Default false while invite-only.
    #[must_use]
    pub fn attachments_require_csam_scan(&self) -> bool {
        self.attachments_require_csam_scan
    }

    /// Access the message domain service as a cloneable `Arc` (for `tokio::spawn`
    /// captures in the async attachment-moderation task).
    #[must_use]
    pub fn message_service_arc(&self) -> &Arc<MessageService> {
        &self.message_service
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

    /// Access the analytics recorder as a cloneable `Arc` (for `tokio::spawn`
    /// captures in the fire-and-forget `track` helper).
    #[must_use]
    pub fn analytics_recorder(&self) -> &Arc<dyn AnalyticsRecorder> {
        &self.analytics_recorder
    }

    /// Access the trusted proxy shared secret. None = forwarded client IPs
    /// are never trusted (see `api::client_ip`).
    #[must_use]
    pub fn trusted_proxy_secret(&self) -> Option<&secrecy::SecretString> {
        self.trusted_proxy_secret.as_ref()
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
