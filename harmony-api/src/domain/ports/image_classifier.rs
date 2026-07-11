//! Port: async adult-NSFW image classification (Phase 2).
//!
//! Mirrors [`ContentModerator`](super::ContentModerator): a pluggable adapter
//! the post-send scan task calls with raw image bytes. Phase 1 wires
//! `NoopImageClassifier` (always `Clean`) so the whole pipeline is exercised
//! with no external dependency; Phase 2 swaps in an in-process `ONNX` `ViT` model.
//!
//! **This detects LEGAL adult porn vs clean — it does NOT detect CSAM.** CSAM
//! is a separate hash-matching concern ([`CsamMatcher`](super::CsamMatcher)).
//! Never conflate the two.

use async_trait::async_trait;

use crate::domain::errors::DomainError;

/// Adult-NSFW vs clean label from a classifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NsfwLabel {
    /// Legal adult/explicit imagery.
    Nsfw,
    /// Not adult-NSFW.
    Clean,
}

/// A classifier verdict: the raw score plus the thresholded label.
///
/// The `score` is `0.0..=1.0`; the `label` is the classifier's own thresholded
/// decision (kept together so the caller logs the score but branches on the
/// label). `score` is persisted server-side only — never shipped to clients.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NsfwVerdict {
    pub score: f32,
    pub label: NsfwLabel,
}

/// Adult-NSFW image classification port.
#[async_trait]
pub trait ImageClassifier: Send + Sync + std::fmt::Debug {
    /// Classify raw image bytes as adult-NSFW vs clean.
    ///
    /// # Errors
    /// Returns [`DomainError::ExternalService`] on inference failure — the scan
    /// task dead-letters and leaves the attachment `pending` (fail-closed).
    async fn classify_nsfw(&self, bytes: &[u8], mime: &str) -> Result<NsfwVerdict, DomainError>;

    /// Whether this is a real, configured classifier. `false` for the Noop.
    ///
    /// WHY: the scan task only fetches the object bytes when a real classifier
    /// (or matcher) needs them — the Noop ignores bytes, so the happy path runs
    /// with no network round-trip.
    fn is_configured(&self) -> bool {
        false
    }
}
