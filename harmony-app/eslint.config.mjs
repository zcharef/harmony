import boundaries from 'eslint-plugin-boundaries'
import tseslint from 'typescript-eslint'

/**
 * ESLint configuration — ONLY for module boundary enforcement.
 * All other linting/formatting is handled by Biome.
 *
 * Boundaries rules enforce the Public API Pattern:
 * - Deep imports into features are FORBIDDEN (must use barrel exports)
 * - Features can only import from: lib/, hooks/, components/shared/
 * - Cross-feature imports must go through index.ts
 *
 * Run with: just boundaries
 *
 * Migrated to eslint-plugin-boundaries v6 (2026-03-22):
 * - element-types -> dependencies (renamed rule)
 * - entry-point -> merged into dependencies via disallow + internalPath
 * - ${from.x} -> {{from.captured.x}} template syntax
 * - string/tuple selectors -> object-based selectors ({ type, captured })
 */

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'tests/**',
      'src/lib/api/**',
      '**/*.d.ts',
    ],
  },
  // TypeScript parser for all TS/TSX files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
      },
    },
  },
  // Boundaries plugin configuration
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'src/**/*.d.ts',
    ],
    plugins: {
      boundaries,
    },
    settings: {
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': [
        // Features — the core business domains
        {
          type: 'feature',
          pattern: 'src/features/*',
          capture: ['featureName'],
        },
        // Shared UI components (pure UI, no business logic)
        {
          type: 'shared',
          pattern: 'src/components/shared/*',
        },
        // Layout components (app shell)
        {
          type: 'layout',
          pattern: 'src/components/layout/*',
        },
        // Technical utilities (framework-agnostic)
        {
          type: 'lib',
          pattern: 'src/lib/*',
        },
        // Generic hooks (non-business)
        {
          type: 'hooks',
          pattern: 'src/hooks/*',
        },
        // Pages (route-level orchestration)
        {
          type: 'pages',
          pattern: 'src/pages/**/*',
        },
        // Router config
        {
          type: 'router',
          pattern: 'src/router/*',
        },
      ],
    },
    rules: {
      /**
       * BOUNDARY RULE: dependencies (v6 — replaces element-types + entry-point)
       *
       * Enforces what each element type can import from AND entry-point constraints.
       * Default is 'disallow' — everything is forbidden unless explicitly allowed.
       *
       * Entry-point enforcement for features: cross-feature imports that target
       * anything other than index.ts/index.tsx are disallowed.
       *
       * ALLOWED:   import { ChatArea } from '@/features/chat'
       * FORBIDDEN: import { ChatArea } from '@/features/chat/chat-area'
       */
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            // Features can import their own internals (same feature, any path)
            {
              from: { type: 'feature' },
              allow: [
                {
                  to: {
                    type: 'feature',
                    captured: { featureName: '{{from.captured.featureName}}' },
                  },
                },
              ],
            },
            // Features can import other features ONLY via index.ts barrel
            {
              from: { type: 'feature' },
              allow: [
                {
                  to: {
                    type: 'feature',
                    captured: { featureName: '!{{from.captured.featureName}}' },
                    internalPath: 'index.ts',
                  },
                },
                {
                  to: {
                    type: 'feature',
                    captured: { featureName: '!{{from.captured.featureName}}' },
                    internalPath: 'index.tsx',
                  },
                },
              ],
            },
            // Features can import from lib, hooks, shared
            {
              from: { type: 'feature' },
              allow: [
                { to: { type: 'lib' } },
                { to: { type: 'hooks' } },
                { to: { type: 'shared' } },
              ],
            },
            // Shared components can import from: lib, hooks
            {
              from: { type: 'shared' },
              allow: [{ to: { type: 'lib' } }, { to: { type: 'hooks' } }],
            },
            // Layout components: features (via barrel), shared, lib, hooks
            {
              from: { type: 'layout' },
              allow: [
                { to: { type: 'feature', internalPath: 'index.ts' } },
                { to: { type: 'feature', internalPath: 'index.tsx' } },
                { to: { type: 'shared' } },
                { to: { type: 'lib' } },
                { to: { type: 'hooks' } },
              ],
            },
            // Lib can import from other lib
            {
              from: { type: 'lib' },
              allow: [{ to: { type: 'lib' } }],
            },
            // Hooks can import from lib and other hooks
            {
              from: { type: 'hooks' },
              allow: [{ to: { type: 'lib' } }, { to: { type: 'hooks' } }],
            },
            // Pages can import from everything (features via barrel only)
            {
              from: { type: 'pages' },
              allow: [
                { to: { type: 'feature', internalPath: 'index.ts' } },
                { to: { type: 'feature', internalPath: 'index.tsx' } },
                { to: { type: 'shared' } },
                { to: { type: 'lib' } },
                { to: { type: 'hooks' } },
                { to: { type: 'layout' } },
              ],
            },
            // Router can import from pages, lib
            {
              from: { type: 'router' },
              allow: [{ to: { type: 'pages' } }, { to: { type: 'lib' } }],
            },
          ],
        },
      ],
    },
  },
)
