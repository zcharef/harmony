//! User-filed message report domain model (T3.3).
//!
//! Members flag a message; moderators triage the queue. The reason taxonomy
//! lives in Rust (not the DB) so a new reason needs no migration — the DB
//! column is validated free-text, mirroring the ban `reason` choice.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::{ChannelId, ReportId, ServerId, UserId};

/// Maximum length for the free-text report detail / stored reason (matches the
/// DB CHECK and the ban-reason cap).
pub const MAX_REPORT_REASON_LENGTH: usize = 512;

/// Report reason taxonomy. Serialized `snake_case` for the API DTO; the chosen
/// value (or the free-text detail when [`ReportReason::Other`]) is what gets
/// persisted to the `reason` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReportReason {
    Spam,
    Harassment,
    Nsfw,
    Violence,
    Other,
}

impl ReportReason {
    /// Stable label persisted for the structured reasons.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spam => "spam",
            Self::Harassment => "harassment",
            Self::Nsfw => "nsfw",
            Self::Violence => "violence",
            Self::Other => "other",
        }
    }

    /// Resolve the free-text value to store in `message_reports.reason`.
    ///
    /// - [`ReportReason::Other`] requires a non-empty `detail` (≤ 512 chars);
    ///   the detail becomes the stored reason.
    /// - Structured reasons store their stable label; an over-long `detail`
    ///   (if supplied for context) is still rejected so the request is not
    ///   silently truncated.
    ///
    /// # Errors
    /// Returns a static message when `other` has no detail, or any detail
    /// exceeds [`MAX_REPORT_REASON_LENGTH`].
    pub fn resolve_stored_reason(self, detail: Option<&str>) -> Result<String, &'static str> {
        let trimmed = detail.map(str::trim).filter(|s| !s.is_empty());

        if let Some(d) = trimmed
            && d.chars().count() > MAX_REPORT_REASON_LENGTH
        {
            return Err("Report detail must not exceed 512 characters");
        }

        match self {
            Self::Other => trimmed
                .map(str::to_string)
                .ok_or("A detail is required when the reason is 'other'"),
            structured => Ok(structured.as_str().to_string()),
        }
    }
}

/// Lifecycle status of a report. Matches the Postgres `report_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Open,
    Resolved,
    Dismissed,
}

impl ReportStatus {
    /// Postgres enum label (hand-mapped; the column is cast to/from text in SQL).
    #[must_use]
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Dismissed => "dismissed",
        }
    }

    /// Parse a Postgres enum label; `None` for an unrecognized value.
    #[must_use]
    pub fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "resolved" => Some(Self::Resolved),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }

    /// The two terminal states a moderator may resolve an open report into.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Resolved | Self::Dismissed)
    }
}

/// A validated report ready to persist (pre-insert form).
#[derive(Debug, Clone)]
pub struct NewMessageReport {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub message_id: uuid::Uuid,
    pub reporter_id: UserId,
    pub reported_user_id: UserId,
    /// Resolved free-text reason (see [`ReportReason::resolve_stored_reason`]).
    pub reason: String,
}

/// Snapshot of the reported message at queue-read time. The message row may be
/// soft-deleted or purged (no FK), so every field is best-effort.
#[derive(Debug, Clone)]
pub struct ReportedMessageSnapshot {
    /// Plaintext preview (already truncated). `None` when the message is
    /// deleted, encrypted, or purged.
    pub snippet: Option<String>,
    /// The message was soft-deleted or no longer exists.
    pub deleted: bool,
    /// The message is E2EE ciphertext — content is not readable server-side.
    pub encrypted: bool,
}

/// A report as read back for the moderator queue, with reporter/reported
/// display data and the reported-message snapshot resolved at read time.
#[derive(Debug, Clone)]
pub struct MessageReport {
    pub id: ReportId,
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub message_id: uuid::Uuid,
    pub reporter_id: UserId,
    pub reporter_username: String,
    pub reported_user_id: UserId,
    pub reported_username: String,
    pub reason: String,
    pub status: ReportStatus,
    pub message: ReportedMessageSnapshot,
    pub resolved_by: Option<UserId>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn status_db_round_trip() {
        for status in [
            ReportStatus::Open,
            ReportStatus::Resolved,
            ReportStatus::Dismissed,
        ] {
            assert_eq!(ReportStatus::from_db_str(status.as_db_str()), Some(status));
        }
    }

    #[test]
    fn status_unknown_is_none() {
        assert_eq!(ReportStatus::from_db_str("archived"), None);
    }

    #[test]
    fn other_requires_detail() {
        assert_eq!(
            ReportReason::Other.resolve_stored_reason(None),
            Err("A detail is required when the reason is 'other'")
        );
        assert_eq!(
            ReportReason::Other.resolve_stored_reason(Some("   ")),
            Err("A detail is required when the reason is 'other'")
        );
        assert_eq!(
            ReportReason::Other.resolve_stored_reason(Some("  spammy bot  ")),
            Ok("spammy bot".to_string())
        );
    }

    #[test]
    fn structured_reason_stores_label() {
        assert_eq!(
            ReportReason::Nsfw.resolve_stored_reason(None),
            Ok("nsfw".to_string())
        );
        // Detail is optional context for structured reasons; the label wins.
        assert_eq!(
            ReportReason::Spam.resolve_stored_reason(Some("ignored context")),
            Ok("spam".to_string())
        );
    }

    #[test]
    fn detail_length_cap_enforced() {
        let too_long = "a".repeat(MAX_REPORT_REASON_LENGTH + 1);
        assert!(
            ReportReason::Other
                .resolve_stored_reason(Some(&too_long))
                .is_err()
        );
        assert!(
            ReportReason::Spam
                .resolve_stored_reason(Some(&too_long))
                .is_err()
        );

        let exactly = "a".repeat(MAX_REPORT_REASON_LENGTH);
        assert_eq!(
            ReportReason::Other.resolve_stored_reason(Some(&exactly)),
            Ok(exactly)
        );
    }

    #[test]
    fn reason_json_is_snake_case() {
        assert_eq!(
            serde_json::to_string(&ReportReason::Nsfw).unwrap(),
            "\"nsfw\""
        );
    }
}
