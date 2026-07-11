//! Async identity-image content-moderation scan pipeline (scan-before-reveal
//! for avatars + banners).
//!
//! The identity analogue of [`crate::api::attachment_scan`]: a newly-set avatar
//! or banner is staged PENDING (`pending_{kind}_url`, never shown to other
//! users) and only revealed AFTER a verdict. This runs in a post-update
//! `tokio::spawn` (the send-path spawn) and in the dead-letter retry sweep, so
//! the scan logic lives in exactly one place. The actual image classification is
//! the SAME shared primitive both pipelines use ([`crate::api::image_scan`]).
//!
//! On a CLEAN verdict the candidate is promoted into the live column (revealed).
//! On a FLAG (adult-NSFW / CSAM) it is REJECTED: the previous approved image
//! stays live, the flagged object is best-effort deleted, and the subject's own
//! client is notified via a re-emitted `ProfileUpdated`.
//!
//! Fail-closed: any terminal scan error dead-letters the candidate and leaves it
//! `pending` — an unscanned identity image is NEVER revealed.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::timeout;

use crate::api::state::AppState;
use crate::domain::models::{
    IdentityImageKind, IdentityImageModerationStatus, Profile, ServerEvent, UserId,
};
use crate::domain::ports::{
    CsamMatcher, EventBus, IdentityImageScanRetryRepository, ImageClassifier, NsfwLabel,
    StorageObjectRemover,
};
use crate::domain::services::{ProfileService, ServerService};

/// How long to wait for a moderation semaphore permit before deferring to the
/// sweep (mirrors the attachment scan).
const SEMAPHORE_TIMEOUT: Duration = Duration::from_secs(5);

/// Cloned dependencies the scan needs, captured for a `tokio::spawn`.
#[derive(Clone, Debug)]
pub struct IdentityImageScanDeps {
    pub classifier: Arc<dyn ImageClassifier>,
    pub matcher: Arc<dyn CsamMatcher>,
    pub profile_service: Arc<ProfileService>,
    pub server_service: Arc<ServerService>,
    pub retry_repo: Arc<dyn IdentityImageScanRetryRepository>,
    pub storage_remover: Arc<dyn StorageObjectRemover>,
    pub event_bus: Arc<dyn EventBus>,
}

impl IdentityImageScanDeps {
    /// Clone the scan dependencies out of the shared app state.
    #[must_use]
    pub fn from_state(state: &AppState) -> Self {
        Self {
            classifier: state.image_classifier().clone(),
            matcher: state.csam_matcher().clone(),
            profile_service: state.profile_service_arc().clone(),
            server_service: state.server_service_arc().clone(),
            retry_repo: state.identity_image_scan_retry_repository().clone(),
            storage_remover: state.storage_object_remover().clone(),
            event_bus: state.event_bus_arc().clone(),
        }
    }
}

/// Spawn the scan of a user's pending identity images (the update-path entry).
///
/// Bounds concurrency on the shared moderation permit pool. On a permit timeout
/// the candidates stay `pending` (never revealed — the safety property holds);
/// they are re-scanned when the user next saves, and a scan that actually errors
/// records a dead-letter row the sweep retries.
pub fn spawn_identity_image_scan(state: &AppState, user_id: &UserId) {
    let deps = IdentityImageScanDeps::from_state(state);
    let user_id = user_id.clone();
    let semaphore = state.moderation_semaphore().clone();

    tokio::spawn(async move {
        let _permit = match timeout(SEMAPHORE_TIMEOUT, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_closed)) => {
                tracing::warn!(user_id = %user_id, "identity image scan: semaphore closed — skipping");
                return;
            }
            Err(_elapsed) => {
                tracing::warn!(user_id = %user_id, "identity image scan: semaphore timeout — deferring to sweep");
                return;
            }
        };

        scan_pending_identity_images(&deps, &user_id).await;
    });
}

