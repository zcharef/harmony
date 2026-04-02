# ADR-023: From/TryFrom at Layer Boundaries

**Status:** Accepted
**Date:** 2026-03-16

## Context

Manually constructing DTOs field-by-field in handlers is verbose, error-prone, and violates DRY:

```rust
// BAD: field-by-field construction in handler — fragile, repetitive
pub async fn get_user(/* ... */) -> ApiResult<Json<UserResponse>> {
    let user = state.user_service.get_by_id(&user_id).await?;

    // If User gains a new field, every handler doing this breaks.
    // If a field is misspelled, it's a silent bug (wrong data, not compile error).
    Ok(Json(UserResponse {
        id: user.id.to_string(),
        email: user.email.clone(),
        display_name: user.display_name.clone(),
        avatar_url: user.avatar_url.clone(),
        // Forgot to add created_at — compiles if UserResponse has Option<String>
    }))
}
```

Every handler that returns `UserResponse` duplicates this mapping. When `User` gains a new field, every handler must be updated.

## Decision

Use `From` and `TryFrom` implementations at layer boundaries. Handlers use `.into()` or `.try_into()?`.

**Domain to DTO (infallible):**
```rust
// GOOD: single conversion defined once
impl From<User> for UserResponse {
    fn from(user: User) -> Self {
        Self {
            id: user.id.to_string(),
            email: user.email,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            created_at: user.created_at.to_rfc3339(),
        }
    }
}

// Handler is clean and cannot diverge
pub async fn get_user(/* ... */) -> ApiResult<Json<UserResponse>> {
    let user = state.user_service.get_by_id(&user_id).await?;
    Ok(Json(user.into()))
}
```

**Request DTO to Domain (fallible):**
```rust
// GOOD: validation happens in TryFrom, not scattered across handlers
impl TryFrom<CreateServerRequest> for NewServer {
    type Error = DomainError;

    fn try_from(req: CreateServerRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            name: ServerName::try_from(req.name)?,
            description: req.description,
        })
    }
}

pub async fn create_server(/* ... */) -> ApiResult<Json<ServerResponse>> {
    let input: NewServer = req.try_into()?;
    let server = state.server_service.create(input).await?;
    Ok(Json(server.into()))
}
```

## Consequences

**Positive:**
- Conversion logic defined once — adding a field to `User` requires updating one `From` impl, not every handler
- Handlers are concise: `.into()` and `.try_into()?`
- Type system enforces that the conversion is complete (missing fields are compile errors)
- `TryFrom` centralizes request validation (aligns with ADR-014: Parse Don't Validate)

**Negative:**
- More `From`/`TryFrom` impl blocks to maintain
- Conversion is implicit at the call site (`.into()`) — must check the impl to understand the mapping
- Some conversions require access to context (e.g., request URL for HATEOAS links) — these stay in the handler

## Enforcement

- **Enforcement test:** `tests/architecture_test.rs` scans handler files in `src/api/handlers/` for DTO struct literal construction (e.g., `UserResponse {`, `ServerResponse {`) — these should use `.into()` instead
- **Code review:** PRs with field-by-field DTO construction in handlers are rejected with a pointer to this ADR
