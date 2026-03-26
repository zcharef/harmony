//! Server plan and resource limit definitions.
//!
//! WHY: Hardcoded limits act as financial guard-rails for `SaaS` tiers.
//! Self-hosted deployments bypass these entirely via the `AlwaysAllowedChecker` adapter,
//! or use `SELF_HOSTED_LIMITS` for code paths that read limit values.
//!
//! Spec reference: V3 Pricing Simulation

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Plan tier for a server (`SaaS` only — self-hosted ignores this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Supporter,
    Creator,
}

impl Plan {
    /// The canonical lowercase string stored in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Supporter => "supporter",
            Self::Creator => "creator",
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
            "supporter" => Ok(Self::Supporter),
            "creator" => Ok(Self::Creator),
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
/// All numeric limits are `u64`. Self-hosted deployments use specific high defaults
/// with `u64::MAX` only for configurable fields (edit window, rate limits).
/// Fields are organized by spec section (§N).
///
/// For non-countable limits (message chars, edit window, bio chars, rate limits),
/// access the struct fields directly rather than through `limit_for()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    // §1 Servers (per user — global, not per-server)
    pub max_owned_servers: u64,
    pub max_joined_servers: u64,
    // §1 Servers — text limits
    pub max_server_description_chars: u64,
    // §2 Members (per server)
    pub max_members: u64,
    // §3 Channels (per server)
    pub max_channels: u64,
    pub max_categories: u64,
    // §3 Channels — text limits
    pub max_channel_topic_chars: u64,
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
    // §11 Profile — text limits
    pub max_custom_status_chars: u64,
    // §12 Rate limits (per user)
    pub max_messages_per_5s: u64,
}

// -- Hardcoded limit constants -----------------------------------------------
// Source of truth: V3 Pricing Simulation

const FREE_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 3,
    max_joined_servers: 20,
    max_server_description_chars: 500,
    max_members: 200,
    max_channels: 50,
    max_categories: 10,
    max_channel_topic_chars: 256,
    max_roles: 20,
    max_message_chars: 2_000,
    message_edit_window_secs: 15 * 60, // 15 minutes
    max_active_invites: 5,
    max_open_dms: 20,
    max_bio_chars: 200,
    max_custom_status_chars: 50,
    max_messages_per_5s: 5,
};

const SUPPORTER_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 10,
    max_joined_servers: 100,
    max_server_description_chars: 1_000,
    max_members: 10_000,
    max_channels: 500,
    max_categories: 50,
    max_channel_topic_chars: 512,
    max_roles: 250,
    max_message_chars: 4_000,
    message_edit_window_secs: 86_400, // 24 hours
    max_active_invites: 25,
    max_open_dms: 100,
    max_bio_chars: 500,
    max_custom_status_chars: 128,
    max_messages_per_5s: 10,
};

const CREATOR_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 25,
    max_joined_servers: 500,
    max_server_description_chars: 2_000,
    max_members: 50_000,
    max_channels: 1_000,
    max_categories: 100,
    max_channel_topic_chars: 1_024,
    max_roles: 500,
    max_message_chars: 4_000,
    message_edit_window_secs: 604_800, // 7 days
    max_active_invites: 100,
    max_open_dms: 500,
    max_bio_chars: 1_000,
    max_custom_status_chars: 128,
    max_messages_per_5s: 20,
};

/// Self-hosted limits: specific high defaults, with `u64::MAX` only for configurable fields.
pub const SELF_HOSTED_LIMITS: PlanLimits = PlanLimits {
    max_owned_servers: 100,
    max_joined_servers: 1_000,
    max_server_description_chars: 5_000,
    max_members: 500_000,
    max_channels: 10_000,
    max_categories: 500,
    max_channel_topic_chars: 4_096,
    max_roles: 2_000,
    max_message_chars: 8_000,
    message_edit_window_secs: u64::MAX, // configurable
    max_active_invites: 1_000,
    max_open_dms: 2_000,
    max_bio_chars: 4_000,
    max_custom_status_chars: 256,
    max_messages_per_5s: u64::MAX, // configurable
};

impl PlanLimits {
    /// Get the hardcoded limits for a given plan tier.
    #[must_use]
    pub fn for_plan(plan: Plan) -> Self {
        match plan {
            Plan::Free => FREE_LIMITS,
            Plan::Supporter => SUPPORTER_LIMITS,
            Plan::Creator => CREATOR_LIMITS,
        }
    }

