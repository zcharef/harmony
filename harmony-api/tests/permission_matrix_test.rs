#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout,
    clippy::doc_markdown
)]
//! Permission matrix tests — mathematical invariant proofs for the role hierarchy.
//!
//! Basic role behavior (level values, can_moderate matrix, is_assignable, string
//! parsing) is covered by inline unit tests in `src/domain/models/role.rs`.
//! This file focuses on algebraic properties that act as safety nets against
//! future regressions in the hierarchy logic.

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
