import { useEffect } from 'react'
import { useTotalMentions, useTotalUnread } from '@/features/channels'

const BASE_TITLE = 'Harmony'

/**
 * Sets the browser/Tauri window title to reflect total unread count.
 *
 * WHY: Users switching to another browser tab or minimizing the desktop app
 * need a visual cue that new messages arrived. `(N) Harmony` in the tab title
 * is the standard pattern (Slack, Discord, Gmail all do this).
 *
 * WHY `(@M)` takes precedence: pings outrank plain unreads (spec §1). The `@`
 * notation signals a meaning switch, so `(12)` → `(@1)` does not read as a
 * decreasing count.
 */
export function useDocumentTitle(): void {
  const totalUnread = useTotalUnread()
  const totalMentions = useTotalMentions()

  useEffect(() => {
    if (totalMentions > 0) {
      document.title = `(@${totalMentions}) ${BASE_TITLE}`
    } else if (totalUnread > 0) {
      document.title = `(${totalUnread}) ${BASE_TITLE}`
    } else {
      document.title = BASE_TITLE
    }
    return () => {
      document.title = BASE_TITLE
    }
  }, [totalUnread, totalMentions])
}
