import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageResponse, NewAttachmentRequest } from '@/lib/api'
// WHY: Side-effect import initializes the real i18n instance so the composer
// placeholder and the mention popup rows resolve to actual translations.
import '@/lib/i18n'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { ChatArea, filterMessagesByMention } from './chat-area'

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

const {
  sendMutate,
  membersState,
  composerAttachments,
  messagesState,
  platformState,
  cryptoStoreState,
  cryptoGateState,
  sendArgs,
} = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  // WHY mutable platform: most tests run as web (isTauri false); the DM
  // encryption gate + banner tests flip this to desktop per-test and reset after.
  platformState: { isTauri: false },
  // WHY mutable crypto store: the desktop gate needs an initialized local device
  // to produce an encryption param; default matches the original web-uninitialized
  // stub so the pre-existing tests are unaffected.
  cryptoStoreState: { isInitialized: false, deviceId: null as string | null, initFailed: false },
  // WHY mutable gate: useRecipientEncryptable's tri-state (true=encryptable,
  // false=confirmed keyless, undefined=unknown) drives the plaintext-vs-E2EE gate.
  cryptoGateState: { recipientEncryptable: undefined as boolean | undefined },
  // WHY captured: useSendMessage is stubbed, so we read the 4th arg (the encryption
  // param the gate produced) to assert plaintext (undefined) vs E2EE (defined).
  sendArgs: { encryption: undefined as unknown },
  // WHY mutable: most tests want an empty list (data undefined); the message
  // filter tests seed a loaded window by assigning messagesState.data.
  messagesState: { data: undefined as unknown },
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
  // WHY capture the 4th arg: it is the encryption param produced by the real
  // useDmEncryption gate — undefined ⇒ plaintext send, defined ⇒ E2EE.
  useSendMessage: (
    _channelId: string,
    _userId: string,
    _username: string,
    encryption?: unknown,
  ) => {
    sendArgs.encryption = encryption
    return { mutate: sendMutate }
  },
}))

vi.mock('./hooks/use-composer-attachments', () => ({
  useComposerAttachments: () => composerAttachments,
}))

vi.mock('./hooks/use-messages', () => ({
  useMessages: () => ({
    data: messagesState.data,
    isPending: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    isRefetching: false,
  }),
}))

// WHY stub MessageItem: the filter tests assert HOW MANY message rows render;
// the row's own rendering (crypto, embeds, reactions) is covered elsewhere.
vi.mock('./message-item', () => ({
  MessageItem: ({ message }: { message: { id: string; content: string } }) => (
    <div data-test="mock-message" data-id={message.id}>
      {message.content}
    </div>
  ),
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
  useMemberListStore: (selector: (s: { isOpen: boolean; toggle: () => void }) => unknown) =>
    selector({ isOpen: true, toggle: vi.fn() }),
}))

vi.mock('@/features/presence', () => ({
  StatusIndicator: () => null,
  useUserStatus: () => 'online',
}))

vi.mock('@/features/crypto', () => ({
  // WHY a real testid: the keyless-DM disclosure test asserts the banner renders.
  DmPlaintextBanner: () => <div data-test="dm-plaintext-banner" />,
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
    selector: (s: {
      isInitialized: boolean
      deviceId: string | null
      initFailed: boolean
    }) => unknown,
  ) => selector(cryptoStoreState),
  useEncryptedMessages: () => ({
    decryptMessage: vi.fn(),
    loadCachedDecryptions: vi.fn(),
    getCachedPlaintext: vi.fn(),
    setCachedPlaintext: vi.fn(),
  }),
  useRecipientEncryptable: () => cryptoGateState.recipientEncryptable,
  useSafetyNumber: () => ({ safetyNumber: null, isLoading: false }),
  useTrustLevel: () => ({ trustLevel: 'unverified', setLevel: vi.fn() }),
}))

vi.mock('@/features/preferences', () => ({
  usePreferences: () => ({ data: { hideProfanity: false } }),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: () => platformState.isTauri,
  openExternalUrl: vi.fn(),
}))
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
 * Message-list filter (spec §2). The All/Mentions segmented control filters the
 * loaded window client-side: a message is a "mention of me" when its
 * `mentions[]` contains the current user's id.
 */
