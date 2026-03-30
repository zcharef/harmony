# ADR-003: Hexagonal Architecture (Ports & Adapters)

**Status:** Accepted
**Date:** 2026-01-29

## Decision

Use **Hexagonal Architecture** with strict layer separation:

```
src/
├── domain/           # PURE Rust - no infra deps
│   ├── models/       # Entities
│   ├── ports/        # Repository TRAITS (not impls)
│   └── errors.rs     # DomainError enum
├── infra/            # Implementations
│   ├── postgres/     # Postgres adapters
│   └── auth/         # JWT validation
└── api/              # HTTP layer (Axum)
    ├── handlers/     # Route handlers
    └── dto/          # Request/Response types
```

**Key rules:**
1. Domain imports NOTHING from infra or api
2. Handlers receive `Arc<dyn Repository>` (trait objects)
3. Main.rs wires concrete implementations at composition root

## Consequences

**Positive:**
- Unit test domain logic without database
- Clear dependency direction (compile-time enforcement)

**Negative:**
- More boilerplate (traits, impl blocks)
- `Arc<dyn Trait>` has minor runtime cost

**Enforcement:**
- Architecture tests (`tests/architecture_test.rs`) verify:
  - Domain doesn't import infra/api
  - Handlers use trait objects
  - AppState uses Arc<dyn ...>
