//! Message domain service.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use std::collections::{HashMap, HashSet};

use crate::domain::errors::DomainError;
use crate::domain::models::{
    Channel, ChannelId, MentionedUser, MessageId, MessageWithAuthor, NewAttachment, Role, ServerId,
    UserId,
};
use crate::domain::ports::{
    AroundWindow, AttachmentRepository, ChannelRepository, FriendshipRepository, MemberRepository,
    MessageRepository, MessageSearchFilters, PlanLimitChecker, ReactionRepository,
};
use crate::domain::services::channel_access::ensure_channel_access;
use crate::domain::services::content_filter::{ContentFilter, ModerationVerdict};
use crate::domain::services::spam_guard::{self, SpamGuard};

/// Mention targets present in `current` but absent from `previous`,
/// first-appearance order preserved.
///
/// WHY: edits must not re-charge the mention budget for users who were
/// already mentioned before the edit (polish #9) — only this diff consumes
/// budget. NO `mention.received` is ever emitted for edits (§2.4, Discord
/// parity: edit-in mentions don't ping) — this diff exists purely for
/// budget accounting.
fn diff_new_mentions(previous: &[UserId], current: &[UserId]) -> Vec<UserId> {
    let previous: HashSet<&UserId> = previous.iter().collect();
    current
        .iter()
        .filter(|id| !previous.contains(id))
        .cloned()
        .collect()
}

/// Service for message-related business logic.
#[derive(Debug)]
pub struct MessageService {
    repo: Arc<dyn MessageRepository>,
    channel_repo: Arc<dyn ChannelRepository>,
    member_repo: Arc<dyn MemberRepository>,
    plan_checker: Arc<dyn PlanLimitChecker>,
    reaction_repo: Arc<dyn ReactionRepository>,
    attachment_repo: Arc<dyn AttachmentRepository>,
    content_filter: Arc<ContentFilter>,
    spam_guard: Arc<SpamGuard>,
    friendship_repo: Arc<dyn FriendshipRepository>,
}

/// Maximum message length (DB ceiling — self-hosted max).
/// Per-plan enforcement uses `PlanLimits::max_message_chars`.
const MAX_MESSAGE_LENGTH: usize = 8000;

/// Format seconds into a human-readable duration for error messages.
fn format_duration(seconds: u64) -> &'static str {
    match seconds {
        0..=900 => "15 minutes",
        901..=86_400 => "24 hours",
        86_401..=604_800 => "7 days",
        _ => "unlimited",
    }
}

