import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// WHY: framer-motion is a *transitive* dependency (pulled in by HeroUI), so the
// bare "framer-motion" specifier is not resolvable from app code. That makes
// vi.mock('framer-motion') a silent no-op — it never matches HeroUI's own
// imports. We resolve the module through @heroui/react (which declares it as a
// peer) and alias the bare specifier to that exact ESM entry, so HeroUI and the
// test mock share one instance and the mock in vitest.setup.ts actually applies.
const nodeRequire = createRequire(import.meta.url)
const framerMotionPkgJson = createRequire(
  nodeRequire.resolve('@heroui/react/package.json'),
).resolve('framer-motion/package.json')
const framerMotionEntry = path.join(
  path.dirname(framerMotionPkgJson),
  nodeRequire(framerMotionPkgJson).module,
)

export default defineConfig({
  // WHY: Vitest needs dummy VITE_* env vars because module imports chain
  // through src/lib/env.ts which validates them at startup. Without these,
  // any test that transitively imports @/lib/api will crash.
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify('http://localhost:3000'),
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://localhost:54321'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // WHY functions/**: Cloudflare Pages Functions (OG injection) live outside
    // src/ but their pure logic is unit-tested with the same runner.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'functions/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src-tauri'],
    server: {
      deps: {
        // WHY: node_modules are externalized (native import) by default, which
        // bypasses vi.mock. HeroUI (accordion/calendar/modal/navbar/popover/
        // ripple/toast/tooltip) loads framer-motion's <LazyMotion> features via
        // `() => import('@heroui/dom-animation')`; inlining the whole HeroUI ->
        // framer-motion chain routes those imports through Vitest's runner so
        // the LazyMotion mock in vitest.setup.ts applies and the async import is
        // eliminated (see the note there).
        inline: [/@heroui\//, 'framer-motion'],
      },
    },
  },
  resolve: {
    // WHY array form: the framer-motion entry is an exact match (must not touch
    // hypothetical subpath imports), while "@" stays a prefix alias.
    alias: [
      { find: /^framer-motion$/, replacement: framerMotionEntry },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
})
