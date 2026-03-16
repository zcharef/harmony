//! `OpenAPI` documentation configuration.
//!
//! This is the single source of truth for the API spec.

use utoipa::OpenApi;

use super::dto::{
    ChannelListResponse, ChannelResponse, CreateServerRequest, MessageListQuery,
    MessageListResponse, MessageResponse, ProfileResponse, SendMessageRequest, ServerListResponse,
    ServerResponse,
};
use super::errors::ProblemDetails;
use super::handlers::{self, ComponentHealth, HealthResponse};
use crate::domain::models::{
    CategoryId, ChannelId, ChannelType, MessageId, ServerId, UserId, UserStatus,
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
        // Messages
        handlers::messages::send_message,
        handlers::messages::list_messages,
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
            ChannelResponse,
            ChannelListResponse,
            // Message DTOs
            SendMessageRequest,
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
