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
    fn can_moderate_enforces_strict_hierarchy() {
        // Owner can moderate everyone
        assert!(Role::Owner.can_moderate(Role::Admin));
        assert!(Role::Owner.can_moderate(Role::Moderator));
        assert!(Role::Owner.can_moderate(Role::Member));

        // Admin can moderate moderator and member
        assert!(Role::Admin.can_moderate(Role::Moderator));
        assert!(Role::Admin.can_moderate(Role::Member));
        // Admin cannot moderate admin or owner
        assert!(!Role::Admin.can_moderate(Role::Admin));
        assert!(!Role::Admin.can_moderate(Role::Owner));

        // Moderator can moderate member only
        assert!(Role::Moderator.can_moderate(Role::Member));
        assert!(!Role::Moderator.can_moderate(Role::Moderator));
        assert!(!Role::Moderator.can_moderate(Role::Admin));

        // Member cannot moderate anyone
        assert!(!Role::Member.can_moderate(Role::Member));
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

    #[test]
    fn invalid_role_rejected() {
        let result = "superadmin".parse::<Role>();
        assert!(result.is_err());

        let result = "".parse::<Role>();
        assert!(result.is_err());
    }

    #[test]
    fn serde_round_trip() {
        let role = Role::Moderator;
        let json = serde_json::to_string(&role).unwrap();
        assert_eq!(json, r#""moderator""#);

        let parsed: Role = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, role);
    }

    #[test]
    fn serde_invalid_role_rejected() {
        let result: Result<Role, _> = serde_json::from_str(r#""superadmin""#);
        assert!(result.is_err());
    }
}
