//! Channel domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{Channel, ChannelId, ChannelType, ServerId, UserId};
use crate::domain::ports::{ChannelRepository, PlanLimitChecker, ServerRepository};
use crate::domain::services::content_filter::ContentFilter;

/// Maximum length for a channel name (lowercase slug).
const MAX_CHANNEL_NAME_LENGTH: usize = 100;

/// Maximum length for a channel topic (DB ceiling — self-hosted max).
/// Per-plan enforcement uses `PlanLimits::max_channel_topic_chars`.
const MAX_CHANNEL_TOPIC_LENGTH: usize = 4096;

/// Service for channel-related business logic.
#[derive(Debug)]
pub struct ChannelService {
    repo: Arc<dyn ChannelRepository>,
    server_repo: Arc<dyn ServerRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
    content_filter: Arc<ContentFilter>,
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

/// Guard against setting slow mode on DM channels.
///
/// WHY: Extracted from `update_channel` so that unit tests can verify the
/// DM slow-mode guard without requiring a `ServerRepository`.
pub(crate) fn check_slow_mode_dm(
    is_dm: bool,
    slow_mode_seconds: Option<i32>,
) -> Result<(), DomainError> {
    if let Some(secs) = slow_mode_seconds
        && is_dm
        && secs > 0
    {
        return Err(DomainError::ValidationError(
            "Slow mode cannot be set on DM channels".to_string(),
        ));
    }
    Ok(())
}

/// Validate slow mode seconds range. 0 = disabled, max 6 hours (21600s).
///
/// WHY: Extracted from `update_channel` so that unit tests can verify the
/// range check without requiring a `ChannelRepository`.
fn validate_slow_mode_seconds(seconds: i32) -> Result<(), DomainError> {
    if !(0..=21600).contains(&seconds) {
        return Err(DomainError::ValidationError(
            "slow_mode_seconds must be between 0 and 21600 (6 hours)".to_string(),
        ));
    }
    Ok(())
}

/// Guard against disabling encryption on an already-encrypted channel.
///
/// WHY: Extracted from `update_channel` so that unit tests can verify the
/// one-way toggle logic without requiring a `ChannelRepository`.
pub(crate) fn check_encryption_toggle(
    current_encrypted: bool,
    requested: Option<bool>,
) -> Result<(), DomainError> {
    if let Some(new_encrypted) = requested
        && current_encrypted
        && !new_encrypted
    {
        return Err(DomainError::ValidationError(
            "Encryption cannot be disabled once enabled".to_string(),
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
    pub fn new(
        repo: Arc<dyn ChannelRepository>,
        server_repo: Arc<dyn ServerRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
        content_filter: Arc<ContentFilter>,
    ) -> Self {
        Self {
            repo,
            server_repo,
            plan_checker,
            content_filter,
        }
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
        self.content_filter.check_hard(&normalized)?;

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
        self.repo.create_channel(&channel).await
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
    /// if attempting to disable encryption on an already-encrypted channel,
    /// or if attempting to set slow mode on a DM channel.
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
        slow_mode_seconds: Option<i32>,
    ) -> Result<Channel, DomainError> {
        // WHY: Prevents cross-server IDOR — an admin on Server A must not
        // be able to update channels on Server B by crafting the channel_id.
        let channel = self.get_by_id(channel_id).await?;
        if channel.server_id != *server_id {
            return Err(DomainError::Forbidden(
                "Channel does not belong to this server".to_string(),
            ));
        }

        check_encryption_toggle(channel.encrypted, encrypted)?;

        // WHY: DM channels are 1:1 conversations; slow mode is a server-level
        // moderation tool that has no meaning in DMs. We fetch the parent server
        // only when slow_mode_seconds > 0 to avoid unnecessary DB calls.
        if let Some(secs) = slow_mode_seconds
            && secs > 0
        {
            let server = self
                .server_repo
                .get_by_id(server_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Server",
                    id: server_id.to_string(),
                })?;
            check_slow_mode_dm(server.is_dm, slow_mode_seconds)?;
        }

        let validated_name = match name {
            Some(raw) => {
                let normalized = raw.trim().to_lowercase();
                validate_channel_name(&normalized)?;
                self.content_filter.check_hard(&normalized)?;
                Some(normalized)
            }
            None => None,
        };

        // Validate topic length when provided (outer Some = field present).
        // WHY: Per-plan enforcement — Free: 256, Supporter: 512, Creator: 1024.
        // validate_channel_topic checks the DB ceiling (4096); the plan limit is stricter.
        if let Some(Some(ref t)) = topic {
            validate_channel_topic(t)?;
            self.content_filter.check_hard(t)?;
            let limits = self.plan_checker.get_server_plan_limits(server_id).await?;
            #[allow(clippy::cast_possible_truncation)] // WHY: max is 4096, fits in usize
            let max_topic = limits.max_channel_topic_chars as usize;
            if t.chars().count() > max_topic {
                return Err(DomainError::ValidationError(format!(
                    "Channel topic must not exceed {} characters on this plan",
                    max_topic
                )));
            }
        }

        if let Some(secs) = slow_mode_seconds {
            validate_slow_mode_seconds(secs)?;
        }

        self.repo
            .update_channel(
                channel_id,
                validated_name,
                topic,
                is_private,
                is_read_only,
                encrypted,
                slow_mode_seconds,
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

    /// Find the default (lowest position) channel for a server.
    ///
    /// Used for system messages (join announcements). Returns `None` if the
    /// server has no channels.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn find_default_for_server(
        &self,
        server_id: &ServerId,
    ) -> Result<Option<Channel>, DomainError> {
        self.repo.find_default_for_server(server_id).await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
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

    // ── encryption one-way toggle ──────────────────────────────────

    #[test]
    fn encryption_toggle_false_to_true_allowed() {
        assert!(check_encryption_toggle(false, Some(true)).is_ok());
    }

    #[test]
    fn encryption_toggle_true_to_false_rejected() {
        let result = check_encryption_toggle(true, Some(false));
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(msg, "Encryption cannot be disabled once enabled");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn encryption_toggle_none_preserves_current() {
        // None means "don't change" — should succeed regardless of current state.
        assert!(check_encryption_toggle(false, None).is_ok());
        assert!(check_encryption_toggle(true, None).is_ok());
    }

    #[test]
    fn encryption_toggle_true_to_true_allowed() {
        // WHY: Re-enabling an already-encrypted channel is a no-op, not an error.
        assert!(check_encryption_toggle(true, Some(true)).is_ok());
    }

    #[test]
    fn encryption_toggle_false_to_false_allowed() {
        // WHY: "Disabling" when already disabled is a no-op, not an error.
        assert!(check_encryption_toggle(false, Some(false)).is_ok());
    }

    // ── slow mode DM guard ───────────────────────────────────────────

    #[test]
    fn slow_mode_on_dm_rejected() {
        let result = check_slow_mode_dm(true, Some(10));
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(msg, "Slow mode cannot be set on DM channels");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn slow_mode_on_non_dm_allowed() {
        assert!(check_slow_mode_dm(false, Some(10)).is_ok());
        assert!(check_slow_mode_dm(false, Some(21600)).is_ok());
    }

    #[test]
    fn slow_mode_zero_on_dm_allowed() {
        // WHY: 0 = disabled. Disabling slow mode on a DM is a no-op, not an error.
        assert!(check_slow_mode_dm(true, Some(0)).is_ok());
    }

    #[test]
    fn slow_mode_none_on_dm_allowed() {
        // WHY: None means "don't change" — should succeed regardless of is_dm.
        assert!(check_slow_mode_dm(true, None).is_ok());
        assert!(check_slow_mode_dm(false, None).is_ok());
    }

    // ── validate_slow_mode_seconds ────────────────────────────────

    #[test]
    fn slow_mode_zero_is_valid() {
        // WHY: 0 means slow mode is disabled — must be accepted.
        assert!(validate_slow_mode_seconds(0).is_ok());
    }

    #[test]
    fn slow_mode_max_is_valid() {
        // WHY: 21600 (6 hours) is the upper boundary — must be accepted.
        assert!(validate_slow_mode_seconds(21600).is_ok());
    }

    #[test]
    fn slow_mode_negative_rejected() {
        let result = validate_slow_mode_seconds(-1);
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(
                    msg,
                    "slow_mode_seconds must be between 0 and 21600 (6 hours)"
                );
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn slow_mode_above_max_rejected() {
        let result = validate_slow_mode_seconds(21601);
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert_eq!(
                    msg,
                    "slow_mode_seconds must be between 0 and 21600 (6 hours)"
                );
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn slow_mode_typical_value_valid() {
        // WHY: 30s is a common slow mode setting — sanity check for mid-range values.
        assert!(validate_slow_mode_seconds(30).is_ok());
    }
}
