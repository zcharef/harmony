/**
 * Canonical `<@uuid>` mention-marker grammar (mentions spec §1).
 *
 * This is the wire format the backend emits — it mirrors the scanner in
 * harmony-api/src/domain/services/spam_guard.rs (`extract_mentions`). It lives
 * in `lib/` (not a feature) because both chat rendering and the search preview
 * parse it, and the format must have exactly ONE definition so the two can
 * never drift (e.g. if a role-mention marker is ever added).
 */

/**
 * The §1 marker grammar: `<@` + lowercase-hex UUID + `>`. Capture group 1 = the
 * UUID.
 *
 * WHY no exec/test on this shared instance: it carries the `g` flag, and
 * exec/test mutate `lastIndex`. Consumers use split/matchAll/replace only
 * (all three reset `lastIndex`, leaving this instance stateless).
 */
export const MENTION_MARKER_RE =
  /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g

/**
 * Replace every `<@uuid>` marker in `content` with the string `resolve` returns
 * for its id. The resolver receives the raw marker too, so a consumer that
 * can't resolve an id may return it unchanged (round-trip safe). Name resolution
 * stays at the call site — the edit buffer renders `@username`, the search
 * preview renders `@displayName` — but the marker grammar is shared here.
 */
export function replaceMentionMarkers(
  content: string,
  resolve: (userId: string, marker: string) => string,
): string {
  return content.replace(MENTION_MARKER_RE, (marker: string, userId: string) =>
    resolve(userId, marker),
  )
}
