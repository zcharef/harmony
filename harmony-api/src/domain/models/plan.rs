//! Server plan and resource limit definitions.
//!
//! WHY: Hardcoded limits act as financial guard-rails for `SaaS` tiers.
//! Self-hosted deployments bypass these entirely via the `AlwaysAllowedChecker` adapter.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Plan tier for a server (`SaaS` only — self-hosted ignores this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Free,
    Pro,
}

impl Plan {
    /// The canonical lowercase string stored in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Pro => "pro",
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
            _ => Err(format!("Invalid plan: '{s}'")),
        }
    }
}

/// Kind of server resource subject to plan limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    Members,
    Channels,
    Roles,
    VoiceConcurrent,
    StorageTotalBytes,
    MaxFileSizeBytes,
}

impl ResourceKind {
    /// Human-readable plural noun for error messages.
    #[must_use]
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Members => "members",
            Self::Channels => "channels",
            Self::Roles => "roles",
            Self::VoiceConcurrent => "concurrent voice users",
            Self::StorageTotalBytes => "bytes of total storage",
            Self::MaxFileSizeBytes => "bytes per file",
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
/// All limits are `u64` to accommodate storage bytes (50 GB = `53_687_091_200`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    pub max_members: u64,
    pub max_channels: u64,
    pub max_roles: u64,
    pub max_voice_concurrent: u64,
    pub max_storage_total_bytes: u64,
    pub max_file_size_bytes: u64,
}

// -- Hardcoded limit constants -----------------------------------------------

const FREE_LIMITS: PlanLimits = PlanLimits {
    max_members: 200,
    max_channels: 50,
    max_roles: 20,
    max_voice_concurrent: 12,
    max_storage_total_bytes: 1024 * 1024 * 1024, // 1 GB
    max_file_size_bytes: 8 * 1024 * 1024,        // 8 MB
};

const PRO_LIMITS: PlanLimits = PlanLimits {
    max_members: 10_000,
    max_channels: 500,
    max_roles: 250,
    max_voice_concurrent: 100,
    max_storage_total_bytes: 50 * 1024 * 1024 * 1024, // 50 GB
    max_file_size_bytes: 50 * 1024 * 1024,            // 50 MB
};

impl PlanLimits {
    /// Get the hardcoded limits for a given plan tier.
    #[must_use]
    pub fn for_plan(plan: Plan) -> Self {
        match plan {
            Plan::Free => FREE_LIMITS,
            Plan::Pro => PRO_LIMITS,
        }
    }

    /// Get the limit value for a specific resource kind.
    #[must_use]
    pub fn limit_for(&self, resource: ResourceKind) -> u64 {
        match resource {
            ResourceKind::Members => self.max_members,
            ResourceKind::Channels => self.max_channels,
            ResourceKind::Roles => self.max_roles,
            ResourceKind::VoiceConcurrent => self.max_voice_concurrent,
            ResourceKind::StorageTotalBytes => self.max_storage_total_bytes,
            ResourceKind::MaxFileSizeBytes => self.max_file_size_bytes,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // -- Free plan limits match spec -----------------------------------------

    #[test]
    fn free_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Free);

        assert_eq!(limits.max_members, 200);
        assert_eq!(limits.max_channels, 50);
        assert_eq!(limits.max_roles, 20);
        assert_eq!(limits.max_voice_concurrent, 12);
        assert_eq!(limits.max_storage_total_bytes, 1024 * 1024 * 1024); // 1 GB
        assert_eq!(limits.max_file_size_bytes, 8 * 1024 * 1024); // 8 MB
    }

    // -- Pro plan limits match spec ------------------------------------------

    #[test]
    fn pro_plan_limits_match_spec() {
        let limits = PlanLimits::for_plan(Plan::Pro);

        assert_eq!(limits.max_members, 10_000);
        assert_eq!(limits.max_channels, 500);
        assert_eq!(limits.max_roles, 250);
        assert_eq!(limits.max_voice_concurrent, 100);
        assert_eq!(limits.max_storage_total_bytes, 50 * 1024 * 1024 * 1024); // 50 GB
        assert_eq!(limits.max_file_size_bytes, 50 * 1024 * 1024); // 50 MB
    }

    // -- limit_for returns correct value for each ResourceKind ---------------

    #[test]
    fn limit_for_members() {
        let limits = PlanLimits::for_plan(Plan::Free);
        assert_eq!(limits.limit_for(ResourceKind::Members), 200);
    }

    #[test]
    fn limit_for_channels() {
        let limits = PlanLimits::for_plan(Plan::Free);
        assert_eq!(limits.limit_for(ResourceKind::Channels), 50);
    }

    #[test]
    fn limit_for_roles() {
        let limits = PlanLimits::for_plan(Plan::Pro);
        assert_eq!(limits.limit_for(ResourceKind::Roles), 250);
    }

    #[test]
    fn limit_for_voice_concurrent() {
        let limits = PlanLimits::for_plan(Plan::Free);
        assert_eq!(limits.limit_for(ResourceKind::VoiceConcurrent), 12);
    }

    #[test]
    fn limit_for_storage_total_bytes() {
        let limits = PlanLimits::for_plan(Plan::Pro);
        assert_eq!(
            limits.limit_for(ResourceKind::StorageTotalBytes),
            50 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn limit_for_max_file_size_bytes() {
        let limits = PlanLimits::for_plan(Plan::Free);
        assert_eq!(
            limits.limit_for(ResourceKind::MaxFileSizeBytes),
            8 * 1024 * 1024
        );
    }

    // -- Plan FromStr round-trip ---------------------------------------------

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

    // -- Plan serde round-trip -----------------------------------------------

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

    // -- Invalid plan string rejected ----------------------------------------

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
        let result = "Free".parse::<Plan>();
        assert!(result.is_err());
    }

    #[test]
    fn plan_serde_rejects_invalid() {
        let result = serde_json::from_str::<Plan>(r#""enterprise""#);
        assert!(result.is_err());
    }

    // -- ResourceKind display_name returns correct strings -------------------

    #[test]
    fn resource_kind_display_names() {
        assert_eq!(ResourceKind::Members.display_name(), "members");
        assert_eq!(ResourceKind::Channels.display_name(), "channels");
        assert_eq!(ResourceKind::Roles.display_name(), "roles");
        assert_eq!(
            ResourceKind::VoiceConcurrent.display_name(),
            "concurrent voice users"
        );
        assert_eq!(
            ResourceKind::StorageTotalBytes.display_name(),
            "bytes of total storage"
        );
        assert_eq!(
            ResourceKind::MaxFileSizeBytes.display_name(),
            "bytes per file"
        );
    }

    // -- Display impls -------------------------------------------------------

    #[test]
    fn plan_display() {
        assert_eq!(format!("{}", Plan::Free), "free");
        assert_eq!(format!("{}", Plan::Pro), "pro");
    }

    #[test]
    fn resource_kind_display() {
        assert_eq!(format!("{}", ResourceKind::Members), "members");
        assert_eq!(format!("{}", ResourceKind::Channels), "channels");
    }
}
