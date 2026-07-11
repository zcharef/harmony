use thiserror::Error;

use crate::domain::models::{Plan, ResourceKind};

/// Domain-level errors.
///
/// These errors represent business logic failures, not infrastructure failures.
/// They are mapped to HTTP status codes in the API layer.
#[derive(Debug, Error)]
#[allow(dead_code)] // Variants will be used as domain services are implemented
pub enum DomainError {
    #[error("Resource not found: {resource_type} with id {id}")]
    NotFound {
        resource_type: &'static str,
        id: String,
    },

    #[error("Validation failed: {0}")]
    ValidationError(String),

    #[error("Operation not permitted: {0}")]
    Forbidden(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("External service error: {0}")]
    ExternalService(String),

    #[error("Rate limited: {0}")]
    RateLimited(String),

    /// A plan-gated resource was rejected.
    ///
    /// `plan: None` means the rejection is not tied to a `SaaS` tier
    /// (self-hosted deployments) — the API layer then renders a generic
    /// limit message without upgrade details.
    #[error("Plan limit exceeded: {} limit of {limit} reached", resource.display_name())]
    LimitExceeded {
        resource: ResourceKind,
        plan: Option<Plan>,
        limit: u64,
    },
}
