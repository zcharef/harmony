# ADR-044: HeroUI Component Library — Single UI Primitive Source

**Status:** Accepted (supersedes ADR-032 styling section)
**Date:** 2026-03-16

## Context

The walking-skeleton used shadcn/ui (Radix UI primitives + copy-pasted wrapper components) with Tailwind CSS v3. This approach has three problems for an AI-agent-driven codebase:

1. **Copy-paste ownership burden**: shadcn components live in `src/components/ui/` as source code we own. Every AI agent can modify, diverge, or break them — there's no single upstream to validate against.
2. **Raw Tailwind class soup**: Without a prop-based API, every component requires 10-30 Tailwind classes. Agents write inconsistent class combinations, producing visual drift across features.
3. **No design token enforcement**: shadcn's CSS variable layer (`--background`, `--foreground`) is hand-maintained. Nothing prevents agents from using hardcoded Tailwind colors (`bg-emerald-500`) instead of semantic tokens.

Additionally, Tailwind CSS v3 uses a JS config file (`tailwind.config.js`) that is being superseded by Tailwind CSS v4's CSS-first approach.

## Decision

**HeroUI is the Single Source of Truth for all UI components, design tokens, and styling.**

### Rules

1. **NEVER import from `@/components/ui/`** — this directory is deleted. All UI primitives come from `@heroui/react`.

2. **NEVER import from `@radix-ui/*`** in application code — HeroUI wraps React Aria (not Radix) internally.

3. **HeroUI component first**: Use HeroUI components (`<Button>`, `<Avatar>`, `<Dropdown>`, `<Tooltip>`, etc.) instead of raw HTML elements whenever a matching component exists.

4. **Prop-based styling over className**: Use HeroUI's built-in props (`color="primary"`, `variant="flat"`, `radius="md"`, `size="sm"`) for styling. Only use `className`/`classNames` for layout concerns (flexbox, margins, positioning) that HeroUI props cannot express.

5. **Semantic color tokens only**: Use HeroUI's semantic colors (`primary`, `secondary`, `success`, `danger`, `warning`, `default`) mapped to Harmony brand colors. Never hardcode hex values or generic Tailwind color names (`bg-emerald-500`).

6. **Dark mode colors via HeroUI**: Rely on HeroUI's automatic dark mode color switching via `<HeroUIProvider>` and the `dark` class. Never write manual `dark:` Tailwind variants **for color overrides** (e.g., `dark:bg-gray-800`). The `dark:` prefix is still permitted for non-color layout adjustments (e.g., `dark:border-2`) when needed.

7. **Tailwind CSS v4**: Use the CSS-first configuration approach (`@import "tailwindcss"`, `@plugin`, `@source`). The `tailwind.config.js` file is removed. Theme config lives in `hero.ts` (the HeroUI plugin file consumed by `@plugin ./hero.ts` in CSS).

### Component Mapping (shadcn → HeroUI)

| shadcn Component | HeroUI Replacement | Notes |
|---|---|---|
| `Button` | `Button` from `@heroui/react` | Use `color`, `variant`, `size` props |
| `Avatar` + `AvatarFallback` | `Avatar` from `@heroui/react` | Use `name` prop for auto-initials, or `fallback` prop for custom content |
| `ScrollArea` | Native `overflow-auto` or `ScrollShadow` | Use `ScrollShadow` only when visual shadow effect is desired |
| `Separator` | `Divider` from `@heroui/react` | Direct replacement |
| `Textarea` | `Textarea` from `@heroui/react` | Use `variant`, `label` props |
| `Input` | `Input` from `@heroui/react` | Use `variant`, `label` props |
| `Collapsible` | `Accordion` from `@heroui/react` | Use `selectionMode="multiple"` to match independent expand/collapse behavior. Requires `classNames` customization for minimal styling. |
| `DropdownMenu` | `Dropdown` from `@heroui/react` | Use `DropdownTrigger`, `DropdownMenu`, `DropdownItem` |
| `Tooltip` | `Tooltip` from `@heroui/react` | Use `content` + `placement` props. No Provider/Trigger/Content children — wraps trigger directly. No `asChild` pattern. |
| `Sheet` | `Drawer` from `@heroui/react` | Slide-over panel |
| `ResizablePanel` | `react-resizable-panels` (direct) | No HeroUI equivalent — keep as direct dependency with styled handle in `components/layout/` |

### Semantic Token Mapping (shadcn → HeroUI)

