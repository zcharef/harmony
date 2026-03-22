//! Channel domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, ServerId, UserId};
use crate::domain::ports::{ChannelRepository, PlanLimitChecker};

/// Maximum length for a channel name (lowercase slug).
const MAX_CHANNEL_NAME_LENGTH: usize = 100;

/// Maximum length for a channel topic.
const MAX_CHANNEL_TOPIC_LENGTH: usize = 1024;

/// Service for channel-related business logic.
#[derive(Debug)]
pub struct ChannelService {
    repo: Arc<dyn ChannelRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
}

/// Validate that a channel name matches `^[a-z0-9-]{1,100}$`.
fn validate_channel_name(name: &str) -> Result<(), DomainError> {
    if name.is_empty() || name.len() > MAX_CHANNEL_NAME_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Channel name must be between 1 and {} characters",
            MAX_CHANNEL_NAME_LENGTH
        )));
    }

    let valid = name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');

    if !valid {
        return Err(DomainError::ValidationError(
            "Channel name may only contain lowercase letters, digits, and hyphens".to_string(),
        ));
    }

    Ok(())
}

/// Validate that a channel topic does not exceed the maximum length.
fn validate_channel_topic(topic: &str) -> Result<(), DomainError> {
    if topic.chars().count() > MAX_CHANNEL_TOPIC_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Channel topic must not exceed {} characters",
            MAX_CHANNEL_TOPIC_LENGTH
        )));
    }
    Ok(())
}

impl ChannelService {
    /// Exposed for integration tests that need the channel name length limit.
    #[cfg(test)]
    pub const TEST_MAX_CHANNEL_NAME_LENGTH: usize = MAX_CHANNEL_NAME_LENGTH;

    /// Exposed for integration tests that need the channel topic length limit.
    #[cfg(test)]
    pub const TEST_MAX_CHANNEL_TOPIC_LENGTH: usize = MAX_CHANNEL_TOPIC_LENGTH;

    #[must_use]
    pub fn new(repo: Arc<dyn ChannelRepository>, plan_checker: Arc<dyn PlanLimitChecker>) -> Self {
        Self { repo, plan_checker }
    }

    /// Create a new channel in a server.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the name is invalid.
    pub async fn create_channel(
        &self,
        server_id: ServerId,
        name: String,
        channel_type: Option<ChannelType>,
        is_private: bool,
        is_read_only: bool,
    ) -> Result<Channel, DomainError> {
        let normalized = name.trim().to_lowercase();
        validate_channel_name(&normalized)?;

        // WHY: TOCTOU race exists between this limit check and the insert below.
        // Two concurrent requests could both pass, exceeding the limit by one.
        // Acceptable: same pattern as Discord. Plan limits are billing guard-rails,
        // not hard DB constraints. Exact enforcement would require advisory locks.
        //
        // Check plan limit AFTER validation (no point hitting DB for invalid input)
        // but BEFORE resource creation to enforce billing constraints.
        self.plan_checker.check_channel_limit(&server_id).await?;

        let channel_type = channel_type.unwrap_or(ChannelType::Text);
        let count = self.repo.count_for_server(&server_id).await?;
        let position = i32::try_from(count).unwrap_or(i32::MAX);

        let channel = Channel::new(
            server_id,
            normalized,
            channel_type,
            position,
            is_private,
            is_read_only,
        );
        self.repo.create(&channel).await
    }

