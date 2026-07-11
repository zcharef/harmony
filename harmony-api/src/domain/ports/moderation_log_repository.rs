//! Port: moderation audit-log persistence (append-only).

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{ModerationLogEntry, NewModerationLogEntry, ServerId};

/// Intent-based repository for the moderation audit log.
#[async_trait]
pub trait ModerationLogRepository: Send + Sync + std::fmt::Debug {
    /// Append one audit-log row. Called best-effort by the service AFTER the
    /// enforcement mutation commits — a failure here must never fail the action.
    async fn record(&self, entry: NewModerationLogEntry) -> Result<(), DomainError>;

    /// List a server's audit log newest-first, cursor-paginated (ADR-036).
    ///
    /// Returns rows created before `cursor` (if provided), limited to `limit`,
    /// with actor/target display data resolved.
    async fn list_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<ModerationLogEntry>, DomainError>;
}
