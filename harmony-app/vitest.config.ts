import path from 'node:path'
import { defineConfig } from 'vitest/config'

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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'src-tauri'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
