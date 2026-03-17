//! Message domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, Message, MessageId, UserId};
use crate::domain::ports::{
    ChannelRepository, MemberRepository, MessageRepository, ServerRepository,
};

/// Service for message-related business logic.
#[derive(Debug)]
pub struct MessageService {
    repo: Arc<dyn MessageRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    server_repo: Arc<dyn ServerRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl MessageService {
    #[must_use]
    pub fn new(
        repo: Arc<dyn MessageRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        server_repo: Arc<dyn ServerRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            server_repo,
            member_repo,
        }
    }

    /// Maximum messages per author per channel within the rate limit window.
    const RATE_LIMIT_MAX: i64 = 5;
    /// Rate limit window in seconds.
    const RATE_LIMIT_WINDOW_SECS: i64 = 5;

    /// Verify that a user is a member of the server containing a channel.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel doesn't exist,
    /// `DomainError::Forbidden` if the user is not a server member.
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
                "You must be a server member to access this channel".to_string(),
            ));
        }

        Ok(())
    }

    /// Send a new message to a channel.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the author is not a server member,
    /// `DomainError::ValidationError` if content is empty,
    /// `DomainError::RateLimited` if the author exceeds 5 messages per 5 seconds,
    /// or a repository error on failure.
    pub async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError> {
        self.verify_channel_membership(channel_id, author_id)
            .await?;

        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        let recent_count = self
            .repo
            .count_recent(channel_id, author_id, Self::RATE_LIMIT_WINDOW_SECS)
            .await?;

        if recent_count >= Self::RATE_LIMIT_MAX {
            return Err(DomainError::RateLimited(
                "Too many messages — try again in a few seconds".to_string(),
            ));
        }

        self.repo.create(channel_id, author_id, content).await
    }

    /// List messages in a channel with cursor-based pagination.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the caller is not a server member,
    /// or a repository error on failure.
    pub async fn list_for_channel(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<Message>, DomainError> {
        self.verify_channel_membership(channel_id, user_id).await?;

        self.repo.list_for_channel(channel_id, cursor, limit).await
    }

    /// Edit a message's content. Only the author can edit.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if content is empty,
    /// `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is not the author.
    pub async fn edit_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        content: String,
    ) -> Result<Message, DomainError> {
        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        if message.author_id != *user_id {
            return Err(DomainError::Forbidden(
                "Only the message author can edit this message".to_string(),
            ));
        }

        self.repo.update_content(message_id, content).await
    }

    /// Soft-delete a message. The author or the server owner can delete (ADR-038).
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is neither the author nor the server owner.
    pub async fn delete_message(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
    ) -> Result<(), DomainError> {
        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        if message.author_id != *user_id {
            // WHY: Server owners can delete any message in their server (moderation).
            // Lookup chain: message.channel_id → channel.server_id → server.owner_id.
            let is_owner = self
                .is_server_owner_for_channel(&message.channel_id, user_id)
                .await?;
            if !is_owner {
                return Err(DomainError::Forbidden(
                    "Only the message author or server owner can delete this message".to_string(),
                ));
            }
        }

        self.repo.soft_delete(message_id).await
    }

    /// Check if a user is the server owner for the server containing a channel.
    async fn is_server_owner_for_channel(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<bool, DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        let server = self
            .server_repo
            .get_by_id(&channel.server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Server",
                id: channel.server_id.to_string(),
            })?;

        Ok(server.owner_id == *user_id)
    }
}
