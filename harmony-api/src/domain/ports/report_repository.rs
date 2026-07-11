//! Port: user-filed message report persistence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;
use crate::domain::models::{
    MessageReport, NewMessageReport, ReportId, ReportStatus, ServerId, UserId,
};

/// Intent-based repository for the message reports queue.
#[async_trait]
pub trait ReportRepository: Send + Sync + std::fmt::Debug {
    /// File a new report. Returns `DomainError::Conflict` if the reporter
    /// already has an OPEN report for the same message (partial unique index).
    async fn create(&self, report: NewMessageReport) -> Result<MessageReport, DomainError>;

    /// List a server's OPEN reports newest-first, cursor-paginated (ADR-036),
    /// with reporter/reported display data and the reported-message snapshot.
    async fn list_open_paginated(
        &self,
        server_id: &ServerId,
        cursor: Option<DateTime<Utc>>,
        limit: i64,
    ) -> Result<Vec<MessageReport>, DomainError>;

    /// Fetch a single report by id, scoped to `server_id` (returns `None` when
    /// the report does not exist or belongs to another server).
    async fn get(
        &self,
        server_id: &ServerId,
        report_id: &ReportId,
    ) -> Result<Option<MessageReport>, DomainError>;

    /// Transition an OPEN report to a terminal status, stamping the resolver.
    /// Returns `DomainError::NotFound` if no OPEN report matched.
    async fn resolve(
        &self,
        server_id: &ServerId,
        report_id: &ReportId,
        status: ReportStatus,
        resolved_by: &UserId,
    ) -> Result<MessageReport, DomainError>;

    /// Count OPEN reports for a server (drives the queue badge).
    async fn count_open(&self, server_id: &ServerId) -> Result<i64, DomainError>;
}
