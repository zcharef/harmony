import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

// WHY: Inject version + commit SHA at build time for the About page.
// try/catch: build may run outside a git repo (CI archive, Docker tarball).
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
let commitSha = 'unknown'
try {
  commitSha = execSync('git rev-parse --short HEAD').toString().trim()
} catch {}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
  css: {
    // Disable PostCSS — @tailwindcss/vite handles CSS processing directly.
    // Without this, Vite's built-in PostCSS picks up tailwindcss@3 (a transitive
    // dep of HeroUI) and conflicts with our Tailwind v4 CSS-first config.
    postcss: {},
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}))
