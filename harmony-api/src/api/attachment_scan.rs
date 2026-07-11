//! Async image content-moderation scan pipeline (spec §c.1).
//!
//! Runs where text moderation already runs — a post-send `tokio::spawn` — but
//! the client render default is inverted: attachments insert as `pending`
//! (blurred/withheld) and are only revealed AFTER a verdict (scan-before-reveal).
//!
//! Shared by the send-path spawn (`messages::spawn_attachment_moderation`) and
//! the dead-letter retry sweep (`main::spawn_attachment_scan_sweep`), so the scan
//! logic lives in exactly one place.
//!
//! Fail-closed: any terminal scan error dead-letters the attachment and leaves it
//! `pending` — an unscanned image is NEVER revealed.

use std::sync::Arc;
use std::time::Duration;

use crate::api::state::AppState;
use crate::domain::models::server_event::MessagePayload;
use crate::domain::models::{
    Attachment, AttachmentModerationStatus, ChannelId, MessageId, SYSTEM_MODERATOR_ID, ServerEvent,
    ServerId, UserId,
};
use crate::domain::ports::{
    AttachmentRepository, AttachmentScanRetryRepository, ChannelRepository, CsamMatcher, EventBus,
    ImageClassifier, NsfwLabel,
};
use crate::domain::services::attachment_moderation::{AttachmentContext, resolve_status};
use crate::domain::services::{MessageService, resolve_channel_access_by_id};

/// How long to wait when fetching object bytes for a real scan.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// NSFW score at/above which content is treated as adult-NSFW (spec §d Phase 2).
/// Only meaningful for a real classifier; the Noop always scores 0.0.
pub const NSFW_SCORE_THRESHOLD: f32 = 0.85;

/// Cloned dependencies the scan needs, captured for a `tokio::spawn`.
#[derive(Clone, Debug)]
pub struct AttachmentScanDeps {
    pub classifier: Arc<dyn ImageClassifier>,
    pub matcher: Arc<dyn CsamMatcher>,
    pub attachment_repo: Arc<dyn AttachmentRepository>,
    pub channel_repo: Arc<dyn ChannelRepository>,
    pub retry_repo: Arc<dyn AttachmentScanRetryRepository>,
    pub message_service: Arc<MessageService>,
    pub event_bus: Arc<dyn EventBus>,
}

impl AttachmentScanDeps {
    /// Clone the scan dependencies out of the shared app state.
    #[must_use]
    pub fn from_state(state: &AppState) -> Self {
        Self {
            classifier: state.image_classifier().clone(),
            matcher: state.csam_matcher().clone(),
            attachment_repo: state.attachment_repository().clone(),
            channel_repo: state.channel_repository_arc().clone(),
            retry_repo: state.attachment_scan_retry_repository().clone(),
            message_service: state.message_service_arc().clone(),
            event_bus: state.event_bus_arc().clone(),
        }
    }
}

/// Scan every still-`pending` attachment of a freshly-sent message, write each
/// verdict, and emit a single `MessageUpdated` so every reader's tile flips.
///
/// Per attachment: non-images are auto-approved (v1 moderates images only);
/// images run CSAM-match then NSFW-classify, mapped to a status via the §b
/// decision table. A terminal scan error dead-letters that attachment (stays
/// `pending`); the whole message never blocks on one bad object.
pub async fn scan_message_attachments(
    deps: &AttachmentScanDeps,
    message_id: &MessageId,
    author_id: &UserId,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let pending = match deps
        .attachment_repo
        .list_pending_for_message(message_id)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(message_id = %message_id, error = %e, "attachment scan: failed to load pending attachments");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }

    // Resolve the decision-table context once for the whole message.
    let ctx = match deps.channel_repo.get_moderation_context(channel_id).await {
        Ok(Some(raw)) => AttachmentContext {
            is_nsfw_channel: raw.is_nsfw,
            is_dm: raw.is_dm,
            author_is_owner: raw.owner_id == *author_id,
        },
        Ok(None) => {
            tracing::warn!(channel_id = %channel_id, "attachment scan: channel context not found — leaving pending");
            return;
        }
        Err(e) => {
            tracing::error!(channel_id = %channel_id, error = %e, "attachment scan: context lookup failed — leaving pending");
            return;
        }
    };

    let mut any_applied = false;
    for attachment in &pending {
        if apply_one(deps, &ctx, attachment, channel_id).await {
            any_applied = true;
        }
    }

    // Only emit when at least one status actually flipped off `pending`.
    if any_applied {
        emit_message_updated(deps, message_id, channel_id, server_id).await;
    }
}