    /// List channels visible to the caller in a server, ordered by position.
    ///
    /// Private channels are filtered out unless the caller has access.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_for_server(
        &self,
        server_id: &ServerId,
        caller_user_id: &UserId,
    ) -> Result<Vec<Channel>, DomainError> {
        self.repo.list_for_server(server_id, caller_user_id).await
    }

    /// Get a channel by ID.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn get_by_id(&self, channel_id: &ChannelId) -> Result<Channel, DomainError> {
        self.repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })
    }

    /// Update a channel's name, topic, permission flags, and/or encryption toggle.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if the new name or topic is invalid,
    /// or if attempting to disable encryption on an already-encrypted channel.
    /// Returns `DomainError::Forbidden` if the channel does not belong to `server_id`.
    /// Returns `DomainError::NotFound` if the channel does not exist.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_channel(
        &self,
        server_id: &ServerId,
        channel_id: &ChannelId,
        name: Option<String>,
        topic: Option<Option<String>>,
        is_private: Option<bool>,
        is_read_only: Option<bool>,
        encrypted: Option<bool>,
    ) -> Result<Channel, DomainError> {
        // WHY: Prevents cross-server IDOR — an admin on Server A must not
        // be able to update channels on Server B by crafting the channel_id.
        let channel = self.get_by_id(channel_id).await?;
        if channel.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Channel does not belong to this server".to_string(),
            ));
        }

        // WHY: One-way toggle — once encryption is enabled, it cannot be disabled
        // to prevent accidental plaintext leaks in a previously-encrypted channel.
        if let Some(new_encrypted) = encrypted
            && channel.encrypted
            && !new_encrypted
        {
            return Err(DomainError::ValidationError(
                "Encryption cannot be disabled once enabled".to_string(),
            ));
        }

        let validated_name = match name {
            Some(raw) => {
                let normalized = raw.trim().to_lowercase();
                validate_channel_name(&normalized)?;
                Some(normalized)
            }
            None => None,
        };

        // Validate topic length when provided (outer Some = field present).
        if let Some(Some(ref t)) = topic {
            validate_channel_topic(t)?;
        }

        self.repo
            .update(
                channel_id,
                validated_name,
                topic,
                is_private,
                is_read_only,
                encrypted,
            )
            .await
    }

    /// Delete a channel.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if this is the last channel in the server.
    /// Returns `DomainError::Forbidden` if the channel does not belong to `server_id`.
    /// Returns `DomainError::NotFound` if the channel does not exist.
    pub async fn delete_channel(
        &self,
        server_id: &ServerId,
        channel_id: &ChannelId,
    ) -> Result<(), DomainError> {
        // WHY: Prevents cross-server IDOR — an admin on Server A must not
        // be able to delete channels on Server B by crafting the channel_id.
        let channel = self.get_by_id(channel_id).await?;
        if channel.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Channel does not belong to this server".to_string(),
            ));
        }

        self.repo.delete_if_not_last(channel_id).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── validate_channel_name ──────────────────────────────────────

    #[test]
    fn channel_name_valid_lowercase_alphanumeric() {
        assert!(validate_channel_name("general").is_ok());
        assert!(validate_channel_name("dev-chat").is_ok());
        assert!(validate_channel_name("channel-123").is_ok());
        assert!(validate_channel_name("a").is_ok());
        assert!(validate_channel_name("0").is_ok());
        assert!(validate_channel_name("a-b-c").is_ok());
    }

    #[test]
    fn channel_name_max_length_boundary() {
        // Exactly at limit: OK
        let at_limit = "a".repeat(MAX_CHANNEL_NAME_LENGTH);
        assert!(validate_channel_name(&at_limit).is_ok());

        // One over limit: rejected
        let over_limit = "a".repeat(MAX_CHANNEL_NAME_LENGTH + 1);
        assert!(validate_channel_name(&over_limit).is_err());
    }

    #[test]
    fn channel_name_empty_rejected() {
        let result = validate_channel_name("");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, DomainError::ValidationError(_)),
            "Expected ValidationError, got {:?}",
            err,
        );
    }

    #[test]
    fn channel_name_uppercase_rejected() {
        assert!(validate_channel_name("General").is_err());
        assert!(validate_channel_name("GENERAL").is_err());
        assert!(validate_channel_name("devChat").is_err());
    }

    #[test]
    fn channel_name_special_chars_rejected() {
        assert!(validate_channel_name("hello world").is_err()); // space
        assert!(validate_channel_name("hello_world").is_err()); // underscore
        assert!(validate_channel_name("hello.world").is_err()); // dot
        assert!(validate_channel_name("hello@world").is_err()); // at
        assert!(validate_channel_name("#general").is_err()); // hash
        assert!(validate_channel_name("hello!").is_err()); // exclamation
    }

    #[test]
    fn channel_name_unicode_rejected() {
        assert!(validate_channel_name("\u{00e9}").is_err()); // e-acute
        assert!(validate_channel_name("\u{1f600}").is_err()); // emoji
    }

    // ── validate_channel_topic ─────────────────────────────────────

    #[test]
    fn channel_topic_valid() {
        assert!(validate_channel_topic("Welcome to the general channel!").is_ok());
        assert!(validate_channel_topic("").is_ok()); // empty is allowed
        assert!(validate_channel_topic("a").is_ok());
    }

    #[test]
    fn channel_topic_max_length_boundary() {
        // Exactly at limit: OK
        let at_limit: String = "a".repeat(MAX_CHANNEL_TOPIC_LENGTH);
        assert!(validate_channel_topic(&at_limit).is_ok());

        // One over limit: rejected
        let over_limit: String = "a".repeat(MAX_CHANNEL_TOPIC_LENGTH + 1);
        assert!(validate_channel_topic(&over_limit).is_err());
    }

    #[test]
    fn channel_topic_unicode_counted_by_chars() {
        // WHY: The validation uses .chars().count(), not .len().
        // A multi-byte character should count as 1, not as its byte length.
        // U+1F600 (grinning face) is 4 bytes but 1 char.
        let topic: String = "\u{1f600}".repeat(MAX_CHANNEL_TOPIC_LENGTH);
        assert!(validate_channel_topic(&topic).is_ok());

        let over: String = "\u{1f600}".repeat(MAX_CHANNEL_TOPIC_LENGTH + 1);
        assert!(validate_channel_topic(&over).is_err());
    }
}
