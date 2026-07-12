import type { QueryClient } from '@tanstack/react-query'
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import type { MemberListResponse, MentionedUserResponse, MessageResponse } from '@/lib/api'
// WHY: Side-effect import initializes the real i18n instance so aria-labels
// resolve to actual translations (missing keys would log via mocked logger).
import '@/lib/i18n'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { MessageItem, ReactionTooltipContent } from './message-item'

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
    mentions: [],
    attachments: [],
    embeds: [],
    isPinned: false,
    ...overrides,
  }
}

function renderMessageItem(
  message: MessageResponse,
  options: {
    serverId?: string | null
    queryClient?: QueryClient
    canModerateMessages?: boolean
    onTogglePin?: () => void
  } = {},
) {
  const onAddReaction = vi.fn()
  const onRemoveReaction = vi.fn()
  const queryClient = options.queryClient ?? createTestQueryClient()
  // WHY seed an empty official set by default: MessageHeader calls
  // useOfficialBadges; without a cache entry it would fire a real (rejecting)
  // request whose async settle re-renders the row and destabilizes the
  // timing-sensitive picker tests. Tests that need holders pass their own client.
  if (queryClient.getQueryData(queryKeys.badges.official()) === undefined) {
    queryClient.setQueryData(queryKeys.badges.official(), { userIds: [] })
  }
  // WHY wrapper: MentionPill subscribes to the members cache via useQuery,
  // which requires a QueryClientProvider even when the cache is empty.
  const Wrapper = createQueryWrapper(queryClient)
  const utils = render(
    <Wrapper>
      <MessageItem
        message={message}
        currentUserId={CURRENT_USER_ID}
        serverId={options.serverId ?? null}
        canModerateMessages={options.canModerateMessages ?? false}
        isEditing={false}
        onStartEdit={vi.fn()}
        onSaveEdit={vi.fn()}
        onCancelEdit={vi.fn()}
        onDelete={vi.fn()}
        onTogglePin={options.onTogglePin}
        onAddReaction={onAddReaction}
        onRemoveReaction={onRemoveReaction}
        onReply={vi.fn()}
      />
    </Wrapper>,
  )
  return { onAddReaction, onRemoveReaction, queryClient, ...utils }
}

describe('MessageItem identity rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the author display name over the raw username', () => {
    renderMessageItem(buildMessage({ authorUsername: 'jsmith', authorDisplayName: 'John Smith' }))

    expect(screen.getByTestId('message-author').textContent).toBe('John Smith')
  })

  it('falls back to the username when the display name is null', () => {
    renderMessageItem(buildMessage({ authorUsername: 'jsmith', authorDisplayName: null }))

    expect(screen.getByTestId('message-author').textContent).toBe('jsmith')
  })

  it('treats an empty-string display name as absent and shows the username', () => {
    renderMessageItem(buildMessage({ authorUsername: 'jsmith', authorDisplayName: '' }))

    expect(screen.getByTestId('message-author').textContent).toBe('jsmith')
  })

  it('passes the author avatar URL to the Avatar img', () => {
    const { container } = renderMessageItem(
      buildMessage({ authorAvatarUrl: 'https://cdn.example.com/a.webp' }),
    )

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/a.webp')
  })

  it('renders initials only (no img) when the author has no avatar', () => {
    const { container } = renderMessageItem(buildMessage({ authorAvatarUrl: null }))

    // WHY: HeroUI Avatar only renders <img> when `src` is truthy — its absence
    // proves the initials fallback is active.
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('message-author').textContent).toBe('test-user')
  })
})

// ── Mentions (wave 3) ─────────────────────────────────────────────────

const MENTION_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SERVER_ID = 'server-1'

function buildMention(overrides: Partial<MentionedUserResponse> = {}): MentionedUserResponse {
  return {
    userId: MENTION_UUID,
    username: 'alice',
    displayName: 'Alice Doe',
    nickname: null,
    ...overrides,
  }
}

