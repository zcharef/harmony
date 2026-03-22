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

    /// Update a server's name.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the new name is empty, too long,
    /// or contains control characters.
    /// Returns `DomainError::NotFound` if the server does not exist.
    pub async fn update_server(
        &self,
        server_id: &ServerId,
        name: Option<String>,
    ) -> Result<Server, DomainError> {
        let validated_name = match name {
            Some(raw) => Some(validate_server_name(&raw)?),
            None => None,
        };

        // WHY: If no fields were provided, return the current server unchanged.
        let Some(new_name) = validated_name else {
            return self.get_by_id(server_id).await;
        };

        self.repo
            .update_name(server_id, new_name)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: server_id.to_string(),
            })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── validate_server_name ───────────────────────────────────────

    #[test]
    fn server_name_valid() {
        assert!(validate_server_name("My Server").is_ok());
        assert!(validate_server_name("a").is_ok());
        assert!(validate_server_name("Server 123!").is_ok());
        assert!(validate_server_name("Caf\u{00e9}").is_ok()); // unicode allowed
    }

    #[test]
    fn server_name_returns_trimmed() {
        let result = validate_server_name("  My Server  ").unwrap();
        assert_eq!(result, "My Server");
    }

    #[test]
    fn server_name_empty_rejected() {
        let result = validate_server_name("");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, DomainError::ValidationError(_)));
    }

    #[test]
    fn server_name_whitespace_only_rejected() {
        // After trim(), becomes empty.
        assert!(validate_server_name("   ").is_err());
        assert!(validate_server_name("\t\n").is_err());
    }

    #[test]
    fn server_name_max_length_boundary() {
        // Exactly at limit: OK
        let at_limit = "a".repeat(MAX_SERVER_NAME_LENGTH);
        assert!(validate_server_name(&at_limit).is_ok());

        // One over limit: rejected
        let over_limit = "a".repeat(MAX_SERVER_NAME_LENGTH + 1);
        assert!(validate_server_name(&over_limit).is_err());
    }

    #[test]
    fn server_name_control_chars_rejected() {
        assert!(validate_server_name("Hello\x00World").is_err()); // null byte
        assert!(validate_server_name("Hello\x01World").is_err()); // SOH
        assert!(validate_server_name("Tab\x09Here").is_err()); // horizontal tab
        assert!(validate_server_name("New\x0ALine").is_err()); // newline
        assert!(validate_server_name("Return\x0DChar").is_err()); // carriage return
        assert!(validate_server_name("\x1F").is_err()); // unit separator (last control char before space)
    }

    #[test]
    fn server_name_space_is_allowed() {
        // Space (0x20) is explicitly NOT a control character in this context.
        assert!(validate_server_name("Hello World").is_ok());
    }

    #[test]
    fn server_name_unicode_length_counted_by_chars() {
        // Multi-byte characters should count as 1 char, not by byte length.
        let name: String = "\u{1f600}".repeat(MAX_SERVER_NAME_LENGTH);
        assert!(validate_server_name(&name).is_ok());

        let over: String = "\u{1f600}".repeat(MAX_SERVER_NAME_LENGTH + 1);
        assert!(validate_server_name(&over).is_err());
    }
}
