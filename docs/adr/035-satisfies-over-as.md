# ADR-035: satisfies Over as Type Assertions

**Status:** Accepted
**Date:** 2026-03-16

## Context

`as Type` assertions lie to the TypeScript compiler, suppressing real type errors:

```typescript
// BAD: `as` hides a real bug — TypeScript trusts you blindly
interface User {
  id: string;
  email: string;
  displayName: string;
}

const user = {
  id: '123',
  email: 'test@example.com',
  // displayName is missing!
} as User;

// TypeScript thinks user.displayName is a string. It's actually undefined.
// user.displayName.toUpperCase() → runtime TypeError: Cannot read property 'toUpperCase' of undefined
```

`as Type` is a type assertion, not a type check. It tells the compiler "trust me, this is a User" even when it is not. The compiler suppresses the error, and the bug surfaces at runtime.

## Decision

Use `satisfies` for type validation. Ban `as Type` assertions.

```typescript
// GOOD: `satisfies` validates the type at compile time
const user = {
  id: '123',
  email: 'test@example.com',
  // displayName is missing!
} satisfies User;
// Compile error: Property 'displayName' is missing in type
// '{ id: string; email: string; }' but required in type 'User'.
```

**`satisfies` validates without widening:** The value's inferred type is preserved (not widened to the constraint type), while the compiler verifies it matches the expected shape.

```typescript
// GOOD: type is validated AND the literal types are preserved
const config = {
  port: 3000,
  host: 'localhost',
} satisfies ServerConfig;
// typeof config.port is 3000, not number
// typeof config.host is 'localhost', not string
```

**Allowed uses of `as`:**
- `as const` — immutable literal type (not an assertion, a type annotation)
- `as unknown` — explicit escape hatch for genuinely untyped data (e.g., JSON parsing)
- `as never` — exhaustive switch default (indicates unreachable code)
- Test files (`.test.ts`, `.spec.ts`) — may use `as` for testing edge cases with invalid data

## Consequences

**Positive:**
- Compiler catches missing fields, wrong types, and structural mismatches at build time
- `satisfies` preserves literal types (better autocomplete, narrower types)
- No runtime `undefined` surprises from missing fields that `as` would hide
- `as const` and `as unknown` remain available for their intended purposes

**Negative:**
- `satisfies` is TypeScript 4.9+ (not an issue for modern projects)
- Some third-party library patterns require `as` for compatibility (evaluate case-by-case)
- Slightly more verbose than `as` in some patterns

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` uses a TypeScript AST parser (NOT regex) to scan `.ts` and `.tsx` files for `as` type assertions — test fails if found outside the allowed patterns (`as const`, `as unknown`, `as never`, test files)
- **Why AST, not regex:** Regex produces false positives on `as` in import statements (`import { X as Y }`), comments, and string literals. An AST parser (`ts-morph` or TypeScript compiler API) identifies only actual `AsExpression` nodes
