//! Port: server persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Server, ServerId, UserId};

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

    /// List all servers the user is a member of.
    async fn list_for_user(&self, user_id: &UserId) -> Result<Vec<Server>, DomainError>;

    /// Get a server by ID. Returns `None` if not found.
    async fn get_by_id(&self, server_id: &ServerId) -> Result<Option<Server>, DomainError>;
}
