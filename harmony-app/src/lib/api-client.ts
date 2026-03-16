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
import type { CreateClientConfig } from './api/client.gen'

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: env.VITE_API_URL,
})
