# ADR-009: NewType Pattern for Type-Safe IDs

**Status:** Accepted
**Date:** 2026-01-29

## Context

Without strong typing, functions accept interchangeable strings:

```rust
// BUG: user_id and payment_id are both String, can be swapped
fn process_payment(user_id: String, payment_id: String) { ... }

// Compiles, but wrong!
process_payment(payment_id, user_id);
```

## Decision

Use **NewType pattern** for all domain IDs:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ServerId(Uuid);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChannelId(Uuid);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageId(Uuid);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RoleId(Uuid);
```

Now the compiler prevents swapping:
```rust
fn process_payment(user_id: UserId, payment_id: PaymentId) { ... }

// Compile error: expected UserId, found PaymentId
process_payment(payment_id, user_id);
```

## Consequences

**Positive:**
- Compile-time prevention of ID mix-ups
- Self-documenting code (function signature shows intent)
- Encapsulation (can change internal representation later)

**Negative:**
- More boilerplate (derive macros, From/Into impls)
- Conversion needed at API boundaries

**Location:** `src/domain/models/ids.rs`

**Defined types:**
- `UserId(Uuid)` - Supabase Auth UID
- `ServerId(Uuid)` - Server identifier
- `ChannelId(Uuid)` - Channel identifier
- `MessageId(Uuid)` - Message identifier
- `RoleId(Uuid)` - Role identifier

**Usage in repositories:**
```rust
async fn get_by_id(&self, id: &UserId) -> Result<User, DomainError>;
async fn create_server(&self, new: NewServer) -> Result<Server, DomainError>;
```
