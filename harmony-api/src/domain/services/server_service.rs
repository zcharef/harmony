//! Server domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Server, ServerId, UserId};
use crate::domain::ports::ServerRepository;

/// Maximum length for a server name.
const MAX_SERVER_NAME_LENGTH: usize = 100;

/// Service for server-related business logic.
#[derive(Debug)]
pub struct ServerService {
    repo: Arc<dyn ServerRepository>,
}

/// Validate a server name: 1-100 chars after trim, no control characters.
fn validate_server_name(name: &str) -> Result<String, DomainError> {
    let trimmed = name.trim().to_string();

    if trimmed.is_empty() {
        return Err(DomainError::ValidationError(
            "Server name must not be empty".to_string(),
        ));
    }

    if trimmed.chars().count() > MAX_SERVER_NAME_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Server name must not exceed {} characters",
            MAX_SERVER_NAME_LENGTH
        )));
    }

    // WHY: Control characters (< 0x20) except space (0x20) can cause display
    // issues and are never valid in a server name.
    let has_control_chars = trimmed.chars().any(|c| c < '\u{0020}');

    if has_control_chars {
        return Err(DomainError::ValidationError(
            "Server name must not contain control characters".to_string(),
        ));
    }

    Ok(trimmed)
}

impl ServerService {
    #[must_use]
    pub fn new(repo: Arc<dyn ServerRepository>) -> Self {
        Self { repo }
    }

    /// Create a new server with default setup (member + `#general` channel).
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the name is empty, too long,
    /// or contains control characters, or a repository error on failure.
    pub async fn create_server(
        &self,
        name: String,
        owner_id: UserId,
    ) -> Result<Server, DomainError> {
        let validated_name = validate_server_name(&name)?;

        self.repo
            .create_with_defaults(validated_name, owner_id)
            .await
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
