import { useState } from 'react'

/**
 * State buffer for the message edit textarea.
 *
 * WHY: Seeding `useState(message.content)` once at mount creates a stale
 * shadow of realtime data (ADR-045) — if the message is edited via SSE or
 * AutoMod between mount and the user opening the editor, the textarea would
 * show outdated content. The buffer is therefore (re)seeded from the CURRENT
 * content on every editing false→true transition.
 *
 * While the editor is OPEN, remote content changes deliberately do NOT
 * clobber the buffer — the user's draft is the source of truth (ADR-045
 * form-input exception).
 */
export function useEditBuffer(content: string, isEditing: boolean) {
  // WHY: AutoMod stores `\*` (markdown-escaped asterisks) in the DB so
  // ReactMarkdown renders literal `*`. The edit textarea is plain text, so we
  // unescape before editing.
  const unescaped = content.replace(/\\\*/g, '*')

  const [editContent, setEditContent] = useState(unescaped)

  // WHY render-time reset (React "adjusting state during render" pattern, not
  // useEffect): the buffer is reseeded synchronously on the editing
  // false→true transition, so the editor never paints a frame of stale content.
  const [wasEditing, setWasEditing] = useState(isEditing)
  if (isEditing !== wasEditing) {
    setWasEditing(isEditing)
    if (isEditing) {
      setEditContent(unescaped)
    }
  }

  return { editContent, setEditContent }
}
