//! Reaction summary view model.
//!
//! Aggregated reaction data for display alongside messages.
//! Each summary represents one emoji on one message, with a count
//! and whether the requesting user participated.

use serde::Serialize;
use utoipa::ToSchema;

/// A single person who reacted, resolved to display data.
///
/// The client renders `display_name` when present, otherwise `username`
/// (mirrors the message-author label resolution). The raw user id is never
/// exposed — a reactor is identified by username on the wire (SSE removal
/// matches by username too). Bounded list — see [`ReactionSummary::reactors`].
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reactor {
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Aggregated reaction summary for a single emoji on a message.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionSummary {
    pub emoji: String,
    /// TOTAL number of people who reacted with this emoji (unbounded).
    pub count: i64,
    pub reacted_by_me: bool,
    /// First up-to-10 reactors, ordered by `created_at ASC`. `count` is
    /// authoritative for the total; `reactors.len()` may be smaller. When
    /// `count > reactors.len()` the client renders "+N others".
    pub reactors: Vec<Reactor>,
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn reactor_serializes_display_name_camelcase() {
        let reactor = Reactor {
            username: "alice".to_string(),
            display_name: Some("Alice A".to_string()),
        };
        let json = serde_json::to_value(&reactor).unwrap();
        assert_eq!(json["username"], "alice");
        assert_eq!(json["displayName"], "Alice A");
    }

    #[test]
    fn reactor_omits_absent_display_name() {
        let reactor = Reactor {
            username: "bob".to_string(),
            display_name: None,
        };
        let json = serde_json::to_value(&reactor).unwrap();
        assert_eq!(json["username"], "bob");
        assert!(json.get("displayName").is_none());
    }

    #[test]
    fn reaction_summary_serializes_reactors_camelcase() {
        let summary = ReactionSummary {
            emoji: "👍".to_string(),
            count: 3,
            reacted_by_me: true,
            reactors: vec![Reactor {
                username: "carol".to_string(),
                display_name: None,
            }],
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["emoji"], "👍");
        assert_eq!(json["count"], 3);
        assert_eq!(json["reactedByMe"], true);
        assert_eq!(json["reactors"][0]["username"], "carol");
    }
}
