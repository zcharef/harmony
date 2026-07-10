//! Member-migration command-center DTOs (growth-plan §14.1).

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{
    ALIVE_MIN_ACTIVE_DAYS, ALIVE_MIN_DISTINCT_SENDERS, ALIVE_MIN_MEMBERS_JOINED,
    ALIVE_MIN_MESSAGES, ALIVE_MIN_NON_OWNER_ACTIVE, MemberCohortPage, MemberFollowThrough,
    MigrationProgress, NotYetActiveMember, RecommendedAction, ServerAliveSnapshot,
};

/// The §5 week-1 "alive server" thresholds, echoed so the client can render
/// progress bars without hardcoding them (`SSoT` stays in the analytics view).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AliveThresholds {
    pub members_joined: i64,
    pub non_owner_active: i64,
    pub messages: i64,
    pub distinct_senders: i64,
    pub active_days: i64,
}

impl AliveThresholds {
    fn current() -> Self {
        Self {
            members_joined: ALIVE_MIN_MEMBERS_JOINED,
            non_owner_active: ALIVE_MIN_NON_OWNER_ACTIVE,
            messages: ALIVE_MIN_MESSAGES,
            distinct_senders: ALIVE_MIN_DISTINCT_SENDERS,
            active_days: ALIVE_MIN_ACTIVE_DAYS,
        }
    }
}

/// The §5 week-1 alive snapshot. `isAlive` is `true` once every criterion
/// holds, `false` once the week-1 window closes unmet, `null` while it is
/// still open (the §10 null/unknown rule — never a fake zero).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AliveSnapshotResponse {
    pub members_joined_week1: i64,
    pub non_owner_active_week1: i64,
    pub messages_week1: i64,
    pub distinct_senders_week1: i64,
    pub active_days_week1: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_alive: Option<bool>,
    pub thresholds: AliveThresholds,
}

impl From<ServerAliveSnapshot> for AliveSnapshotResponse {
    fn from(s: ServerAliveSnapshot) -> Self {
        Self {
            members_joined_week1: s.members_joined_week1,
            non_owner_active_week1: s.non_owner_active_week1,
            messages_week1: s.messages_week1,
            distinct_senders_week1: s.distinct_senders_week1,
            active_days_week1: s.active_days_week1,
            is_alive: s.is_alive,
            thresholds: AliveThresholds::current(),
        }
    }
}

/// All-time member-follow-through counts.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FollowThroughResponse {
    pub members_joined: i64,
    pub members_active: i64,
    pub members_sent_message: i64,
    pub not_yet_active: i64,
}

impl From<MemberFollowThrough> for FollowThroughResponse {
    fn from(f: MemberFollowThrough) -> Self {
        Self {
            members_joined: f.members_joined,
            members_active: f.members_active,
            members_sent_message: f.members_sent_message,
            not_yet_active: f.not_yet_active,
        }
    }
}

/// The single owner-actionable next step (client renders localized copy).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecommendedActionResponse {
    InviteMembers,
    SeedConversation,
    NudgeInactive,
    ShareProgress,
}

impl From<RecommendedAction> for RecommendedActionResponse {
    fn from(a: RecommendedAction) -> Self {
        match a {
            RecommendedAction::InviteMembers => Self::InviteMembers,
            RecommendedAction::SeedConversation => Self::SeedConversation,
            RecommendedAction::NudgeInactive => Self::NudgeInactive,
            RecommendedAction::ShareProgress => Self::ShareProgress,
        }
    }
}

/// Owner-facing migration-progress payload for one server.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgressResponse {
    pub server_id: String,
    pub alive: AliveSnapshotResponse,
    pub follow_through: FollowThroughResponse,
    pub recommended_action: RecommendedActionResponse,
}

impl From<MigrationProgress> for MigrationProgressResponse {
    fn from(p: MigrationProgress) -> Self {
        Self {
            server_id: p.server_id.to_string(),
            alive: p.alive.into(),
            follow_through: p.follow_through.into(),
            recommended_action: p.recommended_action.into(),
        }
    }
}

/// One not-yet-active member (an intervention target).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotYetActiveMemberResponse {
    pub user_id: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    pub joined_at: String,
    pub has_sent_message: bool,
}

impl From<NotYetActiveMember> for NotYetActiveMemberResponse {
    fn from(m: NotYetActiveMember) -> Self {
        Self {
            user_id: m.user_id.to_string(),
            username: m.username,
            display_name: m.display_name,
            avatar_url: m.avatar_url,
            nickname: m.nickname,
            joined_at: m.joined_at.to_rfc3339(),
            has_sent_message: m.has_sent_message,
        }
    }
}

/// Cursor-paginated not-yet-active cohort (ADR-036 envelope).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberCohortResponse {
    pub items: Vec<NotYetActiveMemberResponse>,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl MemberCohortResponse {
    /// Build the envelope, deriving the next cursor from the last row when the
    /// page came back full (there may be more).
    #[must_use]
    pub fn from_page(page: MemberCohortPage, limit: i64) -> Self {
        let next_cursor = if i64::try_from(page.items.len()).unwrap_or(0) == limit {
            page.items.last().map(|m| m.joined_at.to_rfc3339())
        } else {
            None
        };
        Self {
            items: page.items.into_iter().map(Into::into).collect(),
            total: page.total,
            next_cursor,
        }
    }
}

/// Query parameters for the not-yet-active cohort list.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct CohortQuery {
    /// ISO 8601 `joined_at` cursor; returns members who joined before it.
    pub before: Option<String>,
    /// Page size (default 25, max 100).
    pub limit: Option<i64>,
}
