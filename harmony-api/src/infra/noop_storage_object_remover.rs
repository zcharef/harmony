//! Noop storage-object remover — the ONLY remover wired this phase.
//!
//! Deletion of a flagged identity-image object is a best-effort no-op until a
//! service-role Supabase Storage adapter lands (needs a service key in config —
//! a documented follow-up). The scan-before-reveal safety property does NOT
//! depend on deletion: a rejected candidate is never promoted into the live
//! column, so no other user is ever shown it. This adapter keeps the reject
//! pipeline delete-shaped in the meantime.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::ports::StorageObjectRemover;

/// A remover that does nothing. Not a real deleter.
#[derive(Debug, Clone, Default)]
pub struct NoopStorageObjectRemover;

#[async_trait]
impl StorageObjectRemover for NoopStorageObjectRemover {
    async fn remove(&self, public_url: &str) -> Result<(), DomainError> {
        tracing::debug!(
            object_url = %public_url,
            "noop storage remover: skipping delete of flagged object (no service-role adapter wired)"
        );
        Ok(())
    }
}
