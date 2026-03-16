use thiserror::Error;

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
}
