/**
 * Custom-emoji token helpers: `:name:` parsing, the O(1) resolution map, and
 * the emoji-mart `custom` category shape. Pure — no React, no DOM.
 */

import type { EmojiResponse } from '@/lib/api'

/**
 * Canonical inline-token pattern. `name` is `^[a-z0-9_]{2,32}$` (same class the
 * API enforces). Global + capturing so a text walker can split on every match.
 */
export const CUSTOM_EMOJI_TOKEN_RE = /:([a-z0-9_]{2,32}):/g

/** Wrap a bare name into its `:name:` token form. */
export function toEmojiToken(name: string): string {
  return `:${name}:`
}

/** Match a whole string as exactly one `:name:` token → the inner name, or null. */
export function parseEmojiToken(value: string): string | null {
  const match = /^:([a-z0-9_]{2,32}):$/.exec(value)
  return match?.[1] ?? null
}

/** Build the O(1) name → emoji map used by the render sites. */
export function buildEmojiMap(emojis: ReadonlyArray<EmojiResponse>): Map<string, EmojiResponse> {
  return new Map(emojis.map((e) => [e.name, e]))
}

/** One emoji-mart custom emoji entry. */
interface CustomEmojiMartEntry {
  id: string
  name: string
  keywords: Array<string>
  skins: Array<{ src: string }>
}

/** One emoji-mart custom category (the shape `<Picker custom={...} />` expects). */
export interface CustomEmojiMartCategory {
  id: string
  name: string
  emojis: Array<CustomEmojiMartEntry>
}

/**
 * Build the emoji-mart `custom` prop from a server's emoji. Returns `[]` when
 * the server has none, so the Custom category is simply absent from the picker
 * (empty-state parity, §1).
 */
export function buildCustomCategory(
  emojis: ReadonlyArray<EmojiResponse>,
): Array<CustomEmojiMartCategory> {
  if (emojis.length === 0) return []
  return [
    {
      id: 'server',
      name: 'Server',
      emojis: emojis.map((e) => ({
        id: e.name,
        name: e.name,
        keywords: [e.name],
        skins: [{ src: e.url }],
      })),
    },
  ]
}
