//! Friendship domain model.
//!
//! Two relationship tables back these types: `friendships`
//! (pending/accepted, requester→addressee) and `user_blocks` (directional).
//! `blocked` is a derived relationship state, never a `friendships.status`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::ids::UserId;

/// State of a `friendships` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FriendshipStatus {
    Pending,
    Accepted,
}

/// Direction of a pending friend request relative to the querying user.
///
/// Lives in the DOMAIN (not the DTO layer) so both the DTO response and the
/// `FriendRequestPayload` SSE event can carry it without the domain importing
/// from `api/` (which the hexagonal boundary test forbids). Same treatment as
/// [`super::UserStatus`]. Single words, so `camelCase` yields lowercase
/// `incoming`/`outgoing` — the shape the Zod mirror expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestDirection {
    Incoming,
    Outgoing,
}

/// A `friendships` row (pending or accepted).
#[derive(Debug, Clone)]
pub struct Friendship {
    pub requester_id: UserId,
    pub addressee_id: UserId,
    pub status: FriendshipStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A friend (accepted friendship) joined with the counterpart's profile.
///
/// `friends_since` maps to `friendships.updated_at` (accept time), not
/// `created_at` (request time).
#[derive(Debug, Clone)]
pub struct FriendRow {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub friends_since: DateTime<Utc>,
}

/// A pending friend request joined with the counterpart's profile.
#[derive(Debug, Clone)]
pub struct FriendRequestRow {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub direction: RequestDirection,
    pub created_at: DateTime<Utc>,
}

/// A blocked user joined with the counterpart's profile.
#[derive(Debug, Clone)]
pub struct BlockedUserRow {
    pub user_id: UserId,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub blocked_at: DateTime<Utc>,
}

/// Result of a `create_request` state-machine transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestOutcome {
    /// A fresh pending request was inserted.
    Requested,
    /// A reverse-direction pending request existed and flipped to accepted.
    AutoAccepted,
    /// The caller already has an outgoing pending request (idempotent no-op).
    AlreadyRequested,
    /// The pair is already friends (idempotent no-op).
    AlreadyFriends,
}

/// Result of a `create_block` transition — describes what was torn down so the
/// handler knows which SSE events to publish (§4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockOutcome {
    /// The block row already existed (idempotent PUT — nothing torn down).
    AlreadyBlocked,
    /// A fresh block was inserted; nothing else existed between the pair.
    Blocked,
    /// A fresh block was inserted and an accepted friendship was deleted.
    BlockedWasFriends,
    /// A fresh block was inserted and a pending request was deleted.
    BlockedWasPending,
}
