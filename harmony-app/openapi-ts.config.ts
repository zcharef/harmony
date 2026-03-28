import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  // SSoT: static spec exported from Rust utoipa structs (via `just export-openapi` in harmony-api)
  input: '../harmony-api/openapi.json',
  output: 'src/lib/api',
  plugins: [
    '@hey-api/typescript', // Types from OpenAPI schemas
    '@hey-api/sdk', // Type-safe SDK functions
    'zod', // Zod schemas from OpenAPI definitions (generates zod.gen.ts)
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: '../api-client',
    },
  ],
})
