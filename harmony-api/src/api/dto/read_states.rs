//! Read state DTOs (request/response types).

use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::models::MessageId;

/// Request body for marking a channel as read.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkReadRequest {
    /// ID of the last message the user has read.
    pub last_message_id: MessageId,
}
