# ADR-047: Server-Persisted User Preferences (DND, Hide Profanity)

**Status:** Accepted
**Date:** 2026-07-07

## Context

Harmony needs per-user, cross-device settings that change runtime behavior:

- **Do Not Disturb (DND):** suppress notification sounds and desktop
  notifications, and lock the user's presence status to `dnd`.
- **Hide Profanity:** client-side masking of profanity in rendered messages.

`localStorage` was rejected: preferences must survive reinstalls and follow
the user across the web app and the Tauri desktop app. Putting the flags on
`profiles` was rejected too — profile rows are visible to other members,
while preferences are private to their owner.

The notification stack already has per-channel granularity
(`notification_settings`, level `all | mentions | none`). Preferences are the
**global** layer above it: DND overrides everything for the whole account.

## Decision

### Storage: dedicated `user_preferences` table, RLS-owned

Migration `20260402120000_create_user_preferences.sql` (+
`20260402130000_add_hide_profanity_preference.sql`):

- PK `user_id` referencing `profiles(id) ON DELETE CASCADE` — at most one row
  per user.
- `dnd_enabled BOOLEAN NOT NULL DEFAULT false`,
  `hide_profanity BOOLEAN NOT NULL DEFAULT true`.
- RLS: owner-only `SELECT` and `ALL` policies (`user_id = auth.uid()`),
  created idempotently (ADR-019, ADR-040).

### API: GET/PATCH `/v1/preferences`, defaults without a row

- `GET /v1/preferences` → 200 `UserPreferencesResponse`. When no row exists,
  the service returns defaults (`dndEnabled: false`, `hideProfanity: true`) —
  a user who never touched preferences never needs an INSERT.
- `PATCH /v1/preferences` → **204 No Content**. The request DTO
  (`UpdateUserPreferencesRequest`) has all-optional fields; the repository
  UPSERTs with `COALESCE` so a partial patch (`{ dndEnabled: true }`) never
  clobbers other fields.
- Hexagonal layering as everywhere else: `UserPreferences` model,
  `UserPreferencesRepository` port, `PgUserPreferencesRepository` adapter,
  `UserPreferencesService` (`harmony-api/src/domain/services/user_preferences_service.rs`).

### Frontend: TanStack Query cache is the runtime SSoT

- `usePreferences()` (`features/preferences/hooks/use-preferences.ts`) reads
  `queryKeys.preferences.me()`. Every consumer reads this one cache entry —
  no Zustand mirror, no prop drilling (ADR-045: never shadow server state).
- `useUpdatePreferences()` PATCHes optimistically: `onMutate` writes the
  patch into the cache, `onError` rolls back (defaulting to
  `{ dndEnabled: false, hideProfanity: true }` when no previous entry
  exists) and toasts. **No `invalidateQueries` in `onSettled`** — the server
  returns 204 with no body, and v1 has no SSE echo to reconcile against, so
  the optimistic write is final.

### Behavior contract for DND

| Consumer | Behavior when `dndEnabled === true` |
|----------|-------------------------------------|
| `use-notification-sound.ts` | `shouldSuppressSound` returns true before any other check — no sounds. |
| `use-desktop-notifications.ts` | `shouldSuppressNotification` returns true first — no native notifications. |
| `use-presence.ts` | Posts `dnd` presence; activity/visibility handlers and the idle interval become no-ops until DND is turned off. |
| `status-picker.tsx` | Shows the red DND state on the user's own avatar area. |

Turning DND **off** restores status from real activity: if
`Date.now() - lastActivity >= IDLE_TIMEOUT_MS` the user comes back as `idle`,
not `online` — an AFK user must not look available just because they flipped
a switch.

**Loading semantics differ by risk:**

- Notification hooks treat a still-loading query (`data === undefined`) as
  DND off. Worst case is one extra sound during the first hundred
  milliseconds after boot — acceptable.
- `use-presence.ts` gates on `!preferences.isPending` before posting any
  status. Without the gate, a premature `online` POST is broadcast to all
  peers before the corrective `dnd` arrives — a user-visible flicker of the
  wrong status.

Unread badges and counts are intentionally **not** affected by DND: the user
still wants to see what they missed, they just do not want to be interrupted.

### Precedence

```
DND (global, user_preferences)          — checked first, suppresses everything
  └─ per-channel notification_settings  — level 'none' mutes one channel
       └─ baseline guards               — system msg, own msg, active channel,
                                          focus (desktop), cooldowns
```

## Consequences

**Positive:**

- Preferences follow the account across devices and reinstalls; RLS keeps
  them private without handler-level checks.
- One cache entry drives sounds, desktop notifications, presence, and
  profanity masking — no state duplication, no ordering races between
  consumers.
- Defaults-without-a-row keeps the table small and the GET path trivial.

**Negative / accepted trade-offs:**

- **No cross-device live sync in v1.** Toggling DND on device A does not
  update an already-open device B until its next fetch (reload or SSE
  reconnect refetch). The SSE `preferences.updated` event is specced as v2
  in `dev/active/user-preferences-dnd/user-preferences-dnd-tasks.md`.
- Optimistic-final writes mean a lost PATCH (network drop after optimistic
  update) leaves the client wrong until the next GET. Accepted: the failure
  path rolls back and toasts, and preferences are low-stakes.
- Other users learn about DND only via the presence system (`dnd` status),
  never via the preferences themselves.

**Test coverage** (added with this ADR): `use-preferences.test.ts`,
`use-update-preferences.test.ts`, `use-notification-sound.test.ts`,
`use-desktop-notifications.test.ts`, `use-presence.test.ts` — covering
suppression, restore-after-toggle, AFK→idle restore, per-channel `none`
override, and optimistic update/rollback.
