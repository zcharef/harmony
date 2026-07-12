//! Platform-admin (founder) view models.
//!
//! WHY: The founder-only admin panel needs a compact user summary (search
//! results) and a quota view (plan + limits + current usage). These are pure
//! read models assembled by the admin repository; they carry no infra deps.

use crate::domain::models::{Plan, PlanLimits, UserId};

/// One row in the founder's user-search results.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminUserSummary {
    pub id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub plan: Plan,
    /// Holds the `founding` badge (one of the first accounts).
    pub is_founding: bool,
    /// Holds the `official` verified badge (staff account).
    pub is_official: bool,
}

/// Current resource usage for a user, counted against their per-user limits.
///
/// Mirrors the COUNT queries the plan checker runs before a POST — surfaced
/// read-only so the founder can see how close a user is to their caps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminUserUsage {
    pub owned_servers: u64,
    pub joined_servers: u64,
    pub open_dms: u64,
}

/// A user's plan, its per-user limits, and their current usage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdminUserQuota {
    pub plan: Plan,
    pub limits: PlanLimits,
    pub usage: AdminUserUsage,
}
