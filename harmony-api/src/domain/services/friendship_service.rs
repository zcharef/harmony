//! Friendship domain service — state machine, caps, block gates.

use std::sync::Arc;
use std::time::Duration;

use crate::domain::errors::DomainError;
use crate::domain::models::friendship::{
    BlockOutcome, BlockedUserRow, FriendRequestRow, FriendRow, Friendship, FriendshipStatus,
    RequestDirection, RequestOutcome,
};
use crate::domain::models::{Profile, UserId};
use crate::domain::ports::{FriendshipRepository, ProfileRepository};
use crate::domain::services::SpamGuard;

/// Friend requests per user per hour (`SpamGuard`).
const FRIEND_REQUEST_RATE: usize = 15;
/// Blocks per user per hour (`SpamGuard`).
const BLOCK_RATE: usize = 30;
/// The rate-limit window for both friend requests and blocks.
const RATE_WINDOW: Duration = Duration::from_secs(3600);
/// Maximum outgoing pending requests per user (DB cap).
pub const MAX_OUTGOING_PENDING: i64 = 100;
/// Maximum accepted friends per user (DB cap).
pub const MAX_FRIENDS: i64 = 1_000;
/// Maximum blocks per user (DB cap).
pub const MAX_BLOCKS: i64 = 1_000;

