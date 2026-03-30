# ADR-004: Intent-Based Repository Methods

**Status:** Accepted
**Date:** 2026-01-29

## Context

Traditional repositories use CRUD methods:
```rust
fn create(entity: User) -> Result<User>;
fn update(id: UserId, entity: User) -> Result<User>;
fn delete(id: UserId) -> Result<()>;
```

This leads to the **lowest-common-denominator problem**: business logic leaks into handlers, and database-specific optimizations become impossible.

## Decision

Use **intent-based repository methods** that express business operations:

```rust
// BAD: Generic CRUD
trait UserRepository {
    fn update(&self, id: UserId, user: User) -> Result<User>;
}

// GOOD: Intent-based
trait UserRepository {
    fn update_profile(&self, id: UserId, update: ProfileUpdate) -> Result<User>;
    fn update_nickname(&self, id: UserId, nickname: String) -> Result<()>;
}

// BAD: Generic CRUD
trait ServerRepository {
    fn update(&self, id: ServerId, server: Server) -> Result<Server>;
}

// GOOD: Intent-based
trait ServerRepository {
    fn create_server(&self, new: NewServer) -> Result<Server>;
    fn join_server(&self, id: ServerId, user_id: UserId) -> Result<Member>;
    fn send_message(&self, channel_id: ChannelId, msg: NewMessage) -> Result<Message>;
}
```

## Consequences

**Positive:**
- Business intent is clear in the code
- Postgres can use optimized transactions per intent
- Easier to add validation (e.g., "only server owners can delete channels")
- API is self-documenting

**Negative:**
- More methods in repository traits
- Can't use generic CRUD libraries

**Examples in codebase:**
- `create_server` vs `create`
- `join_server` vs `insert(member)`
- `send_message` vs `create(message)`
