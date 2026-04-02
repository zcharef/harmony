//! Server ban domain model.

use chrono::{DateTime, Utc};

use super::ids::{ServerId, UserId};

/// A ban record for a user in a server.
#[derive(Debug, Clone)]
pub struct ServerBan {
    pub server_id: ServerId,
    pub user_id: UserId,
    pub username: String,
    pub avatar_url: Option<String>,
    pub banned_by: Option<UserId>,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}
