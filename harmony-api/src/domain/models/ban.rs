//! Server ban domain model.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::{ServerId, UserId};

/// A ban record for a user in a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerBan {
    pub server_id: ServerId,
    pub user_id: UserId,
    pub banned_by: Option<UserId>,
    pub reason: Option<String>,
    pub created_at: DateTime<Utc>,
}
