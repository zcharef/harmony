import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Vitest configuration for architecture tests only.
 * Run with: just test-arch
 *
 * These tests validate structural rules that cannot be enforced by ESLint:
 * - Feature barrel exports (index.ts presence)
 * - File naming conventions
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/arch/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src-tauri'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
