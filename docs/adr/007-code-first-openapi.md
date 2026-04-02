# ADR-007: Code-First OpenAPI with utoipa

**Status:** Accepted
**Date:** 2026-01-29

## Context

API documentation options:
1. **Spec-first** - Write OpenAPI YAML, generate code
2. **Code-first** - Annotate Rust code, generate spec

## Decision

Use **code-first** with `utoipa` crate.

```rust
#[derive(Serialize, ToSchema)]
pub struct UserResponse {
    pub id: String,
    pub email: String,
}

#[utoipa::path(
    get,
    path = "/v1/users/me",
    responses(
        (status = 200, body = UserResponse),
        (status = 401, body = ProblemDetails)
    )
)]
pub async fn get_me(...) -> ApiResult<Json<UserResponse>> { ... }
```

**Rationale:**
- Rust types ARE the spec (no drift between code and docs)
- Compiler enforces that response types match handler returns
- Swagger UI auto-generated at `/swagger-ui`

## Consequences

**Positive:**
- Single source of truth (Rust code)
- Type changes automatically update API docs
- No YAML editing, no code generation step

**Negative:**
- Annotations add visual noise to handlers
- utoipa-specific macros (not portable to other frameworks)

**Generated spec:**
- Endpoint: `GET /api-docs/openapi.json`
- Swagger UI: `GET /swagger-ui`

**TypeScript client generation (Next.js):**
```bash
npx openapi-typescript-codegen \
  --input http://localhost:3000/api-docs/openapi.json \
  --output ./src/lib/api \
  --client fetch
```
