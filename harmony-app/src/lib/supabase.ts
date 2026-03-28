import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * Supabase client — used ONLY for Auth and Realtime.
 *
 * WHY: All data CRUD goes through the Rust REST API (OpenAPI SSoT).
 * Supabase JS is used exclusively for:
 * - Auth (login, signup, session management)
 * - Realtime (live messages, typing indicators, presence)
 * - Storage (avatars, file uploads)
 */
export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
