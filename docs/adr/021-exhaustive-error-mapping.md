# ADR-021: Exhaustive DomainError to ApiError Mapping

**Status:** Accepted
**Date:** 2026-03-16

## Context

A wildcard match in the error mapping silently maps new domain errors to 500:

```rust
// BAD: wildcard swallows new variants — they all become 500
impl From<DomainError> for ApiError {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::NotFound(msg) => ApiError::not_found(msg),
            DomainError::Forbidden(msg) => ApiError::forbidden(msg),
            _ => ApiError::internal("Internal server error"),
            // New variant DomainError::RateLimited added last week?
            // Silently becomes 500 instead of 429.
        }
    }
}
```

When a developer adds `DomainError::RateLimited`, the wildcard catch-all maps it to a generic 500. The client receives an unhelpful error, and the developer never realizes the mapping is missing because the code compiles without warning.

## Decision

The `From<DomainError> for ApiError` implementation must use **exhaustive matching** with no `_ =>` wildcard:

```rust
// GOOD: exhaustive — adding a new variant forces updating this match
impl From<DomainError> for ApiError {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::NotFound(msg) => ApiError::not_found(msg),
            DomainError::ValidationError(msg) => ApiError::bad_request(msg),
            DomainError::Forbidden(msg) => ApiError::forbidden(msg),
            DomainError::Conflict(msg) => ApiError::conflict(msg),
            DomainError::RateLimited { retry_after } => ApiError::too_many_requests(retry_after),
            DomainError::Internal(msg) => ApiError::internal(msg),
            // Adding DomainError::NewVariant without a match arm here
            // is a COMPILE ERROR. The developer is forced to choose
            // the correct HTTP status code.
        }
    }
}
```

This leverages Rust's exhaustive pattern matching: adding a new `DomainError` variant without updating this `From` impl produces a compiler error, not a silent 500.

## Consequences

**Positive:**
- Compiler enforces that every domain error has an explicit HTTP mapping
- New error variants cannot silently degrade to 500
- The mapping serves as documentation of the error-to-HTTP-status contract

**Negative:**
- Adding a new `DomainError` variant requires updating the `From` impl (this is the point — it is a feature, not a burden)
- Slightly more code than a wildcard match

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans the `From<DomainError> for ApiError` implementation for `_ =>` — test fails if a wildcard is found
- **Compiler:** Rust's exhaustive match checking prevents missing variants at compile time (the primary enforcement mechanism)
