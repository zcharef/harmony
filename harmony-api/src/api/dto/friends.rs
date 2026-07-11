//! Friendship + block DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::friendship::{
    BlockedUserRow, FriendRequestRow, FriendRow, RequestDirection, RequestOutcome,
};
use crate::domain::models::{Profile, UserId};
use crate::domain::services::friendship_service::RequestTarget;

/// Counterpart profile embedded in friendship responses (shape of
/// `DmRecipientResponse`, own type per feature).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendUserResponse {
    pub id: UserId,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

impl From<Profile> for FriendUserResponse {
    fn from(p: Profile) -> Self {
        Self {
            id: p.id,
            username: p.username,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
        }
    }
}

/// A single friend (accepted friendship).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendResponse {
    pub user: FriendUserResponse,
    /// Maps to `friendships.updated_at` (accept time).
    pub friends_since: DateTime<Utc>,
}

impl From<FriendRow> for FriendResponse {
    fn from(r: FriendRow) -> Self {
        Self {
            user: FriendUserResponse {
                id: r.user_id,
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
            },
            friends_since: r.friends_since,
        }
    }
}

/// Envelope for the friends list. `next_cursor` is always `None` (§3.1).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendListResponse {
    pub items: Vec<FriendResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl FromIterator<FriendRow> for FriendListResponse {
    fn from_iter<T: IntoIterator<Item = FriendRow>>(iter: T) -> Self {
        Self {
            items: iter.into_iter().map(FriendResponse::from).collect(),
            next_cursor: None,
        }
    }
}

/// A single pending friend request.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestResponse {
    pub user: FriendUserResponse,
    pub direction: RequestDirection,
    pub created_at: DateTime<Utc>,
}

impl From<FriendRequestRow> for FriendRequestResponse {
    fn from(r: FriendRequestRow) -> Self {
        Self {
            user: FriendUserResponse {
                id: r.user_id,
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
            },
            direction: r.direction,
            created_at: r.created_at,
        }
    }
}

/// Envelope for a pending-requests list. `next_cursor` always `None` (§3.1).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestListResponse {
    pub items: Vec<FriendRequestResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl FromIterator<FriendRequestRow> for FriendRequestListResponse {
    fn from_iter<T: IntoIterator<Item = FriendRequestRow>>(iter: T) -> Self {
        Self {
            items: iter.into_iter().map(FriendRequestResponse::from).collect(),
            next_cursor: None,
        }
    }
}

/// Query params for `GET /v1/friends/requests`.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct FriendRequestListQuery {
    /// `incoming` or `outgoing`.
    pub direction: RequestDirection,
}

/// Body for `POST /v1/friends/requests` — exactly one of the two fields.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendFriendRequestRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addressee_id: Option<UserId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

impl TryFrom<SendFriendRequestRequest> for RequestTarget {
    type Error = &'static str;

    fn try_from(req: SendFriendRequestRequest) -> Result<Self, Self::Error> {
        match (req.addressee_id, req.username) {
            (Some(id), None) => Ok(RequestTarget::Id(id)),
            (None, Some(username)) => Ok(RequestTarget::Username(username)),
            (Some(_), Some(_)) => Err("Provide exactly one of addresseeId or username, not both"),
            (None, None) => Err("Provide either addresseeId or username"),
        }
    }
}

/// Result state of a friend-request POST.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum FriendRequestState {
    PendingOutgoing,
    AutoAccepted,
    AlreadyRequested,
    AlreadyFriends,
}

impl From<RequestOutcome> for FriendRequestState {
    fn from(outcome: RequestOutcome) -> Self {
        match outcome {
            RequestOutcome::Requested => Self::PendingOutgoing,
            RequestOutcome::AutoAccepted => Self::AutoAccepted,
            RequestOutcome::AlreadyRequested => Self::AlreadyRequested,
            RequestOutcome::AlreadyFriends => Self::AlreadyFriends,
        }
    }
}

/// Response for a friend-request POST.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendRequestResultResponse {
    pub state: FriendRequestState,
    pub user: FriendUserResponse,
    pub created_at: DateTime<Utc>,
}

impl From<(RequestOutcome, Profile, DateTime<Utc>)> for FriendRequestResultResponse {
    fn from((outcome, profile, created_at): (RequestOutcome, Profile, DateTime<Utc>)) -> Self {
        Self {
            state: FriendRequestState::from(outcome),
            user: FriendUserResponse::from(profile),
            created_at,
        }
    }
}

/// A single friend (accept response).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FriendAcceptedResponse {
    pub user: FriendUserResponse,
    pub friends_since: DateTime<Utc>,
}

impl From<(Profile, DateTime<Utc>)> for FriendAcceptedResponse {
    fn from((profile, friends_since): (Profile, DateTime<Utc>)) -> Self {
        Self {
            user: FriendUserResponse::from(profile),
            friends_since,
        }
    }
}

/// A single blocked user.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlockedUserResponse {
    pub user: FriendUserResponse,
    pub blocked_at: DateTime<Utc>,
}

impl From<BlockedUserRow> for BlockedUserResponse {
    fn from(r: BlockedUserRow) -> Self {
        Self {
            user: FriendUserResponse {
                id: r.user_id,
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
            },
            blocked_at: r.blocked_at,
        }
    }
}

/// Envelope for a blocked-users list. `next_cursor` always `None` (§3.1).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlockedListResponse {
    pub items: Vec<BlockedUserResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

impl FromIterator<BlockedUserRow> for BlockedListResponse {
    fn from_iter<T: IntoIterator<Item = BlockedUserRow>>(iter: T) -> Self {
        Self {
            items: iter.into_iter().map(BlockedUserResponse::from).collect(),
            next_cursor: None,
        }
    }
}
