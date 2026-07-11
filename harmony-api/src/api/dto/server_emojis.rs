//! DTOs for custom server emoji.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{EmojiId, ServerEmoji, ServerId, UserId};

/// A single custom emoji.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmojiResponse {
    pub id: EmojiId,
    pub server_id: ServerId,
    /// The name WITHOUT colons; the client wraps it in `:name:` for the token.
    pub name: String,
    pub url: String,
    pub is_animated: bool,
    pub created_by: UserId,
    pub created_at: DateTime<Utc>,
}

impl From<ServerEmoji> for EmojiResponse {
    fn from(e: ServerEmoji) -> Self {
        Self {
            id: e.id,
            server_id: e.server_id,
            name: e.name,
            url: e.url,
            is_animated: e.is_animated,
            created_by: e.created_by,
            created_at: e.created_at,
        }
    }
}

/// Collection envelope for the server's emoji set (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EmojiListResponse {
    pub items: Vec<EmojiResponse>,
    pub total: i64,
}

impl From<Vec<ServerEmoji>> for EmojiListResponse {
    fn from(emojis: Vec<ServerEmoji>) -> Self {
        let total = i64::try_from(emojis.len()).unwrap_or(i64::MAX);
        Self {
            items: emojis.into_iter().map(EmojiResponse::from).collect(),
            total,
        }
    }
}

/// Request body to register a custom emoji (bytes already uploaded to Storage).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEmojiRequest {
    /// 2–32 chars, lowercased + validated server-side to `^[a-z0-9_]{2,32}$`.
    pub name: String,
    /// Public URL from the `server-emojis` bucket (client uploaded direct).
    /// The server validates the host/prefix; it never fetches the bytes.
    pub url: String,
    pub is_animated: bool,
}