| shadcn Token | HeroUI Equivalent | Tailwind Class Change |
|---|---|---|
| `bg-background` | `bg-background` | No change |
| `text-foreground` | `text-foreground` | No change |
| `bg-card` | `bg-content1` | Rename |
| `bg-muted` | `bg-default-100` | Rename |
| `text-muted-foreground` | `text-default-500` | Rename |
| `bg-accent` | `bg-default-200` | Rename |
| `text-destructive` | `text-danger` | Rename |
| `border-border` | `border-divider` | Rename |
| `bg-emerald-500` (online) | `bg-success` | Semantic replacement |
| `bg-amber-400` (idle) | `bg-warning` | Semantic replacement |
| `bg-red-500` (DND) | `bg-danger` | Semantic replacement |
| `bg-zinc-500` (offline) | `bg-default-400` | Semantic replacement |

### Theme Configuration (Harmony Brand → HeroUI Tokens)

This config lives in `hero.ts`, consumed by Tailwind v4 via `@plugin ./hero.ts` in `App.css`:

```typescript
// hero.ts — HeroUI theme plugin for Tailwind v4
import { heroui } from "@heroui/react";

export default heroui({
  defaultTheme: "dark",
  themes: {
    light: {
      colors: {
        primary: { DEFAULT: "#5F9EA0", foreground: "#FFFFFF" },    // Harmony teal
        secondary: { DEFAULT: "#A4C6B8", foreground: "#36454F" },  // Harmony green
        success: { DEFAULT: "#10b981" },                            // Online status
        warning: { DEFAULT: "#f59e0b" },                            // Idle status
        danger: { DEFAULT: "#ef4444" },                             // DND status / destructive
        background: "#FAF9F6",                                      // Harmony light
        foreground: "#36454F",                                      // Harmony charcoal
      },
    },
    dark: {
      colors: {
        primary: { DEFAULT: "#5F9EA0", foreground: "#FFFFFF" },
        secondary: { DEFAULT: "#2B3A42", foreground: "#FAF9F6" },
        success: { DEFAULT: "#10b981" },
        warning: { DEFAULT: "#f59e0b" },
        danger: { DEFAULT: "#ef4444" },
        background: "#1E2D35",
        foreground: "#FAF9F6",
      },
    },
  },
});
```

## Consequences

**Positive:**
- AI agents use HeroUI's prop API — fewer ways to produce inconsistent output
- Design tokens are enforced by the theme system, not hand-maintained CSS variables
- 60+ production-ready components out of the box (Modal, Table, Calendar, Toast, etc.)
- Automatic dark mode color switching — no manual `dark:bg-*` maintenance
- Tailwind v4 CSS-first approach reduces configuration surface area
- `motion` animations included (HeroUI peer dependency)

**Negative:**
- Migration effort: rewrite 6 component consumer files + tooling config
- `motion` (formerly framer-motion) adds ~45-50KB gzipped to bundle (acceptable for Tauri desktop app)
- Less granular control than raw Tailwind (mitigated by `classNames` slot API)
- Semantic token system differs from shadcn — requires explicit mapping decisions

**Cleanup Required:**
After migration, ALL shadcn artifacts must be removed:
- `src/components/ui/` directory (11 files)
- `components.json` (shadcn CLI config)
- 13 npm packages (8 Radix + CVA + tailwind-merge + tailwindcss-animate + postcss + autoprefixer)
- `biome.json` override for `src/components/ui/**`
- `knip.json` ignore entries for `src/components/ui/**` and dead `ignoreDependencies`
- `eslint.config.mjs` `ui` boundary type definition and all `allow: ['ui']` references
- `tailwind.config.js` and `postcss.config.js`
- All shadcn/Radix references in CLAUDE.md (6+ locations) and CONTRIBUTING.md

**Enforcement:**
- **Arch test**: scan `src/` for `@/components/ui/` imports — must find zero
- **Arch test**: scan `src/features/` and `src/components/` for `@radix-ui` imports — must find zero
- **Arch test**: scan for `style={{` in application code (unchanged from ADR-032)
- **Arch test**: scan for hardcoded Tailwind color classes (`bg-emerald-*`, `bg-red-*`, `bg-amber-*`, `bg-zinc-*`, `text-white`) outside theme config — must find zero
- **Knip**: detect any remaining unused shadcn dependencies
- **CLAUDE.md**: updated rules for AI agents — HeroUI prop-based styling
