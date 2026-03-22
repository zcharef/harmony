/**
 * Crypto lifecycle provider — bootstraps E2EE after auth is ready.
 *
 * WHY separate from AuthProvider: Keeps Tauri-specific E2EE logic isolated
 * from the core auth lifecycle. AuthProvider manages Supabase sessions;
 * CryptoProvider manages vodozemac Olm sessions. Separation means the
 * auth flow is unchanged on web (no Tauri imports leak into auth-provider.tsx).
 *
 * Must be rendered inside AuthProvider so useAuthStore has a valid user.
 * Follows the same provider-wraps-children pattern as AuthProvider
 * (src/features/auth/auth-provider.tsx:38-74).
 */

import type { ReactNode } from 'react'
import { useCryptoInit } from './hooks/use-crypto-init'
import { useKeyReplenishment } from './hooks/use-key-replenishment'

export function CryptoProvider({ children }: { children: ReactNode }) {
  // WHY: Both hooks are no-ops on web (isTauri() guard inside each).
  useCryptoInit()
  useKeyReplenishment()

  return children
}
