//! DM (Direct Message) DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{ChannelId, ServerId, UserId};
use crate::domain::services::dm_service::DmConversation;

/// Request body for creating a new DM conversation.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateDmRequest {
    /// The user ID of the recipient.
    pub recipient_id: UserId,
}

/// Recipient profile embedded in DM responses.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmRecipientResponse {
    pub id: UserId,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

/// Response for a single DM conversation (create or get).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmResponse {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub recipient: DmRecipientResponse,
}

impl From<DmConversation> for DmResponse {
    fn from(dm: DmConversation) -> Self {
        Self {
            server_id: dm.server_id,
            channel_id: dm.channel_id,
            recipient: DmRecipientResponse {
                id: dm.recipient_id,
                username: dm.recipient_username,
                display_name: dm.recipient_display_name,
                avatar_url: dm.recipient_avatar_url,
            },
        }
    }
}

/// Last message preview embedded in DM list items.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmLastMessageResponse {
    pub content: String,
    pub created_at: DateTime<Utc>,
    /// Whether this message contains E2EE ciphertext.
    pub encrypted: bool,
}

/// A single DM conversation in the list response.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmListItem {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub recipient: DmRecipientResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<DmLastMessageResponse>,
}

impl From<DmConversation> for DmListItem {
    fn from(dm: DmConversation) -> Self {
        let last_message = match (dm.last_message_content, dm.last_message_at) {
            (Some(content), Some(created_at)) => Some(DmLastMessageResponse {
                content,
                created_at,
                encrypted: dm.last_message_encrypted.unwrap_or(false),
            }),
            _ => None,
        };

        Self {
            server_id: dm.server_id,
            channel_id: dm.channel_id,
            recipient: DmRecipientResponse {
                id: dm.recipient_id,
                username: dm.recipient_username,
                display_name: dm.recipient_display_name,
                avatar_url: dm.recipient_avatar_url,
            },
            last_message,
        }
    }
}

/// Envelope for a list of DM conversations with cursor pagination (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmListResponse {
    pub items: Vec<DmListItem>,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl DmListResponse {
    /// Build from domain conversations with an optional cursor for the next page.
    #[must_use]
    pub fn from_conversations(
        conversations: Vec<DmConversation>,
        next_cursor: Option<String>,
    ) -> Self {
        Self {
            items: conversations.into_iter().map(DmListItem::from).collect(),
            next_cursor,
        }
    }
}

/// Query parameters for listing DMs (cursor-based pagination).
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct DmListQuery {
    /// ISO 8601 timestamp cursor -- fetch DMs with last activity before this time.
    pub before: Option<String>,
    /// Maximum number of DMs to return (1-100, default 50).
    pub limit: Option<i64>,
}
