//! Port: append-only analytics event recorder (growth-plan §10).

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::AnalyticsEvent;

/// Records funnel events into the own-DB analytics log.
///
/// Callers MUST treat recording as fire-and-forget: a failed insert never
/// fails the user action (spawn + `tracing::warn!`, ADR-027). Once-per-user
/// events (`first_message`) dedup at the DB level — recording a duplicate
/// is a silent no-op, not an error.
#[async_trait]
pub trait AnalyticsRecorder: Send + Sync + std::fmt::Debug {
    /// Insert one event row.
    async fn record(&self, event: AnalyticsEvent) -> Result<(), DomainError>;
}
