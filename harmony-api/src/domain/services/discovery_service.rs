//! Server-directory domain service (opt-in discovery).
//!
//! Owns the category allowlist, the moderation of the public description
//! (same hard filter as server names — see `server_service.rs`), the
//! never-leak listing rules, and the ban-respecting direct join.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::Server;
use crate::domain::models::{DiscoveryCursor, DiscoveryServer, ServerId, UserId};
use crate::domain::ports::{BanRepository, MemberRepository, PlanLimitChecker, ServerRepository};
use crate::domain::services::content_filter::ContentFilter;

/// Fixed category allowlist for the server directory.
///
/// WHY one const: the single source of truth server-side; the app mirrors it
/// with an i18n label map keyed by these exact values. The DB CHECK
/// constraint is defense-in-depth only.
pub const DISCOVERY_CATEGORIES: [&str; 8] = [
    "gaming",
    "tech",
    "education",
    "music",
    "art",
    "science",
    "community",
    "other",
];

/// Maximum length for the public directory description.
const MAX_DISCOVERY_DESCRIPTION_LENGTH: usize = 300;

/// Default and maximum page sizes for the directory listing.
const DEFAULT_PAGE_SIZE: i64 = 20;
const MAX_PAGE_SIZE: i64 = 50;

/// Maximum length accepted for the name search substring.
const MAX_SEARCH_LENGTH: usize = 100;

/// Outcome of a direct join attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryJoinOutcome {
    /// Membership was created.
    Joined,
    /// The user was already a member — idempotent no-op.
    AlreadyMember,
}

/// One page of directory results.
#[derive(Debug)]
pub struct DiscoveryPage {
    pub items: Vec<DiscoveryServer>,
    pub total: i64,
    pub next_cursor: Option<String>,
}

/// Validate a category value against the allowlist.
fn validate_category(category: &str) -> Result<(), DomainError> {
    if DISCOVERY_CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err(DomainError::ValidationError(format!(
            "Unknown discovery category '{category}'"
        )))
    }
}

/// Normalize a directory description: trim, empty → None, cap length.
fn validate_description(raw: Option<String>) -> Result<Option<String>, DomainError> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim().to_string();

    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed.chars().count() > MAX_DISCOVERY_DESCRIPTION_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Discovery description must not exceed {MAX_DISCOVERY_DESCRIPTION_LENGTH} characters"
        )));
    }

    // WHY: Control characters (< 0x20) can break the directory card layout
    // and are never legitimate in a short blurb. Same rule as server names.
    if trimmed.chars().any(|c| c < '\u{0020}') {
        return Err(DomainError::ValidationError(
            "Discovery description must not contain control characters".to_string(),
        ));
    }

    Ok(Some(trimmed))
}

/// Service for the opt-in server directory.
#[derive(Debug)]
pub struct DiscoveryService {
    server_repo: Arc<dyn ServerRepository>,
    member_repo: Arc<dyn MemberRepository>,
    ban_repo: Arc<dyn BanRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
    content_filter: Arc<ContentFilter>,
}

impl DiscoveryService {
    #[must_use]
    pub fn new(
        server_repo: Arc<dyn ServerRepository>,
        member_repo: Arc<dyn MemberRepository>,
        ban_repo: Arc<dyn BanRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
        content_filter: Arc<ContentFilter>,
    ) -> Self {
        Self {
            server_repo,
            member_repo,
            ban_repo,
            plan_checker,
            content_filter,
        }
    }