/// Re-scan a single dead-lettered attachment (the retry sweep entry point).
///
/// On success: writes the verdict, clears the dead-letter row, emits
/// `MessageUpdated`. On failure: the dead-letter UPSERT bumps the retry count
/// (stays `pending`). `server_id` for the event is resolved from the channel.
pub async fn rescan_attachment(
    deps: &AttachmentScanDeps,
    attachment: &Attachment,
    author_id: &UserId,
    channel_id: &ChannelId,
) {
    // Resolve server_id (for the event) + the decision context from the channel.
    let Some(channel) = (match deps.channel_repo.get_by_id(channel_id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(channel_id = %channel_id, error = %e, "attachment rescan: channel lookup failed");
            return;
        }
    }) else {
        return;
    };
    let server_id = channel.server_id.clone();

    let ctx = match deps.channel_repo.get_moderation_context(channel_id).await {
        Ok(Some(raw)) => AttachmentContext {
            is_nsfw_channel: raw.is_nsfw,
            is_dm: raw.is_dm,
            author_is_owner: raw.owner_id == *author_id,
        },
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(channel_id = %channel_id, error = %e, "attachment rescan: context lookup failed");
            return;
        }
    };

    if apply_one(deps, &ctx, attachment, channel_id).await {
        // Success cleared the row inside apply_one; publish the flip.
        emit_message_updated(deps, &attachment.message_id, channel_id, &server_id).await;
    }
}

/// Scan + persist one attachment. Returns `true` when a terminal status was
/// written (the tile flips); `false` when it was dead-lettered (stays pending).
async fn apply_one(
    deps: &AttachmentScanDeps,
    ctx: &AttachmentContext,
    attachment: &Attachment,
    channel_id: &ChannelId,
) -> bool {
    // v1 moderates images only — non-images are approved without a scan.
    if !attachment.mime.starts_with("image/") {
        return write_status(
            deps,
            attachment,
            AttachmentModerationStatus::Approved,
            None,
            "clean",
        )
        .await;
    }

    match classify(deps, attachment).await {
        Ok((label, csam_match, score)) => {
            let status = resolve_status(*ctx, label, csam_match);
            let reason = match status {
                AttachmentModerationStatus::Gated => "adult_nsfw_gated",
                AttachmentModerationStatus::Blocked => "adult_nsfw_blocked",
                AttachmentModerationStatus::Quarantined => "csam_match",
                _ => "clean",
            };
            write_status(deps, attachment, status, Some(score), reason).await
        }
        Err(e) => {
            // Fail-closed: dead-letter and leave the attachment pending.
            tracing::warn!(
                attachment_id = %attachment.id,
                channel_id = %channel_id,
                error = %e,
                "image scan failed — dead-lettering, attachment stays pending"
            );
            if let Err(insert_err) = deps
                .retry_repo
                .insert(
                    &attachment.id,
                    &attachment.message_id,
                    channel_id,
                    &attachment.url,
                    &attachment.mime,
                    &e.to_string(),
                )
                .await
            {
                tracing::error!(
                    attachment_id = %attachment.id,
                    error = %insert_err,
                    "image scan: failed to record dead-letter — attachment unmoderated with no retry path"
                );
            }
            false
        }
    }
}

