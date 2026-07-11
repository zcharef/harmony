//! Async custom-emoji image content-moderation scan pipeline (scan-before-reveal
//! for server emoji).
//!
//! The emoji analogue of [`crate::api::identity_image_scan`]: a newly-created
//! emoji is staged `pending` (invisible to other members) and only revealed
//! AFTER a verdict. This runs in a post-create `tokio::spawn` (the create-path
//! spawn) and in the dead-letter retry sweep, so the scan logic lives in exactly
//! one place. The actual image classification is the SAME shared primitive both
//! image pipelines use ([`crate::api::image_scan`]).
//!
//! Unlike profile images there is no "previous approved" emoji to keep — a new
//! emoji simply stays hidden while pending:
//! - CLEAN verdict → promote (`approved`) and emit `emoji.created` so every
//!   member's `:name:` tokens resolve live.
//! - FLAG (adult-NSFW / CSAM) → reject: DELETE the row (never goes live),
//!   best-effort delete the flagged object, and notify the creator via a
//!   creator-scoped `emoji.rejected` (drop the optimistic emoji + show a notice).
//! - Scan ERROR → dead-letter and leave the emoji `pending` (never revealed).

use std::sync::Arc;
use std::time::Duration;

use tokio::time::timeout;

use crate::api::state::AppState;
use crate::domain::models::server_event::EmojiPayload;
use crate::domain::models::{EmojiId, IdentityImageModerationStatus, ServerEmoji, ServerEvent};
use crate::domain::ports::{
    CsamMatcher, EmojiImageScanRetryRepository, EventBus, ImageClassifier, NsfwLabel,
    StorageObjectRemover,
};
use crate::domain::services::ServerEmojiService;

/// How long to wait for a moderation semaphore permit before deferring to the
/// sweep (mirrors the identity-image scan).
const SEMAPHORE_TIMEOUT: Duration = Duration::from_secs(5);

/// Cloned dependencies the scan needs, captured for a `tokio::spawn`.
#[derive(Clone, Debug)]
pub struct EmojiImageScanDeps {
    pub classifier: Arc<dyn ImageClassifier>,
    pub matcher: Arc<dyn CsamMatcher>,
    pub emoji_service: Arc<ServerEmojiService>,
    pub retry_repo: Arc<dyn EmojiImageScanRetryRepository>,
    pub storage_remover: Arc<dyn StorageObjectRemover>,
    pub event_bus: Arc<dyn EventBus>,
}

impl EmojiImageScanDeps {
    /// Clone the scan dependencies out of the shared app state.
    #[must_use]
    pub fn from_state(state: &AppState) -> Self {
        Self {
            classifier: state.image_classifier().clone(),
            matcher: state.csam_matcher().clone(),
            emoji_service: state.server_emoji_service_arc().clone(),
            retry_repo: state.emoji_image_scan_retry_repository().clone(),
            storage_remover: state.storage_object_remover().clone(),
            event_bus: state.event_bus_arc().clone(),
        }
    }
}

/// Spawn the scan of a freshly-created emoji (the create-path entry).
///
/// Bounds concurrency on the shared moderation permit pool. On a permit timeout
/// the emoji stays `pending` (never revealed — the safety property holds) and is
/// re-scanned by the sweep once a dead-letter row exists; if no scan ever ran,
/// the emoji simply remains hidden until an admin recreates it.
pub fn spawn_emoji_image_scan(state: &AppState, emoji_id: &EmojiId) {
    let deps = EmojiImageScanDeps::from_state(state);
    let emoji_id = emoji_id.clone();
    let semaphore = state.moderation_semaphore().clone();

    tokio::spawn(async move {
        let _permit = match timeout(SEMAPHORE_TIMEOUT, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_closed)) => {
                tracing::warn!(emoji_id = %emoji_id, "emoji image scan: semaphore closed — skipping");
                return;
            }
            Err(_elapsed) => {
                tracing::warn!(emoji_id = %emoji_id, "emoji image scan: semaphore timeout — emoji stays pending");
                return;
            }
        };

        scan_emoji(&deps, &emoji_id).await;
    });
}

