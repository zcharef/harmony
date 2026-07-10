//! Member-migration command-center domain models (growth-plan §14.1).
//!
//! The owner-facing view of a migration's PEOPLE-half: is the server alive
//! yet (the honest §5 signal), how many invited members have actually followed
//! through, and who hasn't participated yet (the intervention targets).
//!
//! Every figure here traces to a real analytics query that reuses the §10 /
//! §5 metric definitions — this module NEVER re-derives "active". See
//! `analytics.metrics_server_alive` (v1.1.0) and `analytics.server_member_cohort`.

use chrono::{DateTime, Utc};

use super::ids::{ServerId, UserId};

/// §5 "alive server" week-1 thresholds (tightened, alt-account resistant).
///
/// These mirror the constants baked into `analytics.metrics_server_alive`
/// so the owner UI can render progress bars without re-deriving them. The
/// measured VALUES come from the view; only these published targets live here.
pub const ALIVE_MIN_MEMBERS_JOINED: i64 = 5;
/// §5: ≥3 non-owner members performing genuine activity in week 1.
pub const ALIVE_MIN_NON_OWNER_ACTIVE: i64 = 3;
/// §5: ≥50 messages in week 1.
pub const ALIVE_MIN_MESSAGES: i64 = 50;
/// §5: from ≥3 distinct senders.
pub const ALIVE_MIN_DISTINCT_SENDERS: i64 = 3;
/// §5: message activity on ≥2 separate days.
pub const ALIVE_MIN_ACTIVE_DAYS: i64 = 2;

/// The §5 week-1 "alive server" snapshot for one server, straight from
/// `analytics.metrics_server_alive`. `is_alive` obeys the §10 null rule:
/// `Some(true)` once every criterion holds, `Some(false)` once the week-1
/// window closes unmet, `None` while the window is still open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerAliveSnapshot {
    pub members_joined_week1: i64,
    pub non_owner_active_week1: i64,
    pub messages_week1: i64,
    pub distinct_senders_week1: i64,
    pub active_days_week1: i64,
    pub is_alive: Option<bool>,
}

impl ServerAliveSnapshot {
    /// All-zero snapshot with an unknown alive verdict — used when the server
    /// has no row in `metrics_server_alive` (e.g. excluded from analytics).
    #[must_use]
    pub fn empty() -> Self {
        Self {
            members_joined_week1: 0,
            non_owner_active_week1: 0,
            messages_week1: 0,
            distinct_senders_week1: 0,
            active_days_week1: 0,
            is_alive: None,
        }
    }
}

/// All-time member-follow-through counts for one server, aggregated from
/// `analytics.server_member_cohort` (non-owner eligible members). "Active"
/// here is the SAME genuine-activity set as §5 criterion 2 — no divergence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberFollowThrough {
    /// Non-owner eligible members who have joined the server.
    pub members_joined: i64,
    /// …of whom have performed a genuine action (message/voice/reaction).
    pub members_active: i64,
    /// …of whom have sent at least one message.
    pub members_sent_message: i64,
    /// Joined but never performed a genuine action — the intervention targets.
    pub not_yet_active: i64,
}

/// The single owner-actionable next step, derived from the metrics per the
/// member-migration playbook (troubleshooting Issues 1-2 + progress cadence).
///
/// The API returns the reason; the client renders the localized copy and the
/// honest migration-truth caveat (structure-only migration).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecommendedAction {
    /// No members have joined yet — personally invite your top members.
    InviteMembers,
    /// Members joined but few are active — seed conversation / run an event.
    SeedConversation,
    /// Some are dormant — nudge the not-yet-active members directly.
    NudgeInactive,
    /// The server is alive — share the progress as social proof.
    ShareProgress,
}

impl RecommendedAction {
    /// Stable wire identifier (camelCase-free; the DTO layer owns casing).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InviteMembers => "invite_members",
            Self::SeedConversation => "seed_conversation",
            Self::NudgeInactive => "nudge_inactive",
            Self::ShareProgress => "share_progress",
        }
    }
}

/// The full migration-progress payload for an owner's server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationProgress {
    pub server_id: ServerId,
    pub alive: ServerAliveSnapshot,
    pub follow_through: MemberFollowThrough,
    pub recommended_action: RecommendedAction,
}

/// One not-yet-active member: joined the server but has not performed a
/// genuine action yet. `has_sent_message` is always false for this cohort
/// (a message is a genuine action) but is surfaced explicitly so the UI does
/// not have to infer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotYetActiveMember {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub nickname: Option<String>,
    pub joined_at: DateTime<Utc>,
    pub has_sent_message: bool,
}

/// A cursor page of not-yet-active members, newest joiners first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberCohortPage {
    pub items: Vec<NotYetActiveMember>,
    /// Total not-yet-active members for the server (without pagination).
    pub total: i64,
}
