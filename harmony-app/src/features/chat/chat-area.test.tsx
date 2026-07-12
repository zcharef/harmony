import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { NewAttachmentRequest } from '@/lib/api'
// WHY: Side-effect import initializes the real i18n instance so the composer
// placeholder and the mention popup rows resolve to actual translations.
import '@/lib/i18n'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { ChatArea } from './chat-area'

configure({ testIdAttribute: 'data-test' })

/**
 * ChatArea mention WIRING tests (mentions spec §1 keyboard rules + §5.2).
 *
 * The reducer and the transform are unit-tested in isolation
 * (use-mention-autocomplete.test.ts, mention-tokens.test.ts) — these tests pin
 * the two lines that connect them to the composer, which no other test covers:
 *   1. handleKeyDown: `if (mention.handleKeyDown(e)) return` BEFORE Enter-to-send.
 *   2. handleSend: `applyMentionMap(...)` feeding `content` + the conditional
 *      `mentions` key into sendMessage.mutate.
 */

const MENTION_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SERVER_ID = 'server-1'
const CHANNEL_ID = 'channel-1'

const { sendMutate, membersState, composerAttachments } = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  // WHY a shared mutable stub: the send onError guard only reaches
  // setSendError when the tray is non-empty (hasAttachments), so the plan-gate
  // suppression test flips `isEmpty` and spies on setSendError. Defaults to an
  // empty tray so the mention-wiring tests keep their original behavior.
  composerAttachments: {
    items: [] as unknown[],
    capError: null,
    sendError: null as string | null,
    isEmpty: true,
    hasFailedUpload: false,
    enqueueFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clear: vi.fn(),
    setSendError: vi.fn(),
    resolveUploaded: vi.fn(async () => [] as unknown[]),
  },
  membersState: {
    page: {
      items: [
        {
          userId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          username: 'alice',
          displayName: 'Alice',
          nickname: null,
          avatarUrl: null,
          role: 'member',
          joinedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
    },
  },
}))

// WHY mocked at the hook seam (not '@/lib/api'): the wiring under test is
// ChatArea → useMentionAutocomplete → applyMentionMap → sendMessage.mutate.
// Everything on that path stays REAL; only data sources and side-effect hooks
// are stubbed.
vi.mock('./hooks/use-send-message', () => ({
  OPTIMISTIC_ID_PREFIX: 'temp-',
  useSendMessage: () => ({ mutate: sendMutate }),
}))

vi.mock('./hooks/use-composer-attachments', () => ({
  useComposerAttachments: () => composerAttachments,
}))

vi.mock('./hooks/use-messages', () => ({
  useMessages: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    isRefetching: false,
  }),
}))

vi.mock('./hooks/use-slow-mode', () => ({
  useSlowMode: () => ({
    isInCooldown: false,
    remainingSeconds: 0,
    startCooldown: vi.fn(),
    syncFromServer: vi.fn(),
  }),
}))

vi.mock('./hooks/use-typing-indicator', () => ({
  useTypingIndicator: () => ({ typingUsers: [], sendTyping: vi.fn() }),
}))

// WHY satisfies: the stub must stay shaped like the real hook's return type
// (UploadedAttachment = NewAttachmentRequest) — vi.mock factories are not
// checked against the mocked module, so this pins the contract instead.
vi.mock('./hooks/use-upload-attachment', () => ({
  useUploadAttachment: () => async () =>
    ({
      url: 'https://storage.example.test/storage/v1/object/public/attachments/user-me/notes.txt',
      mime: 'text/plain',
      size: 5,
    }) satisfies NewAttachmentRequest,
}))

vi.mock('./hooks/use-realtime-messages', () => ({ useRealtimeMessages: () => undefined }))
vi.mock('./hooks/use-realtime-reactions', () => ({ useRealtimeReactions: () => undefined }))
vi.mock('./hooks/use-add-reaction', () => ({ useAddReaction: () => ({ mutate: vi.fn() }) }))
vi.mock('./hooks/use-remove-reaction', () => ({ useRemoveReaction: () => ({ mutate: vi.fn() }) }))
vi.mock('./hooks/use-delete-message', () => ({ useDeleteMessage: () => ({ mutate: vi.fn() }) }))
vi.mock('./hooks/use-edit-message', () => ({ useEditMessage: () => ({ mutate: vi.fn() }) }))
vi.mock('./hooks/use-notification-settings', () => ({
  useNotificationSettings: () => ({ data: undefined }),
}))
vi.mock('./hooks/use-update-notification-settings', () => ({
  useUpdateNotificationSettings: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-me' } }),
  useCurrentProfile: () => ({ data: { username: 'me', displayName: null, avatarUrl: null } }),
}))

