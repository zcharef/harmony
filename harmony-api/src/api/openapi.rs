//! `OpenAPI` documentation configuration.
//!
//! This is the single source of truth for the API spec.

use utoipa::OpenApi;

use super::dto::{
    ChannelListResponse, ChannelResponse, CreateChannelRequest, CreateInviteRequest,
    CreateServerRequest, EditMessageRequest, InvitePreviewResponse, InviteResponse,
    JoinServerRequest, MemberListResponse, MemberResponse, MessageListQuery, MessageListResponse,
    MessageResponse, ProfileResponse, SendMessageRequest, ServerListResponse, ServerResponse,
    UpdateChannelRequest,
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
        // Messages
        handlers::messages::send_message,
        handlers::messages::list_messages,
        handlers::messages::edit_message,
        handlers::messages::delete_message,
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
            // Message DTOs
            SendMessageRequest,
            EditMessageRequest,
            MessageResponse,
            MessageListResponse,
            MessageListQuery,
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
        (name = "Messages", description = "Messaging within channels"),
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
