/**
 * Whether a DM recipient can receive E2EE — i.e. has at least one registered device.
 *
 * WHY: Desktop forces E2EE for DMs, but web-only users never register device keys
 * (device registration is desktop-only, see use-crypto-init.ts). Encrypting to a
 * keyless recipient is impossible — `getPreKeyBundle` 404s server-side — AND pointless,
 * since a web-only user could not decrypt it anyway. This hook lets the DM send gate
 * fall back to plaintext for keyless recipients (exactly as web↔web DMs already do)
 * instead of forcing E2EE and failing closed.
 *
 * CONFIDENTIALITY-SAFE TRI-STATE:
 *   - `true`      → recipient has ≥1 device: keep E2EE (never downgrade).
 *   - `false`     → recipient CONFIRMED keyless (0 devices): send plaintext + disclose.
 *   - `undefined` → unknown (query loading or errored / web / no recipient): treat as
 *                   encryptable so a transient failure NEVER silently downgrades a
 *                   key-holding recipient to plaintext.
 */

import { useQuery } from '@tanstack/react-query'
import { listDevices } from '@/lib/api'
import { isTauri } from '@/lib/platform'
import { queryKeys } from '@/lib/query-keys'

// WHY 5 min: device registration is rare (once per device install), so the
// recipient's device set is effectively static for the lifetime of a DM view.
const DEVICES_STALE_TIME_MS = 5 * 60 * 1000

export function useRecipientEncryptable(recipientUserId: string | null): boolean | undefined {
  // WHY isTauri gate: web never encrypts DMs (plaintext by design), so the
  // capability probe is desktop-only — avoids a needless request on the web app.
  const enabled = isTauri() && recipientUserId !== null

  const { data, isSuccess } = useQuery({
    queryKey: queryKeys.crypto.devices(recipientUserId ?? ''),
    queryFn: async () => {
      // WHY the guard: `enabled` already prevents this running with a null id;
      // the explicit narrow keeps the call type-safe without a non-null assertion.
      if (recipientUserId === null) throw new Error('recipientUserId required')
      const { data } = await listDevices({
        path: { user_id: recipientUserId },
        throwOnError: true,
      })
      return data
    },
    enabled,
    staleTime: DEVICES_STALE_TIME_MS,
  })

  // WHY only on success: loading/error stays `undefined` (unknown) so we never
  // downgrade a recipient who might hold keys — only a confirmed empty device
  // list flips this to `false`.
  if (!isSuccess) return undefined
  return data.items.length > 0
}
