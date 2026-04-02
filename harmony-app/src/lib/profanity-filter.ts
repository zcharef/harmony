/**
 * Client-side profanity filter.
 *
 * WHY: Masks mild profanity (damn, hell, shit, fuck) locally before rendering.
 * Unlike server-side AutoMod (abuse/slurs), this is user-togglable via preferences.
 * The original message is never modified in the DB — masking is display-only.
 */

import profanityWords from './profanity-words.json'

const PROFANITY_SET: ReadonlySet<string> = new Set(profanityWords as string[])

/**
 * Replace profanity words with `\*` (markdown-safe asterisks) of the same length.
 * Tokenizes on unicode word boundaries so "class" won't match "ass".
 * WHY `\p{L}\p{N}`: `\w` only matches ASCII — misses accented/non-Latin profanity.
 */
export function maskProfanity(text: string): string {
  return text.replace(/([\p{L}\p{N}]+)/gu, (match) => {
    if (PROFANITY_SET.has(match.toLowerCase())) {
      return '\\*'.repeat(match.length)
    }
    return match
  })
}
