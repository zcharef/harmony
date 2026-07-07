import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageResponse } from '@/lib/api'
// WHY: Side-effect import initializes the real i18n instance so aria-labels
// resolve to actual translations (missing keys would log via mocked logger).
import '@/lib/i18n'
import { MessageItem } from './message-item'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

// WHY: Stub the lazy emoji-mart picker — the real one is a web component that
// doesn't render in jsdom. The stub exposes a button that selects 🔥.
vi.mock('@emoji-mart/react', () => ({
  default: ({ onEmojiSelect }: { onEmojiSelect: (emoji: { native: string }) => void }) => (
    <button
      type="button"
      data-test="mock-emoji-picker"
      onClick={() => onEmojiSelect({ native: '🔥' })}
    >
      pick
    </button>
  ),
}))

vi.mock('@emoji-mart/data', () => ({ default: {} }))

vi.mock('@/features/preferences', () => ({
  usePreferences: () => ({ data: { hideProfanity: false } }),
}))

vi.mock('@/features/crypto', () => ({
  EncryptedMessageContent: () => null,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const CURRENT_USER_ID = 'user-99'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-42',
    content: 'Hello',
    authorId: 'user-42',
    authorUsername: 'test-user',
    channelId: 'channel-1',
    createdAt: '2026-01-01T00:00:00Z',
    editedAt: null,
    deletedBy: null,
    encrypted: false,
    senderDeviceId: null,
    messageType: 'default',
    ...overrides,
  }
}

function renderMessageItem(message: MessageResponse) {
  const onAddReaction = vi.fn()
  const onRemoveReaction = vi.fn()
  render(
    <MessageItem
      message={message}
      currentUserId={CURRENT_USER_ID}
      canModerateMessages={false}
      isEditing={false}
      onStartEdit={vi.fn()}
      onSaveEdit={vi.fn()}
      onCancelEdit={vi.fn()}
      onDelete={vi.fn()}
      onAddReaction={onAddReaction}
      onRemoveReaction={onRemoveReaction}
      onReply={vi.fn()}
    />,
  )
  return { onAddReaction, onRemoveReaction }
}

describe('MessageItem reactions UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('hover action bar react button', () => {
    it('renders the react button FIRST in the hover-revealed action bar', () => {
      renderMessageItem(buildMessage())

      const actions = screen.getByTestId('message-actions')
      // WHY: jsdom cannot simulate CSS :hover — assert the hover-reveal classes instead.
      expect(actions.className).toContain('hidden')
      expect(actions.className).toContain('group-hover:flex')

      const reactButton = screen.getByTestId('message-react-button')
      expect(reactButton.getAttribute('aria-label')).toBe('Add Reaction')
      // Discord order: react, reply, edit, delete.
      const firstButton = actions.querySelector('button')
      expect(firstButton).toBe(reactButton)
    })

    it('opens the picker on click and keeps the action bar visible while open', async () => {
      renderMessageItem(buildMessage())

      fireEvent.click(screen.getByTestId('message-react-button'))

      expect(await screen.findByTestId('mock-emoji-picker')).toBeDefined()
      // WHY: The bar must not disappear when the row loses hover while picking.
      const actions = screen.getByTestId('message-actions')
      expect(actions.className).toContain('flex')
      expect(actions.className).not.toContain('hidden')
    })

    it('selecting an emoji calls onAddReaction with the native emoji and closes the picker', async () => {
      const { onAddReaction, onRemoveReaction } = renderMessageItem(buildMessage())

      fireEvent.click(screen.getByTestId('message-react-button'))
      fireEvent.click(await screen.findByTestId('mock-emoji-picker'))

      expect(onAddReaction).toHaveBeenCalledExactlyOnceWith('🔥')
      expect(onRemoveReaction).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(screen.queryByTestId('mock-emoji-picker')).toBeNull()
      })
    })

    it('works on a message with ZERO reactions (no ReactionBar rendered)', async () => {
      const { onAddReaction } = renderMessageItem(buildMessage({ reactions: [] }))

      // No bar, no "+" pill — but the hover react button still starts a reaction.
      expect(screen.queryByTestId('reaction-add-button')).toBeNull()

      fireEvent.click(screen.getByTestId('message-react-button'))
      fireEvent.click(await screen.findByTestId('mock-emoji-picker'))

      expect(onAddReaction).toHaveBeenCalledExactlyOnceWith('🔥')
    })
  })

  describe('ReactionBar "+" pill', () => {
    it('renders the pill after existing reaction pills and opens the same picker', async () => {
      const { onAddReaction } = renderMessageItem(
        buildMessage({ reactions: [{ emoji: '👍', count: 2, reactedByMe: false }] }),
      )

      const pill = screen.getByTestId('reaction-add-button')
      expect(pill.getAttribute('aria-label')).toBe('Add Reaction')

      fireEvent.click(pill)
      fireEvent.click(await screen.findByTestId('mock-emoji-picker'))

      expect(onAddReaction).toHaveBeenCalledExactlyOnceWith('🔥')
    })

    it('does not render the pill on deleted messages', () => {
      renderMessageItem(
        buildMessage({
          deletedBy: 'user-42',
          reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
        }),
      )

      expect(screen.queryByTestId('reaction-add-button')).toBeNull()
    })

    it('preserves the existing pile-on toggle behavior', () => {
      const { onAddReaction, onRemoveReaction } = renderMessageItem(
        buildMessage({
          reactions: [
            { emoji: '👍', count: 2, reactedByMe: true },
            { emoji: '🎉', count: 1, reactedByMe: false },
          ],
        }),
      )

      const thumbsPill = screen.getByText('👍').closest('button')
      const partyPill = screen.getByText('🎉').closest('button')
      if (thumbsPill === null || partyPill === null) throw new Error('reaction pills not found')

      fireEvent.click(thumbsPill)
      expect(onRemoveReaction).toHaveBeenCalledExactlyOnceWith('👍')

      fireEvent.click(partyPill)
      expect(onAddReaction).toHaveBeenCalledExactlyOnceWith('🎉')
    })
  })
})