    /// Get the self-hosted limits.
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
        assert_eq!(limits.max_joined_servers, 20);
        assert_eq!(limits.max_server_description_chars, 500);
        // §2 Members
        assert_eq!(limits.max_members, 200);
        // §3 Channels
        assert_eq!(limits.max_channels, 50);
        assert_eq!(limits.max_categories, 10);
        assert_eq!(limits.max_channel_topic_chars, 256);
        // §4 Roles
        assert_eq!(limits.max_roles, 20);
        // §5 Messages
        assert_eq!(limits.max_message_chars, 2_000);
        assert_eq!(limits.message_edit_window_secs, 900); // 15 minutes
        // §8 Invites
        assert_eq!(limits.max_active_invites, 5);
        // §10 DMs
        assert_eq!(limits.max_open_dms, 20);
        // §11 Profile
        assert_eq!(limits.max_bio_chars, 200);
        assert_eq!(limits.max_custom_status_chars, 50);
        // §12 Rate limits
        assert_eq!(limits.max_messages_per_5s, 5);
    }

    // ── Supporter plan limits match spec ────────────────────────────────

    #[test]
    fn supporter_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Supporter);

        assert_eq!(limits.max_owned_servers, 10);
        assert_eq!(limits.max_joined_servers, 100);
        assert_eq!(limits.max_server_description_chars, 1_000);
        assert_eq!(limits.max_members, 10_000);
        assert_eq!(limits.max_channels, 500);
        assert_eq!(limits.max_categories, 50);
        assert_eq!(limits.max_channel_topic_chars, 512);
        assert_eq!(limits.max_roles, 250);
        assert_eq!(limits.max_message_chars, 4_000);
        assert_eq!(limits.message_edit_window_secs, 86_400); // 24 hours
        assert_eq!(limits.max_active_invites, 25);
        assert_eq!(limits.max_open_dms, 100);
        assert_eq!(limits.max_bio_chars, 500);
        assert_eq!(limits.max_custom_status_chars, 128);
        assert_eq!(limits.max_messages_per_5s, 10);
    }

    // ── Creator plan limits match spec ──────────────────────────────────

    #[test]
    fn creator_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Creator);

        assert_eq!(limits.max_owned_servers, 25);
        assert_eq!(limits.max_joined_servers, 500);
        assert_eq!(limits.max_server_description_chars, 2_000);
        assert_eq!(limits.max_members, 50_000);
        assert_eq!(limits.max_channels, 1_000);
        assert_eq!(limits.max_categories, 100);
        assert_eq!(limits.max_channel_topic_chars, 1_024);
        assert_eq!(limits.max_roles, 500);
        assert_eq!(limits.max_message_chars, 4_000);
        assert_eq!(limits.message_edit_window_secs, 604_800); // 7 days
        assert_eq!(limits.max_active_invites, 100);
        assert_eq!(limits.max_open_dms, 500);
        assert_eq!(limits.max_bio_chars, 1_000);
        assert_eq!(limits.max_custom_status_chars, 128);
        assert_eq!(limits.max_messages_per_5s, 20);
    }

    // ── Self-hosted limits: specific high defaults ──────────────────────

    #[test]
    fn self_hosted_limits_match_spec() {
        let limits = PlanLimits::for_self_hosted();

        assert_eq!(limits.max_owned_servers, 100);
        assert_eq!(limits.max_joined_servers, 1_000);
        assert_eq!(limits.max_server_description_chars, 5_000);
        assert_eq!(limits.max_members, 500_000);
        assert_eq!(limits.max_channels, 10_000);
        assert_eq!(limits.max_categories, 500);
        assert_eq!(limits.max_channel_topic_chars, 4_096);
        assert_eq!(limits.max_roles, 2_000);
        assert_eq!(limits.max_message_chars, 8_000);
        assert_eq!(limits.message_edit_window_secs, u64::MAX); // configurable
        assert_eq!(limits.max_active_invites, 1_000);
        assert_eq!(limits.max_open_dms, 2_000);
        assert_eq!(limits.max_bio_chars, 4_000);
        assert_eq!(limits.max_custom_status_chars, 256);
        assert_eq!(limits.max_messages_per_5s, u64::MAX); // configurable
    }

    // ── Tier ordering: Free < Supporter < Creator for all limits ────────

    #[test]
    fn tier_ordering_free_le_supporter_le_creator() {
        let free = PlanLimits::for_plan(Plan::Free);
        let supporter = PlanLimits::for_plan(Plan::Supporter);
        let creator = PlanLimits::for_plan(Plan::Creator);

        assert!(free.max_owned_servers <= supporter.max_owned_servers);
        assert!(supporter.max_owned_servers <= creator.max_owned_servers);

        assert!(free.max_joined_servers <= supporter.max_joined_servers);
        assert!(supporter.max_joined_servers <= creator.max_joined_servers);

        assert!(free.max_server_description_chars <= supporter.max_server_description_chars);
        assert!(supporter.max_server_description_chars <= creator.max_server_description_chars);

        assert!(free.max_members <= supporter.max_members);
        assert!(supporter.max_members <= creator.max_members);

        assert!(free.max_channels <= supporter.max_channels);
        assert!(supporter.max_channels <= creator.max_channels);

        assert!(free.max_categories <= supporter.max_categories);
        assert!(supporter.max_categories <= creator.max_categories);

        assert!(free.max_channel_topic_chars <= supporter.max_channel_topic_chars);
        assert!(supporter.max_channel_topic_chars <= creator.max_channel_topic_chars);

        assert!(free.max_roles <= supporter.max_roles);
        assert!(supporter.max_roles <= creator.max_roles);

        assert!(free.max_message_chars <= supporter.max_message_chars);
        assert!(supporter.max_message_chars <= creator.max_message_chars);

        assert!(free.message_edit_window_secs <= supporter.message_edit_window_secs);
        assert!(supporter.message_edit_window_secs <= creator.message_edit_window_secs);

        assert!(free.max_active_invites <= supporter.max_active_invites);
        assert!(supporter.max_active_invites <= creator.max_active_invites);

        assert!(free.max_open_dms <= supporter.max_open_dms);
        assert!(supporter.max_open_dms <= creator.max_open_dms);

        assert!(free.max_bio_chars <= supporter.max_bio_chars);
        assert!(supporter.max_bio_chars <= creator.max_bio_chars);

        assert!(free.max_custom_status_chars <= supporter.max_custom_status_chars);
        assert!(supporter.max_custom_status_chars <= creator.max_custom_status_chars);

        assert!(free.max_messages_per_5s <= supporter.max_messages_per_5s);
        assert!(supporter.max_messages_per_5s <= creator.max_messages_per_5s);
    }

    // ── limit_for returns correct value for each ResourceKind ───────────

    #[test]
    fn limit_for_owned_servers() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::OwnedServers),
            3
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Supporter).limit_for(ResourceKind::OwnedServers),
            10
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Creator).limit_for(ResourceKind::OwnedServers),
            25
        );
    }

    #[test]
    fn limit_for_joined_servers() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::JoinedServers),
            20
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Supporter).limit_for(ResourceKind::JoinedServers),
            100
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Creator).limit_for(ResourceKind::JoinedServers),
            500
        );
    }

    #[test]
    fn limit_for_members() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Members),
            200
        );
    }

    #[test]
    fn limit_for_channels() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Channels),
            50
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Supporter).limit_for(ResourceKind::Channels),
            500
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Creator).limit_for(ResourceKind::Channels),
            1_000
        );
    }

    #[test]
    fn limit_for_categories() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::Categories),
            10
        );
    }

    #[test]
    fn limit_for_roles() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Supporter).limit_for(ResourceKind::Roles),
            250
        );
    }

    #[test]
    fn limit_for_active_invites() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Free).limit_for(ResourceKind::ActiveInvites),
            5
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Creator).limit_for(ResourceKind::ActiveInvites),
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
            PlanLimits::for_plan(Plan::Creator).limit_for(ResourceKind::OpenDms),
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
    fn plan_from_str_supporter_round_trip() {
        let plan: Plan = "supporter".parse().unwrap();
        assert_eq!(plan, Plan::Supporter);
        assert_eq!(plan.as_str(), "supporter");
    }

    #[test]
    fn plan_from_str_creator_round_trip() {
        let plan: Plan = "creator".parse().unwrap();
        assert_eq!(plan, Plan::Creator);
        assert_eq!(plan.as_str(), "creator");
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
    fn plan_serde_round_trip_supporter() {
        let json = serde_json::to_string(&Plan::Supporter).unwrap();
        assert_eq!(json, r#""supporter""#);
        let deserialized: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Plan::Supporter);
    }

    #[test]
    fn plan_serde_round_trip_creator() {
        let json = serde_json::to_string(&Plan::Creator).unwrap();
        assert_eq!(json, r#""creator""#);
        let deserialized: Plan = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Plan::Creator);
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
        assert!("Supporter".parse::<Plan>().is_err());
        assert!("Creator".parse::<Plan>().is_err());
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
        assert_eq!(format!("{}", Plan::Supporter), "supporter");
        assert_eq!(format!("{}", Plan::Creator), "creator");
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

    // ── Supporter has 24h and Creator has 7d edit window ────────────────

    #[test]
    fn supporter_and_creator_edit_windows() {
        assert_eq!(
            PlanLimits::for_plan(Plan::Supporter).message_edit_window_secs,
            86_400 // 24 hours
        );
        assert_eq!(
            PlanLimits::for_plan(Plan::Creator).message_edit_window_secs,
            604_800 // 7 days
        );
    }

    // ── for_self_hosted matches SELF_HOSTED_LIMITS constant ─────────────

    #[test]
    fn for_self_hosted_matches_constant() {
        assert_eq!(PlanLimits::for_self_hosted(), SELF_HOSTED_LIMITS);
    }
}
