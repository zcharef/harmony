//! Port: server member persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, MentionedUser, Role, ServerId, ServerMember, UserId};

/// Intent-based repository for server members.
#[async_trait]
pub trait MemberRepository: Send + Sync + std::fmt::Debug {
    /// List all members of a server (joined with profile data).
    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<ServerMember>, DomainError>;

    /// List members of a server with cursor-based pagination (ADR-036).
    ///
    /// Returns members who joined before `cursor` (if provided), limited to `limit` rows,
    /// ordered by `joined_at DESC`.
    async fn list_by_server_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ServerMember>, DomainError>;

    /// Check if a user is a member of a server.
    async fn is_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<bool, DomainError>;

    /// Add a user as a member of a server (with default 'member' role).
    async fn add_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError>;

    /// Race-safe direct join for the server directory.
    ///
    /// Takes the same per-(server, user) advisory lock as `ban_user` /
    /// `complete_join`, then re-checks INSIDE the lock that the server is
    /// still `discoverable` (a concurrent opt-out must not admit the user)
    /// and that the user is not banned, before inserting the membership.
    ///
    /// Returns `DomainError::Forbidden` if banned or no longer discoverable,
    /// `DomainError::Conflict` if already a member (callers treat as
    /// idempotent success).
    async fn join_discoverable_server(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError>;

    /// Remove a user from a server.
    ///
    /// Returns `DomainError::NotFound` if the user was not a member.
    async fn remove_member(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<(), DomainError>;

    /// Get a single member by server and user ID (joined with profile data).
    /// Returns `None` if the user is not a member.
    async fn get_member(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Option<ServerMember>, DomainError>;

    /// Get a member's role in a server. Returns `None` if not a member.
    async fn get_member_role(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
    ) -> Result<Option<Role>, DomainError>;

    /// Update a member's role in a server.
    ///
    /// Returns `DomainError::NotFound` if the user is not a member.
    async fn update_member_role(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        new_role: Role,
    ) -> Result<(), DomainError>;

    /// Count members in a server (uses denormalized column for performance).
    async fn count_by_server(&self, server_id: &ServerId) -> Result<i64, DomainError>;

    /// Transfer ownership atomically: set `new_owner` role='owner',
    /// old owner role='admin', update `servers.owner_id`.
    async fn transfer_ownership(
        &self,
        server_id: &ServerId,
        old_owner_id: &UserId,
        new_owner_id: &UserId,
    ) -> Result<(), DomainError>;

    /// Filter candidate mention targets down to users who can SEE the channel:
    /// server members, and for private channels, admin/owner or a
    /// `channel_role_access` grant for their role. MUST match
    /// `ensure_channel_access` semantics (`channel_access.rs`) — a silent drop,
    /// never an error (no membership/access oracle). Returned order is not
    /// significant; the service re-orders against the candidate list.
    async fn filter_mentionable(
        &self,
        channel: &Channel,
        user_ids: &[UserId],
    ) -> Result<Vec<UserId>, DomainError>;

    /// Batch-resolve mentioned users for response building: `profiles` LEFT JOIN
    /// `server_members` (nickname). Users who left the server still resolve
    /// (`nickname = None`); deleted accounts (no profile row) are omitted.
    async fn resolve_mentioned_users(
        &self,
        server_id: &ServerId,
        user_ids: &[UserId],
    ) -> Result<Vec<MentionedUser>, DomainError>;

    /// Search members by a query string (substring `ILIKE` on `username`,
    /// `display_name` and `nickname`), prefix matches ranked first, capped at
    /// `limit`. Powers the autocomplete `q` param past the first member page
    /// (§3.4). No pagination — top-N only.
    async fn search_by_server(
        &self,
        server_id: &ServerId,
        q: &str,
        limit: i64,
    ) -> Result<Vec<ServerMember>, DomainError>;
}
