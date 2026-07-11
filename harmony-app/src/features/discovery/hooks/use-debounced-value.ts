import { useEffect, useState } from 'react'

/**
 * Returns a debounced copy of `value` that only updates after `delayMs` of
 * quiet time. Mirrors `use-debounced-value.ts` in the chat feature (feature
 * hooks stay colocated — CLAUDE.md §1.1) so typing in the directory search
 * does not fire a request per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
