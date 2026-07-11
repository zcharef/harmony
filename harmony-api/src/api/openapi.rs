//! `OpenAPI` documentation configuration.
//!
//! This is the single source of truth for the API spec.

use utoipa::OpenApi;

use super::dto::voice::{
    RefreshVoiceTokenRequest, RefreshVoiceTokenResponse, UpdateVoiceStateRequest,
    VoiceHeartbeatRequest, VoiceParticipantResponse, VoiceParticipantsResponse, VoiceTokenResponse,
};
use super::dto::{
    AssignRoleRequest, AttachmentResponse, BanListQuery, BanListResponse, BanResponse,
    BanUserRequest, ChannelListResponse, ChannelReadStateResponse, ChannelResponse,
    ChannelRoleAccessResponse, CheckUsernameQuery, CheckUsernameResponse, ClaimedKeyResponse,
    CreateChannelRequest, CreateDesktopAuthRequest, CreateDesktopAuthResponse, CreateDmRequest,
    CreateInviteRequest, CreateMegolmSessionRequest, CreateServerRequest, DeviceListResponse,
    DeviceResponse, DmLastMessageResponse, DmListItem, DmListQuery, DmListResponse,
    DmRecipientResponse, DmResponse, EditMessageRequest, GifItem, GifListResponse, GifSearchQuery,
    GifTrendingQuery, InvitePreviewResponse, InviteResponse, JoinServerRequest, KeyCountResponse,
    MarkReadRequest, MegolmSessionResponse, MemberListQuery, MemberListResponse, MemberResponse,
    MentionedUserResponse, MessageListQuery, MessageListResponse, MessageResponse,
    NewAttachmentRequest, OneTimeKeyDto, PreKeyBundleResponse, ProfileResponse,
    RedeemDesktopAuthRequest, RedeemDesktopAuthResponse, RegisterDeviceRequest, SendMessageRequest,
    ServerListResponse, ServerResponse, SetChannelRoleAccessRequest, TransferOwnershipRequest,
    UpdateChannelRequest, UpdateProfileRequest, UpdateServerRequest, UploadOneTimeKeysRequest,
};
use super::errors::ProblemDetails;
use super::handlers::{self, ComponentHealth, HealthResponse, LivenessResponse};
use crate::domain::models::{
    AttachmentId, CategoryId, ChannelId, ChannelType, DeviceId, DeviceKeyId, InviteCode,
    MegolmSessionId, MessageId, MessageType, OneTimeKeyId, ServerId, UserId, UserStatus,
    VoiceAction,
};
use crate::domain::models::{ParentMessagePreview, ReactionSummary, Reactor};

