import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Supabase client — used ONLY for Auth and Storage.
 *
 * WHY: All data CRUD goes through the Rust REST API (OpenAPI SSoT).
 * Realtime is handled by the Rust SSE endpoint (GET /v1/events).
 * Supabase JS is used exclusively for:
 * - Auth (login, signup, session management, token refresh)
 * - Storage (avatars, file uploads)
 */
export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
