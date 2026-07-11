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
    /// Opt-in flag for the public server directory (default OFF).
    pub discoverable: bool,
    /// Allowlisted directory category (see `DISCOVERY_CATEGORIES`).
    pub discovery_category: Option<String>,
    /// Short public blurb shown on the directory card (moderated).
    pub discovery_description: Option<String>,
    /// Curated ordering flag — no UI, set directly in the DB only.
    pub discovery_featured: bool,
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
            discoverable: false,
            discovery_category: None,
            discovery_description: None,
            discovery_featured: false,
            created_at: now,
            updated_at: now,
        }
    }
}

/// One entry of the public server directory (listing projection).
///
/// WHY a separate type (not `Server`): the directory exposes ONLY public
/// fields plus a computed member count — never `owner_id`, timestamps, or
/// moderation settings.
#[derive(Debug, Clone)]
pub struct DiscoveryServer {
    pub id: ServerId,
    pub name: String,
    pub icon_url: Option<String>,
    pub member_count: i64,
    pub category: Option<String>,
    pub description: Option<String>,
    pub featured: bool,
}

/// Keyset cursor for the directory listing (ADR-036: no OFFSET).
///
/// The listing orders by `(featured DESC, member_count DESC, id DESC)`;
/// the cursor carries that exact sort key of the last returned row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryCursor {
    pub featured: bool,
    pub member_count: i64,
    pub id: Uuid,
}

impl DiscoveryCursor {
    /// Serialize to the opaque wire form `"{featured}:{member_count}:{id}"`.
    #[must_use]
    pub fn encode(&self) -> String {
        format!(
            "{}:{}:{}",
            u8::from(self.featured),
            self.member_count,
            self.id
        )
    }

    /// Parse the opaque wire form. Returns `None` for malformed cursors —
    /// callers map that to a validation error.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let mut parts = raw.splitn(3, ':');
        let featured = match parts.next()? {
            "0" => false,
            "1" => true,
            _ => return None,
        };
        let member_count = parts.next()?.parse::<i64>().ok()?;
        let id = Uuid::parse_str(parts.next()?).ok()?;
        Some(Self {
            featured,
            member_count,
            id,
        })
    }
}
