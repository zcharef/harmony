# ADR-014: Parse Don't Validate as Canonical Validation Strategy

**Status:** Accepted
**Date:** 2026-02-08

## Context

The API needs input validation. Two fundamentally different approaches exist:

**Runtime validation** (e.g., `validator` crate with `#[derive(Validate)]`):
```rust
#[derive(Validate)]
struct CreateUserRequest {
    #[validate(length(min = 1, max = 100))]
    name: String,
    #[validate(email)]
    email: String,
}

// Caller must remember to call .validate() — nothing enforces it
let req: CreateUserRequest = serde_json::from_str(body)?;
req.validate()?; // Easy to forget. Data is "valid String" but still just String.
```

**Type-driven validation** ("parse, don't validate"):
```rust
struct Email(String); // Can only be constructed via TryFrom/Deserialize

impl<'de> Deserialize<'de> for Email {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if s.contains('@') { Ok(Email(s)) } else { Err(de::Error::custom("invalid email")) }
    }
}
// Once you have an Email, it is guaranteed valid. No .validate() call needed.
```

The `validator` crate (v0.20) was added as a dependency but never used in any source file. Meanwhile, the codebase already follows the "parse, don't validate" pattern through NewType wrappers (ADR-009) and `From`/`TryFrom` conversions at DTO boundaries.

## Decision

Adopt **"parse, don't validate"** as the canonical validation strategy. Remove the unused `validator` dependency.

All validation is encoded in the type system through four mechanisms:

1. **NewType wrappers for IDs** (`src/domain/models/ids.rs`):
   - `UserId(Uuid)`, `ServerId(Uuid)`, `ChannelId(Uuid)`, `MessageId(Uuid)`, `RoleId(Uuid)`
   - `#[serde(transparent)]` for seamless serialization
   - Compiler prevents mixing up ID types at call sites

2. **Custom `Deserialize` impls for constrained values**:
   - Example: a custom deserializer that treats `null` as `false` for boolean fields
   - Validation happens at deserialization time, not as a separate step

3. **`From` conversions from domain models to response DTOs**:
   - `impl From<DomainModel> for ResponseDto`
   - Domain model is the SSoT; DTOs are derived projections

4. **Invalid states are unrepresentable at the type level**:
   - A function accepting `UserId` cannot receive a `ServiceId`
   - A parsed `ServerId` is guaranteed to contain a valid `Uuid`

## Consequences

**Positive:**
- Compile-time guarantees: if code compiles, IDs cannot be mixed up
- No runtime validation step that can be forgotten (the `.validate()` call problem)
- Validation happens exactly once, at the deserialization boundary — once parsed, data is guaranteed valid throughout the entire call stack
- Aligns with the existing NewType pattern (ADR-009) and Rust's ownership model
- Fewer dependencies (removed `validator` + its derive macro)

**Negative/Trade-off:**
- More upfront type design work (defining NewTypes, writing `From`/`TryFrom` impls)
- Adding new constrained types requires implementing `Deserialize` or `TryFrom` rather than adding an annotation
- Pays off in safety: one-time cost at the boundary vs. perpetual risk of forgetting `.validate()`

**Prior art:**
- Alexis King, "Parse, don't validate" (2019) — foundational blog post on the pattern
- r/rust discussions on replacing `validator` with type-driven parsing
- ADR-009 (NewType Pattern) — already established in this codebase

**Files changed:**
- `Cargo.toml` — removed `validator = { version = "0.20", features = ["derive"] }`
- `src/domain/models/ids.rs` — existing NewType definitions (unchanged, referenced as evidence)
