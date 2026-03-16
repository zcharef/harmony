/**
 * API Client Runtime Configuration
 *
 * WHY: This file is the bridge between the generated OpenAPI client (SSoT from Rust)
 * and our runtime environment (base URL, credentials). The generated `client.gen.ts`
 * imports `createClientConfig` from here to initialize the client with correct values.
 *
 * Do NOT import from `./api/client.gen` here — it would create a circular dependency.
 *
 * NOTE: The import below will resolve after running `just gen-api` to generate
 * the API client from the Rust API's OpenAPI spec.
 */

// TODO: Uncomment after first `just gen-api` run generates src/lib/api/
// import { env } from '@/lib/env'
// import type { CreateClientConfig } from './api/client'
//
// export const createClientConfig: CreateClientConfig = (config) => ({
//   ...config,
//   baseUrl: env.VITE_API_URL,
// })
