//! Server member domain model.
//!
//! A view model joining `server_members` with `profiles` to represent
//! a member within a server.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::{ServerId, UserId};

/// A member of a server (join of `server_members` + `profiles`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerMember {
    pub user_id: UserId,
    pub server_id: ServerId,
    pub username: String,
    pub avatar_url: Option<String>,
    pub nickname: Option<String>,
    pub joined_at: DateTime<Utc>,
}
