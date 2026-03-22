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
       * BOUNDARY RULE: element-types
       *
       * Enforces what each element type can import from.
       * Default is 'disallow' — everything is forbidden unless explicitly allowed.
       */
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // Features can import from:
            // - Their own internals (same feature)
            // - Other features ONLY via index.ts (barrel export)
            // - lib/, hooks/, shared/
            {
              from: 'feature',
              allow: [
                ['feature', { featureName: '${from.featureName}' }],
                ['feature', { featureName: '!${from.featureName}' }],
                'lib',
                'hooks',
                'shared',
              ],
            },
            // Shared components can import from: lib, hooks
            {
              from: 'shared',
              allow: ['lib', 'hooks'],
            },
            // Layout components: features (via barrel), shared, lib, hooks
            {
              from: 'layout',
              allow: ['feature', 'shared', 'lib', 'hooks'],
            },
            // Lib can import from other lib
            {
              from: 'lib',
              allow: ['lib'],
            },
            // Hooks can import from lib and other hooks
            {
              from: 'hooks',
              allow: ['lib', 'hooks'],
            },
            // Pages can import from everything
            {
              from: 'pages',
              allow: ['feature', 'shared', 'lib', 'hooks', 'layout'],
            },
            // Router can import from pages, lib
            {
              from: 'router',
              allow: ['pages', 'lib'],
            },
          ],
        },
      ],

      /**
       * BOUNDARY RULE: entry-point
       *
       * CRITICAL: Enforces the PUBLIC API pattern.
       * Features can only be imported via their index.ts barrel.
       *
       * ALLOWED:
       *   import { ChatArea } from '@/features/chat'
       *
       * FORBIDDEN (BUILD FAIL):
       *   import { ChatArea } from '@/features/chat/chat-area'
       */
      'boundaries/entry-point': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              target: 'feature',
              allow: 'index.(ts|tsx)',
            },
          ],
        },
      ],
    },
  },
)
