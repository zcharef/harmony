//! Attachment content-moderation decision logic (pure).
//!
//! Turns a scan result (CSAM match + adult-NSFW label) plus the resolved
//! channel context into a terminal [`AttachmentModerationStatus`], per the §b
//! enforcement decision table. This is the ONE place the policy lives; the scan
//! pipeline is a thin orchestrator around it.
//!
//! Pure and side-effect-free so every decision-table cell is unit-tested without
//! a DB or a classifier.

use crate::domain::models::AttachmentModerationStatus;
use crate::domain::ports::NsfwLabel;

/// Resolved server-side context for one attachment at scan time.
///
/// Built from `channels.is_nsfw`, `servers.is_dm`, and whether the message
/// author owns the server (`author == servers.owner_id`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentContext {
    /// The channel is flagged `is_nsfw`.
    pub is_nsfw_channel: bool,
    /// The parent server is a DM server (`is_dm`).
    pub is_dm: bool,
    /// The message author owns the server (controls the space).
    pub author_is_owner: bool,
}

/// Map a scan result + context to a terminal moderation status (§b table).
///
/// - **CSAM match** → `Quarantined` everywhere, no exception (row-invariant).
///   (The matcher is Noop this phase, so this is never produced.)
/// - **Clean** → `Approved` everywhere.
/// - **Adult-NSFW** → `Approved` only in an `is_nsfw` channel or the author's
///   own server (they control the space); otherwise `Gated` (blur + spoiler +
///   click-to-reveal) — the default for public non-NSFW channels AND DMs (a
///   friend-DM auto-approve is a fast-follow once Friendship ships). A strict
///   `Blocked` server option is a documented follow-up, so `Blocked` is never
///   produced this phase.
///
/// NEVER returns `Quarantined` for the classifier alone — only a CSAM match
/// quarantines. Adult-NSFW always leaves a human appeal path (§f).
#[must_use]
pub fn resolve_status(
    ctx: AttachmentContext,
    nsfw: NsfwLabel,
    csam_is_match: bool,
) -> AttachmentModerationStatus {
    if csam_is_match {
        return AttachmentModerationStatus::Quarantined;
    }
    match nsfw {
        NsfwLabel::Clean => AttachmentModerationStatus::Approved,
        NsfwLabel::Nsfw => {
            if ctx.is_nsfw_channel || ctx.author_is_owner {
                AttachmentModerationStatus::Approved
            } else {
                AttachmentModerationStatus::Gated
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(is_nsfw_channel: bool, is_dm: bool, author_is_owner: bool) -> AttachmentContext {
        AttachmentContext {
            is_nsfw_channel,
            is_dm,
            author_is_owner,
        }
    }

    // ── Clean class: approved in every context cell ──────────────
    #[test]
    fn clean_is_approved_in_every_context() {
        for is_nsfw in [false, true] {
            for is_dm in [false, true] {
                for owner in [false, true] {
                    assert_eq!(
                        resolve_status(ctx(is_nsfw, is_dm, owner), NsfwLabel::Clean, false),
                        AttachmentModerationStatus::Approved,
                    );
                }
            }
        }
    }

    // ── Adult-NSFW class: each decision-table cell ───────────────
    #[test]
    fn nsfw_public_non_nsfw_channel_is_gated() {
        // Public non-NSFW channel, author is not the owner → gated (default).
        assert_eq!(
            resolve_status(ctx(false, false, false), NsfwLabel::Nsfw, false),
            AttachmentModerationStatus::Gated,
        );
    }

    #[test]
    fn nsfw_flagged_channel_is_approved() {
        assert_eq!(
            resolve_status(ctx(true, false, false), NsfwLabel::Nsfw, false),
            AttachmentModerationStatus::Approved,
        );
    }

    #[test]
    fn nsfw_in_dm_is_gated_by_default() {
        // Friend-DM auto-approve is a fast-follow; default DM to gated.
        assert_eq!(
            resolve_status(ctx(false, true, false), NsfwLabel::Nsfw, false),
            AttachmentModerationStatus::Gated,
        );
    }

    #[test]
    fn nsfw_in_authors_own_server_is_approved() {
        // author == owner, non-NSFW channel → approved (author controls space).
        assert_eq!(
            resolve_status(ctx(false, false, true), NsfwLabel::Nsfw, false),
            AttachmentModerationStatus::Approved,
        );
    }

    #[test]
    fn nsfw_never_quarantines_on_classifier_alone() {
        // No context ever escalates adult-NSFW to quarantine (only CSAM does).
        for is_nsfw in [false, true] {
            for is_dm in [false, true] {
                for owner in [false, true] {
                    assert_ne!(
                        resolve_status(ctx(is_nsfw, is_dm, owner), NsfwLabel::Nsfw, false),
                        AttachmentModerationStatus::Quarantined,
                    );
                }
            }
        }
    }

    // ── CSAM class: quarantine is row-invariant ──────────────────
    #[test]
    fn csam_match_quarantines_in_every_context_and_class() {
        for label in [NsfwLabel::Clean, NsfwLabel::Nsfw] {
            for is_nsfw in [false, true] {
                for is_dm in [false, true] {
                    for owner in [false, true] {
                        assert_eq!(
                            resolve_status(ctx(is_nsfw, is_dm, owner), label, true),
                            AttachmentModerationStatus::Quarantined,
                            "CSAM must quarantine regardless of context/class",
                        );
                    }
                }
            }
        }
    }
}
