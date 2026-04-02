# ADR-032: Tailwind-Only Styling

**Status:** Superseded by [ADR-044](./044-heroui-component-library.md)
**Date:** 2026-03-16

## Context

Mixed styling approaches create inconsistency and bloat:

```typescript
// BAD: inline styles — not responsive, not themeable, not extractable
<div style={{ marginTop: 16, backgroundColor: '#1a1a2e', borderRadius: 8 }}>
  <h1 style={{ fontSize: 24, color: 'white' }}>Hello</h1>
</div>

// BAD: CSS modules — separate file, different mental model, no design tokens
import styles from './chat.module.css';
<div className={styles.container}>
  <h1 className={styles.title}>Hello</h1>
</div>

// BAD: styled-components — runtime CSS-in-JS, bundle bloat, SSR complexity
const Container = styled.div`
  margin-top: 16px;
  background-color: #1a1a2e;
`;
```

When a project uses three styling approaches, developers must learn all three, cross-reference three sets of design tokens, and deal with specificity conflicts between them.

## Decision

**Tailwind CSS via `className` is the only permitted styling approach.**

```typescript
// GOOD: Tailwind only — consistent, responsive, themeable
<div className="mt-4 rounded-lg bg-zinc-900">
  <h1 className="text-2xl text-white">Hello</h1>
</div>

// GOOD: conditional classes with cn() utility
<button className={cn(
  "rounded-md px-4 py-2 font-medium transition-colors",
  variant === "primary" && "bg-indigo-600 text-white hover:bg-indigo-700",
  variant === "ghost" && "text-zinc-400 hover:bg-zinc-800 hover:text-white",
  disabled && "cursor-not-allowed opacity-50"
)}>
  {children}
</button>
```

**Exception:** HeroUI components may use inline `style={{}}` for positioning requirements (e.g., dropdown menus, popovers, tooltips). These are library-internal concerns, not application styling.

**Banned in application code:**
- `style={{}}` inline styles
- CSS modules (`.module.css`)
- `styled-components` / `@emotion/styled`
- `<style>` tags

## Consequences

**Positive:**
- One styling pattern for the entire application — lowest cognitive load
- Tailwind design tokens (spacing, colors, typography) enforce consistency
- Responsive design via utility classes (`md:`, `lg:`) without media query boilerplate
- No runtime CSS — all styles are compiled at build time
- Dark mode via `dark:` variant (aligns with Tailwind config)

**Negative:**
- Long `className` strings for complex components (mitigate with `cn()` utility and component extraction)
- Some CSS features (animations, complex selectors) require `tailwind.config.js` extensions
- Developers must learn Tailwind utility class names

## Enforcement

- **Enforcement test:** `tests/arch/feature-structure.test.ts` scans all `.tsx` files in `src/features/` and `src/components/` (excluding `src/components/ui/`) for `style={{` — test fails if found
- **Lint rule:** ESLint can flag `styled-components` imports and CSS module imports
- **Allowed:** `src/components/ui/*.tsx` may contain `style={{` for Radix positioning
