//! Reaction domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, MessageId, UserId};
use crate::domain::ports::{ChannelRepository, MemberRepository, ReactionRepository};

/// Maximum emoji length in characters.
const MAX_EMOJI_LENGTH: usize = 32;

/// Service for message reaction business logic.
#[derive(Debug)]
pub struct ReactionService {
    repo: Arc<dyn ReactionRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl ReactionService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn ReactionRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
        }
    }

    /// Verify that a user is a member of the server containing a channel.
    ///
    /// WHY: Same pattern as `MessageService::verify_channel_membership` —
    /// reactions require the same authorization check.
    async fn verify_channel_membership(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        let is_member = self
            .member_repo
            .is_member(&channel.server_id, user_id)
            .await?;

        if !is_member {
            return Err(DomainError::Forbidden(
                "You must be a server member to react in this channel".to_string(),
            ));
        }

        Ok(())
    }

    /// Add a reaction to a message.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the user is not a server member,
    /// `DomainError::ValidationError` if the emoji is empty or too long.
    pub async fn add_reaction(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        self.verify_channel_membership(channel_id, user_id).await?;
        validate_emoji(emoji)?;
        self.repo.add(message_id, user_id, emoji).await
    }

    /// Remove a reaction from a message.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the user is not a server member.
    pub async fn remove_reaction(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
        user_id: &UserId,
        emoji: &str,
    ) -> Result<(), DomainError> {
        self.verify_channel_membership(channel_id, user_id).await?;
        self.repo.remove(message_id, user_id, emoji).await
    }
}

/// Validate emoji format: non-empty and within length limit.
fn validate_emoji(emoji: &str) -> Result<(), DomainError> {
    if emoji.trim().is_empty() {
        return Err(DomainError::ValidationError(
            "Emoji must not be empty".to_string(),
        ));
    }
    if emoji.chars().count() > MAX_EMOJI_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "Emoji must not exceed {} characters",
            MAX_EMOJI_LENGTH
        )));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn validate_emoji_rejects_empty() {
        assert!(validate_emoji("").is_err());
        assert!(validate_emoji("   ").is_err());
    }

    #[test]
    fn validate_emoji_rejects_too_long() {
        let long_emoji = "a".repeat(MAX_EMOJI_LENGTH + 1);
        assert!(validate_emoji(&long_emoji).is_err());
    }

    #[test]
    fn validate_emoji_accepts_valid() {
        assert!(validate_emoji("👍").is_ok());
        assert!(validate_emoji("🎉").is_ok());
        assert!(validate_emoji("+1").is_ok());
    }

    #[test]
    fn validate_emoji_at_boundary() {
        let at_limit = "a".repeat(MAX_EMOJI_LENGTH);
        assert!(validate_emoji(&at_limit).is_ok());
    }
}
