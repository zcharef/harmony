//! Server domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Server, ServerId, UserId};
use crate::domain::ports::ServerRepository;

/// Service for server-related business logic.
#[derive(Debug)]
pub struct ServerService {
    repo: Arc<dyn ServerRepository>,
}

impl ServerService {
    #[must_use]
    pub fn new(repo: Arc<dyn ServerRepository>) -> Self {
        Self { repo }
    }

    /// Create a new server with default setup (member + `#general` channel).
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the name is empty,
    /// or a repository error on failure.
    pub async fn create_server(
        &self,
        name: String,
        owner_id: UserId,
    ) -> Result<Server, DomainError> {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            return Err(DomainError::ValidationError(
                "Server name must not be empty".to_string(),
            ));
        }

        self.repo.create_with_defaults(trimmed, owner_id).await
    }

    /// List all servers the user is a member of.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_user(&self, user_id: &UserId) -> Result<Vec<Server>, DomainError> {
        self.repo.list_for_user(user_id).await
    }

    /// Get a server by ID.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the server does not exist,
    /// or a repository error on failure.
    pub async fn get_by_id(&self, server_id: &ServerId) -> Result<Server, DomainError> {
        self.repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })
    }
}