/// `OpenAPI` documentation for Harmony API.
#[derive(Debug, OpenApi)]
#[openapi(
    info(
        title = "Harmony API",
        version = "0.1.0",
        description = "REST API for Harmony.\n\n**Rate Limiting:** All endpoints are subject to rate limiting. When the limit is exceeded, the API responds with `429 Too Many Requests` and a `Retry-After` header indicating when the client may retry.",
        license(name = "AGPL-3.0")
    ),
    servers(
        (url = "http://localhost:3000", description = "Local development"),
    ),
    paths(
        // System
        handlers::health_check,
        handlers::liveness_check,
        // Auth
        handlers::profiles::sync_profile,
        handlers::profiles::check_username,
        // Profiles
        handlers::profiles::get_my_profile,
        handlers::profiles::update_my_profile,
        handlers::profiles::get_profile_by_id,
        // Servers
        handlers::servers::create_server,
        handlers::servers::list_servers,
        handlers::servers::get_server,
        handlers::servers::update_server,
        handlers::servers::delete_server,
        // Channels
        handlers::channels::list_channels,
        handlers::channels::create_channel,
        handlers::channels::update_channel,
        handlers::channels::delete_channel,
        handlers::channels::get_channel_role_access,
        handlers::channels::set_channel_role_access,
        handlers::channels::create_megolm_session,
        // Invites
        handlers::invites::create_invite,
        handlers::invites::preview_invite,
        handlers::invites::join_server,
        // Members
        handlers::members::list_members,
        handlers::members::leave_server,
        handlers::members::kick_member,
        handlers::members::assign_role,
        handlers::members::transfer_ownership,
        // Member Migration (owner dashboard)
        handlers::migration::get_migration_progress,
        handlers::migration::list_not_yet_active_cohort,
        // Bans (Moderation)
        handlers::bans::list_bans,
        handlers::bans::ban_member,
        handlers::bans::unban_member,
        // Moderation Settings
        handlers::moderation_settings::get_moderation_settings,
        handlers::moderation_settings::update_moderation_settings,
        // Messages
        handlers::messages::send_message,
        handlers::messages::list_messages,
        handlers::messages::edit_message,
        handlers::messages::delete_message,
        // Reactions
        handlers::reactions::add_reaction,
        handlers::reactions::remove_reaction,
        // GIFs (Klipy proxy)
        handlers::gifs::search_gifs,
        handlers::gifs::trending_gifs,
        // Read States
        handlers::read_states::mark_channel_read,
        handlers::read_states::get_channel_read_state,
        // Notification Settings
        handlers::notification_settings::get_notification_settings,
        handlers::notification_settings::update_notification_settings,
        handlers::notification_settings::list_notification_settings,
        // Typing indicators
        handlers::typing::send_typing,
        // Direct Messages
        handlers::dms::create_dm,
        handlers::dms::list_dms,
        handlers::dms::close_dm,
        // Friends & Blocks
        handlers::friends::list_friends,
        handlers::friends::list_requests,
        handlers::friends::send_request,
        handlers::friends::accept_request,
        handlers::friends::remove_request,
        handlers::friends::unfriend,
        handlers::friends::list_blocks,
        handlers::friends::block_user,
        handlers::friends::unblock_user,
        // E2EE Key Distribution
        handlers::keys::register_device,
        handlers::keys::upload_one_time_keys,
        handlers::keys::get_pre_key_bundle,
        handlers::keys::list_devices,
        handlers::keys::remove_device,
        handlers::keys::get_key_count,
        // User Preferences
        handlers::user_preferences::get_preferences,
        handlers::user_preferences::update_preferences,
        // Presence
        handlers::presence::update_presence,
        // Desktop Auth (PKCE exchange)
        handlers::desktop_auth::create_desktop_auth_code,
        handlers::desktop_auth::redeem_desktop_auth_code,
        // Voice
        handlers::voice::join_voice,
        handlers::voice::leave_voice,
        handlers::voice::list_voice_participants,
        handlers::voice::refresh_voice_token,
        handlers::voice::voice_heartbeat,
        handlers::voice::update_voice_state,
        // Events (SSE)
        handlers::events::sse_events,
    ),
    components(
        schemas(
            // System
            LivenessResponse,
            HealthResponse,
            ComponentHealth,
            ProblemDetails,
            // Domain ID types
            UserId,
            ServerId,
            ChannelId,
            MessageId,
            AttachmentId,
            CategoryId,
            InviteCode,
            DeviceKeyId,
            OneTimeKeyId,
            DeviceId,
            MegolmSessionId,
            // Domain enums
            UserStatus,
            ChannelType,
            MessageType,
            // Profile DTOs
            ProfileResponse,
            CheckUsernameQuery,
            CheckUsernameResponse,
            UpdateProfileRequest,
            // Server DTOs
            CreateServerRequest,
            UpdateServerRequest,
            ServerResponse,
            ServerListResponse,
            // Channel DTOs
            CreateChannelRequest,
            UpdateChannelRequest,
            ChannelResponse,
            SetChannelRoleAccessRequest,
            ChannelRoleAccessResponse,
            ChannelListResponse,
            CreateMegolmSessionRequest,
            MegolmSessionResponse,
            // Invite DTOs
            CreateInviteRequest,
            InviteResponse,
            InvitePreviewResponse,
            JoinServerRequest,
            // Member DTOs
            MemberResponse,
            MemberListResponse,
            MemberListQuery,
            AssignRoleRequest,
            TransferOwnershipRequest,
            // Member Migration DTOs
            super::dto::migration::MigrationProgressResponse,
            super::dto::migration::AliveSnapshotResponse,
            super::dto::migration::AliveThresholds,
            super::dto::migration::FollowThroughResponse,
            super::dto::migration::RecommendedActionResponse,
            super::dto::migration::MemberCohortResponse,
            super::dto::migration::NotYetActiveMemberResponse,
            super::dto::migration::CohortQuery,
            // Ban DTOs
            BanUserRequest,
            BanResponse,
            BanListResponse,
            BanListQuery,
            // Message DTOs
            SendMessageRequest,
            EditMessageRequest,
            MessageResponse,
            MessageListResponse,
            MessageListQuery,
            MentionedUserResponse,
            NewAttachmentRequest,
            AttachmentResponse,
            // Reaction DTOs
            super::handlers::reactions::AddReactionRequest,
            ReactionSummary,
            Reactor,
            ParentMessagePreview,
            // GIF DTOs (Klipy proxy)
            GifItem,
            GifListResponse,
            GifSearchQuery,
            GifTrendingQuery,
            // Notification Settings DTOs
            super::dto::notification_settings::UpdateNotificationSettingsRequest,
            super::dto::notification_settings::NotificationSettingsResponse,
            super::dto::notification_settings::ListNotificationSettingsResponse,
            super::dto::notification_settings::NotificationLevel,
            // Moderation Settings DTOs
            super::dto::moderation_settings::ModerationSettingsResponse,
            super::dto::moderation_settings::UpdateModerationSettingsRequest,
            // Read State DTOs
            MarkReadRequest,
            ChannelReadStateResponse,
            // DM DTOs
            CreateDmRequest,
            DmResponse,
            DmRecipientResponse,
            DmListItem,
            DmLastMessageResponse,
            DmListResponse,
            DmListQuery,
            // Friends & Blocks DTOs
            crate::domain::models::RequestDirection,
            super::dto::friends::FriendUserResponse,
            super::dto::friends::FriendResponse,
            super::dto::friends::FriendListResponse,
            super::dto::friends::FriendRequestResponse,
            super::dto::friends::FriendRequestListResponse,
            super::dto::friends::FriendRequestListQuery,
            super::dto::friends::SendFriendRequestRequest,
            super::dto::friends::FriendRequestState,
            super::dto::friends::FriendRequestResultResponse,
            super::dto::friends::FriendAcceptedResponse,
            super::dto::friends::BlockedUserResponse,
            super::dto::friends::BlockedListResponse,
            // Desktop Auth DTOs
            CreateDesktopAuthRequest,
            CreateDesktopAuthResponse,
            RedeemDesktopAuthRequest,
            RedeemDesktopAuthResponse,
            // User Preferences DTOs
            super::dto::user_preferences::UserPreferencesResponse,
            super::dto::user_preferences::UpdateUserPreferencesRequest,
            // Presence DTOs
            super::handlers::presence::UpdatePresenceRequest,
            // Voice DTOs
            VoiceHeartbeatRequest,
            VoiceTokenResponse,
            RefreshVoiceTokenRequest,
            RefreshVoiceTokenResponse,
            VoiceParticipantResponse,
            VoiceParticipantsResponse,
            VoiceAction,
            UpdateVoiceStateRequest,
            // Key Distribution DTOs
            RegisterDeviceRequest,
            UploadOneTimeKeysRequest,
            OneTimeKeyDto,
            DeviceResponse,
            DeviceListResponse,
            ClaimedKeyResponse,
            PreKeyBundleResponse,
            KeyCountResponse,
        )
    ),
    tags(
        (name = "System", description = "System health and status endpoints"),
        (name = "Auth", description = "Authentication and profile sync"),
        (name = "Profiles", description = "User profile endpoints"),
        (name = "Servers", description = "Server (guild) management"),
        (name = "Channels", description = "Channel management within servers"),
        (name = "Invites", description = "Server invite management"),
        (name = "Members", description = "Server member management"),
        (name = "Moderation", description = "Server moderation (bans, kicks)"),
        (name = "Messages", description = "Messaging within channels"),
        (name = "Reactions", description = "Message reactions"),
        (name = "Gifs", description = "GIF picker (Klipy proxy)"),
        (name = "ReadStates", description = "Channel read state tracking"),
        (name = "NotificationSettings", description = "Per-channel notification preferences"),
        (name = "DirectMessages", description = "Direct message conversations"),
        (name = "Friends", description = "Friendships, friend requests, and blocks"),
        (name = "Keys", description = "E2EE key distribution (device keys, pre-key bundles)"),
        (name = "UserPreferences", description = "User preferences (DND mode, settings)"),
        (name = "Presence", description = "User presence status updates"),
        (name = "Voice", description = "Voice channel management (LiveKit)"),
        (name = "Events", description = "Server-Sent Events for real-time updates"),
    ),
    modifiers(&SecurityAddon)
)]
pub struct ApiDoc;

/// Adds security schemes to `OpenAPI` documentation.
#[derive(Debug)]
struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};

            components.add_security_scheme(
                "bearer_auth",
                SecurityScheme::Http(
                    HttpBuilder::new()
                        .scheme(HttpAuthScheme::Bearer)
                        .bearer_format("JWT")
                        .description(Some("Supabase JWT (mobile/API clients)"))
                        .build(),
                ),
            );
        }
    }
}
