//! Server plan and resource limit definitions.
//!
//! WHY: Hardcoded limits act as financial guard-rails for `SaaS` tiers.
//! Self-hosted deployments bypass these entirely via the `AlwaysAllowedChecker` adapter,
//! or use `SELF_HOSTED_LIMITS` (all `u64::MAX`) for code paths that read limit values.
//!
//! Spec reference: dev/active/plan-limits/plan-limits-plan.md

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Plan tier for a server (`SaaS` only — self-hosted ignores this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Pro,
    Community,
}

impl Plan {
    /// The canonical lowercase string stored in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Pro => "pro",
            Self::Community => "community",
        }
    }
}

impl std::fmt::Display for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Plan {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "free" => Ok(Self::Free),
            "pro" => Ok(Self::Pro),
            "community" => Ok(Self::Community),
            _ => Err(format!("Invalid plan: '{s}'")),
        }
    }
}

/// Kind of server resource subject to plan limits.
///
/// Only includes resources with active enforcement or imminent implementation.
/// Future resources (voice, emoji, files, bots, etc.) are documented as TODOs in
/// `domain/ports/plan_limit_checker.rs` with their spec values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    // §1 Servers (per user)
    OwnedServers,
    JoinedServers,
    // §2 Members (per server)
    Members,
    // §3 Channels (per server)
    Channels,
    Categories,
    // §4 Roles (per server)
    Roles,
    // §8 Invites (per server)
    ActiveInvites,
    // §10 DMs (per user)
    OpenDms,
}

impl ResourceKind {
    /// Human-readable plural noun for error messages.
    #[must_use]
    pub fn display_name(self) -> &'static str {
        match self {
            Self::OwnedServers => "owned servers",
            Self::JoinedServers => "joined servers",
            Self::Members => "members",
            Self::Channels => "channels",
            Self::Categories => "categories",
            Self::Roles => "roles",
            Self::ActiveInvites => "active invites",
            Self::OpenDms => "open DM conversations",
        }
    }
}

impl std::fmt::Display for ResourceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.display_name())
    }
}

/// Concrete limit values for a plan tier.
///
/// All numeric limits are `u64`. Self-hosted deployments use `u64::MAX` for all values.
/// Fields are organized by spec section (§N).
///
/// For non-countable limits (message chars, edit window, bio chars, rate limits),
/// access the struct fields directly rather than through `limit_for()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    // §1 Servers (per user — global, not per-server)
    pub max_owned_servers: u64,
    pub max_joined_servers: u64,
    // §2 Members (per server)
    pub max_members: u64,
    // §3 Channels (per server)
    pub max_channels: u64,
    pub max_categories: u64,
    // §4 Roles (per server)
    pub max_roles: u64,
    // §5 Messages (per server)
    pub max_message_chars: u64,
    /// Edit window in seconds. `u64::MAX` means unlimited.
    pub message_edit_window_secs: u64,
    // §8 Invites (per server)
    pub max_active_invites: u64,
    // §10 DMs (per user — global)
    pub max_open_dms: u64,
    // §11 Profile (per user)
    pub max_bio_chars: u64,
    // §12 Rate limits (per user)
    pub max_messages_per_5s: u64,
}

// -- Hardcoded limit constants -----------------------------------------------
// Source of truth: dev/active/plan-limits/plan-limits-plan.md

const FREE_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 3,
    max_joined_servers: 10,
    max_members: 150,
    max_channels: 20,
    max_categories: 5,
    max_roles: 10,
    max_message_chars: 2_000,
    message_edit_window_secs: 15 * 60, // 15 minutes
    max_active_invites: 5,
    max_open_dms: 20,
    max_bio_chars: 200,
    max_messages_per_5s: 5,
};

const PRO_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 10,
    max_joined_servers: 50,
    max_members: 2_000,
    max_channels: 100,
    max_categories: 20,
    max_roles: 50,
    max_message_chars: 4_000,
    message_edit_window_secs: u64::MAX, // unlimited
    max_active_invites: 25,
    max_open_dms: 100,
    max_bio_chars: 500,
    max_messages_per_5s: 10,
};

const COMMUNITY_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 25,
    max_joined_servers: 100,
    max_members: 10_000,
    max_channels: 500,
    max_categories: 50,
    max_roles: 250,
    max_message_chars: 4_000,
    message_edit_window_secs: u64::MAX, // unlimited
    max_active_invites: 100,
    max_open_dms: 500,
    max_bio_chars: 500,
    max_messages_per_5s: 15,
};