/// Scan one emoji if it is still `pending`, write the verdict, and emit the
/// reveal (`emoji.created`) or rejection (`emoji.rejected`) event.
///
/// Reused by BOTH the create-path spawn and the retry sweep — one code path. An
/// emoji no longer pending (already resolved / deleted) is a cheap no-op.
pub async fn scan_emoji(deps: &EmojiImageScanDeps, emoji_id: &EmojiId) {
    let emoji = match deps.emoji_service.get_by_id(emoji_id).await {
        Ok(Some(e)) => e,
        Ok(None) => return, // deleted meanwhile — nothing to scan
        Err(e) => {
            tracing::error!(emoji_id = %emoji_id, error = %e, "emoji image scan: load failed — leaving pending");
            return;
        }
    };
    if emoji.moderation_status != IdentityImageModerationStatus::Pending {
        return;
    }

    let started = std::time::Instant::now();
    let mime = mime_from_url(&emoji.url);
    match crate::api::image_scan::classify_image(&deps.classifier, &deps.matcher, &emoji.url, &mime)
        .await
    {
        Ok(verdict) => {
            let scan_latency_ms = started.elapsed().as_millis();
            let flagged = verdict.csam_match || verdict.nsfw == NsfwLabel::Nsfw;
            let reason = if verdict.csam_match {
                "csam_match"
            } else if flagged {
                "adult_nsfw"
            } else {
                "clean"
            };
            tracing::info!(
                emoji_id = %emoji_id,
                server_id = %emoji.server_id,
                flagged,
                reason,
                nsfw_score = f64::from(verdict.score),
                scan_latency_ms,
                "emoji image scan verdict resolved"
            );
            if flagged {
                reject(deps, &emoji, verdict.score, reason).await;
            } else {
                promote(deps, &emoji, verdict.score).await;
            }
        }
        Err(e) => {
            // Fail-closed: dead-letter and leave the emoji pending.
            tracing::warn!(
                emoji_id = %emoji_id,
                error = %e,
                "emoji image scan failed — dead-lettering, emoji stays pending"
            );
            if let Err(insert_err) = deps
                .retry_repo
                .insert(emoji_id, &emoji.url, &e.to_string())
                .await
            {
                tracing::error!(
                    emoji_id = %emoji_id,
                    error = %insert_err,
                    "emoji image scan: failed to record dead-letter — emoji unmoderated with no retry path"
                );
            }
        }
    }
}

/// Promote a clean emoji to `approved`, clear any dead-letter row, and emit
/// `emoji.created` so every member reveals it.
async fn promote(deps: &EmojiImageScanDeps, emoji: &ServerEmoji, score: f32) {
    match deps.emoji_service.promote(&emoji.id, Some(score)).await {
        Ok(Some(promoted)) => {
            clear_dead_letter(deps, &emoji.id).await;
            let receivers = deps.event_bus.publish(ServerEvent::EmojiCreated {
                sender_id: promoted.created_by.clone(),
                server_id: promoted.server_id.clone(),
                emoji: EmojiPayload::from(promoted),
            });
            tracing::info!(emoji_id = %emoji.id, receivers, "emoji promoted (revealed)");
        }
        Ok(None) => {
            // Already resolved/deleted meanwhile — nothing to reveal.
            clear_dead_letter(deps, &emoji.id).await;
        }
        Err(e) => {
            tracing::error!(emoji_id = %emoji.id, error = %e, "emoji image scan: promote write failed — staying pending");
        }
    }
}

/// Reject a flagged emoji: delete the row (never revealed), best-effort delete
/// the flagged object, clear the dead-letter row, and notify the creator.
async fn reject(deps: &EmojiImageScanDeps, emoji: &ServerEmoji, score: f32, reason: &str) {
    match deps.emoji_service.reject(&emoji.id).await {
        Ok(Some(rejected)) => {
            // Audit trail (ADR-046: an expected rejection is a WARN/breadcrumb).
            tracing::warn!(
                emoji_id = %emoji.id,
                server_id = %rejected.server_id,
                reason,
                nsfw_score = f64::from(score),
                "emoji REJECTED on scan — row deleted, never revealed"
            );
            // Best-effort: remove the flagged object from the public bucket so a
            // raw-URL fetch can't reach it. Never fatal — the emoji is already
            // withheld by never having been promoted.
            if let Err(e) = deps.storage_remover.remove(&rejected.url).await {
                tracing::warn!(emoji_id = %emoji.id, error = %e, "emoji image scan: flagged-object delete failed (best-effort)");
            }
            clear_dead_letter(deps, &emoji.id).await;
            let receivers = deps.event_bus.publish(ServerEvent::EmojiRejected {
                sender_id: rejected.created_by.clone(),
                target_user_id: rejected.created_by.clone(),
                server_id: rejected.server_id.clone(),
                emoji_id: rejected.id.clone(),
                name: rejected.name,
            });
            tracing::debug!(emoji_id = %emoji.id, receivers, "emitted emoji.rejected");
        }
        Ok(None) => {
            // Already resolved/deleted meanwhile.
            clear_dead_letter(deps, &emoji.id).await;
        }
        Err(e) => {
            tracing::error!(emoji_id = %emoji.id, error = %e, "emoji image scan: reject write failed — staying pending");
        }
    }
}

/// Best-effort clear of a dead-letter row after a terminal verdict.
async fn clear_dead_letter(deps: &EmojiImageScanDeps, emoji_id: &EmojiId) {
    if let Err(e) = deps.retry_repo.delete(emoji_id).await {
        tracing::warn!(emoji_id = %emoji_id, error = %e, "emoji image scan: failed to clear dead-letter row");
    }
}

/// Best-effort image mime from a URL extension (the shared classifier needs a
/// mime hint; the Noop ignores it, a real classifier decodes bytes regardless).
fn mime_from_url(url: &str) -> String {
    let ext = url
        .rsplit('/')
        .next()
        .and_then(|seg| seg.rsplit('.').next())
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/*",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::mime_from_url;

    #[test]
    fn mime_from_url_maps_common_extensions() {
        assert_eq!(mime_from_url("https://x/y/a.png"), "image/png");
        assert_eq!(mime_from_url("https://x/y/a.GIF"), "image/gif");
        assert_eq!(mime_from_url("https://x/y/a.webp?v=2"), "image/webp");
        assert_eq!(mime_from_url("https://x/y/noext"), "image/*");
    }
}
