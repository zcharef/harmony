import { Fragment, type ReactNode } from 'react'
import type { MentionedUserResponse } from '@/lib/api'
import { MENTION_MARKER_RE } from '../lib/mention-tokens'
import { MentionPill } from './mention-pill'

interface MentionTextProps {
  content: string
  mentions: MentionedUserResponse[] | undefined
  serverId: string | null
}

/**
 * Renderer for decrypted E2EE plaintext: splits on the mention marker grammar
 * and renders `<MentionPill/>` segments inline.
 *
 * WHY no markdown: encrypted messages render as plain spans today
 * (encrypted-message-content.tsx) — this only adds pill rendering, keeping
 * the same text styling.
 */
export function MentionText({ content, mentions, serverId }: MentionTextProps) {
  const parts = content.split(MENTION_MARKER_RE)
  if (parts.length === 1) {
    return <span className="text-sm text-foreground/90">{content}</span>
  }

  // WHY offset-based keys: segments have no intrinsic identity; the character
  // offset in the source string is deterministic and unique per segment.
  let offset = 0
  const segments: ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === undefined) continue
    // WHY odd indices: split on a regex with one capture group interleaves
    // [text, uuid, text, uuid, ..., text].
    if (i % 2 === 1) {
      segments.push(
        <MentionPill key={offset} userId={part} mentions={mentions} serverId={serverId} />,
      )
      // WHY +3: the marker's `<@` prefix and `>` suffix around the UUID.
      offset += part.length + 3
    } else {
      if (part.length > 0) {
        segments.push(<Fragment key={offset}>{part}</Fragment>)
      }
      offset += part.length
    }
  }

  return <span className="text-sm text-foreground/90">{segments}</span>
}