function buildMemberList(): MemberListResponse {
  return {
    items: [
      {
        userId: MENTION_UUID,
        username: 'alice',
        displayName: 'Cache Alice',
        nickname: null,
        role: 'member',
        isFounding: false,
        joinedAt: '2026-01-01T00:00:00Z',
      },
    ],
    nextCursor: null,
  }
}

describe('MessageItem mention rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a marker as a resolved pill from message.mentions (survives rehype-sanitize)', () => {
    renderMessageItem(
      buildMessage({
        content: `hey <@${MENTION_UUID}> hello`,
        mentions: [buildMention()],
      }),
    )

    const pill = screen.getByTestId('mention-pill')
    expect(pill.textContent).toBe('@Alice Doe')
    expect(pill.getAttribute('data-mention-user-id')).toBe(MENTION_UUID)
    // WHY: The pill renders through the full markdown pipeline — its survival
    // proves the sanitizer schema allowlists data-mention-id.
    expect(screen.getByTestId('message-content').textContent).toBe('hey @Alice Doe hello')
  })

  it('prefers the nickname tier over displayName and username', () => {
    renderMessageItem(
      buildMessage({
        content: `<@${MENTION_UUID}>`,
        mentions: [buildMention({ nickname: 'Ali' })],
      }),
    )

    expect(screen.getByTestId('mention-pill').textContent).toBe('@Ali')
  })

  it('mentions array beats the members cache (resolution order)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_ID), buildMemberList())

    renderMessageItem(buildMessage({ content: `<@${MENTION_UUID}>`, mentions: [buildMention()] }), {
      serverId: SERVER_ID,
      queryClient,
    })

    expect(screen.getByTestId('mention-pill').textContent).toBe('@Alice Doe')
  })

  it('falls back to the members cache when the mentions array misses the id', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.members(SERVER_ID), buildMemberList())

    renderMessageItem(buildMessage({ content: `<@${MENTION_UUID}>`, mentions: [] }), {
      serverId: SERVER_ID,
      queryClient,
    })

    expect(screen.getByTestId('mention-pill').textContent).toBe('@Cache Alice')
  })

  it('renders a muted @unknown-user pill when no source resolves the id', () => {
    renderMessageItem(buildMessage({ content: `<@${MENTION_UUID}>`, mentions: [] }))

    const pill = screen.getByTestId('mention-pill')
    expect(pill.textContent).toBe('@unknown-user')
    expect(pill.getAttribute('data-test-unknown')).toBe('true')
  })

  it('re-resolves the pill live when the members cache fills later (no refresh)', async () => {
    const queryClient = createTestQueryClient()
    renderMessageItem(buildMessage({ content: `<@${MENTION_UUID}>`, mentions: [] }), {
      serverId: SERVER_ID,
      queryClient,
    })
    expect(screen.getByTestId('mention-pill').textContent).toBe('@unknown-user')

    act(() => {
      queryClient.setQueryData(queryKeys.servers.members(SERVER_ID), buildMemberList())
    })

    await waitFor(() => {
      expect(screen.getByTestId('mention-pill').textContent).toBe('@Cache Alice')
    })
  })

  it('leaves invalid markers as plain text (no pill, no crash)', () => {
    renderMessageItem(buildMessage({ content: '<@everyone> and <@not-a-uuid>', mentions: [] }))

    expect(screen.queryByTestId('mention-pill')).toBeNull()
    expect(screen.getByTestId('message-content').textContent).toContain('<@everyone>')
  })

  it('tints the row when the server-validated mentions include me', () => {
    renderMessageItem(
      buildMessage({
        content: `<@${CURRENT_USER_ID}>`,
        mentions: [buildMention({ userId: CURRENT_USER_ID, username: 'me' })],
      }),
    )

    const row = screen.getByTestId('message-item')
    expect(row.getAttribute('data-test-mentions-me')).toBe('true')
    expect(row.className).toContain('bg-warning/10')
    expect(row.className).toContain('border-warning')
  })

  it('does NOT tint the row for mentions of someone else', () => {
    renderMessageItem(buildMessage({ content: `<@${MENTION_UUID}>`, mentions: [buildMention()] }))

    const row = screen.getByTestId('message-item')
    expect(row.getAttribute('data-test-mentions-me')).toBeNull()
    expect(row.className).not.toContain('bg-warning/10')
  })

  it('derives the tint from the mentions field even when no marker renders (E2EE ghost ping)', () => {
    renderMessageItem(
      buildMessage({
        content: 'no marker in the visible text',
        mentions: [buildMention({ userId: CURRENT_USER_ID, username: 'me' })],
      }),
    )

    expect(screen.getByTestId('message-item').getAttribute('data-test-mentions-me')).toBe('true')
  })
})

