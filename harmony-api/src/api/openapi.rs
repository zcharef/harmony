//! `OpenAPI` documentation configuration.
//!
//! This is the single source of truth for the API spec.

use utoipa::OpenApi;

use super::dto::{
    AssignRoleRequest, BanListQuery, BanListResponse, BanResponse, BanUserRequest,
    ChannelListResponse, ChannelResponse, CheckUsernameQuery, CheckUsernameResponse,
    ClaimedKeyResponse, CreateChannelRequest, CreateDmRequest, CreateInviteRequest,
    CreateMegolmSessionRequest, CreateServerRequest, DeviceListResponse, DeviceResponse,
    DmLastMessageResponse, DmListItem, DmListQuery, DmListResponse, DmRecipientResponse,
    DmResponse, EditMessageRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest,
    KeyCountResponse, MegolmSessionResponse, MemberListQuery, MemberListResponse, MemberResponse,
    MessageListQuery, MessageListResponse, MessageResponse, OneTimeKeyDto, PreKeyBundleResponse,
    ProfileResponse, RegisterDeviceRequest, SendMessageRequest, ServerListResponse, ServerResponse,
    TransferOwnershipRequest, UpdateChannelRequest, UpdateServerRequest, UploadOneTimeKeysRequest,
};
use super::errors::ProblemDetails;
use super::handlers::{self, ComponentHealth, HealthResponse, LivenessResponse};
use crate::domain::models::{
    CategoryId, ChannelId, ChannelType, DeviceId, DeviceKeyId, InviteCode, MessageId, MessageType,
    OneTimeKeyId, ServerId, UserId, UserStatus,
};

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
        // Servers
        handlers::servers::create_server,
        handlers::servers::list_servers,
        handlers::servers::get_server,
        handlers::servers::update_server,
        // Channels
        handlers::channels::list_channels,
        handlers::channels::create_channel,
        handlers::channels::update_channel,
        handlers::channels::delete_channel,
        handlers::channels::create_megolm_session,
        // Invites
        handlers::invites::create_invite,
        handlers::invites::preview_invite,
        handlers::invites::join_server,
        // Members
        handlers::members::list_members,
        handlers::members::kick_member,
        handlers::members::assign_role,
        handlers::members::transfer_ownership,
        // Bans (Moderation)
        handlers::bans::list_bans,
        handlers::bans::ban_member,
        handlers::bans::unban_member,
        // Messages
        handlers::messages::send_message,
        handlers::messages::list_messages,
        handlers::messages::edit_message,
        handlers::messages::delete_message,
        // Direct Messages
        handlers::dms::create_dm,
        handlers::dms::list_dms,
        handlers::dms::close_dm,
        // E2EE Key Distribution
        handlers::keys::register_device,
        handlers::keys::upload_one_time_keys,
        handlers::keys::get_pre_key_bundle,
        handlers::keys::list_devices,
        handlers::keys::remove_device,
        handlers::keys::get_key_count,
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
            CategoryId,
            InviteCode,
            DeviceKeyId,
            OneTimeKeyId,
            DeviceId,
            // Domain enums
            UserStatus,
            ChannelType,
            MessageType,
            // Profile DTOs
            ProfileResponse,
            CheckUsernameQuery,
            CheckUsernameResponse,
            // Server DTOs
            CreateServerRequest,
            UpdateServerRequest,
            ServerResponse,
            ServerListResponse,
            // Channel DTOs
            CreateChannelRequest,
            UpdateChannelRequest,
            ChannelResponse,
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
            // DM DTOs
            CreateDmRequest,
            DmResponse,
            DmRecipientResponse,
            DmListItem,
            DmLastMessageResponse,
            DmListResponse,
            DmListQuery,
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
        (name = "DirectMessages", description = "Direct message conversations"),
        (name = "Keys", description = "E2EE key distribution (device keys, pre-key bundles)"),
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
