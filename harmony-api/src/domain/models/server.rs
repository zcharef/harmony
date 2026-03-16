//! Server (guild) domain model.
//!
//! A server is the top-level container for channels and members.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::ids::{ServerId, UserId};

/// A server (guild).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: ServerId,
    pub name: String,
    pub icon_url: Option<String>,
    pub owner_id: UserId,
    pub is_dm: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Server {
    /// Create a new server with a generated ID and current timestamps.
    #[must_use]
    pub fn new(name: String, owner_id: UserId) -> Self {
        let now = Utc::now();
        Self {
            id: ServerId::new(Uuid::new_v4()),
            name,
            icon_url: None,
            owner_id,
            is_dm: false,
            created_at: now,
            updated_at: now,
        }
    }
}
