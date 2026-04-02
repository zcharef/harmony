# ADR-037: Permission Bitmask Invariants

**Status:** Accepted
**Date:** 2026-03-16

## Context

A permission system using bitmasks can have subtle bugs if invariants are not enforced:

```rust
// BAD: overlapping bits — SEND_MESSAGES and MANAGE_CHANNELS share bit 2
const SEND_MESSAGES: u64 = 0b0110;  // bits 1 and 2
const MANAGE_CHANNELS: u64 = 0b0100; // bit 2 — OVERLAPS with SEND_MESSAGES!

// Granting SEND_MESSAGES accidentally grants part of MANAGE_CHANNELS.
// Revoking MANAGE_CHANNELS accidentally revokes part of SEND_MESSAGES.
```

```rust
// BAD: non-power-of-2 constant — represents multiple permissions
const VIEW_CHANNELS: u64 = 3; // 0b11 — this is TWO bits, not one permission
```

Without invariants, the permission system silently grants unintended permissions or fails to revoke them.

## Decision

All permission constants must be **powers of 2** (`1 << n`), with **no overlapping bits**. Deny overrides allow in `compute_permissions()`.

```rust
// GOOD: each permission is exactly one bit — 1 << n
pub struct Permissions;

impl Permissions {
    pub const VIEW_CHANNELS: u64      = 1 << 0;  // 0x0000_0001
    pub const SEND_MESSAGES: u64      = 1 << 1;  // 0x0000_0002
    pub const MANAGE_MESSAGES: u64    = 1 << 2;  // 0x0000_0004
    pub const MANAGE_CHANNELS: u64    = 1 << 3;  // 0x0000_0008
    pub const MANAGE_ROLES: u64       = 1 << 4;  // 0x0000_0010
    pub const MANAGE_SERVER: u64      = 1 << 5;  // 0x0000_0020
    pub const KICK_MEMBERS: u64       = 1 << 6;  // 0x0000_0040
    pub const BAN_MEMBERS: u64        = 1 << 7;  // 0x0000_0080
    pub const ADMINISTRATOR: u64      = 1 << 8;  // 0x0000_0100
    pub const ATTACH_FILES: u64       = 1 << 9;  // 0x0000_0200
    pub const MENTION_EVERYONE: u64   = 1 << 10; // 0x0000_0400
}
```

**Deny overrides allow in `compute_permissions()`:**
```rust
pub fn compute_permissions(roles: &[Role], channel_overrides: &[Override]) -> u64 {
    let mut allow: u64 = 0;
    let mut deny: u64 = 0;

    // Accumulate role permissions
    for role in roles {
        allow |= role.permissions;
    }

    // Apply channel-level overrides
    for ov in channel_overrides {
        allow |= ov.allow;
        deny |= ov.deny;
    }

    // Deny wins over allow — this is the critical invariant
    allow & !deny
}
```

## Consequences

**Positive:**
- Each permission is independently grantable and revocable — no unintended side effects
- Bitmask operations (`|`, `&`, `!`) are O(1) — permission checks are constant time
- "Deny wins over allow" is simple, predictable, and matches Discord's model
- 64 bits support up to 64 distinct permissions

**Negative:**
- Limited to 64 permissions with `u64` (use `u128` or `BitVec` if more are needed)
- Bitmask arithmetic is error-prone — unit tests are critical
- Permission names are not self-documenting in the database (stored as integers)

## Enforcement

- **Unit test:** Verifies every permission constant is a power of 2: `assert!(perm.count_ones() == 1)` for each constant
- **Unit test:** Verifies no two permission constants share a bit: `assert!(perm_a & perm_b == 0)` for all pairs
- **Unit test:** Verifies deny-wins-over-allow: `compute_permissions` with a deny override produces `allow & !deny`
- **Location:** `src/domain/models/permissions.rs` (or equivalent)
