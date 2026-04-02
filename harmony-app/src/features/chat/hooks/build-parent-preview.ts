import type { InfiniteData } from '@tanstack/react-query'
import type { MessageListResponse, MessageResponse } from '@/lib/api'

/**
 * WHY: The SSE payload only carries parentMessageId (a UUID), not the full
 * parentMessage preview that the REST API returns via SQL JOIN. Without this,
 * the ParentQuote component sees parentMessage=undefined and renders nothing
 * until the next full fetch. This builds the preview from the cached messages.
 */
export function buildParentPreview(
  data: InfiniteData<MessageListResponse>,
  parentId: string,
): MessageResponse['parentMessage'] {
  for (const page of data.pages) {
    const found = page.items.find((m) => m.id === parentId)
    if (found) {
      const isDeleted = found.deletedBy !== undefined && found.deletedBy !== null
      return {
        id: found.id,
        authorUsername: isDeleted ? '' : found.authorUsername,
        contentPreview: isDeleted ? '' : (found.content?.slice(0, 100) ?? ''),
        deleted: isDeleted,
      }
    }
  }
}
