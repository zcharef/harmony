#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    clippy::doc_markdown
)]
//! Permission matrix tests for role hierarchy enforcement.
//!
//! These tests verify the domain-level permission constants and logic that
//! protect every moderation and role-assignment operation. They test the
//! domain layer directly (no HTTP, no DB) -- same pattern as architecture_test.rs.
//!
//! Rules enforced:
//! 1. Role hierarchy is strictly ordered: Owner(4) > Admin(3) > Moderator(2) > Member(1)
//! 2. can_moderate uses strict greater-than (same level cannot moderate each other)
//! 3. Owner role cannot be assigned via assign_role (is_assignable = false)
//! 4. Only four valid role values exist
//! 5. Role string representations match DB TEXT column values

use harmony_api::domain::models::role::Role;

/// All roles in descending authority order.
const ALL_ROLES: [Role; 4] = [Role::Owner, Role::Admin, Role::Moderator, Role::Member];

/// Expected (role, level) pairs.
const ROLE_LEVELS: [(Role, u8); 4] = [
    (Role::Member, 1),
    (Role::Moderator, 2),
    (Role::Admin, 3),
    (Role::Owner, 4),
];

// ─── Hierarchy ordering ────────────────────────────────────────────

#[test]
fn hierarchy_is_strictly_ordered() {
    for window in ROLE_LEVELS.windows(2) {
        let (lower_role, lower_level) = window[0];
        let (higher_role, higher_level) = window[1];
        assert!(
            higher_level > lower_level,
            "{} (level {}) must be strictly above {} (level {})",
            higher_role,
            higher_level,
            lower_role,
            lower_level,
        );
    }
}

#[test]
fn no_two_roles_share_a_level() {
    let mut levels: Vec<u8> = ALL_ROLES.iter().map(|r| r.level()).collect();
    levels.sort_unstable();
    levels.dedup();
    assert_eq!(
        levels.len(),
        ALL_ROLES.len(),
        "All roles must have unique levels; found duplicates",
    );
}

#[test]
fn level_values_match_specification() {
    for &(role, expected_level) in &ROLE_LEVELS {
        assert_eq!(
            role.level(),
            expected_level,
            "{} should have level {} but has {}",
            role,
            expected_level,
            role.level(),
        );
    }
}

// ─── can_moderate full matrix ──────────────────────────────────────

/// Verify the full 4x4 can_moderate matrix (16 combinations).
///
/// The rule is: actor can moderate target iff actor.level() > target.level().
/// This means the diagonal (same role) is always false.
#[test]
fn can_moderate_matrix_matches_strict_greater_than() {
    let mut tested = 0u32;

    for &actor in &ALL_ROLES {
        for &target in &ALL_ROLES {
            let expected = actor.level() > target.level();
            assert_eq!(
                actor.can_moderate(target),
                expected,
                "can_moderate({}, {}) should be {} (levels: {} vs {})",
                actor,
                target,
                expected,
                actor.level(),
                target.level(),
            );
            tested += 1;
        }
    }

    assert_eq!(tested, 16, "Must test all 16 role x role combinations",);
}

/// The diagonal: no role can moderate itself.
#[test]
fn diagonal_is_all_false() {
    for &role in &ALL_ROLES {
        assert!(
            !role.can_moderate(role),
            "{} must not be able to moderate itself",
            role,
        );
    }
}

/// Member cannot moderate anyone (entire row is false).
#[test]
fn member_cannot_moderate_anyone() {
    for &target in &ALL_ROLES {
        assert!(
            !Role::Member.can_moderate(target),
            "Member must not be able to moderate {}",
            target,
        );
    }
}

/// Owner can moderate everyone except itself.
#[test]
fn owner_can_moderate_all_except_self() {
    for &target in &ALL_ROLES {
        if target == Role::Owner {
            assert!(!Role::Owner.can_moderate(target));
        } else {
            assert!(
                Role::Owner.can_moderate(target),
                "Owner must be able to moderate {}",
                target,
            );
        }
    }
}

// ─── is_assignable ─────────────────────────────────────────────────

#[test]
fn only_owner_is_not_assignable() {
    for &role in &ALL_ROLES {
        if role == Role::Owner {
            assert!(
                !role.is_assignable(),
                "Owner must not be assignable via assign_role",
            );
        } else {
            assert!(role.is_assignable(), "{} must be assignable", role,);
        }
    }
}

// ─── String representations ────────────────────────────────────────

/// The four DB text values are the only valid role strings.
#[test]
fn only_four_valid_role_strings() {
    let valid_strings = ["owner", "admin", "moderator", "member"];

    for s in &valid_strings {
        assert!(
            s.parse::<Role>().is_ok(),
            "'{}' must parse to a valid Role",
            s,
        );
    }

    let invalid_strings = [
        "",
        "Owner",
        "ADMIN",
        "superadmin",
        "mod",
        "user",
        "guest",
        "banned",
        " member",
        "member ",
    ];

    for s in &invalid_strings {
        assert!(
            s.parse::<Role>().is_err(),
            "'{}' must be rejected as an invalid role",
            s,
        );
    }
}

/// as_str round-trips through FromStr for all roles.
#[test]
fn as_str_round_trips_through_from_str() {
    for &role in &ALL_ROLES {
        let s = role.as_str();
        let parsed: Role = s.parse().unwrap();
        assert_eq!(parsed, role);
    }
}

/// Display uses the same lowercase DB representation.
#[test]
fn display_matches_as_str() {
    for &role in &ALL_ROLES {
        assert_eq!(
            format!("{}", role),
            role.as_str(),
            "Display and as_str must produce identical output for {:?}",
            role,
        );
    }
}

// ─── Invariant: can_moderate is antisymmetric ──────────────────────

/// If A can moderate B, then B cannot moderate A.
/// This ensures no mutual-moderation scenarios exist.
#[test]
fn can_moderate_is_antisymmetric() {
    for &a in &ALL_ROLES {
        for &b in &ALL_ROLES {
            if a.can_moderate(b) {
                assert!(
                    !b.can_moderate(a),
                    "Antisymmetry violated: {} can moderate {} AND {} can moderate {}",
                    a,
                    b,
                    b,
                    a,
                );
            }
        }
    }
}

/// Transitivity: if A can moderate B and B can moderate C, then A can moderate C.
#[test]
fn can_moderate_is_transitive() {
    for &a in &ALL_ROLES {
        for &b in &ALL_ROLES {
            for &c in &ALL_ROLES {
                if a.can_moderate(b) && b.can_moderate(c) {
                    assert!(
                        a.can_moderate(c),
                        "Transitivity violated: {} > {} and {} > {} but {} cannot moderate {}",
                        a,
                        b,
                        b,
                        c,
                        a,
                        c,
                    );
                }
            }
        }
    }
}