    /// Update a server's directory settings.
    ///
    /// The description is user-supplied PUBLIC text: it goes through the same
    /// `ContentFilter::check_hard` gate as server names
    /// (`server_service.rs::update_server`).
    ///
    /// # Errors
    /// - `DomainError::ValidationError` for an unknown category, an oversized
    ///   or banned-word description, or a discoverable server without category.
    /// - `DomainError::NotFound` if the server does not exist (or is a DM).
    pub async fn update_discovery_settings(
        &self,
        server_id: &ServerId,
        discoverable: bool,
        category: Option<String>,
        description: Option<String>,
    ) -> Result<Server, DomainError> {
        if let Some(c) = category.as_deref() {
            validate_category(c)?;
        }

        // WHY: A listed server without a category would be unreachable through
        // the category chips — require it at opt-in time.
        if discoverable && category.is_none() {
            return Err(DomainError::ValidationError(
                "A discovery category is required to list a server".to_string(),
            ));
        }

        let description = validate_description(description)?;
        if let Some(d) = description.as_deref() {
            // Same hard-moderation gate as server names (server_service.rs).
            self.content_filter.check_hard(d)?;
        }

        self.server_repo
            .update_discovery(server_id, discoverable, category, description)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })
    }

    /// List the directory: only `discoverable = true` servers, featured first
    /// then by member count.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` for an unknown category, oversized
    ///   search, or malformed cursor.
    pub async fn list_directory(
        &self,
        category: Option<String>,
        search: Option<String>,
        cursor: Option<String>,
        limit: Option<i64>,
    ) -> Result<DiscoveryPage, DomainError> {
        if let Some(c) = category.as_deref() {
            validate_category(c)?;
        }

        let search = match search {
            Some(q) => {
                let trimmed = q.trim().to_string();
                if trimmed.chars().count() > MAX_SEARCH_LENGTH {
                    return Err(DomainError::ValidationError(format!(
                        "Search query must not exceed {MAX_SEARCH_LENGTH} characters"
                    )));
                }
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            None => None,
        };

        let cursor = match cursor.as_deref() {
            Some(raw) => Some(DiscoveryCursor::parse(raw).ok_or_else(|| {
                DomainError::ValidationError("Malformed pagination cursor".to_string())
            })?),
            None => None,
        };

        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);

        let items = self
            .server_repo
            .list_discoverable(category.as_deref(), search.as_deref(), cursor, limit)
            .await?;
        let total = self
            .server_repo
            .count_discoverable(category.as_deref(), search.as_deref())
            .await?;

        // WHY items.len() == limit: a short page is by construction the last
        // one. A full page MAY have a next page; the client finds out on the
        // next request (standard keyset behavior, mirrors ADR-036 endpoints).
        let next_cursor = if items.len() == usize::try_from(limit).unwrap_or(usize::MAX) {
            items.last().map(|s| {
                DiscoveryCursor {
                    featured: s.featured,
                    member_count: s.member_count,
                    id: s.id.0,
                }
                .encode()
            })
        } else {
            None
        };

        Ok(DiscoveryPage {
            items,
            total,
            next_cursor,
        })
    }

    /// One-click direct join of a discoverable server.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server does not exist.
    /// - `DomainError::Forbidden` if the server is not discoverable (checked
    ///   both here AND inside the repository transaction at insert time) or
    ///   the user is banned.
    /// - `DomainError::LimitExceeded` on plan member limits.
    pub async fn join(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<DiscoveryJoinOutcome, DomainError> {
        let server = self
            .server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })?;

        // WHY re-checked at join time (not trusted from the listing): the
        // owner can opt out between the directory render and the click.
        if !server.discoverable || server.is_dm {
            return Err(DomainError::Forbidden(
                "This server is not open for discovery".to_string(),
            ));
        }

        // WHY fast-path: clean 403 before any lock. NOT the race-safe guard —
        // `join_discoverable_server` re-checks the ban inside the same
        // advisory lock `ban_user` takes (mirrors invite_service.rs).
        let is_banned = self.ban_repo.is_banned(server_id, user_id).await?;
        if is_banned {
            return Err(DomainError::Forbidden(
                "You are banned from this server".to_string(),
            ));
        }

        // Existing member → idempotent no-op (the client just navigates).
        let already_member = self.member_repo.is_member(server_id, user_id).await?;
        if already_member {
            return Ok(DiscoveryJoinOutcome::AlreadyMember);
        }

        // WHY: Same TOCTOU tolerance as invite joins — plan limits are billing
        // guard-rails, not hard DB constraints. Joining is capped by the
        // per-server member limit and the user's joined-servers limit; the
        // owned-servers cap does NOT apply to joins.
        self.plan_checker.check_member_limit(server_id).await?;
        self.plan_checker.check_joined_server_limit(user_id).await?;

        match self
            .member_repo
            .join_discoverable_server(server_id, user_id)
            .await
        {
            Ok(()) => Ok(DiscoveryJoinOutcome::Joined),
            // Race window between is_member and the insert — still idempotent.
            Err(DomainError::Conflict(_)) => Ok(DiscoveryJoinOutcome::AlreadyMember),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── validate_category ──────────────────────────────────────────

    #[test]
    fn category_allowlist_accepts_known_values() {
        for c in DISCOVERY_CATEGORIES {
            assert!(validate_category(c).is_ok(), "category '{c}' rejected");
        }
    }

    #[test]
    fn category_allowlist_rejects_unknown_values() {
        assert!(validate_category("crypto-scams").is_err());
        assert!(validate_category("").is_err());
        assert!(validate_category("Gaming").is_err()); // case-sensitive
    }

    // ── validate_description ───────────────────────────────────────

    #[test]
    fn description_none_and_empty_normalize_to_none() {
        assert_eq!(validate_description(None).unwrap(), None);
        assert_eq!(validate_description(Some(String::new())).unwrap(), None);
        assert_eq!(validate_description(Some("   ".to_string())).unwrap(), None);
    }

    #[test]
    fn description_is_trimmed() {
        assert_eq!(
            validate_description(Some("  hello  ".to_string())).unwrap(),
            Some("hello".to_string())
        );
    }

    #[test]
    fn description_max_length_boundary() {
        let at_limit = "a".repeat(MAX_DISCOVERY_DESCRIPTION_LENGTH);
        assert!(validate_description(Some(at_limit)).is_ok());

        let over_limit = "a".repeat(MAX_DISCOVERY_DESCRIPTION_LENGTH + 1);
        assert!(validate_description(Some(over_limit)).is_err());
    }

    #[test]
    fn description_control_chars_rejected() {
        assert!(validate_description(Some("line\nbreak".to_string())).is_err());
        assert!(validate_description(Some("null\x00byte".to_string())).is_err());
    }

    // ── DiscoveryCursor round-trip ─────────────────────────────────

    #[test]
    fn cursor_round_trips() {
        let cursor = DiscoveryCursor {
            featured: true,
            member_count: 42,
            id: Uuid::new_v4(),
        };
        let parsed = DiscoveryCursor::parse(&cursor.encode()).unwrap();
        assert_eq!(parsed, cursor);
    }

    #[test]
    fn cursor_rejects_malformed_input() {
        assert!(DiscoveryCursor::parse("").is_none());
        assert!(DiscoveryCursor::parse("2:10:not-a-uuid").is_none());
        assert!(DiscoveryCursor::parse("1:ten:00000000-0000-0000-0000-000000000000").is_none());
        assert!(DiscoveryCursor::parse("1:10").is_none());
        assert!(DiscoveryCursor::parse("true:10:00000000-0000-0000-0000-000000000000").is_none());
    }
}