describe('ChatArea message filter', () => {
  const CURRENT_USER_ID = 'user-me'

  function makeMessage(id: string, content: string, mentionsMe: boolean): MessageResponse {
    return {
      id,
      channelId: CHANNEL_ID,
      authorId: `author-${id}`,
      authorUsername: `user-${id}`,
      content,
      createdAt: '2026-01-01T00:00:00Z',
      attachments: [],
      embeds: [],
      encrypted: false,
      isPinned: false,
      messageType: 'default',
      mentions: mentionsMe ? [{ userId: CURRENT_USER_ID, username: 'me' }] : [],
    }
  }

  function seedMessages(...items: ReturnType<typeof makeMessage>[]) {
    messagesState.data = { pages: [{ items }] }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    messagesState.data = undefined
  })

  it('filterMessagesByMention keeps only mentions-of-me, All is identity', () => {
    const loaded = [
      makeMessage('a', 'hi @me', true),
      makeMessage('b', 'unrelated', false),
      makeMessage('c', 'ping @me', true),
    ]

    const all = filterMessagesByMention(loaded, 'all', CURRENT_USER_ID)
    expect(all).toHaveLength(3)

    const mentions = filterMessagesByMention(loaded, 'mentions', CURRENT_USER_ID)
    expect(mentions.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('toggles aria-pressed on the segmented control', () => {
    seedMessages(makeMessage('a', 'hi @me', true))
    renderChatArea()

    const allBtn = screen.getByTestId('message-filter-all')
    const mentionsBtn = screen.getByTestId('message-filter-mentions')
    expect(allBtn.getAttribute('aria-pressed')).toBe('true')
    expect(mentionsBtn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(mentionsBtn)

    expect(screen.getByTestId('message-filter-all').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('message-filter-mentions').getAttribute('aria-pressed')).toBe('true')
  })

  it('shows the empty hint when no loaded message mentions me', () => {
    seedMessages(makeMessage('a', 'hello', false), makeMessage('b', 'world', false))
    renderChatArea()

    expect(screen.queryByTestId('mention-filter-empty')).toBeNull()

    fireEvent.click(screen.getByTestId('message-filter-mentions'))

    expect(screen.queryAllByTestId('mock-message')).toHaveLength(0)
    expect(screen.getByTestId('mention-filter-empty')).toBeTruthy()
  })

  it('has no dead threads/sticker buttons and wires the member + search controls', () => {
    seedMessages(makeMessage('a', 'hey', false))
    renderChatArea()

    // The removed dead controls must be gone entirely.
    expect(screen.queryByLabelText('Threads')).toBeNull()
    expect(screen.queryByLabelText('Stickers')).toBeNull()

    // The surviving toolbar controls are wired (member toggle exposes state).
    const members = screen.getByTestId('chat-toolbar-members')
    expect(members.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('chat-toolbar-search')).toBeTruthy()
  })

  it('hides the filter control in DM view', () => {
    seedMessages(makeMessage('a', 'hey', false))
    const Wrapper = createQueryWrapper(createTestQueryClient())
    render(
      <Wrapper>
        <ChatArea
          channelId={CHANNEL_ID}
          channelName={null}
          serverId={SERVER_ID}
          currentUserRole="member"
          isDm
          dmRecipient={{
            id: 'user-friend',
            username: 'friend',
            displayName: null,
            avatarUrl: null,
          }}
        />
      </Wrapper>,
    )

    expect(screen.queryByTestId('message-filter')).toBeNull()
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

/**
 * Desktop DM encryption gate + plaintext disclosure (E9). Desktop forces E2EE for
 * DMs, but a keyless (web-only) recipient cannot receive it — encrypting to them
 * 404s and fails the send closed. The gate must fall back to plaintext (with the
 * disclosure banner) ONLY for a confirmed-keyless recipient, and NEVER downgrade a
 * recipient who has keys. `sendArgs.encryption` is the encryption param the real
 * useDmEncryption gate produced: undefined ⇒ plaintext, defined ⇒ E2EE.
 */
describe('ChatArea desktop DM encryption gate', () => {
  const RECIPIENT = {
    id: 'user-friend',
    username: 'friend',
    displayName: null,
    avatarUrl: null,
  }

  function renderDesktopDm() {
    const Wrapper = createQueryWrapper(createTestQueryClient())
    return render(
      <Wrapper>
        <ChatArea
          channelId={CHANNEL_ID}
          channelName={null}
          serverId={SERVER_ID}
          currentUserRole="member"
          isDm
          dmRecipient={RECIPIENT}
        />
      </Wrapper>,
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sendArgs.encryption = 'unset'
    // Desktop with an initialized local device — the prerequisites for E2EE.
    platformState.isTauri = true
    cryptoStoreState.isInitialized = true
    cryptoStoreState.deviceId = 'device-local'
    cryptoStoreState.initFailed = false
  })

  afterEach(() => {
    platformState.isTauri = false
    cryptoStoreState.isInitialized = false
    cryptoStoreState.deviceId = null
    cryptoGateState.recipientEncryptable = undefined
  })

  it('encrypts (no plaintext downgrade) when the recipient has keys', () => {
    cryptoGateState.recipientEncryptable = true
    renderDesktopDm()

    // The gate produced an encryption param ⇒ the DM is sent E2EE.
    expect(sendArgs.encryption).toBeDefined()
    expect(sendArgs.encryption).toHaveProperty('encryptFn')
    // No plaintext disclosure banner when the DM is actually encrypted.
    expect(screen.queryByTestId('dm-plaintext-banner')).toBeNull()
  })

  it('sends plaintext + shows the disclosure banner for a confirmed-keyless recipient', () => {
    cryptoGateState.recipientEncryptable = false
    renderDesktopDm()

    // The gate returned undefined ⇒ plaintext send (no throw, no fail-closed).
    expect(sendArgs.encryption).toBeUndefined()
    // The user is told the DM is not encrypted (recipient has no keys).
    expect(screen.getByTestId('dm-plaintext-banner')).toBeTruthy()
  })

  it('keeps E2EE (never downgrades) while the capability probe is unknown', () => {
    // undefined = query loading / errored: must NOT be read as keyless.
    cryptoGateState.recipientEncryptable = undefined
    renderDesktopDm()

    expect(sendArgs.encryption).toBeDefined()
    expect(screen.queryByTestId('dm-plaintext-banner')).toBeNull()
  })
})
