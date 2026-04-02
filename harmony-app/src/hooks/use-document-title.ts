import { useEffect } from 'react'
import { useTotalUnread } from '@/features/channels'

const BASE_TITLE = 'Harmony'

/**
 * Sets the browser/Tauri window title to reflect total unread count.
 *
 * WHY: Users switching to another browser tab or minimizing the desktop app
 * need a visual cue that new messages arrived. `(N) Harmony` in the tab title
 * is the standard pattern (Slack, Discord, Gmail all do this).
 */
export function useDocumentTitle(): void {
  const totalUnread = useTotalUnread()

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [totalUnread])
}
