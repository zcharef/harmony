/**
 * API Client Runtime Configuration
 *
 * WHY: This file is the bridge between the generated OpenAPI client (SSoT from Rust)
 * and our runtime environment (base URL, credentials). The generated `client.gen.ts`
 * imports `createClientConfig` from here to initialize the client with correct values.
 *
 * Do NOT import from `./api/client.gen` here — it would create a circular dependency.
 */

import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'
import type { CreateClientConfig } from './api/client.gen'

/** @public Consumed by generated client.gen.ts (gitignored, invisible to knip). */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: env.VITE_API_URL,
  // WHY: Every API request needs the Supabase JWT for backend auth verification.
  // The @hey-api client calls this before each request to get a fresh token.
  auth: async () => {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token
  },
})
