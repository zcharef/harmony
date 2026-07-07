//! Reaction summary view model.
//!
//! Aggregated reaction data for display alongside messages.
//! Each summary represents one emoji on one message, with a count
//! and whether the requesting user participated.

use serde::Serialize;
use utoipa::ToSchema;

/// Aggregated reaction summary for a single emoji on a message.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionSummary {
    pub emoji: String,
    pub count: i64,
    pub reacted_by_me: bool,
}

/// Snapshot of emoji variety on a message, used to enforce the per-message
/// distinct-emoji cap.
///
/// Not serialized — internal read model, never exposed through the API.
#[derive(Debug, Clone, Copy)]
pub struct EmojiVariety {
    /// Number of DISTINCT emoji currently reacted on the message.
    pub distinct_count: i64,
    /// Whether the candidate emoji is already among them.
    pub emoji_present: bool,
}
