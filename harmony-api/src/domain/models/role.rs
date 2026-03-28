//! Server member role domain logic.
//!
//! WHY: Centralizes role hierarchy and validation. The DB stores roles as TEXT
//! with values: owner, admin, moderator, member. This module provides
//! type-safe comparisons and validation without introducing a Postgres enum
//! (avoids migration pain on future role additions).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Strongly-typed role enum matching the `server_members.role` TEXT column.
///
/// Variants are ordered by authority level (Member < Moderator < Admin < Owner).
/// `PartialOrd`/`Ord` are manually avoided to prevent accidental comparisons;
/// use `level()` or `can_moderate()` for hierarchy checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Member,
    Moderator,
    Admin,
    Owner,
}

impl Role {
    /// Numeric authority level. Higher value = more authority.
    #[must_use]
    pub fn level(self) -> u8 {
        match self {
            Self::Member => 1,
            Self::Moderator => 2,
            Self::Admin => 3,
            Self::Owner => 4,
        }
    }

    /// Check whether `self` strictly outranks `target` in the role hierarchy.
    ///
    /// Used for moderation: admins can moderate moderators/members,
    /// but not other admins or the owner.
    #[must_use]
    pub fn can_moderate(self, target: Self) -> bool {
        self.level() > target.level()
    }

    /// Check whether this role can be assigned via the `assign_role` endpoint.
    /// Owner role requires the `transfer_ownership` flow instead.
    #[must_use]
    pub fn is_assignable(self) -> bool {
        !matches!(self, Self::Owner)
    }

    /// The canonical lowercase string stored in the DB.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Moderator => "moderator",
            Self::Member => "member",
        }
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Role {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "owner" => Ok(Self::Owner),
            "admin" => Ok(Self::Admin),
            "moderator" => Ok(Self::Moderator),
            "member" => Ok(Self::Member),
            _ => Err(format!("Invalid role: '{s}'")),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn role_levels_are_ordered() {
        assert!(Role::Owner.level() > Role::Admin.level());
        assert!(Role::Admin.level() > Role::Moderator.level());
        assert!(Role::Moderator.level() > Role::Member.level());
    }

    #[test]
    fn role_levels_have_exact_values() {
        assert_eq!(Role::Member.level(), 1);
        assert_eq!(Role::Moderator.level(), 2);
        assert_eq!(Role::Admin.level(), 3);
        assert_eq!(Role::Owner.level(), 4);
    }

    /// Full 4x4 `can_moderate` matrix (16 combinations).
    /// `can_moderate` is strict greater-than: only returns true when
    /// `actor.level()` > `target.level()`.
    #[test]
    fn can_moderate_full_matrix() {
        let all_roles = [Role::Owner, Role::Admin, Role::Moderator, Role::Member];

        // Expected results: (actor, target) -> can_moderate
        let expected: &[(Role, Role, bool)] = &[
            // Owner (4) vs all
            (Role::Owner, Role::Owner, false),
            (Role::Owner, Role::Admin, true),
            (Role::Owner, Role::Moderator, true),
            (Role::Owner, Role::Member, true),
            // Admin (3) vs all
            (Role::Admin, Role::Owner, false),
            (Role::Admin, Role::Admin, false),
            (Role::Admin, Role::Moderator, true),
            (Role::Admin, Role::Member, true),
            // Moderator (2) vs all
            (Role::Moderator, Role::Owner, false),
            (Role::Moderator, Role::Admin, false),
            (Role::Moderator, Role::Moderator, false),
            (Role::Moderator, Role::Member, true),
            // Member (1) vs all
            (Role::Member, Role::Owner, false),
            (Role::Member, Role::Admin, false),
            (Role::Member, Role::Moderator, false),
            (Role::Member, Role::Member, false),
        ];

        // Verify we test every combination
        assert_eq!(expected.len(), all_roles.len() * all_roles.len());

        for &(actor, target, should_moderate) in expected {
            assert_eq!(
                actor.can_moderate(target),
                should_moderate,
                "{} (level {}) can_moderate {} (level {}) should be {}",
                actor,
                actor.level(),
                target,
                target.level(),
                should_moderate,
            );
        }
    }

    /// Verify that same-level roles NEVER moderate each other (diagonal is all false).
    #[test]
    fn same_role_cannot_moderate_self() {
        for role in [Role::Owner, Role::Admin, Role::Moderator, Role::Member] {
            assert!(
                !role.can_moderate(role),
                "{} should not be able to moderate itself",
                role,
            );
        }
    }

    #[test]
    fn owner_is_not_assignable() {
        assert!(!Role::Owner.is_assignable());
        assert!(Role::Admin.is_assignable());
        assert!(Role::Moderator.is_assignable());
        assert!(Role::Member.is_assignable());
    }

    #[test]
    fn round_trip_from_str() {
        for role in [Role::Owner, Role::Admin, Role::Moderator, Role::Member] {
            let parsed: Role = role.as_str().parse().unwrap();
            assert_eq!(parsed, role);
        }
    }

    /// Display round-trip: `Display` -> `FromStr` -> original value.
    #[test]
    fn display_round_trip() {
        for role in [Role::Owner, Role::Admin, Role::Moderator, Role::Member] {
            let displayed = format!("{}", role);
            let parsed: Role = displayed.parse().unwrap();
            assert_eq!(parsed, role, "Display round-trip failed for {:?}", role);
        }
    }

    /// `as_str` must match the lowercase DB representation.
    #[test]
    fn as_str_matches_db_values() {
        assert_eq!(Role::Owner.as_str(), "owner");
        assert_eq!(Role::Admin.as_str(), "admin");
        assert_eq!(Role::Moderator.as_str(), "moderator");
        assert_eq!(Role::Member.as_str(), "member");
    }

    #[test]
    fn invalid_role_rejected() {
        let result = "superadmin".parse::<Role>();
        assert!(result.is_err());

        let result = "".parse::<Role>();
        assert!(result.is_err());
    }

    /// Case-sensitive: uppercase variants must be rejected.
    #[test]
    fn case_sensitive_role_parsing() {
        assert!("Owner".parse::<Role>().is_err());
        assert!("ADMIN".parse::<Role>().is_err());
        assert!("Moderator".parse::<Role>().is_err());
        assert!("MEMBER".parse::<Role>().is_err());
    }

    #[test]
    fn serde_round_trip() {
        for role in [Role::Owner, Role::Admin, Role::Moderator, Role::Member] {
            let json = serde_json::to_string(&role).unwrap();
            let parsed: Role = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, role, "Serde round-trip failed for {:?}", role);
        }
    }

    /// Serde serializes to lowercase JSON strings matching DB values.
    #[test]
    fn serde_serializes_to_lowercase() {
        assert_eq!(serde_json::to_string(&Role::Owner).unwrap(), r#""owner""#);
        assert_eq!(serde_json::to_string(&Role::Admin).unwrap(), r#""admin""#);
        assert_eq!(
            serde_json::to_string(&Role::Moderator).unwrap(),
            r#""moderator""#
        );
        assert_eq!(serde_json::to_string(&Role::Member).unwrap(), r#""member""#);
    }

    #[test]
    fn serde_invalid_role_rejected() {
        let result: Result<Role, _> = serde_json::from_str(r#""superadmin""#);
        assert!(result.is_err());
    }
}
