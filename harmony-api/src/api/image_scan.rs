//! Shared image content-moderation primitives.
//!
//! ONE implementation of "fetch the object bytes, run the CSAM matcher, then the
//! adult-NSFW classifier" — used by BOTH the message-attachment scan
//! ([`crate::api::attachment_scan`]) and the identity-image scan
//! ([`crate::api::identity_image_scan`]). Keeping the classify step in one place
//! means the two pipelines can never drift on how images are scanned (one
//! pattern per concern); each pipeline layers its own decision + persistence on
//! top of this shared verdict.

use std::sync::Arc;
use std::time::Duration;

use crate::domain::errors::DomainError;
use crate::domain::ports::{CsamMatcher, ImageClassifier, NsfwLabel};

/// How long to wait when fetching object bytes for a real scan.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// The combined verdict of a scan over one image's bytes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageScanVerdict {
    /// Adult-NSFW vs clean (only meaningful when `csam_match` is false).
    pub nsfw: NsfwLabel,
    /// Whether the bytes matched a known-CSAM hash (short-circuits NSFW).
    pub csam_match: bool,
    /// Raw NSFW score `0.0..=1.0` (server-side only; never shipped to clients).
    pub score: f32,
}

/// Run the CSAM matcher then the NSFW classifier over one image URL.
///
/// Fetches object bytes only when a real detector needs them (the Noop adapters
/// ignore them, so the happy path makes no network call). CSAM runs first and
/// short-circuits — a CSAM match never proceeds to the adult classifier.
///
/// # Errors
/// Returns [`DomainError::ExternalService`] on a fetch or inference failure. The
/// caller treats this as fail-closed (leaves the image withheld + dead-letters).
pub async fn classify_image(
    classifier: &Arc<dyn ImageClassifier>,
    matcher: &Arc<dyn CsamMatcher>,
    url: &str,
    mime: &str,
) -> Result<ImageScanVerdict, DomainError> {
    let bytes = if classifier.is_configured() || matcher.is_configured() {
        fetch_bytes(url).await?
    } else {
        Vec::new()
    };

    let csam = matcher.match_hash(&bytes, mime).await?;
    if csam.is_match {
        return Ok(ImageScanVerdict {
            nsfw: NsfwLabel::Clean,
            csam_match: true,
            score: 1.0,
        });
    }

    let nsfw = classifier.classify_nsfw(&bytes, mime).await?;
    Ok(ImageScanVerdict {
        nsfw: nsfw.label,
        csam_match: false,
        score: nsfw.score,
    })
}

/// Fetch raw object bytes for a real scan.
///
/// # Errors
/// Returns [`DomainError::ExternalService`] on any transport error or non-2xx
/// response.
pub async fn fetch_bytes(url: &str) -> Result<Vec<u8>, DomainError> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| DomainError::ExternalService(e.to_string()))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| DomainError::ExternalService(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(DomainError::ExternalService(format!(
            "object fetch returned {}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| DomainError::ExternalService(e.to_string()))?;
    Ok(bytes.to_vec())
}
