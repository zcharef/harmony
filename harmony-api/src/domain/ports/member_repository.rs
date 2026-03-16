//! Port: server member persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{ServerId, ServerMember, UserId};

/// Intent-based repository for server members.
#[async_trait]
pub trait MemberRepository: Send + Sync + std::fmt::Debug {
    /// List all members of a server (joined with profile data).
    async fn list_by_server(&self, server_id: &ServerId) -> Result<Vec<ServerMember>, DomainError>;

    /// Check if a user is a member of a server.
    async fn is_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<bool, DomainError>;

    /// Add a user as a member of a server.
    async fn add_member(&self, server_id: &ServerId, user_id: &UserId) -> Result<(), DomainError>;
}
