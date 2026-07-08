//! Port: server persistence.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Role, Server, ServerId, UserId};

/// Intent-based repository for servers (guilds).
#[async_trait]
pub trait ServerRepository: Send + Sync + std::fmt::Debug {
    /// Create a server with default setup: adds the owner as a member and creates a `#general` channel.
    ///
    /// This is a single transactional operation.
    async fn create_with_defaults(
        &self,
        name: String,
        owner_id: UserId,
    ) -> Result<Server, DomainError>;

    /// List all non-DM servers the user is a member of (for the server list UI).
    async fn list_for_user(&self, user_id: &UserId) -> Result<Vec<Server>, DomainError>;

    /// List ALL servers the user is a member of, including DMs.
    ///
    /// WHY: The SSE handler needs the full membership set to filter events.
    /// `list_for_user` excludes DMs (correct for the sidebar), but the SSE
    /// event stream must include DM events.
    async fn list_all_memberships(&self, user_id: &UserId) -> Result<Vec<ServerId>, DomainError>;

    /// List ALL memberships (incl. DMs) paired with the user's role in each.
    ///
    /// WHY: The SSE handler needs the receiver's per-server role to gate
    /// private-channel events. `list_all_memberships` returns only IDs; this
    /// carries the role so the Stage-2 filter can decide channel access without
    /// a per-event DB lookup. DM "servers" carry whatever role the row holds —
    /// irrelevant, since DM channels are never private.
    async fn list_all_memberships_with_roles(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<(ServerId, Role)>, DomainError>;

    /// Get a server by ID. Returns `None` if not found.
    async fn get_by_id(&self, server_id: &ServerId) -> Result<Option<Server>, DomainError>;

    /// Update a server's name. Returns the updated server, or `None` if not found.
    async fn update_name(
        &self,
        server_id: &ServerId,
        name: String,
    ) -> Result<Option<Server>, DomainError>;

    /// Delete a server by ID. Returns `true` if a row was deleted, `false` if not found.
    ///
    /// WHY: CASCADE in the database removes related rows (channels, members,
    /// `voice_sessions`, etc.). Callers must snapshot dependent data before calling
    /// this method so they can emit cleanup SSE events.
    async fn delete(&self, server_id: &ServerId) -> Result<bool, DomainError>;

    /// Fetch the server's Tier 2 moderation category settings.
    /// Returns empty `HashMap` if no settings configured (= all Tier 2 OFF).
    async fn get_moderation_categories(
        &self,
        server_id: &ServerId,
    ) -> Result<HashMap<String, bool>, DomainError>;

    /// Replace the server's Tier 2 moderation category settings.
    /// WHY replace (not merge): The PATCH endpoint sends the full desired state.
    async fn update_moderation_categories(
        &self,
        server_id: &ServerId,
        categories: HashMap<String, bool>,
    ) -> Result<(), DomainError>;
}
