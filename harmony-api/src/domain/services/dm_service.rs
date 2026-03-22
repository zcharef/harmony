//! DM (Direct Message) domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ChannelId, ServerId, UserId};
use crate::domain::ports::dm_repository::DmRow;
use crate::domain::ports::{DmRepository, MemberRepository, ProfileRepository, ServerRepository};

/// Hydrated DM conversation returned from service methods.
#[derive(Debug, Clone)]
pub struct DmConversation {
    pub server_id: ServerId,
    pub channel_id: ChannelId,
    pub recipient_id: UserId,
    pub recipient_username: String,
    pub recipient_display_name: Option<String>,
    pub recipient_avatar_url: Option<String>,
    pub last_message_content: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    /// When the caller joined this DM (used as cursor fallback when no messages exist).
    pub joined_at: DateTime<Utc>,
}

impl From<DmRow> for DmConversation {
    fn from(row: DmRow) -> Self {
        Self {
            server_id: row.server_id,
            channel_id: row.channel_id,
            recipient_id: row.other_user_id,
            recipient_username: row.other_username,
            recipient_display_name: row.other_display_name,
            recipient_avatar_url: row.other_avatar_url,
            last_message_content: row.last_message_content,
            last_message_at: row.last_message_at,
            joined_at: row.joined_at,
        }
    }
}

/// Service for DM-related business logic.
#[derive(Debug)]
pub struct DmService {
    dm_repo: Arc<dyn DmRepository>,
    profile_repo: Arc<dyn ProfileRepository>,
    server_repo: Arc<dyn ServerRepository>,
    member_repo: Arc<dyn MemberRepository>,
}

impl DmService {
    #[must_use]
    pub fn new(
        dm_repo: Arc<dyn DmRepository>,
        profile_repo: Arc<dyn ProfileRepository>,
        server_repo: Arc<dyn ServerRepository>,
        member_repo: Arc<dyn MemberRepository>,
    ) -> Self {
        Self {
            dm_repo,
            profile_repo,
            server_repo,
            member_repo,
        }
    }

    /// Create a new DM conversation or return an existing one (idempotent).
    ///
    /// # Returns
    /// `(conversation, created)` where `created` is `true` if a new DM was created.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if the caller tries to DM themselves.
    /// - `DomainError::NotFound` if the recipient profile does not exist.
    /// - `DomainError::RateLimited` if the caller has created too many DMs recently.
    /// - Repository errors on failure.
    pub async fn create_or_get_dm(
        &self,
        caller_id: &UserId,
        recipient_id: &UserId,
    ) -> Result<(DmConversation, bool), DomainError> {
        if *caller_id == *recipient_id {
            return Err(DomainError::ValidationError(
                "Cannot create a DM with yourself".to_string(),
            ));
        }

        // WHY: Both users must have profiles because server_members.user_id has a FK
        // constraint referencing profiles(id). Without this check, the INSERT into
        // server_members would fail with a FK violation if the caller hasn't called
        // syncProfile yet.
        if self.profile_repo.get_by_id(caller_id).await?.is_none() {
            return Err(DomainError::ValidationError(
                "You must sync your profile before creating a DM".to_string(),
            ));
        }

        let recipient = self
            .profile_repo
            .get_by_id(recipient_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "User",
                id: recipient_id.to_string(),
            })?;

        let now = Utc::now();

        // Check for existing DM
        if let Some((server_id, channel_id)) = self
            .dm_repo
            .find_dm_between_users(caller_id, recipient_id)
            .await?
        {
            let conversation = DmConversation {
                server_id,
                channel_id,
                recipient_id: recipient.id,
                recipient_username: recipient.username,
                recipient_display_name: recipient.display_name,
                recipient_avatar_url: recipient.avatar_url,
                last_message_content: None,
                last_message_at: None,
                // WHY: For the create-or-get path we don't have the real joined_at
                // from the DB, but this value is only used as a cursor fallback when
                // last_message_at is None. Using `now` is acceptable here because
                // create_or_get returns a single DM, not a paginated list.
                joined_at: now,
            };
            return Ok((conversation, false));
        }

        // WHY: Rate limit NEW DM creation only. Returning existing DMs is free
        // (idempotent path above). This prevents a malicious user from mass-creating
        // DM servers to pollute the database. 10 new DMs per hour is generous for
        // legitimate use while blocking automated abuse.
        const MAX_DMS_PER_HOUR: i64 = 10;
        let recent_count = self.dm_repo.count_recent_dms_for_user(caller_id).await?;

        if recent_count >= MAX_DMS_PER_HOUR {
            return Err(DomainError::RateLimited(
                "Too many DMs created recently. Please try again later.".to_string(),
            ));
        }

        // Create new DM
        let (server_id, channel_id) = self.dm_repo.create_dm(caller_id, recipient_id).await?;

        let conversation = DmConversation {
            server_id,
            channel_id,
            recipient_id: recipient.id,
            recipient_username: recipient.username,
            recipient_display_name: recipient.display_name,
            recipient_avatar_url: recipient.avatar_url,
            last_message_content: None,
            last_message_at: None,
            // WHY: Just created, so joined_at is effectively now.
            joined_at: now,
        };

        Ok((conversation, true))
    }

    /// List all DM conversations for a user with cursor-based pagination.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn list_dms(
        &self,
        caller_id: &UserId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<DmConversation>, DomainError> {
        let rows = self
            .dm_repo
            .list_dms_for_user(caller_id, cursor, limit)
            .await?;

        Ok(rows.into_iter().map(DmConversation::from).collect())
    }

    /// Close (leave) a DM conversation.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the server doesn't exist.
    /// - `DomainError::ValidationError` if the server is not a DM.
    /// - `DomainError::Forbidden` if the caller is not a member.
    pub async fn close_dm(
        &self,
        caller_id: &UserId,
        server_id: &ServerId,
    ) -> Result<(), DomainError> {
        let server = self
            .server_repo
            .get_by_id(server_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "DM",
                id: server_id.to_string(),
            })?;

        if !server.is_dm {
            return Err(DomainError::ValidationError(
                "Server is not a DM conversation".to_string(),
            ));
        }

        let is_member = self.member_repo.is_member(server_id, caller_id).await?;
        if !is_member {
            return Err(DomainError::Forbidden(
                "You are not a member of this DM conversation".to_string(),
            ));
        }

        self.member_repo.remove_member(server_id, caller_id).await
    }
}
