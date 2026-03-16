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
