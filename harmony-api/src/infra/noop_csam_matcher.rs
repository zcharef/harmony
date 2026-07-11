//! Noop CSAM matcher — the ONLY matcher wired this phase.
//!
//! Always returns no-match. While Harmony is invite-only we run NO CSAM-specific
//! detector, so no "actual knowledge" / legal report duty is ever triggered
//! (18 U.S.C. § 2258A(f): no duty to proactively scan). A real hash-matching
//! adapter + the NCMEC preserve/report pipeline is Phase 3 and gates public
//! launch. `is_configured()` stays `false` so the `attachments_require_csam_scan`
//! gate treats it as unconfigured.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::ports::{CsamMatcher, CsamVerdict};

/// CSAM matcher that never matches. Not a real detector.
#[derive(Debug, Clone, Default)]
pub struct NoopCsamMatcher;

#[async_trait]
impl CsamMatcher for NoopCsamMatcher {
    async fn match_hash(&self, _bytes: &[u8], _mime: &str) -> Result<CsamVerdict, DomainError> {
        Ok(CsamVerdict {
            is_match: false,
            source: "noop".to_string(),
        })
    }

    fn is_configured(&self) -> bool {
        false
    }
}
