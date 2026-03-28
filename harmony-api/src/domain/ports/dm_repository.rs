//! Port: DM conversation persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ServerId, UserId};

/// Summary of a DM conversation for listing purposes.
#[derive(Debug, Clone)]
pub struct DmRow {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    /// The other participant in the DM.
    pub other_user_id: UserId,
    pub other_username: String,
    pub other_display_name: Option<String>,
    pub other_avatar_url: Option<String>,
    /// Most recent message content (`None` if no messages yet).
    pub last_message_content: Option<String>,
    /// Timestamp of the most recent message (`None` if no messages yet).
    pub last_message_at: Option<DateTime<Utc>>,
    /// When the caller joined this DM (used as sort fallback).
    pub joined_at: DateTime<Utc>,
}

/// Intent-based repository for DM-specific queries.
#[async_trait]
pub trait DmRepository: Send + Sync + std::fmt::Debug {
    /// Find an existing DM server between two users.
    ///
    /// Returns the `server_id` and `channel_id` if a DM already exists.
    async fn find_dm_between_users(
        &self,
        user_a: &UserId,
        user_b: &UserId,
    ) -> Result<Option<(ServerId, ChannelId)>, DomainError>;

    /// Create a DM server with a single channel and both users as members.
    ///
    /// Returns `(server_id, channel_id)`. This is a single transactional operation.
    async fn create_dm(
        &self,
        user_a: &UserId,
        user_b: &UserId,
    ) -> Result<(ServerId, ChannelId), DomainError>;

    /// List all DM conversations for a user with cursor-based pagination.
    ///
    /// Sorted by most recent message timestamp (or `joined_at` if no messages).
    async fn list_dms_for_user(
        &self,
        user_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<DmRow>, DomainError>;

    /// Count how many DM servers the user has joined in the last hour.
    ///
    /// WHY: Domain-level rate limiting for DM creation. Prevents abuse without
    /// requiring external infrastructure (Redis). Only counts NEW DM creation
    /// (based on `server_members.joined_at`), not returning existing DMs.
    async fn count_recent_dms_for_user(&self, user_id: &UserId) -> Result<i64, DomainError>;
}