/// Self-hosted limits: everything unlimited.
pub const SELF_HOSTED_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: u64::MAX,
    max_joined_servers: u64::MAX,
    max_members: u64::MAX,
    max_channels: u64::MAX,
    max_categories: u64::MAX,
    max_roles: u64::MAX,
    max_message_chars: u64::MAX,
    message_edit_window_secs: u64::MAX,
    max_active_invites: u64::MAX,
    max_open_dms: u64::MAX,
    max_bio_chars: u64::MAX,
    max_messages_per_5s: u64::MAX,
};

impl PlanLimits {
    /// Get the hardcoded limits for a given plan tier.
    #[must_use]
    pub fn for_plan(plan: Plan) -> Self {
        match plan {
            Plan::Free => FREE_LIMITS,
            Plan::Pro => PRO_LIMITS,
            Plan::Community => COMMUNITY_LIMITS,
        }
    }

    /// Get the self-hosted limits (all `u64::MAX`).
    #[must_use]
    pub fn for_self_hosted() -> Self {
        SELF_HOSTED_LIMITS
    }

    /// Get the limit value for a specific countable resource.
    ///
    /// Only covers `ResourceKind` variants (COUNT-before-POST pattern).
    /// For non-countable limits (message chars, edit window, bio chars,
    /// rate limits), access the struct fields directly.
    #[must_use]
    pub fn limit_for(&self, resource: ResourceKind) -> u64 {
        match resource {
            ResourceKind::OwnedServers => self.max_owned_servers,
            ResourceKind::JoinedServers => self.max_joined_servers,
            ResourceKind::Members => self.max_members,
            ResourceKind::Channels => self.max_channels,
            ResourceKind::Categories => self.max_categories,
            ResourceKind::Roles => self.max_roles,
            ResourceKind::ActiveInvites => self.max_active_invites,
            ResourceKind::OpenDms => self.max_open_dms,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // ── Free plan limits match spec (§1-§12) ────────────────────────────

    #[test]
    fn free_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Free);

        // §1 Servers
        assert_eq!(limits.max_owned_servers, 3);
        assert_eq!(limits.max_joined_servers, 10);
        // §2 Members
        assert_eq!(limits.max_members, 150);
        // §3 Channels
        assert_eq!(limits.max_channels, 20);
        assert_eq!(limits.max_categories, 5);
        // §4 Roles
        assert_eq!(limits.max_roles, 10);
        // §5 Messages
        assert_eq!(limits.max_message_chars, 2_000);
        assert_eq!(limits.message_edit_window_secs, 900); // 15 minutes
        // §8 Invites
        assert_eq!(limits.max_active_invites, 5);
        // §10 DMs
        assert_eq!(limits.max_open_dms, 20);
        // §11 Profile
        assert_eq!(limits.max_bio_chars, 200);
        // §12 Rate limits
        assert_eq!(limits.max_messages_per_5s, 5);
    }

    // ── Pro plan limits match spec ──────────────────────────────────────