/// Username format shared with the DB `CHECK` and the client Zod mirror.
fn is_valid_username(username: &str) -> bool {
    let len = username.chars().count();
    (3..=32).contains(&len)
        && username
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The minimal existing-pair state the transition decision needs.
///
/// WHY a struct (not the full `Friendship`): the pure decision only reads the
/// requester id and the status; keeping the input small keeps the unit test
/// focused and lets the repo build it from a `SELECT ... FOR UPDATE`.
#[derive(Debug, Clone)]
pub struct ExistingRequest {
    pub requester_id: UserId,
    pub status: FriendshipStatus,
}

/// Pure state-machine decision for a friend request (§1.2). Extracted for unit
/// testing without repos (the way `validate_dm_participants` was), and reused by
/// the repository INSIDE its advisory-locked transaction so there is exactly one
/// encoding of the rules.
///
/// - self → `ValidationError`
/// - no existing row → `Requested`
/// - existing pending, caller is requester → `AlreadyRequested`
/// - existing pending, caller is addressee (reverse) → `AutoAccepted`
/// - existing accepted → `AlreadyFriends`
///
/// # Errors
/// Returns `ValidationError` when `caller == target`.
pub fn resolve_request_transition(
    caller: &UserId,
    target: &UserId,
    existing: Option<&ExistingRequest>,
) -> Result<RequestOutcome, DomainError> {
    if caller == target {
        return Err(DomainError::ValidationError(
            "Cannot send a friend request to yourself".to_string(),
        ));
    }
    match existing {
        None => Ok(RequestOutcome::Requested),
        Some(row) => match row.status {
            FriendshipStatus::Accepted => Ok(RequestOutcome::AlreadyFriends),
            FriendshipStatus::Pending => {
                if row.requester_id == *caller {
                    Ok(RequestOutcome::AlreadyRequested)
                } else {
                    Ok(RequestOutcome::AutoAccepted)
                }
            }
        },
    }
}

/// How the caller identified the target of a friend request.
#[derive(Debug)]
pub enum RequestTarget {
    /// By exact user id (member context menu).
    Id(UserId),
    /// By exact username (Add Friend bar) — normalized + validated here.
    Username(String),
}

/// Service for friendship / block business logic.
#[derive(Debug)]
pub struct FriendshipService {
    friendship_repo: Arc<dyn FriendshipRepository>,
    profile_repo: Arc<dyn ProfileRepository>,
    spam_guard: Arc<SpamGuard>,
}

impl FriendshipService {
    #[must_use]
    pub fn new(
        friendship_repo: Arc<dyn FriendshipRepository>,
        profile_repo: Arc<dyn ProfileRepository>,
        spam_guard: Arc<SpamGuard>,
    ) -> Self {
        Self {
            friendship_repo,
            profile_repo,
            spam_guard,
        }
    }

    /// Resolve a request target to its profile (username lookup is authoritative
    /// here — client normalization is UX-only).
    async fn resolve_target(&self, target: RequestTarget) -> Result<Profile, DomainError> {
        match target {
            RequestTarget::Id(id) => {
                self.profile_repo
                    .get_by_id(&id)
                    .await?
                    .ok_or_else(|| DomainError::NotFound {
                        resource_type: "User",
                        id: id.to_string(),
                    })
            }
            RequestTarget::Username(raw) => {
                let normalized = raw.trim().to_lowercase();
                if !is_valid_username(&normalized) {
                    return Err(DomainError::ValidationError(
                        "Invalid username format".to_string(),
                    ));
                }
                self.profile_repo
                    .get_by_username(&normalized)
                    .await?
                    .ok_or(DomainError::NotFound {
                        resource_type: "User",
                        id: normalized,
                    })
            }
        }
    }

    /// Send a friend request (§3.2). Returns the outcome + the counterpart's
    /// profile so the handler can publish events and build the response.
    ///
    /// # Errors
    /// - `ValidationError` self-request / bad username format
    /// - `NotFound` unknown user
    /// - `Forbidden` a block exists in either direction
    /// - `Conflict` pending-outgoing or friends cap reached
    /// - `RateLimited` 15/hour exceeded
    pub async fn send_request(
        &self,
        caller: &UserId,
        target: RequestTarget,
    ) -> Result<(RequestOutcome, Profile), DomainError> {
        let profile = self.resolve_target(target).await?;
        let addressee = profile.id.clone();

        if *caller == addressee {
            return Err(DomainError::ValidationError(
                "Cannot send a friend request to yourself".to_string(),
            ));
        }

        // WHY block check before recording the rate action: a blocked pair must
        // never learn direction, and a 403 must not consume the sender's budget.
        if self
            .friendship_repo
            .is_blocked_between(caller, &addressee)
            .await?
        {
            return Err(DomainError::Forbidden(
                "Cannot send a friend request to this user".to_string(),
            ));
        }

        // Caps (approximate under concurrency, §3.2 — do NOT add per-user locking).
        if self.friendship_repo.count_outgoing_pending(caller).await? >= MAX_OUTGOING_PENDING {
            return Err(DomainError::Conflict(
                "You have too many pending friend requests".to_string(),
            ));
        }
        if self.friendship_repo.count_friends(caller).await? >= MAX_FRIENDS {
            return Err(DomainError::Conflict("Friends list is full".to_string()));
        }

        self.spam_guard.check_and_record_action(
            caller,
            "friend_request",
            FRIEND_REQUEST_RATE,
            RATE_WINDOW,
        )?;

        let outcome = self
            .friendship_repo
            .create_request(caller, &addressee)
            .await?;

        tracing::info!(
            caller_id = %caller.0,
            addressee_id = %addressee.0,
            ?outcome,
            "friendship_request_created"
        );

        Ok((outcome, profile))
    }

    /// Accept a pending incoming request. Returns the friendship + counterpart.
    ///
    /// # Errors
    /// - `NotFound` no pending request from that user
    /// - `Conflict` either side's friends cap reached
    pub async fn accept_request(
        &self,
        caller: &UserId,
        requester: &UserId,
    ) -> Result<(Friendship, Profile), DomainError> {
        let friendship = self
            .friendship_repo
            .accept_request(caller, requester)
            .await?;
        let profile = self
            .profile_repo
            .get_by_id(requester)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "User",
                id: requester.to_string(),
            })?;

        tracing::info!(
            caller_id = %caller.0,
            requester_id = %requester.0,
            "friendship_accepted"
        );

        Ok((friendship, profile))
    }

    /// Decline (incoming) or cancel (outgoing) a pending request.
    ///
    /// # Errors
    /// - `NotFound` no pending request with that user
    pub async fn remove_request(&self, caller: &UserId, other: &UserId) -> Result<(), DomainError> {
        let removed = self.friendship_repo.delete_request(caller, other).await?;
        if !removed {
            return Err(DomainError::NotFound {
                resource_type: "FriendRequest",
                id: other.to_string(),
            });
        }
        tracing::info!(caller_id = %caller.0, other_id = %other.0, "friendship_request_removed");
        Ok(())
    }

    /// Unfriend (idempotent). Returns `true` if a friendship was actually removed
    /// (drives the conditional SSE publish, §4.2).
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn unfriend(&self, caller: &UserId, other: &UserId) -> Result<bool, DomainError> {
        let removed = self
            .friendship_repo
            .delete_friendship(caller, other)
            .await?;
        if removed {
            tracing::info!(caller_id = %caller.0, other_id = %other.0, "friendship_removed");
        }
        Ok(removed)
    }

    /// Block a user (idempotent PUT). Returns the outcome + counterpart profile.
    ///
    /// # Errors
    /// - `ValidationError` self-block
    /// - `NotFound` unknown user
    /// - `Conflict` blocks cap reached
    /// - `RateLimited` 30/hour exceeded
    pub async fn block(
        &self,
        caller: &UserId,
        target: &UserId,
    ) -> Result<(BlockOutcome, Profile), DomainError> {
        if caller == target {
            return Err(DomainError::ValidationError(
                "Cannot block yourself".to_string(),
            ));
        }
        let profile =
            self.profile_repo
                .get_by_id(target)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "User",
                    id: target.to_string(),
                })?;

        if self.friendship_repo.count_blocks(caller).await? >= MAX_BLOCKS {
            return Err(DomainError::Conflict(
                "You have blocked too many users".to_string(),
            ));
        }

        self.spam_guard
            .check_and_record_action(caller, "block", BLOCK_RATE, RATE_WINDOW)?;

        let outcome = self.friendship_repo.create_block(caller, target).await?;

        tracing::info!(caller_id = %caller.0, target_id = %target.0, ?outcome, "friendship_blocked");

        Ok((outcome, profile))
    }

    /// Unblock a user (idempotent). Returns `true` if a block was removed.
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn unblock(&self, caller: &UserId, target: &UserId) -> Result<bool, DomainError> {
        let removed = self.friendship_repo.delete_block(caller, target).await?;
        if removed {
            tracing::info!(caller_id = %caller.0, target_id = %target.0, "friendship_unblocked");
        }
        Ok(removed)
    }

    /// List the caller's friends (username order, whole list).
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn list_friends(&self, user: &UserId) -> Result<Vec<FriendRow>, DomainError> {
        self.friendship_repo.list_friends(user).await
    }

    /// List the caller's pending requests in a direction (newest first).
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn list_requests(
        &self,
        user: &UserId,
        direction: RequestDirection,
    ) -> Result<Vec<FriendRequestRow>, DomainError> {
        self.friendship_repo.list_requests(user, direction).await
    }

    /// List the caller's blocks (newest first).
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn list_blocks(&self, user: &UserId) -> Result<Vec<BlockedUserRow>, DomainError> {
        self.friendship_repo.list_blocks(user).await
    }

    /// The caller's friend ids (SSE receiver-side scoping + `presence.sync`).
    ///
    /// # Errors
    /// Repository errors only.
    pub async fn list_friend_ids(&self, user: &UserId) -> Result<Vec<UserId>, DomainError> {
        self.friendship_repo.list_friend_ids(user).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn uid(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }

    #[test]
    fn transition_none_is_requested() {
        assert_eq!(
            resolve_request_transition(&uid(1), &uid(2), None).unwrap(),
            RequestOutcome::Requested
        );
    }

    #[test]
    fn transition_same_direction_is_already_requested() {
        let existing = ExistingRequest {
            requester_id: uid(1),
            status: FriendshipStatus::Pending,
        };
        assert_eq!(
            resolve_request_transition(&uid(1), &uid(2), Some(&existing)).unwrap(),
            RequestOutcome::AlreadyRequested
        );
    }

    #[test]
    fn transition_reverse_is_auto_accepted() {
        // The reverse-pending row was created by uid(2) → uid(1); now uid(1)
        // sends to uid(2), which auto-accepts.
        let existing = ExistingRequest {
            requester_id: uid(2),
            status: FriendshipStatus::Pending,
        };
        assert_eq!(
            resolve_request_transition(&uid(1), &uid(2), Some(&existing)).unwrap(),
            RequestOutcome::AutoAccepted
        );
    }

    #[test]
    fn transition_accepted_is_already_friends() {
        let existing = ExistingRequest {
            requester_id: uid(2),
            status: FriendshipStatus::Accepted,
        };
        assert_eq!(
            resolve_request_transition(&uid(1), &uid(2), Some(&existing)).unwrap(),
            RequestOutcome::AlreadyFriends
        );
    }

    #[test]
    fn transition_self_is_validation_error() {
        let err = resolve_request_transition(&uid(1), &uid(1), None).unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn username_format_matches_db_check() {
        assert!(is_valid_username("alice"));
        assert!(is_valid_username("a_b_2"));
        assert!(!is_valid_username("ab")); // too short
        assert!(!is_valid_username("Alice")); // uppercase
        assert!(!is_valid_username("has space"));
        assert!(!is_valid_username(&"x".repeat(33))); // too long
    }
}
