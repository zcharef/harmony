//! Port: CSAM hash matching (Phase 3 — Noop this phase).
//!
//! Mirrors [`ContentModerator`](super::ContentModerator). Phase 1/2 wire
//! `NoopCsamMatcher` (always no-match): while Harmony is invite-only we run NO
//! CSAM-specific detector, so no "actual knowledge" / legal report duty is ever
//! triggered. A real hash-matching adapter (`PhotoDNA`) + the `NCMEC`
//! preserve/report pipeline is Phase 3 and gates public launch.
//!
//! This port stays defined so the scan pipeline is CSAM-shaped end to end and
//! Phase 3 is a `main.rs` wiring swap, not a pipeline change.

use async_trait::async_trait;

use crate::domain::errors::DomainError;

/// A CSAM hash-match verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsamVerdict {
    /// Whether the bytes matched a known-CSAM hash.
    pub is_match: bool,
    /// Provider that produced the verdict (e.g. `"noop"`, `"photodna"`).
    pub source: String,
}

/// CSAM hash-matching port.
#[async_trait]
pub trait CsamMatcher: Send + Sync + std::fmt::Debug {
    /// Hash-match raw image bytes against known-CSAM lists.
    ///
    /// # Errors
    /// Returns [`DomainError::ExternalService`] on provider failure — the scan
    /// task dead-letters and leaves the attachment `pending` (fail-closed).
    async fn match_hash(&self, bytes: &[u8], mime: &str) -> Result<CsamVerdict, DomainError>;

    /// Whether this is a real, configured matcher. `false` for the Noop.
    ///
    /// WHY: the `attachments_require_csam_scan` config gate consults this to
    /// decide whether to refuse image attachments (fail-closed) when no real
    /// matcher is wired. Defaults to `false` (the Noop overrides nothing).
    fn is_configured(&self) -> bool {
        false
    }
}