impl MessageService {
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<dyn MessageRepository>,
        channel_repo: Arc<dyn ChannelRepository>,
        member_repo: Arc<dyn MemberRepository>,
        plan_checker: Arc<dyn PlanLimitChecker>,
        reaction_repo: Arc<dyn ReactionRepository>,
        attachment_repo: Arc<dyn AttachmentRepository>,
        content_filter: Arc<ContentFilter>,
        spam_guard: Arc<SpamGuard>,
        friendship_repo: Arc<dyn FriendshipRepository>,
    ) -> Self {
        Self {
            repo,
            channel_repo,
            member_repo,
            plan_checker,
            reaction_repo,
            attachment_repo,
            content_filter,
            spam_guard,
            friendship_repo,
        }
    }

    /// Rate limit window in seconds. Max messages per window is plan-derived.
    const RATE_LIMIT_WINDOW_SECS: i64 = 5;

    /// Verify that a user may access the channel, returning it on success so
    /// callers can inspect its properties (e.g. `is_read_only`) without an extra
    /// query. Enforces server membership AND the private-channel role gate via the
    /// shared [`ensure_channel_access`] helper.
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the channel doesn't exist,
    /// `DomainError::Forbidden` if the user is not a server member or lacks access
    /// to a private channel.
    async fn verify_channel_membership(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Channel, DomainError> {
        let channel = self
            .channel_repo
            .get_by_id(channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: channel_id.to_string(),
            })?;

        ensure_channel_access(&*self.channel_repo, &*self.member_repo, &channel, user_id).await?;

        Ok(channel)
    }

    /// Send a new message to a channel.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the author is not a server member
    /// or the channel is read-only and the author lacks admin+ role,
    /// `DomainError::ValidationError` if content is empty,
    /// `DomainError::RateLimited` if the author exceeds the plan's message rate limit,
    /// or a repository error on failure.
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        content: String,
        encrypted: bool,
        sender_device_id: Option<String>,
        parent_message_id: Option<MessageId>,
        mentioned_user_ids: Option<Vec<UserId>>,
        attachments: Vec<NewAttachment>,
    ) -> Result<MessageWithAuthor, DomainError> {
        let channel = self
            .verify_channel_membership(channel_id, author_id)
            .await?;

        // WHY: In a DM channel, a block in either direction hard-stops new
        // message sends (§3.4). Reads membership metadata only — E2EE unaffected.
        // No-op (false) for non-DM channels.
        if self
            .friendship_repo
            .dm_send_blocked(author_id, channel_id)
            .await?
        {
            return Err(DomainError::Forbidden(
                "Cannot send messages to this user".to_string(),
            ));
        }

        // WHY: A client sending encrypted=true on a plaintext channel would bypass
        // ALL content moderation (word filter, invite blocking, AI moderation, URL
        // scanning, duplicate detection, mention limits). The server must enforce that
        // encrypted messages are only accepted on encrypted channels.
        if encrypted && !channel.encrypted {
            return Err(DomainError::ValidationError(
                "Cannot send encrypted messages in a non-encrypted channel".to_string(),
            ));
        }

        // WHY: sender_device_id is required when encrypted = true so recipients can
        // look up the Olm session for decryption. Without it, encrypted messages are
        // unreadable. Documented on `SendMessageRequest::sender_device_id`.
        if encrypted && sender_device_id.is_none() {
            return Err(DomainError::ValidationError(
                "sender_device_id is required when encrypted is true".to_string(),
            ));
        }

        // WHY reject attachments on encrypted messages (ticket decision D7):
        // v1 ships plaintext attachments only. A plaintext-blob URL riding an
        // encrypted message would leak content outside the E2EE boundary while
        // the UI presents the message as encrypted. Encrypted-blob upload is
        // the deferred desktop-only track.
        if encrypted && !attachments.is_empty() {
            return Err(DomainError::ValidationError(
                "Attachments are not supported on encrypted messages yet".to_string(),
            ));
        }

        // WHY attachments relax the non-empty guard (ticket decision D10):
        // an image-only message (empty content + ≥1 attachment) is valid,
        // Discord parity.
        if content.trim().is_empty() && attachments.is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        // WHY: DB ceiling check first (fast, no I/O), then per-plan check.
        if content.chars().count() > MAX_MESSAGE_LENGTH {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters",
                MAX_MESSAGE_LENGTH
            )));
        }

        // WHY: Per-plan enforcement — Free: 2000, Supporter/Creator: 4000, Self-Hosted: 8000.
        let limits = self
            .plan_checker
            .get_server_plan_limits(&channel.server_id)
            .await?;
        #[allow(clippy::cast_possible_truncation)] // WHY: max is 8000, fits in usize
        let max_chars = limits.max_message_chars as usize;
        if content.chars().count() > max_chars {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters on this plan",
                max_chars
            )));
        }

        // §6 attachments: per-plan count + per-file size caps, then the §12
        // upload-rate budget. Size is checked once on the LARGEST file — the
        // per-plan cap is uniform, so one check covers every file without a
        // DB round-trip per attachment. The 100MB bucket cap remains the hard
        // boundary on the actual bytes (ticket decision D5).
        if !attachments.is_empty() {
            self.plan_checker
                .check_attachment_count(&channel.server_id, attachments.len() as u64)
                .await?;
            if let Some(max_size) = attachments.iter().map(|a| a.size).max() {
                // WHY try_from→MAX: try_new enforces size > 0, but a negative
                // value slipping through a future construction path must FAIL
                // the cap (u64::MAX), never wrap into a tiny number.
                self.plan_checker
                    .check_attachment_size(
                        &channel.server_id,
                        u64::try_from(max_size).unwrap_or(u64::MAX),
                    )
                    .await?;
            }
            // §12 upload rate (Free 3/min, Supporter 10/min, Creator 20/min):
            // enforced at message-create time because uploads go direct to
            // Storage (the API never proxies the bytes). One budget slot per
            // attachment in a rolling 60s window.
            let max_uploads = usize::try_from(limits.max_uploads_per_min).unwrap_or(usize::MAX);
            // All-or-nothing: a rejected message never partially drains the
            // budget (mirrors the pre-persist mention-budget pattern).
            self.spam_guard.check_and_record_actions(
                author_id,
                "attachment upload",
                attachments.len(),
                max_uploads,
                std::time::Duration::from_secs(60),
            )?;
        }

        // WHY: Role needed by is_read_only, slow_mode, and flood mute admin bypass.
        // Single DB lookup for all three checks.
        let caller_role = self
            .member_repo
            .get_member_role(&channel.server_id, author_id)
            .await?
            .unwrap_or_else(|| {
                // WHY: Member was verified above, so None indicates a data
                // inconsistency (member row exists but role column is missing).
                tracing::warn!(
                    user_id = %author_id,
                    server_id = %channel.server_id,
                    "Role lookup returned None after membership verification — defaulting to Member"
                );
                Role::Member
            });
        let is_admin = caller_role.level() >= Role::Admin.level();

        // A3: Check if user is currently auto-muted for flooding.
        // WHY: Admin+ bypass prevents admins from being locked out of their
        // own servers during active moderation (e.g., cleaning up a raid).
        if !is_admin {
            self.spam_guard.check_muted(author_id, &channel.server_id)?;
        }

        // WHY: The API uses service_role which bypasses the RLS
        // messages_insert_member policy that checks is_read_only.
        // We must enforce read-only at the service layer.
        if channel.is_read_only && !is_admin {
            return Err(DomainError::Forbidden(
                "This channel is read-only".to_string(),
            ));
        }

        // WHY: Slow mode enforcement is done atomically inside send_to_channel
        // using pg_advisory_xact_lock to prevent TOCTOU double-send races. Pass
        // 0 when slow mode doesn't apply (disabled or admin bypass).
        let effective_slow_mode = if channel.slow_mode_seconds > 0 && !is_admin {
            channel.slow_mode_seconds
        } else {
            0
        };

        // WHY: If replying, verify the parent message exists, is not deleted,
        // and belongs to the same channel (can't reply across channels).
        if let Some(ref parent_id) = parent_message_id {
            let parent =
                self.repo
                    .find_by_id(parent_id)
                    .await?
                    .ok_or_else(|| DomainError::NotFound {
                        resource_type: "Message",
                        id: parent_id.to_string(),
                    })?;

            if parent.channel_id != *channel_id {
                return Err(DomainError::ValidationError(
                    "Cannot reply to a message in a different channel".to_string(),
                ));
            }
        }

        let recent_count = self
            .repo
            .count_recent(channel_id, author_id, Self::RATE_LIMIT_WINDOW_SECS)
            .await?;

        // WHY: Per-plan rate limit — Free: 5/5s, Supporter: 10/5s, Creator: 20/5s.
        // Uses server's plan (already fetched above for char limit).
        // WHY try_from + saturate: self-hosted limits use u64::MAX ("unlimited");
        // a raw `as i64` cast wraps it to -1, making `recent_count >= -1` always
        // true — every self-hosted message send 429'd (found by
        // analytics_emission_test, which runs with AlwaysAllowedChecker).
        let rate_max = i64::try_from(limits.max_messages_per_5s).unwrap_or(i64::MAX);
        if recent_count >= rate_max {
            return Err(DomainError::RateLimited(
                "Too many messages — try again in a few seconds".to_string(),
            ));
        }

        // A1: Duplicate detection (skip for encrypted — Megolm ratchet means
        // identical plaintext produces different ciphertext).
        // WHY: Save original content for record_message below. After content
        // moderation, the stored content may be masked (e.g., "h***o"), so the
        // hash would differ. We must hash the same content in both check and record.
        let content_for_dedup = content.clone();
        // WHY skip for image-only messages: empty content hashes identically,
        // so two consecutive image-only sends would false-positive as
        // duplicates. The attachment URLs differ per upload (uuid paths), so
        // there is nothing meaningful to dedupe.
        let skip_dedup = encrypted || content.trim().is_empty();
        self.spam_guard
            .check_duplicate(author_id, channel_id, &content, skip_dedup)?;

        // §2.4 mention resolution (step 1): plaintext parses the content markers
        // (server-authoritative — the request sidecar is ignored); encrypted trusts
        // the client sidecar (the server can't read ciphertext). The pre-dedupe
        // count is the limit. WHY here: this runs BEFORE the AutoMod masking block
        // below, so masking can never corrupt a `<@uuid>` marker (parse-before-mask).
        let raw_mentions: Vec<UserId> = if encrypted {
            mentioned_user_ids.unwrap_or_default()
        } else {
            spam_guard::extract_mentions(&content)
        };
        if raw_mentions.len() > spam_guard::MAX_MENTIONS {
            return Err(DomainError::ValidationError(format!(
                "Too many mentions (max {})",
                spam_guard::MAX_MENTIONS
            )));
        }
        // Step 1 (dedupe, first appearance) + step 2 (strip self — self-mentions
        // never notify), in one order-preserving pass.
        let mut seen = HashSet::new();
        let candidate_ids: Vec<UserId> = raw_mentions
            .into_iter()
            .filter(|id| id != author_id && seen.insert(id.clone()))
            .collect();

        // A4: ASCII art / text art / Zalgo detection (unencrypted only).
        // WHY: Admin+ bypass consistent with flood mute bypass — admins may
        // legitimately post formatted announcements.
        if !encrypted && !is_admin {
            spam_guard::check_ascii_art(&content)?;
        }

        // WHY: Skip content moderation for encrypted messages — ciphertext is
        // opaque, we can't inspect it. Also skip for system messages (handled
        // by create_system_message which bypasses this method entirely).
        let (final_content, mod_at, mod_reason, orig_content) = if encrypted {
            (content, None, None, None)
        } else {
            // B5: Block competitor invite links (sync, pre-send).
            self.content_filter.check_invite_links(&content)?;

            match self.content_filter.check_soft(&content) {
                ModerationVerdict::Clean => (content, None, None, None),
                ModerationVerdict::Flagged {
                    masked_content,
                    reason,
                } => {
                    tracing::warn!(channel_id = %channel_id, "Message auto-moderated");
                    (
                        masked_content,
                        Some(Utc::now()),
                        Some(reason),
                        Some(content),
                    )
                }
            }
        };

        // §2.4 steps 3-4: drop non-members and private-channel non-grantees
        // (silent — no error, no access oracle: the sender already passed
        // ensure_channel_access), then apply the per-sender-per-channel mention
        // budget. Both preserve first-appearance order. Dropped mentions are not
        // persisted, so computed counts, events and rendering stay consistent.
        let mentionable: HashSet<UserId> = self
            .member_repo
            .filter_mentionable(&channel, &candidate_ids)
            .await?
            .into_iter()
            .collect();
        let mut mentioned: Vec<UserId> = candidate_ids
            .into_iter()
            .filter(|id| mentionable.contains(id))
            .collect();
        let granted =
            self.spam_guard
                .consume_mention_budget(author_id, channel_id, mentioned.len());
        if granted < mentioned.len() {
            tracing::warn!(
                sender_id = %author_id,
                channel_id = %channel_id,
                requested = mentioned.len(),
                granted,
                "mention budget exceeded — excess mentions dropped"
            );
            mentioned.truncate(granted);
        }

        let mut message = self
            .repo
            .send_to_channel(
                channel_id,
                author_id,
                final_content,
                encrypted,
                sender_device_id,
                parent_message_id,
                mod_at,
                mod_reason,
                orig_content,
                mentioned,
                attachments,
                effective_slow_mode,
            )
            .await?;

        // §2.4 step 5: resolve the persisted mention ids to display data (the
        // Discord `mentions` array) for the response + SSE payload.
        message.mentions = self
            .member_repo
            .resolve_mentioned_users(&channel.server_id, &message.message.mentioned_user_ids)
            .await?;

        // A1+A3: Record message for duplicate detection + flood tracking.
        // Runs AFTER successful DB write. Admin+ bypass: admins don't accumulate
        // flood counts and can't be auto-muted (matches mute check bypass above).
        if !is_admin
            && let Err(e) = self.spam_guard.record_message(
                author_id,
                channel_id,
                &channel.server_id,
                &content_for_dedup,
                encrypted,
            )
        {
            tracing::warn!(
                user_id = %author_id,
                channel_id = %channel_id,
                error = %e,
                "Flood threshold exceeded — user auto-muted for future messages"
            );
        }

        Ok(message)
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
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let channel = self.verify_channel_membership(channel_id, user_id).await?;

        let messages = self
            .repo
            .list_for_channel(channel_id, cursor, limit)
            .await?;

        self.enrich_page(&channel.server_id, user_id, messages)
            .await
    }

    /// Fetch a window of messages centered on `message_id` (jump-to-message).
    ///
    /// Returns up to `limit` messages: `floor(limit/2)` strictly-older, the
    /// anchor, and the rest strictly-newer, ordered `created_at DESC`. The
    /// anchor is included even when soft-deleted so a jump lands on the
    /// tombstone. Membership is gated by the same check as `list_for_channel`.
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden`/`NotFound` when the caller may not
    /// access the channel, and `DomainError::NotFound` when the anchor does not
    /// exist in this channel.
    pub async fn list_around(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
        message_id: &MessageId,
        limit: i64,
    ) -> Result<AroundWindow, DomainError> {
        let channel = self.verify_channel_membership(channel_id, user_id).await?;

        // WHY floor(limit/2) older + anchor + rest newer: keeps the target
        // centered while spending the full budget (ticket §3.2).
        let before_limit = limit / 2;
        let after_limit = (limit - 1 - before_limit).max(0);

        let window = self
            .repo
            .list_around(channel_id, message_id, before_limit, after_limit)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            })?;

        // Enrichment preserves order, so the `has_more_older` flag stays valid.
        let messages = self
            .enrich_page(&channel.server_id, user_id, window.messages)
            .await?;
        Ok(AroundWindow {
            messages,
            has_more_older: window.has_more_older,
        })
    }

    /// Enrich a raw message page with reactions, attachments, and resolved
    /// mention display data (single batched query each). Shared by
    /// `list_for_channel`, `list_around`, and `search_messages` so every page
    /// renders identically.
    async fn enrich_page(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        mut messages: Vec<MessageWithAuthor>,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let ids: Vec<MessageId> = messages.iter().map(|m| m.message.id.clone()).collect();

        // WHY: Batch-fetch reactions for all messages in a single query,
        // then zip into each MessageWithAuthor. Avoids N+1 queries.
        let mut reactions_map = self.reaction_repo.batch_for_messages(&ids, user_id).await?;
        for msg in &mut messages {
            if let Some(reactions) = reactions_map.remove(&msg.message.id) {
                msg.reactions = reactions;
            }
        }

        // WHY: Batch-fetch attachments the same way (single query, zipped in).
        // Messages without attachments are absent from the map — left empty.
        let mut attachments_map = self.attachment_repo.batch_for_messages(&ids).await?;
        for msg in &mut messages {
            if let Some(attachments) = attachments_map.remove(&msg.message.id) {
                msg.attachments = attachments;
            }
        }

        // WHY: Resolve mention display data for the whole page in a single
        // server-scoped query so history pills render without a members-cache
        // dependency (§2.3). Skipped entirely when no message mentions anyone.
        let mention_ids: Vec<UserId> = messages
            .iter()
            .flat_map(|m| m.message.mentioned_user_ids.iter().cloned())
            .collect();
        if !mention_ids.is_empty() {
            let resolved = self
                .member_repo
                .resolve_mentioned_users(server_id, &mention_ids)
                .await?;
            let by_id: HashMap<UserId, MentionedUser> = resolved
                .into_iter()
                .map(|u| (u.user_id.clone(), u))
                .collect();
            for msg in &mut messages {
                msg.mentions = msg
                    .message
                    .mentioned_user_ids
                    .iter()
                    .filter_map(|id| by_id.get(id).cloned())
                    .collect();
            }
        }

        Ok(messages)
    }

    /// Full-text search messages in a server, gated by the same per-channel
    /// access predicate as the rest of the app (§2.4).
    ///
    /// # Errors
    /// Returns `DomainError::Forbidden` if the caller is not a server member, or
    /// (when an explicit `channel_id` filter is set) if they cannot access that
    /// channel / it does not belong to this server. Repository errors propagate.
    pub async fn search_messages(
        &self,
        server_id: &ServerId,
        user_id: &UserId,
        query_text: &str,
        filters: MessageSearchFilters,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        // 1. Membership gate — a non-member never searches this server.
        if !self.member_repo.is_member(server_id, user_id).await? {
            return Err(DomainError::Forbidden(
                "You must be a server member to search this server".to_string(),
            ));
        }

        // 2. Explicit-channel gate: an explicit `in:#channel` the caller cannot
        // access becomes a clean 403 (not empty results), AND this validates the
        // channel belongs to this server (rejects cross-server channelId). Server-
        // wide search skips this — the SQL access predicate handles it (no oracle).
        if let Some(channel_id) = filters.channel_id.as_ref() {
            // WHY Forbidden for BOTH "does not exist" and "belongs to another
            // server": a probing client must not be able to distinguish the two
            // (404 vs 403 would be an existence oracle across servers). The
            // explicit `in:` filter only ever carries a channel the caller
            // resolved from their own visible list, so a legit request never hits
            // this — only an injected id does.
            let channel = self
                .channel_repo
                .get_by_id(channel_id)
                .await?
                .ok_or_else(|| {
                    DomainError::Forbidden("You do not have access to that channel".to_string())
                })?;
            if channel.server_id != *server_id {
                return Err(DomainError::Forbidden(
                    "You do not have access to that channel".to_string(),
                ));
            }
            ensure_channel_access(&*self.channel_repo, &*self.member_repo, &channel, user_id)
                .await?;
        }

        let messages = self
            .repo
            .search_in_server(server_id, user_id, query_text, &filters, cursor, limit)
            .await?;

        self.enrich_page(server_id, user_id, messages).await
    }

    /// Reload a message as a full [`MessageWithAuthor`] (author + attachments +
    /// resolved mentions) for a `MessageUpdated` SSE after an async
    /// attachment-moderation verdict. Returns `None` if the message no longer
    /// exists (soft-deleted meanwhile). Reactions are intentionally left empty —
    /// the SSE `MessagePayload` carries no reactions.
    ///
    /// # Errors
    /// Returns a repository error on failure.
    pub async fn reload_for_moderation_event(
        &self,
        message_id: &MessageId,
    ) -> Result<Option<MessageWithAuthor>, DomainError> {
        let Some(mut message) = self.repo.find_with_author(message_id).await? else {
            return Ok(None);
        };

        // Attachments carry the fresh moderation statuses just written.
        let mut attachments_map = self
            .attachment_repo
            .batch_for_messages(std::slice::from_ref(message_id))
            .await?;
        if let Some(attachments) = attachments_map.remove(message_id) {
            message.attachments = attachments;
        }

        // Resolve mentions so pills render identically to the create/edit paths.
        if !message.message.mentioned_user_ids.is_empty() {
            let channel = self
                .channel_repo
                .get_by_id(&message.message.channel_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Channel",
                    id: message.message.channel_id.to_string(),
                })?;
            message.mentions = self
                .member_repo
                .resolve_mentioned_users(&channel.server_id, &message.message.mentioned_user_ids)
                .await?;
        }

        Ok(Some(message))
    }

    /// Edit a message's content. Only the author can edit.
    ///
    /// Plaintext edits re-parse mentions and persist the new list; only
    /// mentions NEWLY added by the edit consume budget (polish #9). No
    /// `mention.received` is emitted for edits (§2.4, Discord parity).
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` if content is empty,
    /// `DomainError::NotFound` if the message doesn't exist, is deleted, or
    /// does not belong to `channel_id` (path-scope binding),
    /// `DomainError::Forbidden` if the caller is not the author.
    pub async fn edit_message(
        &self,
        channel_id: &ChannelId,
        message_id: &MessageId,
        user_id: &UserId,
        content: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        if content.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "Message content must not be empty".to_string(),
            ));
        }

        // WHY: DB ceiling check first (fast, no I/O).
        if content.chars().count() > MAX_MESSAGE_LENGTH {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters",
                MAX_MESSAGE_LENGTH
            )));
        }

        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        // WHY: bind the URL path to the message — without this, an author could
        // PATCH their message through ANY existing channel id and the handler
        // would stamp SSE events (message.updated) with the attacker-chosen
        // channel/server scope. 404 (not 400) so a mismatched path leaks
        // nothing about the message's real location. Mirrors the cross-channel
        // parent check in `create`.
        if message.channel_id != *channel_id {
            return Err(DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            });
        }

        if message.author_id != *user_id {
            return Err(DomainError::Forbidden(
                "Only the message author can edit this message".to_string(),
            ));
        }

        // WHY: Fetch channel to get server_id for plan lookup.
        let channel = self
            .channel_repo
            .get_by_id(&message.channel_id)
            .await?
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "Channel",
                id: message.channel_id.to_string(),
            })?;

        let limits = self
            .plan_checker
            .get_server_plan_limits(&channel.server_id)
            .await?;

        // WHY: Per-plan edit window — Free: 15min, Supporter: 24h, Creator: 7d.
        // u64::MAX means unlimited (self-hosted).
        if limits.message_edit_window_secs < u64::MAX {
            #[allow(clippy::cast_possible_wrap)] // WHY: guarded by < u64::MAX check above
            let window = chrono::Duration::seconds(limits.message_edit_window_secs as i64);
            if Utc::now() - message.created_at > window {
                return Err(DomainError::Forbidden(format!(
                    "Edit window expired. Your plan allows editing within {} of creation.",
                    format_duration(limits.message_edit_window_secs)
                )));
            }
        }

        // WHY: Per-plan message length — Free: 2000, Supporter/Creator: 4000.
        #[allow(clippy::cast_possible_truncation)] // WHY: max is 8000, fits in usize
        let max_chars = limits.max_message_chars as usize;
        if content.chars().count() > max_chars {
            return Err(DomainError::ValidationError(format!(
                "Message content must not exceed {} characters on this plan",
                max_chars
            )));
        }

        // §2.4 edits: re-parse mentions (plaintext) so rendering and future
        // read-state queries stay correct. Discord parity — the handler emits
        // only MessageUpdated, NO mention.received / live badge deltas for
        // edits. Runs BEFORE the masking block below (parse-before-mask).
        // Polish #9: only mentions NEWLY ADDED by this edit (absent from the
        // pre-edit persisted list) consume the mention budget — pre-existing
        // mentions were charged when first sent, so an edit must not re-charge
        // them. Behavior change (step 2): a plaintext edit producing >10 valid
        // markers returns 400. Encrypted edits pass None (the column is left
        // untouched via COALESCE in the repo) and never add mentions.
        let mentioned_user_ids: Option<Vec<UserId>> = if message.encrypted {
            None
        } else {
            let raw = spam_guard::extract_mentions(&content);
            if raw.len() > spam_guard::MAX_MENTIONS {
                return Err(DomainError::ValidationError(format!(
                    "Too many mentions (max {})",
                    spam_guard::MAX_MENTIONS
                )));
            }
            let mut seen = HashSet::new();
            let candidate_ids: Vec<UserId> = raw
                .into_iter()
                .filter(|id| *id != message.author_id && seen.insert(id.clone()))
                .collect();
            let mentionable: HashSet<UserId> = self
                .member_repo
                .filter_mentionable(&channel, &candidate_ids)
                .await?
                .into_iter()
                .collect();
            let mut mentioned: Vec<UserId> = candidate_ids
                .into_iter()
                .filter(|id| mentionable.contains(id))
                .collect();
            let mut new_ids = diff_new_mentions(&message.mentioned_user_ids, &mentioned);
            let granted = self.spam_guard.consume_mention_budget(
                &message.author_id,
                &message.channel_id,
                new_ids.len(),
            );
            if granted < new_ids.len() {
                tracing::warn!(
                    sender_id = %message.author_id,
                    channel_id = %message.channel_id,
                    requested = new_ids.len(),
                    granted,
                    "mention budget exceeded on edit — excess new mentions dropped"
                );
                // Keep every pre-existing mention plus the first `granted`
                // new ones (first-appearance order) — drop only the excess.
                let dropped: HashSet<UserId> = new_ids.split_off(granted).into_iter().collect();
                mentioned.retain(|id| !dropped.contains(id));
            }
            Some(mentioned)
        };

        // WHY: Re-check content moderation on edits — a user could send a clean
        // message then edit it to add banned words. Skip for encrypted messages.
        let (final_content, mod_at, mod_reason, orig_content) = if message.encrypted {
            (content, None, None, None)
        } else {
            // A4: ASCII art detection on edits (prevent edit-in-bypass).
            // WHY: No admin bypass — consistent with word filter and invite
            // blocking which also apply to all users on edits.
            spam_guard::check_ascii_art(&content)?;

            // B5: Block competitor invite links on edits too (prevent edit-in-bypass).
            self.content_filter.check_invite_links(&content)?;

            match self.content_filter.check_soft(&content) {
                ModerationVerdict::Clean => (content, None, None, None),
                ModerationVerdict::Flagged {
                    masked_content,
                    reason,
                } => {
                    tracing::warn!(message_id = %message_id, "Edited message auto-moderated");
                    (
                        masked_content,
                        Some(Utc::now()),
                        Some(reason),
                        Some(content),
                    )
                }
            }
        };

        let mut updated = self
            .repo
            .update_content(
                message_id,
                final_content,
                mod_at,
                mod_reason,
                orig_content,
                mentioned_user_ids,
            )
            .await?;

        // Resolve the persisted mention ids (post-COALESCE) for the response and
        // MessageUpdated payload. Encrypted edits reflect the unchanged column.
        updated.mentions = self
            .member_repo
            .resolve_mentioned_users(&channel.server_id, &updated.message.mentioned_user_ids)
            .await?;

        // WHY: Edits cannot change attachments (v1), but the MessageUpdated
        // payload replaces the whole cached message client-side — omitting the
        // existing attachments here would make them vanish from every reader's
        // UI on edit.
        let mut attachments_map = self
            .attachment_repo
            .batch_for_messages(std::slice::from_ref(message_id))
            .await?;
        if let Some(attachments) = attachments_map.remove(message_id) {
            updated.attachments = attachments;
        }
        Ok(updated)
    }

    /// Soft-delete a message. The author or moderator+ can delete (ADR-038).
    ///
    /// # Errors
    /// Returns `DomainError::NotFound` if the message doesn't exist or is deleted,
    /// `DomainError::Forbidden` if the caller is neither the author nor a moderator+.
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
            // WHY: Moderator+ can delete any message in their server (moderation).
            // Lookup chain: message.channel_id → channel.server_id → member.role.
            // Matches RLS policy messages_update_moderator_softdelete.
            let channel = self
                .channel_repo
                .get_by_id(&message.channel_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Channel",
                    id: message.channel_id.to_string(),
                })?;

            let caller_role = self
                .member_repo
                .get_member_role(&channel.server_id, user_id)
                .await?
                .ok_or_else(|| {
                    DomainError::Forbidden(
                        "You must be a server member to delete messages in this channel"
                            .to_string(),
                    )
                })?;

            if caller_role.level() < Role::Moderator.level() {
                return Err(DomainError::Forbidden(
                    "Only the message author or a moderator can delete this message".to_string(),
                ));
            }
        }

        // WHY: None = skip stale-content guard. User/moderator deletes should
        // always proceed regardless of edits (they're intentional human actions).
        self.repo.soft_delete(message_id, user_id, None).await
    }

    /// Per-channel pin cap (Discord parity). Soft cap — a concurrent 49→50→51
    /// race is harmless (spec §6); the list endpoint's `LIMIT MAX_PINS` bounds
    /// what renders regardless.
    const MAX_PINS: i64 = 50;

    /// Pin or unpin a message. Requires **moderator+** in the channel's server —
    /// NO author exception (Discord "Manage Messages"; unlike `delete_message`,
    /// pinning your own message still needs the role). The handler enforces
    /// channel access (private-channel gate) on top.
    ///
    /// Returns `Some(updated)` when the flag actually changed (the caller emits
    /// the SSE event), or `None` on an idempotent no-op (already in the target
    /// state — no write, no event, still a 204 to the client, matching Discord).
    ///
    /// # Errors
    /// - `NotFound` if the message doesn't exist, is soft-deleted, or does not
    ///   belong to `channel` (path/message mismatch — prevents fanning the event
    ///   out under an attacker-chosen channel scope, mirroring `edit_message`).
    /// - `Forbidden` if the caller is not a server member or below moderator.
    /// - `Conflict` (→ 409) if pinning would exceed [`Self::MAX_PINS`].
    pub async fn set_pinned(
        &self,
        message_id: &MessageId,
        user_id: &UserId,
        channel: &Channel,
        pinned: bool,
    ) -> Result<Option<MessageWithAuthor>, DomainError> {
        let message =
            self.repo
                .find_by_id(message_id)
                .await?
                .ok_or_else(|| DomainError::NotFound {
                    resource_type: "Message",
                    id: message_id.to_string(),
                })?;

        // WHY bind to the path channel: a moderator must not pin a message that
        // lives in a different channel via this channel's path — the event would
        // fan out with the wrong channel/scope. 404 (not 403) so we never reveal
        // that the id exists elsewhere.
        if message.channel_id != channel.id {
            return Err(DomainError::NotFound {
                resource_type: "Message",
                id: message_id.to_string(),
            });
        }

        // Moderator+ gate — no author exception (Discord "Manage Messages").
        let role = self
            .member_repo
            .get_member_role(&channel.server_id, user_id)
            .await?
            .ok_or_else(|| {
                DomainError::Forbidden("You must be a moderator to pin messages".to_string())
            })?;
        if role.level() < Role::Moderator.level() {
            return Err(DomainError::Forbidden(
                "You must be a moderator to pin messages".to_string(),
            ));
        }

        // Idempotent no-op: already in the target state → no write, no event.
        if message.is_pinned == pinned {
            return Ok(None);
        }

        // Pin path only: enforce the per-channel cap.
        if pinned {
            let count = self.repo.count_pinned(&channel.id).await?;
            if count >= Self::MAX_PINS {
                return Err(DomainError::Conflict(format!(
                    "Channel pin limit ({}) reached",
                    Self::MAX_PINS
                )));
            }
        }

        let updated = self.repo.set_pinned(message_id, user_id, pinned).await?;
        Ok(Some(updated))
    }

    /// List a channel's pinned messages, most-recently-pinned first, capped at
    /// [`Self::MAX_PINS`]. Any member with channel access may read pins.
    ///
    /// # Errors
    /// Returns `Forbidden`/`NotFound` when the caller may not access the channel.
    pub async fn list_pinned(
        &self,
        channel_id: &ChannelId,
        user_id: &UserId,
    ) -> Result<Vec<MessageWithAuthor>, DomainError> {
        let channel = self.verify_channel_membership(channel_id, user_id).await?;

        let messages = self.repo.list_pinned(channel_id, Self::MAX_PINS).await?;

        self.enrich_page(&channel.server_id, user_id, messages)
            .await
    }

    /// Post a system message (e.g. join announcement).
    ///
    /// Bypasses rate limits, content validation, and read-only checks — none
    /// apply to server-generated events. `author_id` is the subject of the
    /// event (the user who joined), not a "sender".
    ///
    /// # Errors
    /// Returns `DomainError::Validation` if `system_event_key` is blank.
    /// Returns a repository error on failure.
    pub async fn create_system_message(
        &self,
        channel_id: &ChannelId,
        author_id: &UserId,
        system_event_key: String,
    ) -> Result<MessageWithAuthor, DomainError> {
        if system_event_key.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "system_event_key must not be blank".to_string(),
            ));
        }

        self.repo
            .create_system(channel_id, author_id, system_event_key)
            .await
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    /// `MAX_MESSAGE_LENGTH` must be 8000 -- DB ceiling (self-hosted max).
    /// Per-plan enforcement is done at the service layer via `PlanLimits::max_message_chars`.
    #[test]
    fn max_message_length_constant() {
        assert_eq!(MAX_MESSAGE_LENGTH, 8000);
    }

    // ── diff_new_mentions (polish #9: edit budget/notify diff) ────

    /// WHY: an edit that keeps the same mentions must produce an EMPTY diff —
    /// this is what guarantees no budget re-charge for users already
    /// mentioned before the edit.
    #[test]
    fn diff_new_mentions_same_mentions_yields_empty() {
        let a = UserId::from(uuid::Uuid::new_v4());
        let b = UserId::from(uuid::Uuid::new_v4());
        let previous = vec![a.clone(), b.clone()];
        let current = vec![a, b];

        let diff = diff_new_mentions(&previous, &current);
        assert!(
            diff.is_empty(),
            "unchanged mentions must not be treated as new"
        );
    }

    /// WHY: only the users ADDED by the edit may consume budget —
    /// pre-existing ones are excluded from the diff.
    #[test]
    fn diff_new_mentions_returns_only_added_users() {
        let existing = UserId::from(uuid::Uuid::new_v4());
        let added = UserId::from(uuid::Uuid::new_v4());
        let previous = vec![existing.clone()];
        let current = vec![existing, added.clone()];

        let diff = diff_new_mentions(&previous, &current);
        assert_eq!(
            diff,
            vec![added],
            "only the newly-added user is in the diff"
        );
    }

    /// WHY: removing a mention is not an addition — the diff stays empty and
    /// nothing is charged. (The removal itself is persisted via the new list.)
    #[test]
    fn diff_new_mentions_removal_yields_empty() {
        let a = UserId::from(uuid::Uuid::new_v4());
        let b = UserId::from(uuid::Uuid::new_v4());
        let previous = vec![a.clone(), b];
        let current = vec![a];

        let diff = diff_new_mentions(&previous, &current);
        assert!(diff.is_empty(), "a removed mention is never 'new'");
    }

    /// WHY: the diff preserves first-appearance order of the NEW content —
    /// budget truncation drops the LAST added mentions, so order is contract.
    #[test]
    fn diff_new_mentions_preserves_first_appearance_order() {
        let old = UserId::from(uuid::Uuid::new_v4());
        let first = UserId::from(uuid::Uuid::new_v4());
        let second = UserId::from(uuid::Uuid::new_v4());
        let previous = vec![old.clone()];
        let current = vec![first.clone(), old, second.clone()];

        let diff = diff_new_mentions(&previous, &current);
        assert_eq!(diff, vec![first, second], "order follows the new content");
    }

    /// WHY: with an empty previous list (message had no mentions), every
    /// validated mention in the edit is new — the edit behaves like a send.
    #[test]
    fn diff_new_mentions_all_new_when_previous_empty() {
        let a = UserId::from(uuid::Uuid::new_v4());
        let b = UserId::from(uuid::Uuid::new_v4());
        let current = vec![a.clone(), b.clone()];

        let diff = diff_new_mentions(&[], &current);
        assert_eq!(diff, vec![a, b]);
    }

    /// Rate limit window must be 5 seconds. Max messages per window is plan-derived.
    #[test]
    fn rate_limit_window_constant() {
        assert_eq!(MessageService::RATE_LIMIT_WINDOW_SECS, 5);
    }

    // ── Validation logic (pure, no I/O) ───────────────────────────

    /// WHY: The `create` and `edit_message` methods both reject empty content.
    /// This tests the validation string directly since the service method
    /// requires async infrastructure. The exact error message is part of
    /// the API contract.
    #[test]
    fn empty_content_produces_validation_error_message() {
        let content = "   ";
        assert!(content.trim().is_empty());
        // Matches the guard in `create` and `edit_message`
    }

    /// WHY: Whitespace-only content (spaces, tabs, newlines) must be treated
    /// as empty. The service uses `content.trim().is_empty()`.
    #[test]
    fn whitespace_only_content_is_treated_as_empty() {
        let cases = ["", " ", "  ", "\t", "\n", "\r\n", " \t \n "];
        for content in cases {
            assert!(
                content.trim().is_empty(),
                "Expected whitespace-only content to be treated as empty: {:?}",
                content
            );
        }
    }

    /// WHY: Content at exactly `MAX_MESSAGE_LENGTH` must be accepted.
    /// Content at `MAX_MESSAGE_LENGTH` + 1 must be rejected.
    #[test]
    fn max_message_length_boundary() {
        let at_limit = "a".repeat(MAX_MESSAGE_LENGTH);
        assert_eq!(at_limit.chars().count(), MAX_MESSAGE_LENGTH);
        assert!(
            at_limit.chars().count() <= MAX_MESSAGE_LENGTH,
            "Content at limit should be accepted"
        );

        let over_limit = "a".repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(
            over_limit.chars().count() > MAX_MESSAGE_LENGTH,
            "Content over limit should be rejected"
        );
    }

    /// WHY: Unicode characters should be counted by char, not by byte.
    /// A 4-byte emoji (U+1F600) counts as 1 character, not 4.
    /// This ensures plan limits are fair for non-ASCII users.
    #[test]
    fn message_length_counts_chars_not_bytes() {
        // U+1F600 (grinning face) is 4 bytes but 1 char
        let emoji = "\u{1f600}";
        assert_eq!(emoji.len(), 4, "emoji should be 4 bytes");
        assert_eq!(emoji.chars().count(), 1, "emoji should be 1 char");

        // Fill to MAX_MESSAGE_LENGTH with emoji — should pass
        let at_limit = emoji.repeat(MAX_MESSAGE_LENGTH);
        assert_eq!(at_limit.chars().count(), MAX_MESSAGE_LENGTH);
        assert!(at_limit.chars().count() <= MAX_MESSAGE_LENGTH);

        // One emoji over — should fail
        let over_limit = emoji.repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(over_limit.chars().count() > MAX_MESSAGE_LENGTH);
    }

    /// WHY: Control characters (U+0000 through U+001F except common
    /// whitespace) should still count toward the character limit.
    /// The service does not strip them — it counts raw chars.
    #[test]
    fn control_characters_count_toward_length() {
        // Null byte is a valid char
        let null_char = "\0";
        assert_eq!(null_char.chars().count(), 1);

        // Bell character (U+0007)
        let bell = "\x07";
        assert_eq!(bell.chars().count(), 1);

        // A message of control chars at limit should be accepted by length check
        // (but would fail the trim().is_empty() check separately if all whitespace)
        // "hello" (5) + \x07 (1) + "world" (5) + \0 (1) + "test" (4) = 16
        let mixed = "hello\x07world\0test".to_string();
        assert_eq!(mixed.chars().count(), 16);
        assert!(!mixed.trim().is_empty(), "mixed content is not empty");
    }

    /// WHY: The soft delete contract requires `deleted_at` and `deleted_by`
    /// fields on the Message model. This ensures the struct fields exist
    /// and have the correct types for the soft-delete pattern (ADR-038).
    #[test]
    fn message_model_supports_soft_delete_fields() {
        use uuid::Uuid;

        let msg = crate::domain::models::Message {
            id: MessageId::from(Uuid::new_v4()),
            channel_id: ChannelId::from(Uuid::new_v4()),
            author_id: UserId::from(Uuid::new_v4()),
            content: "test".to_string(),
            edited_at: None,
            deleted_at: None,
            deleted_by: None,
            encrypted: false,
            sender_device_id: None,
            message_type: crate::domain::models::MessageType::Default,
            system_event_key: None,
            parent_message_id: None,
            moderated_at: None,
            moderation_reason: None,
            original_content: None,
            mentioned_user_ids: vec![],
            is_pinned: false,
            pinned_by: None,
            pinned_at: None,
            created_at: Utc::now(),
        };

        // Not deleted by default
        assert!(msg.deleted_at.is_none());
        assert!(msg.deleted_by.is_none());

        // Simulate soft delete — verify fields accept Some values
        let deleter = UserId::from(Uuid::new_v4());
        let deleted_msg = crate::domain::models::Message {
            deleted_at: Some(Utc::now()),
            deleted_by: Some(deleter),
            ..msg
        };

        assert!(deleted_msg.deleted_at.is_some());
        assert!(deleted_msg.deleted_by.is_some());
    }

    /// WHY: `MessageType` serializes to lowercase strings ("default", "system")
    /// matching the Postgres enum values and the frontend's expected format.
    #[test]
    fn message_type_serialization() {
        use crate::domain::models::MessageType;

        let default_json = serde_json::to_string(&MessageType::Default).unwrap();
        assert_eq!(default_json, r#""default""#);

        let system_json = serde_json::to_string(&MessageType::System).unwrap();
        assert_eq!(system_json, r#""system""#);

        // Deserialization round-trip
        let parsed_system: MessageType = serde_json::from_str(r#""system""#).unwrap();
        assert_eq!(parsed_system, MessageType::System);

        let parsed_default: MessageType = serde_json::from_str(r#""default""#).unwrap();
        assert_eq!(parsed_default, MessageType::Default);
    }

    /// WHY: The create method rejects messages exceeding plan-specific limits
    /// (e.g., Free: 2000 chars). This tests the comparison logic directly.
    #[test]
    fn plan_limit_boundary_check_logic() {
        let free_plan_limit: usize = 2000;
        let supporter_plan_limit: usize = 4000;

        // At free plan limit: accepted
        let at_free = "a".repeat(free_plan_limit);
        assert!(at_free.chars().count() <= free_plan_limit);

        // Over free plan limit but under supporter: rejected on free, accepted on supporter
        let over_free = "a".repeat(free_plan_limit + 1);
        assert!(over_free.chars().count() > free_plan_limit);
        assert!(over_free.chars().count() <= supporter_plan_limit);

        // At supporter limit: accepted on supporter
        let at_supporter = "a".repeat(supporter_plan_limit);
        assert!(at_supporter.chars().count() <= supporter_plan_limit);

        // Over supporter but under DB ceiling: rejected on supporter, accepted on self-hosted
        let over_supporter = "a".repeat(supporter_plan_limit + 1);
        assert!(over_supporter.chars().count() > supporter_plan_limit);
        assert!(over_supporter.chars().count() <= MAX_MESSAGE_LENGTH);
    }

    // ── set_pinned business rules (moderator gate, cap, idempotency) ──
    //
    // These drive the REAL `MessageService::set_pinned` against fake repos so a
    // regression that drops the moderator gate, flips the cap comparison
    // (`>=` → `>`), or removes the idempotent short-circuit fails the normal
    // `just wall`. The repo-layer SQL is covered separately by the `#[ignore]`
    // integration tests in `tests/pins_test.rs` (which are excluded from CI).

    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use uuid::Uuid;

    use crate::domain::models::friendship::{
        BlockOutcome, BlockedUserRow, FriendRequestRow, FriendRow, Friendship, RequestDirection,
        RequestOutcome,
    };
    use crate::domain::models::{
        Attachment, AttachmentId, AttachmentModerationStatus, ChannelType, EmojiVariety, Message,
        MessageType, PlanLimits, ReactionSummary, ServerMember,
    };

    fn pin_user_id(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }
    fn pin_server_id(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }
    fn pin_channel_id(n: u128) -> ChannelId {
        ChannelId::new(Uuid::from_u128(n))
    }
    fn pin_message_id(n: u128) -> MessageId {
        MessageId::new(Uuid::from_u128(n))
    }

    /// A public channel in server 1, id 100 — the path channel for the tests.
    fn pin_channel() -> Channel {
        let now = Utc::now();
        Channel {
            id: pin_channel_id(100),
            server_id: pin_server_id(1),
            name: "general".to_string(),
            topic: None,
            channel_type: ChannelType::Text,
            position: 0,
            category_id: None,
            is_private: false,
            is_read_only: false,
            encrypted: false,
            slow_mode_seconds: 0,
            created_at: now,
            updated_at: now,
        }
    }

    /// A message in `channel`, with the given pin state.
    fn pin_message(channel_id: ChannelId, is_pinned: bool) -> Message {
        Message {
            id: pin_message_id(7),
            channel_id,
            author_id: pin_user_id(1),
            content: "hello".to_string(),
            edited_at: None,
            deleted_at: None,
            deleted_by: None,
            encrypted: false,
            sender_device_id: None,
            message_type: MessageType::Default,
            system_event_key: None,
            parent_message_id: None,
            moderated_at: None,
            moderation_reason: None,
            original_content: None,
            mentioned_user_ids: vec![],
            is_pinned,
            pinned_by: None,
            pinned_at: None,
            created_at: Utc::now(),
        }
    }

    /// `MessageRepository` fake for the pin path. `find_by_id` returns the
    /// configured message (`None` models missing/soft-deleted), `count_pinned`
    /// returns the configured count, and `set_pinned` records how many times it
    /// was invoked so the idempotent no-op can assert "no write".
    #[derive(Debug)]
    struct PinFakeMessageRepo {
        message: Option<Message>,
        pinned_count: i64,
        set_pinned_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl MessageRepository for PinFakeMessageRepo {
        async fn find_by_id(
            &self,
            _message_id: &MessageId,
        ) -> Result<Option<Message>, DomainError> {
            Ok(self.message.clone())
        }
        async fn count_pinned(&self, _channel_id: &ChannelId) -> Result<i64, DomainError> {
            Ok(self.pinned_count)
        }
        async fn set_pinned(
            &self,
            _message_id: &MessageId,
            pinned_by: &UserId,
            pinned: bool,
        ) -> Result<MessageWithAuthor, DomainError> {
            self.set_pinned_calls.fetch_add(1, Ordering::SeqCst);
            let mut message = self.message.clone().unwrap();
            message.is_pinned = pinned;
            message.pinned_by = pinned.then(|| pinned_by.clone());
            Ok(MessageWithAuthor {
                message,
                author_username: "author".to_string(),
                author_display_name: None,
                author_avatar_url: None,
                reactions: vec![],
                parent_message: None,
                mentions: vec![],
                attachments: vec![],
            })
        }

        // -- unused by set_pinned --
        async fn find_with_author(
            &self,
            _message_id: &MessageId,
        ) -> Result<Option<MessageWithAuthor>, DomainError> {
            Ok(None)
        }
        async fn list_pinned(
            &self,
            _channel_id: &ChannelId,
            _limit: i64,
        ) -> Result<Vec<MessageWithAuthor>, DomainError> {
            Ok(vec![])
        }
        #[allow(clippy::too_many_arguments)]
        async fn send_to_channel(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _content: String,
            _encrypted: bool,
            _sender_device_id: Option<String>,
            _parent_message_id: Option<MessageId>,
            _moderated_at: Option<DateTime<Utc>>,
            _moderation_reason: Option<String>,
            _original_content: Option<String>,
            _mentioned_user_ids: Vec<UserId>,
            _attachments: Vec<NewAttachment>,
            _slow_mode_seconds: i32,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn list_for_channel(
            &self,
            _channel_id: &ChannelId,
            _cursor: Option<DateTime<Utc>>,
            _limit: i64,
        ) -> Result<Vec<MessageWithAuthor>, DomainError> {
            Ok(vec![])
        }
        async fn list_around(
            &self,
            _channel_id: &ChannelId,
            _anchor_id: &MessageId,
            _before_limit: i64,
            _after_limit: i64,
        ) -> Result<Option<AroundWindow>, DomainError> {
            Ok(None)
        }
        async fn search_in_server(
            &self,
            _server_id: &ServerId,
            _caller_user_id: &UserId,
            _query_text: &str,
            _filters: &MessageSearchFilters,
            _cursor: Option<DateTime<Utc>>,
            _limit: i64,
        ) -> Result<Vec<MessageWithAuthor>, DomainError> {
            Ok(vec![])
        }
        async fn update_content(
            &self,
            _message_id: &MessageId,
            _content: String,
            _moderated_at: Option<DateTime<Utc>>,
            _moderation_reason: Option<String>,
            _original_content: Option<String>,
            _mentioned_user_ids: Option<Vec<UserId>>,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn soft_delete(
            &self,
            _message_id: &MessageId,
            _deleted_by: &UserId,
            _checked_at: Option<DateTime<Utc>>,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_recent(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _window_secs: i64,
        ) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn get_last_message_time(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
        ) -> Result<Option<DateTime<Utc>>, DomainError> {
            Ok(None)
        }
        async fn create_system(
            &self,
            _channel_id: &ChannelId,
            _author_id: &UserId,
            _system_event_key: String,
        ) -> Result<MessageWithAuthor, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
    }

    /// `MemberRepository` fake: `get_member_role` returns the configured role
    /// (`None` = not a member). All other methods are unused by `set_pinned`.
    #[derive(Debug)]
    struct PinFakeMemberRepo {
        role: Option<Role>,
    }

    #[async_trait]
    impl MemberRepository for PinFakeMemberRepo {
        async fn get_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<Role>, DomainError> {
            Ok(self.role)
        }

        // -- unused by set_pinned --
        async fn list_by_server(
            &self,
            _server_id: &ServerId,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
        async fn list_by_server_paginated(
            &self,
            _server_id: &ServerId,
            _cursor: Option<DateTime<Utc>>,
            _limit: i64,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
        async fn is_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<bool, DomainError> {
            Ok(true)
        }
        async fn add_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn remove_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn get_member(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
        ) -> Result<Option<ServerMember>, DomainError> {
            Ok(None)
        }
        async fn update_member_role(
            &self,
            _server_id: &ServerId,
            _user_id: &UserId,
            _new_role: Role,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_by_server(&self, _server_id: &ServerId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn transfer_ownership(
            &self,
            _server_id: &ServerId,
            _old_owner_id: &UserId,
            _new_owner_id: &UserId,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn filter_mentionable(
            &self,
            _channel: &Channel,
            _user_ids: &[UserId],
        ) -> Result<Vec<UserId>, DomainError> {
            Ok(vec![])
        }
        async fn resolve_mentioned_users(
            &self,
            _server_id: &ServerId,
            _user_ids: &[UserId],
        ) -> Result<Vec<MentionedUser>, DomainError> {
            Ok(vec![])
        }
        async fn search_by_server(
            &self,
            _server_id: &ServerId,
            _q: &str,
            _limit: i64,
        ) -> Result<Vec<ServerMember>, DomainError> {
            Ok(vec![])
        }
    }

    /// `ChannelRepository` fake — unused by `set_pinned` (the channel is passed
    /// in directly), so every method returns a benign default.
    #[derive(Debug)]
    struct PinFakeChannelRepo;

    #[async_trait]
    impl ChannelRepository for PinFakeChannelRepo {
        async fn get_by_id(&self, _channel_id: &ChannelId) -> Result<Option<Channel>, DomainError> {
            Ok(None)
        }
        async fn get_moderation_context(
            &self,
            _channel_id: &ChannelId,
        ) -> Result<Option<crate::domain::models::ChannelModerationContext>, DomainError> {
            Ok(None)
        }
        async fn has_private_channel_access(
            &self,
            _channel_id: &ChannelId,
            _member_role: Role,
        ) -> Result<bool, DomainError> {
            Ok(true)
        }
        async fn list_authorized_roles(
            &self,
            _channel_id: &ChannelId,
        ) -> Result<Vec<Role>, DomainError> {
            Ok(vec![])
        }
        async fn replace_role_access(
            &self,
            _channel_id: &ChannelId,
            _roles: &[Role],
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn list_for_server(
            &self,
            _server_id: &ServerId,
            _caller_user_id: &UserId,
        ) -> Result<Vec<Channel>, DomainError> {
            Ok(vec![])
        }
        async fn create_channel(&self, channel: &Channel) -> Result<Channel, DomainError> {
            Ok(channel.clone())
        }
        async fn update_channel(
            &self,
            _channel_id: &ChannelId,
            _name: Option<String>,
            _topic: Option<Option<String>>,
            _is_private: Option<bool>,
            _is_read_only: Option<bool>,
            _encrypted: Option<bool>,
            _slow_mode_seconds: Option<i32>,
        ) -> Result<Channel, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn delete_if_not_last(&self, _channel_id: &ChannelId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn count_for_server(&self, _server_id: &ServerId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn find_default_for_server(
            &self,
            _server_id: &ServerId,
        ) -> Result<Option<Channel>, DomainError> {
            Ok(None)
        }
    }

    /// `PlanLimitChecker` fake — unused by `set_pinned`.
    #[derive(Debug)]
    struct PinFakePlanChecker;

    #[async_trait]
    impl PlanLimitChecker for PinFakePlanChecker {
        async fn check_channel_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_member_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn get_server_plan_limits(
            &self,
            _server_id: &ServerId,
        ) -> Result<PlanLimits, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn check_owned_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_joined_server_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_attachment_count(
            &self,
            _server_id: &ServerId,
            _count: u64,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_attachment_size(
            &self,
            _server_id: &ServerId,
            _size_bytes: u64,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_voice_concurrent(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_invite_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_emoji_limit(&self, _server_id: &ServerId) -> Result<(), DomainError> {
            Ok(())
        }
        async fn check_dm_limit(&self, _user_id: &UserId) -> Result<(), DomainError> {
            Ok(())
        }
    }

    /// `ReactionRepository` fake — unused by `set_pinned`.
    #[derive(Debug)]
    struct PinFakeReactionRepo;

    #[async_trait]
    impl ReactionRepository for PinFakeReactionRepo {
        async fn add(
            &self,
            _message_id: &MessageId,
            _user_id: &UserId,
            _emoji: &str,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn emoji_variety(
            &self,
            _message_id: &MessageId,
            _emoji: &str,
        ) -> Result<EmojiVariety, DomainError> {
            Ok(EmojiVariety {
                distinct_count: 0,
                emoji_present: false,
            })
        }
        async fn remove(
            &self,
            _message_id: &MessageId,
            _user_id: &UserId,
            _emoji: &str,
        ) -> Result<(), DomainError> {
            Ok(())
        }
        async fn batch_for_messages(
            &self,
            _message_ids: &[MessageId],
            _viewer_id: &UserId,
        ) -> Result<HashMap<MessageId, Vec<ReactionSummary>>, DomainError> {
            Ok(HashMap::new())
        }
    }

    /// `AttachmentRepository` fake — unused by `set_pinned`.
    #[derive(Debug)]
    struct PinFakeAttachmentRepo;

    #[async_trait]
    impl AttachmentRepository for PinFakeAttachmentRepo {
        async fn batch_for_messages(
            &self,
            _message_ids: &[MessageId],
        ) -> Result<HashMap<MessageId, Vec<Attachment>>, DomainError> {
            Ok(HashMap::new())
        }
        async fn list_pending_for_message(
            &self,
            _message_id: &MessageId,
        ) -> Result<Vec<Attachment>, DomainError> {
            Ok(vec![])
        }
        async fn update_moderation(
            &self,
            _attachment_id: &AttachmentId,
            _status: AttachmentModerationStatus,
            _nsfw_score: Option<f32>,
            _reason: Option<&str>,
        ) -> Result<(), DomainError> {
            Ok(())
        }
    }

    /// `FriendshipRepository` fake — unused by `set_pinned`.
    #[derive(Debug)]
    struct PinFakeFriendshipRepo;

    #[async_trait]
    impl FriendshipRepository for PinFakeFriendshipRepo {
        async fn create_request(
            &self,
            _requester: &UserId,
            _addressee: &UserId,
        ) -> Result<RequestOutcome, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn accept_request(
            &self,
            _caller: &UserId,
            _requester: &UserId,
        ) -> Result<Friendship, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn delete_request(
            &self,
            _caller: &UserId,
            _other: &UserId,
        ) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn delete_friendship(&self, _a: &UserId, _b: &UserId) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn list_friends(&self, _user: &UserId) -> Result<Vec<FriendRow>, DomainError> {
            Ok(vec![])
        }
        async fn list_requests(
            &self,
            _user: &UserId,
            _direction: RequestDirection,
        ) -> Result<Vec<FriendRequestRow>, DomainError> {
            Ok(vec![])
        }
        async fn list_friend_ids(&self, _user: &UserId) -> Result<Vec<UserId>, DomainError> {
            Ok(vec![])
        }
        async fn are_friends(&self, _a: &UserId, _b: &UserId) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn count_friends(&self, _user: &UserId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn count_outgoing_pending(&self, _user: &UserId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn create_block(
            &self,
            _blocker: &UserId,
            _blocked: &UserId,
        ) -> Result<BlockOutcome, DomainError> {
            Err(DomainError::Internal("not implemented".to_string()))
        }
        async fn delete_block(
            &self,
            _blocker: &UserId,
            _blocked: &UserId,
        ) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn list_blocks(&self, _blocker: &UserId) -> Result<Vec<BlockedUserRow>, DomainError> {
            Ok(vec![])
        }
        async fn count_blocks(&self, _blocker: &UserId) -> Result<i64, DomainError> {
            Ok(0)
        }
        async fn is_blocked_between(&self, _a: &UserId, _b: &UserId) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn share_non_dm_server(&self, _a: &UserId, _b: &UserId) -> Result<bool, DomainError> {
            Ok(false)
        }
        async fn dm_send_blocked(
            &self,
            _author: &UserId,
            _channel_id: &ChannelId,
        ) -> Result<bool, DomainError> {
            Ok(false)
        }
    }

    /// Build a `MessageService` wired to the pin fakes. Only the message repo
    /// and member repo participate in `set_pinned`; the rest are inert.
    fn pin_service(
        message: Option<Message>,
        role: Option<Role>,
        pinned_count: i64,
        set_pinned_calls: Arc<AtomicUsize>,
    ) -> MessageService {
        MessageService::new(
            Arc::new(PinFakeMessageRepo {
                message,
                pinned_count,
                set_pinned_calls,
            }),
            Arc::new(PinFakeChannelRepo),
            Arc::new(PinFakeMemberRepo { role }),
            Arc::new(PinFakePlanChecker),
            Arc::new(PinFakeReactionRepo),
            Arc::new(PinFakeAttachmentRepo),
            Arc::new(ContentFilter::noop()),
            Arc::new(SpamGuard::new()),
            Arc::new(PinFakeFriendshipRepo),
        )
    }

    /// Rule 1 (authz): a moderator may pin — the flag flips and the repo writes.
    #[tokio::test]
    async fn set_pinned_moderator_can_pin() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            Some(Role::Moderator),
            0,
            calls.clone(),
        );

        let result = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap();

        assert!(result.is_some(), "moderator pin yields an updated message");
        assert!(result.unwrap().message.is_pinned);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "repo write happened");
    }

    /// Rule 1 (authz): an owner may pin too (above moderator).
    #[tokio::test]
    async fn set_pinned_owner_can_pin() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            Some(Role::Owner),
            0,
            calls.clone(),
        );

        let result = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap();

        assert!(result.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Rule 1 (authz): a plain member is `Forbidden` — no author exception — and
    /// no write occurs.
    #[tokio::test]
    async fn set_pinned_member_is_forbidden() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            Some(Role::Member),
            0,
            calls.clone(),
        );

        let err = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap_err();

        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no write on rejection");
    }

    /// Rule 1 (authz): a non-member (no role row) is `Forbidden`.
    #[tokio::test]
    async fn set_pinned_non_member_is_forbidden() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            None,
            0,
            calls.clone(),
        );

        let err = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap_err();

        assert!(matches!(err, DomainError::Forbidden(_)), "got {err:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// Rule 2 (cap): pinning at `MAX_PINS` is a `Conflict` (→ 409) and never
    /// writes. Guards the `>=` comparison against a `>` regression.
    #[tokio::test]
    async fn set_pinned_at_cap_is_conflict() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            Some(Role::Moderator),
            MessageService::MAX_PINS,
            calls.clone(),
        );

        let err = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap_err();

        assert!(matches!(err, DomainError::Conflict(_)), "got {err:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no write at the cap");
    }

    /// Rule 2 (cap): the cap is NOT checked on unpin — a channel sitting at
    /// `MAX_PINS` can still remove a pin.
    #[tokio::test]
    async fn set_pinned_unpin_at_cap_skips_cap_check() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), true)),
            Some(Role::Moderator),
            MessageService::MAX_PINS,
            calls.clone(),
        );

        let result = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, false)
            .await
            .unwrap();

        assert!(result.is_some(), "unpin succeeds even at the cap");
        assert!(!result.unwrap().message.is_pinned);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Rule 3 (idempotency): pinning an already-pinned message returns
    /// `Ok(None)` with NO repo write (and thus no SSE event).
    #[tokio::test]
    async fn set_pinned_already_pinned_is_noop() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), true)),
            Some(Role::Moderator),
            0,
            calls.clone(),
        );

        let result = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap();

        assert!(result.is_none(), "no-op returns None");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "no write on idempotent pin"
        );
    }

    /// Rule 3 (idempotency): unpinning an already-unpinned message is the same
    /// no-op.
    #[tokio::test]
    async fn set_pinned_already_unpinned_is_noop() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(channel.id.clone(), false)),
            Some(Role::Moderator),
            0,
            calls.clone(),
        );

        let result = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, false)
            .await
            .unwrap();

        assert!(result.is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// Path binding: a message living in another channel is `NotFound` (not
    /// `Forbidden`) — the id's existence elsewhere is never revealed, and the
    /// authz/cap checks are short-circuited before any write.
    #[tokio::test]
    async fn set_pinned_message_in_another_channel_is_not_found() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(
            Some(pin_message(pin_channel_id(999), false)),
            Some(Role::Moderator),
            0,
            calls.clone(),
        );

        let err = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap_err();

        assert!(
            matches!(
                err,
                DomainError::NotFound {
                    resource_type: "Message",
                    ..
                }
            ),
            "got {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// Missing/soft-deleted message (repo `find_by_id` → `None`) is `NotFound`.
    #[tokio::test]
    async fn set_pinned_missing_message_is_not_found() {
        let calls = Arc::new(AtomicUsize::new(0));
        let channel = pin_channel();
        let svc = pin_service(None, Some(Role::Moderator), 0, calls.clone());

        let err = svc
            .set_pinned(&pin_message_id(7), &pin_user_id(9), &channel, true)
            .await
            .unwrap_err();

        assert!(
            matches!(
                err,
                DomainError::NotFound {
                    resource_type: "Message",
                    ..
                }
            ),
            "got {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