describe('MessageItem custom-emoji rendering', () => {
  const BUCKET_URL =
    'http://127.0.0.1:64321/storage/v1/object/public/server-emojis/server-1/party.png'

  function seedEmoji(name: string, url: string) {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.servers.emojis(SERVER_ID), {
      items: [
        {
          id: 'emoji-1',
          name,
          url,
          moderationStatus: 'approved',
          isAnimated: false,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    })
    return queryClient
  }

  // WHY this test renders through the REAL react-markdown/unified pipeline
  // (not by calling the remark transformer directly): the plugin is registered
  // via the [plugin, options] tuple, and a prior regression passed the
  // already-called transformer, which unified silently dropped as a no-op.
  // Only a full-pipeline render catches that — unit-calling the transformer
  // would pass either way.
  it('renders a resolvable :name: token as an inline emoji image', () => {
    const queryClient = seedEmoji('party', BUCKET_URL)

    renderMessageItem(buildMessage({ content: 'gg :party: everyone' }), {
      serverId: SERVER_ID,
      queryClient,
    })

    const img = screen.getByTestId('inline-custom-emoji')
    expect(img.getAttribute('src')).toBe(BUCKET_URL)
    expect(img.getAttribute('alt')).toBe(':party:')
    // The literal token must be gone from the visible text.
    expect(screen.getByTestId('message-content').textContent).not.toContain(':party:')
  })

  it('leaves an unknown :name: token as literal text', () => {
    const queryClient = seedEmoji('party', BUCKET_URL)

    renderMessageItem(buildMessage({ content: 'what :missing: is this' }), {
      serverId: SERVER_ID,
      queryClient,
    })

    expect(screen.queryByTestId('inline-custom-emoji')).toBeNull()
    expect(screen.getByTestId('message-content').textContent).toContain(':missing:')
  })

  it('leaves a token literal when the emoji URL is not a server-emojis bucket object', () => {
    const queryClient = seedEmoji('party', 'https://evil.example.com/party.png')

    renderMessageItem(buildMessage({ content: 'gg :party:' }), {
      serverId: SERVER_ID,
      queryClient,
    })

    expect(screen.queryByTestId('inline-custom-emoji')).toBeNull()
    expect(screen.getByTestId('message-content').textContent).toContain(':party:')
  })
})

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
        buildMessage({ reactions: [{ emoji: '👍', count: 2, reactedByMe: false, reactors: [] }] }),
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
          reactions: [{ emoji: '👍', count: 1, reactedByMe: false, reactors: [] }],
        }),
      )

      expect(screen.queryByTestId('reaction-add-button')).toBeNull()
    })

    it('preserves the existing pile-on toggle behavior', () => {
      const { onAddReaction, onRemoveReaction } = renderMessageItem(
        buildMessage({
          reactions: [
            { emoji: '👍', count: 2, reactedByMe: true, reactors: [] },
            { emoji: '🎉', count: 1, reactedByMe: false, reactors: [] },
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

  // Each reaction pill is wrapped in a Tooltip trigger — the hover affordance
  // exists and is keyboard-focusable (it is a real <button>).
  it('wraps every reaction pill in a hoverable, focusable trigger', () => {
    renderMessageItem(
      buildMessage({
        reactions: [
          { emoji: '👍', count: 1, reactedByMe: false, reactors: [{ username: 'alice' }] },
          { emoji: '🎉', count: 1, reactedByMe: false, reactors: [{ username: 'bob' }] },
        ],
      }),
    )

    const pills = screen.getAllByTestId('reaction-pill')
    expect(pills).toHaveLength(2)
    // Real <button>s → focusable, so HeroUI's Tooltip opens on keyboard focus.
    for (const pill of pills) {
      expect(pill.tagName).toBe('BUTTON')
    }
  })
})

// ── "who reacted" tooltip content (T1.5) ──────────────────────────────────
//
// WHY test the content directly: HeroUI's Tooltip renders into a portal only
// after a real pointer/focus interaction that jsdom does not simulate
// faithfully. The rendering logic (names, overflow, degraded fallback) lives in
// ReactionTooltipContent, so we exercise it in isolation.
describe('ReactionTooltipContent', () => {
  function renderContent(reaction: NonNullable<MessageResponse['reactions']>[number]) {
    return render(<ReactionTooltipContent reaction={reaction} />)
  }

  it('lists reactor names, preferring displayName over username', () => {
    renderContent({
      emoji: '👍',
      count: 2,
      reactedByMe: false,
      reactors: [
        { username: 'alice', displayName: 'Alice A' },
        { username: 'bob', displayName: null },
      ],
    })

    expect(screen.getByText('Alice A, bob')).toBeTruthy()
    expect(screen.queryByText(/other/)).toBeNull()
  })

  it('appends a pluralized "+N others" when the count exceeds the reactor list', () => {
    renderContent({
      emoji: '🔥',
      count: 5,
      reactedByMe: false,
      reactors: [
        { username: 'alice', displayName: 'Alice' },
        { username: 'bob', displayName: 'Bob' },
      ],
    })

    expect(screen.getByText('Alice, Bob')).toBeTruthy()
    // 5 total - 2 named = 3 others.
    expect(screen.getByText('+3 others')).toBeTruthy()
  })

  it('uses the singular "+1 other" when exactly one reactor overflows', () => {
    renderContent({
      emoji: '🔥',
      count: 2,
      reactedByMe: false,
      reactors: [{ username: 'alice', displayName: 'Alice' }],
    })

    expect(screen.getByText('+1 other')).toBeTruthy()
  })

  it('falls back to the count-only label when reactors is empty (version skew)', () => {
    renderContent({ emoji: '🎉', count: 3, reactedByMe: false, reactors: [] })

    // Never an empty tooltip — the degraded path shows the pluralized count.
    expect(screen.getByText('3 reactions')).toBeTruthy()
  })

  it('uses the singular "reaction" label for a single degraded reactor', () => {
    renderContent({ emoji: '🎉', count: 1, reactedByMe: false, reactors: [] })

    expect(screen.getByText('1 reaction')).toBeTruthy()
  })
})

// ── Edit-mode mention round-trip (wave 4, spec §5.3) ──────────────────

function renderEditingMessageItem(message: MessageResponse) {
  const onSaveEdit = vi.fn()
  const Wrapper = createQueryWrapper(createTestQueryClient())
  const utils = render(
    <Wrapper>
      <MessageItem
        message={message}
        currentUserId={CURRENT_USER_ID}
        serverId={null}
        canModerateMessages={false}
        isEditing={true}
        onStartEdit={vi.fn()}
        onSaveEdit={onSaveEdit}
        onCancelEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </Wrapper>,
  )
  return { onSaveEdit, ...utils }
}

describe('MessageItem edit-mode mention round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('seeds the edit buffer with @username, never raw <@uuid>', () => {
    renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: `hey <@${MENTION_UUID}> hello`,
        mentions: [buildMention()],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    expect(input.value).toBe('hey @alice hello')
  })

  it('re-applies the marker on save (round-trip byte-identical)', () => {
    const { onSaveEdit } = renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: `hey <@${MENTION_UUID}> hello`,
        mentions: [buildMention()],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith(`hey <@${MENTION_UUID}> hello`)
  })

  it('preserves the mention while surrounding text is edited', () => {
    const { onSaveEdit } = renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: `hey <@${MENTION_UUID}>`,
        mentions: [buildMention()],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    fireEvent.change(input, { target: { value: 'edited @alice bye' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith(`edited <@${MENTION_UUID}> bye`)
  })

  it('round-trips markers the server never registered byte-identical (raw in buffer and save)', () => {
    const unknownUuid = '0e02b2c3-d479-4372-a567-f47ac10b58cc'
    const { onSaveEdit } = renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: `raw <@${unknownUuid}> marker`,
        mentions: [],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    expect(input.value).toBe(`raw <@${unknownUuid}> marker`)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith(`raw <@${unknownUuid}> marker`)
  })

  it('a hand-typed name not backed by the mentions array stays plain text on save', () => {
    const { onSaveEdit } = renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: 'plain text',
        mentions: [],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    fireEvent.change(input, { target: { value: 'ping @stranger now' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSaveEdit).toHaveBeenCalledExactlyOnceWith('ping @stranger now')
  })

  it('does not transform encrypted content (ciphertext untouched, no sidecar on edits in v1)', () => {
    const ciphertext = '{"message_type":0,"ciphertext":"abc"}'
    renderEditingMessageItem(
      buildMessage({
        authorId: CURRENT_USER_ID,
        content: ciphertext,
        encrypted: true,
        mentions: [buildMention()],
      }),
    )

    const input = screen.getByTestId<HTMLTextAreaElement>('message-edit-input')
    expect(input.value).toBe(ciphertext)
  })
})

describe('MessageItem attachments (T1.3 part 1)', () => {
  const IMAGE_ATTACHMENT = {
    id: 'att-1',
    url: 'https://xyz.supabase.co/storage/v1/object/public/attachments/u/pic.webp',
    mime: 'image/webp',
    size: 2048,
    width: 800,
    height: 600,
    moderationStatus: 'approved' as const,
  }
  const PDF_ATTACHMENT = {
    id: 'att-2',
    url: 'https://xyz.supabase.co/storage/v1/object/public/attachments/u/report.pdf',
    mime: 'application/pdf',
    size: 123456,
    moderationStatus: 'approved' as const,
  }

  it('renders an image attachment as a bounded inline <img> with intrinsic dims', () => {
    renderMessageItem(buildMessage({ attachments: [IMAGE_ATTACHMENT] }))

    const img = screen.getByTestId('attachment-image').querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(IMAGE_ATTACHMENT.url)
    // Intrinsic dims from the stored row — zero layout shift while lazy-loading.
    expect(img?.getAttribute('width')).toBe('800')
    expect(img?.getAttribute('height')).toBe('600')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('renders a non-image attachment as a download chip (filename + size), never an <img>', () => {
    renderMessageItem(buildMessage({ attachments: [PDF_ATTACHMENT] }))

    const chip = screen.getByTestId('attachment-file-chip')
    expect(chip.textContent).toContain('report.pdf')
    expect(chip.textContent).toContain('121 KB')
    expect(screen.queryByTestId('attachment-image')).toBeNull()
  })

  it('renders an image-only message (empty content) with its attachment', () => {
    renderMessageItem(buildMessage({ content: '', attachments: [IMAGE_ATTACHMENT] }))

    expect(screen.queryByTestId('message-attachments')).not.toBeNull()
    expect(screen.getByTestId('attachment-image')).toBeDefined()
  })

  it('swaps a broken image for the "Image unavailable" fallback on error', () => {
    renderMessageItem(buildMessage({ attachments: [IMAGE_ATTACHMENT] }))

    const img = screen.getByTestId('attachment-image').querySelector('img')
    if (img === null) throw new Error('attachment img not found')
    act(() => {
      fireEvent.error(img)
    })

    expect(screen.queryByTestId('attachment-unavailable')).not.toBeNull()
    expect(screen.queryByTestId('attachment-image')).toBeNull()
  })

  it('never renders the attachment block on a tombstoned message', () => {
    renderMessageItem(buildMessage({ attachments: [IMAGE_ATTACHMENT], deletedBy: 'user-42' }))

    expect(screen.queryByTestId('message-attachments')).toBeNull()
  })

  it('auto-embeds a bare image URL typed in content (the Klipy render path)', () => {
    renderMessageItem(buildMessage({ content: 'look https://media.example.com/funny.gif' }))

    const embed = screen.getByTestId('attachment-image')
    expect(embed.querySelector('img')?.getAttribute('src')).toBe(
      'https://media.example.com/funny.gif',
    )
  })

  it('keeps non-image URLs as plain gated links, not embeds', () => {
    renderMessageItem(buildMessage({ content: 'see https://example.com/docs' }))

    expect(screen.queryByTestId('attachment-image')).toBeNull()
  })

  it('opens the media lightbox on primary click, not the external-link warning', async () => {
    renderMessageItem(buildMessage({ attachments: [IMAGE_ATTACHMENT] }))

    fireEvent.click(screen.getByTestId('attachment-image'))

    // Primary click enlarges the image in the lightbox…
    expect(await screen.findByTestId('lightbox-image')).not.toBeNull()
    // …and no longer triggers the "you're leaving Harmony" security popup.
    expect(screen.queryByTestId('external-link-warning')).toBeNull()
  })

  it('gates the lightbox secondary "open original" behind the external-link warning', async () => {
    renderMessageItem(buildMessage({ attachments: [IMAGE_ATTACHMENT] }))

    fireEvent.click(screen.getByTestId('attachment-image'))
    fireEvent.click(await screen.findByTestId('lightbox-open-original'))

    expect(await screen.findByTestId('external-link-warning')).not.toBeNull()
  })
})

describe('MessageItem official badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the Official badge next to an author in the official set', () => {
    const queryClient = createTestQueryClient()
    // Seed the cached official-set so useOfficialBadges resolves synchronously.
    queryClient.setQueryData(queryKeys.badges.official(), { userIds: ['user-42'] })

    renderMessageItem(buildMessage({ authorId: 'user-42' }), { queryClient })

    expect(screen.getByTestId('official-badge')).toBeTruthy()
    expect(screen.getByLabelText('Harmony Official')).toBeTruthy()
  })

  it('does NOT render the Official badge for an author outside the set', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.badges.official(), { userIds: ['someone-else'] })

    renderMessageItem(buildMessage({ authorId: 'user-42' }), { queryClient })

    expect(screen.queryByTestId('official-badge')).toBeNull()
  })
})

describe('MessageItem pin action (T2.3)', () => {
  it('hides the pin button when the user cannot moderate', () => {
    renderMessageItem(buildMessage({ authorId: 'user-42' }), {
      canModerateMessages: false,
      onTogglePin: vi.fn(),
    })
    expect(screen.queryByTestId('message-pin-button')).toBeNull()
  })

  it('shows the pin button for a moderator and calls onTogglePin on press', () => {
    const onTogglePin = vi.fn()
    renderMessageItem(buildMessage({ authorId: 'user-42', isPinned: false }), {
      canModerateMessages: true,
      onTogglePin,
    })
    const button = screen.getByTestId('message-pin-button')
    expect(button.getAttribute('aria-label')).toBe('Pin message')
    fireEvent.click(button)
    expect(onTogglePin).toHaveBeenCalledTimes(1)
  })

  it('reflects the pinned state: unpin label + inline pinned tag', () => {
    renderMessageItem(buildMessage({ authorId: 'user-42', isPinned: true }), {
      canModerateMessages: true,
      onTogglePin: vi.fn(),
    })
    expect(screen.getByTestId('message-pin-button').getAttribute('aria-label')).toBe(
      'Unpin message',
    )
    expect(screen.queryByTestId('message-pinned-tag')).not.toBeNull()
  })
})