/// Run the classifiers over one image, returning `(nsfw_label, csam_match,
/// score)`. Fetches object bytes only when a real detector needs them (the Noop
/// ignores them, so the happy path makes no network call). The caller maps the
/// result to a status via the decision table.
async fn classify(
    deps: &AttachmentScanDeps,
    attachment: &Attachment,
) -> Result<(NsfwLabel, bool, f32), crate::domain::errors::DomainError> {
    let bytes = if deps.classifier.is_configured() || deps.matcher.is_configured() {
        fetch_bytes(&attachment.url).await?
    } else {
        Vec::new()
    };

    // CSAM first (highest priority, short-circuits). Noop → never a match.
    let csam = deps.matcher.match_hash(&bytes, &attachment.mime).await?;
    if csam.is_match {
        return Ok((NsfwLabel::Clean, true, 1.0));
    }
    let nsfw = deps
        .classifier
        .classify_nsfw(&bytes, &attachment.mime)
        .await?;
    Ok((nsfw.label, false, nsfw.score))
}

/// Fetch raw object bytes for a real scan.
async fn fetch_bytes(url: &str) -> Result<Vec<u8>, crate::domain::errors::DomainError> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| crate::domain::errors::DomainError::ExternalService(e.to_string()))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| crate::domain::errors::DomainError::ExternalService(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(crate::domain::errors::DomainError::ExternalService(
            format!("object fetch returned {}", resp.status()),
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| crate::domain::errors::DomainError::ExternalService(e.to_string()))?;
    Ok(bytes.to_vec())
}

/// Persist a terminal verdict + clear any dead-letter row. Returns `true` on
/// success (the tile can flip), `false` if the write failed (stays pending).
async fn write_status(
    deps: &AttachmentScanDeps,
    attachment: &Attachment,
    status: AttachmentModerationStatus,
    nsfw_score: Option<f32>,
    reason: &str,
) -> bool {
    let reason_opt = if reason == "clean" {
        None
    } else {
        Some(reason)
    };
    if let Err(e) = deps
        .attachment_repo
        .update_moderation(&attachment.id, status, nsfw_score, reason_opt)
        .await
    {
        tracing::error!(attachment_id = %attachment.id, error = %e, "attachment scan: failed to write moderation status");
        return false;
    }
    // Best-effort clear of any prior dead-letter row for this attachment.
    if let Err(e) = deps.retry_repo.delete(&attachment.id).await {
        tracing::warn!(attachment_id = %attachment.id, error = %e, "attachment scan: failed to clear dead-letter row");
    }
    tracing::info!(
        attachment_id = %attachment.id,
        status = status.as_db_str(),
        "attachment moderation verdict written"
    );
    true
}

/// Reload the message and publish `MessageUpdated` so every reader's cache
/// patches and the attachment tile re-renders with its new status.
async fn emit_message_updated(
    deps: &AttachmentScanDeps,
    message_id: &MessageId,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let message = match deps
        .message_service
        .reload_for_moderation_event(message_id)
        .await
    {
        Ok(Some(m)) => m,
        Ok(None) => return, // message deleted meanwhile — nothing to reveal
        Err(e) => {
            tracing::error!(message_id = %message_id, error = %e, "attachment scan: reload for MessageUpdated failed");
            return;
        }
    };

    // Gate the event for private channels (fail OPEN on lookup error, ADR-027).
    let channel_access = resolve_channel_access_by_id(deps.channel_repo.as_ref(), channel_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(channel_id = %channel_id, error = %e, "attachment scan: channel-access resolve failed — failing open");
            None
        });

    // WHY SYSTEM_MODERATOR_ID as sender: the SSE layer excludes the sender from
    // their own events. The author must ALSO receive the flip (their own image
    // going approved/gated), so the sender must be the system sentinel, never
    // the author.
    let event = ServerEvent::MessageUpdated {
        sender_id: SYSTEM_MODERATOR_ID,
        server_id: server_id.clone(),
        channel_id: channel_id.clone(),
        message: MessagePayload::from(message),
        channel_access,
    };
    let receivers = deps.event_bus.publish(event);
    tracing::debug!(message_id = %message_id, receivers, "emitted moderation message.updated");
}