/// Scan whichever of a user's avatar/banner are currently `pending`, write each
/// verdict, and emit a single `ProfileUpdated` so the subject's client learns
/// the outcome (promoted image revealed, or rejection notice) live.
///
/// Reused by BOTH the update-path spawn and the retry sweep — one code path.
pub async fn scan_pending_identity_images(deps: &IdentityImageScanDeps, user_id: &UserId) {
    let profile = match deps.profile_service.get_by_id_optional(user_id).await {
        Ok(Some(p)) => p,
        Ok(None) => return, // profile deleted meanwhile — nothing to scan
        Err(e) => {
            tracing::error!(user_id = %user_id, error = %e, "identity image scan: profile load failed — leaving pending");
            return;
        }
    };

    let mut any_resolved = false;
    for kind in [IdentityImageKind::Avatar, IdentityImageKind::Banner] {
        let (status, pending_url) = match kind {
            IdentityImageKind::Avatar => (
                profile.avatar_moderation_status,
                profile.pending_avatar_url.as_deref(),
            ),
            IdentityImageKind::Banner => (
                profile.banner_moderation_status,
                profile.pending_banner_url.as_deref(),
            ),
        };
        if status != IdentityImageModerationStatus::Pending {
            continue;
        }
        let Some(url) = pending_url else { continue };
        if scan_one(deps, user_id, kind, url).await {
            any_resolved = true;
        }
    }

    if any_resolved {
        emit_profile_updated(deps, user_id).await;
    }
}

/// Scan + resolve a single pending candidate. Returns `true` when a terminal
/// verdict was written (promoted or rejected); `false` when it was dead-lettered
/// (stays pending) or superseded by a newer candidate.
async fn scan_one(
    deps: &IdentityImageScanDeps,
    user_id: &UserId,
    kind: IdentityImageKind,
    url: &str,
) -> bool {
    let started = std::time::Instant::now();
    let mime = mime_from_url(url);
    match crate::api::image_scan::classify_image(&deps.classifier, &deps.matcher, url, &mime).await
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
                user_id = %user_id,
                image_kind = kind.as_db_str(),
                flagged,
                reason,
                nsfw_score = f64::from(verdict.score),
                scan_latency_ms,
                "identity image scan verdict resolved"
            );
            if flagged {
                reject(deps, user_id, kind, url, verdict.score, reason).await
            } else {
                promote(deps, user_id, kind, url, verdict.score).await
            }
        }
        Err(e) => {
            // Fail-closed: dead-letter and leave the candidate pending.
            tracing::warn!(
                user_id = %user_id,
                image_kind = kind.as_db_str(),
                error = %e,
                "identity image scan failed — dead-lettering, candidate stays pending"
            );
            if let Err(insert_err) = deps
                .retry_repo
                .insert(user_id, kind, url, &e.to_string())
                .await
            {
                tracing::error!(
                    user_id = %user_id,
                    image_kind = kind.as_db_str(),
                    error = %insert_err,
                    "identity image scan: failed to record dead-letter — candidate unmoderated with no retry path"
                );
            }
            false
        }
    }
}

/// Promote a clean candidate to the live image, then clear any dead-letter row.
async fn promote(
    deps: &IdentityImageScanDeps,
    user_id: &UserId,
    kind: IdentityImageKind,
    url: &str,
    score: f32,
) -> bool {
    match deps
        .profile_service
        .promote_identity_image(user_id, kind, url, Some(score))
        .await
    {
        Ok(Some(_)) => {
            clear_dead_letter(deps, user_id, kind).await;
            tracing::info!(user_id = %user_id, image_kind = kind.as_db_str(), "identity image promoted (revealed)");
            true
        }
        Ok(None) => {
            // A newer candidate superseded this one; its own scan governs.
            clear_dead_letter(deps, user_id, kind).await;
            false
        }
        Err(e) => {
            tracing::error!(user_id = %user_id, image_kind = kind.as_db_str(), error = %e, "identity image scan: promote write failed — staying pending");
            false
        }
    }
}