    #[test]
    fn pro_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Pro);

        assert_eq!(limits.max_owned_servers, 10);
        assert_eq!(limits.max_joined_servers, 50);
        assert_eq!(limits.max_members, 2_000);
        assert_eq!(limits.max_channels, 100);
        assert_eq!(limits.max_categories, 20);
        assert_eq!(limits.max_roles, 50);
        assert_eq!(limits.max_message_chars, 4_000);
        assert_eq!(limits.message_edit_window_secs, u64::MAX);
        assert_eq!(limits.max_active_invites, 25);
        assert_eq!(limits.max_open_dms, 100);
        assert_eq!(limits.max_bio_chars, 500);
        assert_eq!(limits.max_messages_per_5s, 10);
    }

    // ── Community plan limits match spec ─────────────────────────────────

    #[test]
    fn community_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Community);

        assert_eq!(limits.max_owned_servers, 25);
        assert_eq!(limits.max_joined_servers, 100);
        assert_eq!(limits.max_members, 10_000);
        assert_eq!(limits.max_channels, 500);
        assert_eq!(limits.max_categories, 50);
        assert_eq!(limits.max_roles, 250);
        assert_eq!(limits.max_message_chars, 4_000);
        assert_eq!(limits.message_edit_window_secs, u64::MAX);
        assert_eq!(limits.max_active_invites, 100);
        assert_eq!(limits.max_open_dms, 500);
        assert_eq!(limits.max_bio_chars, 500);
        assert_eq!(limits.max_messages_per_5s, 15);
    }

    // ── Self-hosted limits are all u64::MAX ─────────────────────────────

    #[test]
    fn self_hosted_limits_are_all_max() {
        let limits = PlanLimits::for_self_hosted();

        assert_eq!(limits.max_owned_servers, u64::MAX);
        assert_eq!(limits.max_joined_servers, u64::MAX);
        assert_eq!(limits.max_members, u64::MAX);
        assert_eq!(limits.max_channels, u64::MAX);
        assert_eq!(limits.max_categories, u64::MAX);
        assert_eq!(limits.max_roles, u64::MAX);
        assert_eq!(limits.max_message_chars, u64::MAX);
        assert_eq!(limits.message_edit_window_secs, u64::MAX);
        assert_eq!(limits.max_active_invites, u64::MAX);
        assert_eq!(limits.max_open_dms, u64::MAX);
        assert_eq!(limits.max_bio_chars, u64::MAX);
        assert_eq!(limits.max_messages_per_5s, u64::MAX);
    }

    // ── Tier ordering: Free < Pro < Community for all limits ────────────

    #[test]
    fn tier_ordering_free_le_pro_le_community() {
        let free = PlanLimits::for_plan(Plan::Free);
        let pro = PlanLimits::for_plan(Plan::Pro);
        let community = PlanLimits::for_plan(Plan::Community);

        assert!(free.max_owned_servers <= pro.max_owned_servers);
        assert!(pro.max_owned_servers <= community.max_owned_servers);

        assert!(free.max_joined_servers <= pro.max_joined_servers);
        assert!(pro.max_joined_servers <= community.max_joined_servers);

        assert!(free.max_members <= pro.max_members);
        assert!(pro.max_members <= community.max_members);

        assert!(free.max_channels <= pro.max_channels);
        assert!(pro.max_channels <= community.max_channels);

        assert!(free.max_categories <= pro.max_categories);
        assert!(pro.max_categories <= community.max_categories);

        assert!(free.max_roles <= pro.max_roles);
        assert!(pro.max_roles <= community.max_roles);

        assert!(free.max_message_chars <= pro.max_message_chars);
        assert!(pro.max_message_chars <= community.max_message_chars);

        assert!(free.message_edit_window_secs <= pro.message_edit_window_secs);
        assert!(pro.message_edit_window_secs <= community.message_edit_window_secs);

        assert!(free.max_active_invites <= pro.max_active_invites);
        assert!(pro.max_active_invites <= community.max_active_invites);

        assert!(free.max_open_dms <= pro.max_open_dms);
        assert!(pro.max_open_dms <= community.max_open_dms);

        assert!(free.max_bio_chars <= pro.max_bio_chars);
        assert!(pro.max_bio_chars <= community.max_bio_chars);

        assert!(free.max_messages_per_5s <= pro.max_messages_per_5s);
        assert!(pro.max_messages_per_5s <= community.max_messages_per_5s);
    }

    // ── limit_for returns correct value for each ResourceKind ───────────

    #[test]
    fn limit_for_owned_servers() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::OwnedServers),
            3
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Pro).limit_for(ResourceKind::OwnedServers),
            10
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).limit_for(ResourceKind::OwnedServers),
            25
        );
    }

    #[test]
    fn limit_for_joined_servers() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::JoinedServers),
            10
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Pro).limit_for(ResourceKind::JoinedServers),
            50
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).limit_for(ResourceKind::JoinedServers),
            100
        );
    }

    #[test]
    fn limit_for_members() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Members),
            150
        );
    }

    #[test]
    fn limit_for_channels() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Channels),
            20
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Pro).limit_for(ResourceKind::Channels),
            100
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).limit_for(ResourceKind::Channels),
            500
        );
    }

    #[test]
    fn limit_for_categories() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Categories),
            5
        );
    }

    #[test]
    fn limit_for_roles() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Pro).limit_for(ResourceKind::Roles),
            50
        );
    }

    #[test]
    fn limit_for_active_invites() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::ActiveInvites),
            5
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).limit_for(ResourceKind::ActiveInvites),
            100
        );
    }

    #[test]
    fn limit_for_open_dms() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::OpenDms),
            20
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).limit_for(ResourceKind::OpenDms),
            500
        );
    }

    // ── Plan FromStr round-trip ─────────────────────────────────────────

    #[test]
    fn plan_from_str_free_round_trip() {
        let plan: Plan = "free".parse().unwrap();
        assert_eq!(plan, Plan::Free);
        assert_eq!(plan.as_str(), "free");
    }

    #[test]
    fn plan_from_str_pro_round_trip() {
        let plan: Plan = "pro".parse().unwrap();
        assert_eq!(plan, Plan::Pro);
        assert_eq!(plan.as_str(), "pro");
    }

    #[test]
    fn plan_from_str_community_round_trip() {
        let plan: Plan = "community".parse().unwrap();
        assert_eq!(plan, Plan::Community);
        assert_eq!(plan.as_str(), "community");
    }

    // ── Plan serde round-trip ───────────────────────────────────────────

    #[test]
    fn plan_serde_round_trip_free() {
        let json = serde_json::to_string(&Plan::Free).unwrap();
        assert_eq!(json, r#""free""#);
        let deserialized: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Plan::Free);
    }

    #[test]
    fn plan_serde_round_trip_pro() {
        let json = serde_json::to_string(&Plan::Pro).unwrap();
        assert_eq!(json, r#""pro""#);
        let deserialized: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Plan::Pro);
    }

    #[test]
    fn plan_serde_round_trip_community() {
        let json = serde_json::to_string(&Plan::Community).unwrap();
        assert_eq!(json, r#""community""#);
        let deserialized: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Plan::Community);
    }

    // ── Invalid plan string rejected ────────────────────────────────────

    #[test]
    fn plan_from_str_rejects_invalid() {
        let result = "enterprise".parse::<Plan>();
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("Invalid plan"));
        assert!(err.contains("enterprise"));
    }

    #[test]
    fn plan_from_str_rejects_uppercase() {
        assert!("Free".parse::<Plan>().is_err());
        assert!("Pro".parse::<Plan>().is_err());
        assert!("Community".parse::<Plan>().is_err());
    }

    #[test]
    fn plan_serde_rejects_invalid() {
        assert!(serde_json::from_str::<Plan>(r#""enterprise""#).is_err());
        assert!(serde_json::from_str::<Plan>(r#""business""#).is_err());
    }

    // ── ResourceKind display names ──────────────────────────────────────

    #[test]
    fn resource_kind_display_names() {
        assert_eq!(ResourceKind::OwnedServers.display_name(), "owned servers");
        assert_eq!(ResourceKind::JoinedServers.display_name(), "joined servers");
        assert_eq!(ResourceKind::Members.display_name(), "members");
        assert_eq!(ResourceKind::Channels.display_name(), "channels");
        assert_eq!(ResourceKind::Categories.display_name(), "categories");
        assert_eq!(ResourceKind::Roles.display_name(), "roles");
        assert_eq!(ResourceKind::ActiveInvites.display_name(), "active invites");
        assert_eq!(
            ResourceKind::OpenDms.display_name(),
            "open DM conversations"
        );
    }

    // ── Display impls ───────────────────────────────────────────────────

    #[test]
    fn plan_display() {
        assert_eq!(format!("{}", Plan::Free), "free");
        assert_eq!(format!("{}", Plan::Pro), "pro");
        assert_eq!(format!("{}", Plan::Community), "community");
    }

    #[test]
    fn resource_kind_display() {
        assert_eq!(format!("{}", ResourceKind::Members), "members");
        assert_eq!(format!("{}", ResourceKind::Channels), "channels");
        assert_eq!(format!("{}", ResourceKind::OwnedServers), "owned servers");
    }

    // ── Free edit window is exactly 15 minutes ──────────────────────────

    #[test]
    fn free_edit_window_is_15_minutes() {
        let limits = PlanLimits::for_plan(Plan::Free);
        assert_eq!(limits.message_edit_window_secs, 15 * 60);
        assert_eq!(limits.message_edit_window_secs, 900);
    }

    // ── Pro and Community have unlimited edit window ─────────────────────

    #[test]
    fn pro_and_community_have_unlimited_edit_window() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Pro).message_edit_window_secs,
            u64::MAX
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Community).message_edit_window_secs,
            u64::MAX
        );
    }

    // ── for_self_hosted matches SELF_HOSTED_LIMITS constant ─────────────

    #[test]
    fn for_self_hosted_matches_constant() {
        assert_eq!(PlanLimits::for_self_hosted(), SELF_HOSTED_LIMITS);
    }
}
