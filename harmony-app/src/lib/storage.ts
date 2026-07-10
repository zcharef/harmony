import { logger } from '@/lib/logger'

/**
 * Safe localStorage helpers.
 *
 * WHY lifted from main-layout.tsx: the notifications feature needs the same
 * quota/denied-safe read/write for its permission-banner dismissal flag, and
 * importing from components/layout would create an import cycle (MainLayout
 * imports the notifications barrel). One pattern per concern — no parallel
 * helper implementations.
 */

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch (err: unknown) {
    logger.warn('write_storage_failed', {
      key,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
