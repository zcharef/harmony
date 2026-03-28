//! Invite domain model.
//!
//! An invite allows users to join a server via a shareable code.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::{InviteCode, ServerId, UserId};

/// A server invite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    pub code: InviteCode,
    pub server_id: ServerId,
    pub creator_id: UserId,
    /// Maximum number of times this invite can be used. `None` means unlimited.
    pub max_uses: Option<i32>,
    pub use_count: i32,
    /// When the invite expires. `None` means it never expires.
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl Invite {
    /// Whether this invite can still be used.
    ///
    /// An invite is valid when:
    /// - it has not expired (or has no expiry), AND
    /// - it has not reached its max uses (or has no use limit)
    #[must_use]
    pub fn is_valid(&self) -> bool {
        let not_expired = match self.expires_at {
            Some(expires) => Utc::now() < expires,
            None => true,
        };

        let under_limit = match self.max_uses {
            Some(max) => self.use_count < max,
            None => true,
        };

        not_expired && under_limit
    }
}
