//! Port: delete an object from the public Storage bucket.
//!
//! Used by the identity-image reject path to remove a flagged avatar/banner
//! object after a scan rejects it (spec: reject → delete the flagged object).
//! The safety property (never reveal an unscanned image) is upheld by NOT
//! promoting the candidate into the live column regardless of deletion; removing
//! the object closes the residual "someone who knows the raw object URL could
//! still fetch it" gap.
//!
//! Phase 1 wires a Noop adapter (`NoopStorageObjectRemover` in the infra layer):
//! deletion is a best-effort no-op until a service-role Supabase Storage adapter
//! (which needs a service key in config) lands — a documented follow-up. The
//! port stays defined so the reject pipeline is delete-shaped and that follow-up
//! is a wiring swap, not a pipeline change.

use async_trait::async_trait;

use crate::domain::errors::DomainError;

/// Deletes objects from public Storage buckets.
#[async_trait]
pub trait StorageObjectRemover: Send + Sync + std::fmt::Debug {
    /// Best-effort delete of the object at `public_url`.
    ///
    /// # Errors
    /// Returns [`DomainError::ExternalService`] on a delete failure. Callers
    /// treat deletion as best-effort — a failure is logged, never fatal (the
    /// image is already withheld by not being promoted).
    async fn remove(&self, public_url: &str) -> Result<(), DomainError>;
}
