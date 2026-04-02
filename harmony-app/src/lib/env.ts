import { z } from 'zod'

/**
 * Environment variable validation — Single Source of Truth.
 *
 * WHY: Unlike Next.js `@t3-oss/env-nextjs`, Vite exposes env vars via `import.meta.env`.
 * We validate them once at startup with Zod to fail fast on misconfiguration.
 *
 * All client-exposed vars must be prefixed with VITE_ (Vite convention).
 */

const envSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
  // WHY: Optional — self-hosted instances may omit Turnstile entirely.
  // When unset, the login form skips the widget and pre-fills a bypass token.
  VITE_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  // WHY: Desktop auth opens the web login page in the system browser.
  // In production: https://app.joinharmony.app — in dev: http://localhost:1420
  VITE_WEB_APP_URL: z.string().url().optional(),
  VITE_SENTRY_DSN: z.string().url().optional(),
  VITE_OFFICIAL_SERVER_ID: z.string().uuid().optional(),
})

function validateEnv() {
  const parsed = envSchema.safeParse(import.meta.env)

  if (!parsed.success) {
    // WHY: throw directly instead of console.error — this runs before Sentry/logger
    // are initialized, and crash-at-startup is the correct fail-fast behavior (ADR-042)
    throw new Error(
      `Invalid environment variables: ${JSON.stringify(parsed.error.flatten().fieldErrors)}. Check .env file.`,
    )
  }

  return parsed.data
}

export const env = validateEnv()
