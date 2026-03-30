//! Read state DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{ChannelId, ChannelReadState, MessageId};

/// Request body for marking a channel as read.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkReadRequest {
    /// ID of the last message the user has read.
    pub last_message_id: MessageId,
}

/// Read state for a single channel.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadStateResponse {
    pub channel_id: ChannelId,
    pub unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_read_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_id: Option<MessageId>,
}

impl From<ChannelReadState> for ReadStateResponse {
    fn from(state: ChannelReadState) -> Self {
        Self {
            channel_id: state.channel_id,
            unread_count: state.unread_count,
            last_read_at: state.last_read_at,
            last_message_id: state.last_message_id,
        }
    }
}

/// Envelope for a list of read states.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadStatesListResponse {
    pub items: Vec<ReadStateResponse>,
}

impl ReadStatesListResponse {
    #[must_use]
    pub fn from_states(states: Vec<ChannelReadState>) -> Self {
        Self {
            items: states.into_iter().map(ReadStateResponse::from).collect(),
        }
    }
}