/// Reject a flagged candidate: keep the previous approved image, best-effort
/// delete the flagged object, clear the dead-letter row.
async fn reject(
    deps: &IdentityImageScanDeps,
    user_id: &UserId,
    kind: IdentityImageKind,
    url: &str,
    score: f32,
    reason: &str,
) -> bool {
    match deps
        .profile_service
        .reject_identity_image(user_id, kind, url, Some(score))
        .await
    {
        Ok(Some(_)) => {
            // Audit trail (ADR-046: an expected rejection is a WARN/breadcrumb).
            tracing::warn!(
                user_id = %user_id,
                image_kind = kind.as_db_str(),
                reason,
                nsfw_score = f64::from(score),
                "identity image REJECTED on scan — previous image kept"
            );
            // Best-effort: remove the flagged object from the public bucket so a
            // raw-URL fetch can't reach it. Never fatal — the image is already
            // withheld by not being promoted.
            if let Err(e) = deps.storage_remover.remove(url).await {
                tracing::warn!(user_id = %user_id, error = %e, "identity image scan: flagged-object delete failed (best-effort)");
            }
            clear_dead_letter(deps, user_id, kind).await;
            true
        }
        Ok(None) => {
            clear_dead_letter(deps, user_id, kind).await;
            false
        }
        Err(e) => {
            tracing::error!(user_id = %user_id, image_kind = kind.as_db_str(), error = %e, "identity image scan: reject write failed — staying pending");
            false
        }
    }
}

/// Best-effort clear of a dead-letter row after a terminal verdict.
async fn clear_dead_letter(
    deps: &IdentityImageScanDeps,
    user_id: &UserId,
    kind: IdentityImageKind,
) {
    if let Err(e) = deps.retry_repo.delete(user_id, kind).await {
        tracing::warn!(user_id = %user_id, image_kind = kind.as_db_str(), error = %e, "identity image scan: failed to clear dead-letter row");
    }
}

/// Reload the profile and publish `ProfileUpdated` (approved images + statuses)
/// so the subject's client reveals a promoted image or shows a rejection notice.
async fn emit_profile_updated(deps: &IdentityImageScanDeps, user_id: &UserId) {
    let profile = match deps.profile_service.get_by_id_optional(user_id).await {
        Ok(Some(p)) => p,
        Ok(None) => return,
        Err(e) => {
            tracing::error!(user_id = %user_id, error = %e, "identity image scan: reload for ProfileUpdated failed");
            return;
        }
    };

    // Routing scope (same posture as the update handler): on lookup failure the
    // event still goes out with an EMPTY scope, which the SSE layer fails CLOSED
    // to the subject's own tabs — never a broadcast to strangers.
    let server_ids = deps
        .server_service
        .list_all_memberships(user_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(user_id = %user_id, error = %e, "identity image scan: membership lookup failed — self-only delivery");
            Vec::new()
        });

    let Profile {
        display_name,
        avatar_url,
        custom_status,
        bio,
        banner_url,
        avatar_moderation_status,
        banner_moderation_status,
        ..
    } = profile;

    let receivers = deps.event_bus.publish(ServerEvent::ProfileUpdated {
        sender_id: user_id.clone(),
        user_id: user_id.clone(),
        display_name,
        avatar_url,
        custom_status,
        bio,
        banner_url,
        avatar_moderation_status,
        banner_moderation_status,
        server_ids,
    });
    tracing::debug!(user_id = %user_id, receivers, "emitted moderation profile.updated");
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
        assert_eq!(mime_from_url("https://x/y/a.JPG"), "image/jpeg");
        assert_eq!(mime_from_url("https://x/y/a.jpeg?v=2"), "image/jpeg");
        assert_eq!(mime_from_url("https://x/y/a.webp"), "image/webp");
        assert_eq!(mime_from_url("https://x/y/a.gif#frag"), "image/gif");
        assert_eq!(mime_from_url("https://x/y/noext"), "image/*");
    }
}
