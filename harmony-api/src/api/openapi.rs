//! `OpenAPI` documentation configuration.
//!
//! This is the single source of truth for the API spec.

use utoipa::OpenApi;

use super::dto::{
    AssignRoleRequest, BanListResponse, BanResponse, BanUserRequest, ChannelListResponse,
    ChannelResponse, CreateChannelRequest, CreateDmRequest, CreateInviteRequest,
    CreateServerRequest, DmLastMessageResponse, DmListItem, DmListQuery, DmListResponse,
    DmRecipientResponse, DmResponse, EditMessageRequest, InvitePreviewResponse, InviteResponse,
    JoinServerRequest, MemberListResponse, MemberResponse, MessageListQuery, MessageListResponse,
    MessageResponse, ProfileResponse, SendMessageRequest, ServerListResponse, ServerResponse,
    TransferOwnershipRequest, UpdateChannelRequest,
};
use super::errors::ProblemDetails;
use super::handlers::{self, ComponentHealth, HealthResponse};
use crate::domain::models::{
    CategoryId, ChannelId, ChannelType, InviteCode, MessageId, ServerId, UserId, UserStatus,
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
        // Auth
        handlers::profiles::sync_profile,
        // Profiles
        handlers::profiles::get_my_profile,
        // Servers
        handlers::servers::create_server,
        handlers::servers::list_servers,
        handlers::servers::get_server,
        // Channels
        handlers::channels::list_channels,
        handlers::channels::create_channel,
        handlers::channels::update_channel,
        handlers::channels::delete_channel,
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
    ),
    components(
        schemas(
            // System
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
            // Domain enums
            UserStatus,
            ChannelType,
            // Profile DTOs
            ProfileResponse,
            // Server DTOs
            CreateServerRequest,
            ServerResponse,
            ServerListResponse,
            // Channel DTOs
            CreateChannelRequest,
            UpdateChannelRequest,
            ChannelResponse,
            ChannelListResponse,
            // Invite DTOs
            CreateInviteRequest,
            InviteResponse,
            InvitePreviewResponse,
            JoinServerRequest,
            // Member DTOs
            MemberResponse,
            MemberListResponse,
            AssignRoleRequest,
            TransferOwnershipRequest,
            // Ban DTOs
            BanUserRequest,
            BanResponse,
            BanListResponse,
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