vi.mock('@/features/channels', () => ({
  useMarkRead: () => ({ mutate: vi.fn() }),
  useUnreadStore: (selector: (s: { clear: () => void }) => unknown) => selector({ clear: vi.fn() }),
}))

vi.mock('@/features/members', () => ({
  ROLE_HIERARCHY: { owner: 4, admin: 3, moderator: 2, member: 1 },
  useMembers: () => ({ data: membersState.page, isPending: false, isError: false }),
}))

vi.mock('@/features/presence', () => ({
  StatusIndicator: () => null,
  useUserStatus: () => 'online',
}))

vi.mock('@/features/crypto', () => ({
  DmPlaintextBanner: () => null,
  E2eeAlphaBanner: () => null,
  EncryptedChannelNotice: () => null,
  EncryptedMessageContent: () => null,
  EncryptionRequiredBanner: () => null,
  TrustBadge: () => null,
  VerifyIdentityModal: () => null,
  useChannelEncryption: () => ({
    encryptChannelMessage: vi.fn(),
    decryptChannelMessage: vi.fn(),
    loadCachedChannelDecryptions: vi.fn(),
    getCachedPlaintext: vi.fn(),
    setCachedPlaintext: vi.fn(),
  }),
  useCryptoSession: () => ({ ensureSession: vi.fn() }),
  useCryptoStore: (
    selector: (s: { isInitialized: boolean; deviceId: null; initFailed: boolean }) => unknown,
  ) => selector({ isInitialized: false, deviceId: null, initFailed: false }),
  useEncryptedMessages: () => ({
    decryptMessage: vi.fn(),
    loadCachedDecryptions: vi.fn(),
    getCachedPlaintext: vi.fn(),
    setCachedPlaintext: vi.fn(),
  }),
  useSafetyNumber: () => ({ safetyNumber: null, isLoading: false }),
  useTrustLevel: () => ({ trustLevel: 'unverified', setLevel: vi.fn() }),
}))

vi.mock('@/features/preferences', () => ({
  usePreferences: () => ({ data: { hideProfanity: false } }),
}))

vi.mock('@/lib/platform', () => ({ isTauri: () => false }))
vi.mock('@/lib/crypto', () => ({ encrypt: vi.fn() }))
vi.mock('@/lib/crypto-cache', () => ({ cacheMessage: vi.fn(async () => undefined) }))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@emoji-mart/react', () => ({ default: () => null }))
vi.mock('@emoji-mart/data', () => ({ default: {} }))

function renderChatArea() {
  const Wrapper = createQueryWrapper(createTestQueryClient())
  const utils = render(
    <Wrapper>
      <ChatArea
        channelId={CHANNEL_ID}
        channelName="general"
        serverId={SERVER_ID}
        currentUserRole="member"
      />
    </Wrapper>,
  )
  const input = screen.getByTestId<HTMLTextAreaElement>('message-input')
  return { input, ...utils }
}

/** Types into the composer: fires React's change AND moves the caret to the end. */
function typeInComposer(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

/** Popup-inserts @alice: type the trigger, wait for the row, press Enter. */
async function insertAliceViaPopup(input: HTMLTextAreaElement) {
  typeInComposer(input, '@ali')
  await waitFor(() => expect(screen.getAllByTestId('mention-option')).toHaveLength(1))
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input.value).toBe('@alice '))
}

