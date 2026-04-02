/**
 * Build-time metadata injected by Vite's `define` in vite.config.ts.
 * Used by the About page to show version and commit SHA.
 */

declare const __APP_VERSION__: string
declare const __COMMIT_SHA__: string

export const buildInfo = {
  version: __APP_VERSION__,
  commitSha: __COMMIT_SHA__,
} as const
