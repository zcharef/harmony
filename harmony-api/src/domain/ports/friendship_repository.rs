//! Port: friendship + block persistence.
//!
//! One port per concern (blocks included) — the friendship state machine and
//! the directional block list are queried and mutated together, so they share
//! a repository like `DmRepository` owns all DM queries.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::friendship::{
    BlockOutcome, BlockedUserRow, FriendRequestRow, FriendRow, Friendship, RequestDirection,
    RequestOutcome,
};
use crate::domain::models::{ChannelId, UserId};

/// Intent-based repository for friendships and blocks.
#[async_trait]
pub trait FriendshipRepository: Send + Sync + std::fmt::Debug {
    /// Create a pending friend request, resolving the mutual-request race in one
    /// transaction guarded by a pair-scoped advisory lock (§3.2).
    async fn create_request(
        &self,
        requester: &UserId,
        addressee: &UserId,
    ) -> Result<RequestOutcome, DomainError>;

    /// Accept a pending request FROM `requester` TO `caller`.
    ///
    /// Returns the now-accepted `Friendship`, or `NotFound` if no pending row
    /// exists (covers the cancel race and the block race — the row is gone).
    async fn accept_request(
        &self,
        caller: &UserId,
        requester: &UserId,
    ) -> Result<Friendship, DomainError>;

    /// Delete a pending request between `caller` and `other` (decline if
    /// incoming, cancel if outgoing). Returns `false` if nothing was deleted.
    async fn delete_request(&self, caller: &UserId, other: &UserId) -> Result<bool, DomainError>;

    /// Delete an accepted friendship between the pair (either direction).
    /// Returns `false` if the pair was not friends (idempotent unfriend).
    async fn delete_friendship(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError>;

    /// List the caller's friends, joined with each counterpart's profile,
    /// ordered by username ASC. Whole bounded list (§3.1).
    async fn list_friends(&self, user: &UserId) -> Result<Vec<FriendRow>, DomainError>;

    /// List the caller's pending requests in the given direction, joined with
    /// each counterpart's profile, ordered by `created_at DESC`. Whole list.
    async fn list_requests(
        &self,
        user: &UserId,
        direction: RequestDirection,
    ) -> Result<Vec<FriendRequestRow>, DomainError>;

    /// List the caller's friend ids (accepted, either direction). Used for SSE
    /// receiver-side presence scoping and the `presence.sync` snapshot (§4.3).
    async fn list_friend_ids(&self, user: &UserId) -> Result<Vec<UserId>, DomainError>;

    /// Whether the pair are accepted friends (either direction).
    async fn are_friends(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError>;

    /// Count the caller's accepted friends.
    async fn count_friends(&self, user: &UserId) -> Result<i64, DomainError>;

    /// Count the caller's outgoing pending requests.
    async fn count_outgoing_pending(&self, user: &UserId) -> Result<i64, DomainError>;

    /// Insert a block and tear down any friendship/pending request between the
    /// pair in one transaction. Returns what was torn down (drives events).
    async fn create_block(
        &self,
        blocker: &UserId,
        blocked: &UserId,
    ) -> Result<BlockOutcome, DomainError>;

    /// Delete a block row. Returns `false` if nothing was deleted (idempotent).
    async fn delete_block(&self, blocker: &UserId, blocked: &UserId) -> Result<bool, DomainError>;

    /// List the caller's blocks, joined with each counterpart's profile, ordered
    /// by `created_at DESC`. Whole bounded list.
    async fn list_blocks(&self, blocker: &UserId) -> Result<Vec<BlockedUserRow>, DomainError>;

    /// Count the caller's blocks.
    async fn count_blocks(&self, blocker: &UserId) -> Result<i64, DomainError>;

    /// Whether a block exists in EITHER direction between the pair (one probe).
    async fn is_blocked_between(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError>;

    /// Whether the pair share at least one non-DM server (DM-gate helper, §3.4).
    async fn share_non_dm_server(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError>;

    /// Whether sending into DM `channel_id` is blocked: `true` iff the channel
    /// belongs to a DM server AND a block exists in either direction between
    /// `author` and the other DM member. `false` for non-DM channels. One SQL
    /// statement resolving the other member + the block (§3.4).
    async fn dm_send_blocked(
        &self,
        author: &UserId,
        channel_id: &ChannelId,
    ) -> Result<bool, DomainError>;
}
