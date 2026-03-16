# ADR-018: No-Mock Testing Strategy

**Status:** Accepted
**Date:** 2026-03-16

## Context

Mock-heavy tests give false confidence:

```rust
// BAD: mocking the repository hides real SQL bugs
#[automock]
trait UserRepository {
    async fn find_by_id(&self, id: &UserId) -> Result<User, DomainError>;
}

#[test]
fn test_get_user() {
    let mut mock = MockUserRepository::new();
    mock.expect_find_by_id()
        .returning(|_| Ok(fake_user()));

    // This test passes even if the real SQL query is broken,
    // the column names are wrong, or the JOIN is missing.
    let result = service.get_user(&mock, &user_id).await;
    assert!(result.is_ok());
}
```

The mock returns whatever you tell it to — it never tests the actual database query, serialization, or transaction behavior. Bugs in the infrastructure layer go undetected until production.

## Decision

**Real dependencies, not mocks:**

- **Database:** Use `testcontainers` to spin up a real PostgreSQL instance per test suite
- **HTTP:** Use `axum::test::TestServer` (or `reqwest` against the real app) for integration tests
- **External APIs only:** Use `wiremock` for third-party HTTP services (e.g., Stripe, SendGrid) where real calls are impractical

**Banned crates** (via `deny.toml`):
- `mockall`
- `mock_derive`

**Allowed crate — `fake`:** The `fake` crate is a **data generator** (like Faker.js), not a mock framework. It generates realistic test data and is explicitly allowed:

```rust
// GOOD: real database, real queries, generated test data
use fake::{Fake, faker::internet::en::SafeEmail};
use testcontainers::clients::Cli;

#[tokio::test]
async fn test_create_user() {
    let pool = setup_test_db().await; // real PostgreSQL via testcontainers

    let email: String = SafeEmail().fake();
    let result = user_repo.create(&pool, &NewUser {
        email,
        display_name: "Test User".into(),
    }).await;

    assert!(result.is_ok());

    // Verify the row actually exists in the real database
    let found = user_repo.find_by_id(&pool, &result.unwrap().id).await;
    assert!(found.is_ok());
}
```

## Consequences

**Positive:**
- Tests verify real SQL, real serialization, real transaction behavior
- No false confidence from mocks that silently diverge from real implementations
- `testcontainers` provides disposable, isolated databases — no shared test state
- Bugs in queries, migrations, and constraint violations are caught before merge

**Negative:**
- Slower tests (~2-5s for container startup, amortized across test suite)
- Requires Docker on CI and developer machines
- Cannot easily test domain logic in isolation from infrastructure (acceptable — the integration boundary is where most bugs live)

## Enforcement

- **`deny.toml`:** `mockall` and `mock_derive` are banned crates — `cargo deny check` fails if added
- **Enforcement test:** `tests/architecture_test.rs` scans all `.rs` files for `#[automock]` attribute — fails if found
- **CI:** `cargo deny check bans` runs on every PR