describe('ChatArea mention wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Enter with the popup open inserts the mention and does NOT send (spec §1)', async () => {
    const { input } = renderChatArea()

    await insertAliceViaPopup(input)

    expect(sendMutate).not.toHaveBeenCalled()
    // The trailing space ends the token — the popup closes after insertion.
    // WHY waitFor: the HeroUI Popover keeps its content mounted through the
    // exit animation — the rows leave the DOM asynchronously, so a synchronous
    // queryAll races the animation (flaked in CI).
    await waitFor(() => expect(screen.queryAllByTestId('mention-option')).toHaveLength(0))
  })

  it('Enter after insertion sends the transformed content WITH the mentions key (spec §5.2)', async () => {
    const { input } = renderChatArea()
    await insertAliceViaPopup(input)

    typeInComposer(input, '@alice hello')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendMutate).toHaveBeenCalledTimes(1)
    // WHY assert the first arg (not the whole call): handleSend now passes a
    // second callbacks object (onSuccess clears the attachment tray).
    // WHY toMatchObject on mentions: the map stores the candidate object as-is
    // (a structural superset of MentionCandidate) — pin the fields the
    // optimistic message and the encrypted sidecar actually consume.
    expect(sendMutate.mock.calls[0]?.[0]).toEqual({
      content: `<@${MENTION_UUID}> hello`,
      parentMessageId: undefined,
      mentions: [expect.objectContaining({ userId: MENTION_UUID, username: 'alice' })],
    })
    // The composer clears after a send.
    expect(input.value).toBe('')
  })

  it('a plain-text send is untransformed and OMITS the mentions key entirely', async () => {
    const { input } = renderChatArea()

    typeInComposer(input, 'hello @stranger')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(sendMutate).toHaveBeenCalledTimes(1)
    const arg = sendMutate.mock.calls[0]?.[0]
    expect(arg).toMatchObject({ content: 'hello @stranger' })
    // Spec §3.1: the key is OMITTED when empty — never [] or null.
    expect(arg).not.toHaveProperty('mentions')
  })
})

/**
 * HTML5 drop wiring (attachments §6.3). This is the path Tauri's native
 * drag-drop interception used to swallow on desktop — dragDropEnabled is now
 * false in tauri.conf.json so the SAME React onDrop runs on web and desktop.
 * These tests pin that handler chain: onDragOver overlay → onDrop →
 * enqueueFiles → tray tile.
 */
describe('ChatArea attachment drop wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function dropFile(target: HTMLElement, file: File) {
    fireEvent.drop(target, { dataTransfer: { files: [file], types: ['Files'] } })
  }

  it('drag-over shows the dropzone overlay and drop forwards the file to the composer', async () => {
    const { input } = renderChatArea()

    fireEvent.dragOver(input, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByTestId('attachment-dropzone')).toBeTruthy()

    dropFile(input, new File(['hello'], 'notes.txt', { type: 'text/plain' }))

    // The onDrop handler forwards the dropped files to the composer-attachments
    // hook (mocked at its seam here); tray/tile rendering is that hook's own
    // unit concern.
    expect(composerAttachments.enqueueFiles).toHaveBeenCalledTimes(1)
    const enqueued = composerAttachments.enqueueFiles.mock.calls[0]?.[0] as FileList
    expect(enqueued.length).toBe(1)
    expect(enqueued[0]?.name).toBe('notes.txt')
    // The drop also clears the overlay.
    expect(screen.queryByTestId('attachment-dropzone')).toBeNull()
  })

  it('drop with no files enqueues nothing', async () => {
    const { input } = renderChatArea()

    fireEvent.drop(input, { dataTransfer: { files: [], types: [] } })

    expect(composerAttachments.enqueueFiles).not.toHaveBeenCalled()
  })
})

/**
 * Plan-gate send feedback (ADR-045). A plan-gated attachment rejection
 * (attachments_per_message / attachment_size) opens the UpgradeModal centrally
 * via the MutationCache — the composer must NOT also set its inline send error
 * (duplicate feedback). Non-plan failures still surface inline.
 */
describe('ChatArea plan-gate send feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // A non-empty tray makes hasAttachments true, so the onError path reaches
    // the setSendError guard under test.
    composerAttachments.isEmpty = false
    composerAttachments.resolveUploaded.mockResolvedValue([])
  })

  afterEach(() => {
    composerAttachments.isEmpty = true
  })

  async function captureSendOnError() {
    const { input } = renderChatArea()
    typeInComposer(input, 'hello')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sendMutate).toHaveBeenCalledTimes(1))
    return sendMutate.mock.calls[0]?.[1]?.onError as (error: unknown) => void
  }

  const planGateProblem = {
    status: 403,
    title: 'Plan Limit Exceeded',
    detail: 'Plan limit reached: 1 attachments per message on the free plan',
    code: 'PLAN_LIMIT_REACHED',
    plan_gate: {
      resource: 'attachments_per_message',
      current_plan: 'free',
      limit: 1,
      required_plan: 'supporter',
    },
  }

  it('does NOT set the inline send error for a plan-gate rejection', async () => {
    const onError = await captureSendOnError()
    onError(planGateProblem)
    expect(composerAttachments.setSendError).not.toHaveBeenCalled()
  })

  it('DOES set the inline send error for a non-plan-gate failure', async () => {
    const onError = await captureSendOnError()
    onError({ status: 500, title: 'Server Error', detail: 'boom' })
    expect(composerAttachments.setSendError).toHaveBeenCalledTimes(1)
  })
})
