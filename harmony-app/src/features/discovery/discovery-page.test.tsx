import { configure, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
// WHY: Side-effect import initializes the real i18n instance so labels
// resolve to actual translations.
import '@/lib/i18n'

// WHY: The repo uses data-test (not data-testid) — align Testing Library queries.
configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// WHY pass-through: the debounce is timing behavior, not under test here.
vi.mock('./hooks/use-debounced-value', () => ({
  useDebouncedValue: <T,>(value: T) => value,
}))

const mockUseDiscoveryServers = vi.fn()
vi.mock('./hooks/use-discovery-servers', () => ({
  useDiscoveryServers: (search: string, category: string | null) =>
    mockUseDiscoveryServers(search, category),
}))

const mockMutate = vi.fn()
let mockIsJoinPending = false
vi.mock('./hooks/use-join-discovery-server', () => ({
  useJoinDiscoveryServer: () => ({
    mutate: mockMutate,
    isPending: mockIsJoinPending,
    variables: 'srv-1',
  }),
}))

vi.mock('@/features/server-nav', () => ({
  useServers: () => ({
    data: [{ id: 'srv-member', name: 'Already Mine', ownerId: 'me', isDm: false }],
  }),
}))

const closeDiscovery = vi.fn()
vi.mock('@/lib/discovery-ui-store', () => ({
  useDiscoveryUiStore: (selector: (s: { closeDiscovery: () => void }) => unknown) =>
    selector({ closeDiscovery }),
}))

import { DiscoveryPage } from './discovery-page'

function page(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ items, total: items.length, nextCursor: undefined }] },
    isPending: false,
    isError: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    isRefetching: false,
    ...overrides,
  }
}

const SERVERS = [
  {
    id: 'srv-1',
    name: 'Rust Guild',
    iconUrl: null,
    memberCount: 42,
    category: 'tech',
    description: 'Systems programming hangout',
  },
  {
    id: 'srv-member',
    name: 'Already Mine',
    iconUrl: null,
    memberCount: 7,
    category: 'community',
    description: null,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockIsJoinPending = false
  mockUseDiscoveryServers.mockReturnValue(page(SERVERS))
})

describe('DiscoveryPage', () => {
  it('renders one card per directory entry with name, member count and category', () => {
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    const cards = screen.getAllByTestId('discovery-server-card')
    expect(cards).toHaveLength(2)
    expect(screen.getByText('Rust Guild')).toBeDefined()
    expect(screen.getByText('42 members')).toBeDefined()
    expect(screen.getByText('Systems programming hangout')).toBeDefined()
  })

  it('joins a non-member server and navigates on success', () => {
    const onJoined = vi.fn()
    mockMutate.mockImplementation((serverId: string, opts: { onSuccess: (id: string) => void }) => {
      opts.onSuccess(serverId)
    })
    render(<DiscoveryPage onJoined={onJoined} onCreateServer={vi.fn()} />)

    // Only the non-member card shows a Join button.
    const joinButtons = screen.getAllByTestId('discovery-join-button')
    expect(joinButtons).toHaveLength(1)
    fireEvent.click(joinButtons[0] as HTMLElement)

    expect(mockMutate).toHaveBeenCalledWith('srv-1', expect.any(Object))
    expect(onJoined).toHaveBeenCalledWith('srv-1')
  })

  it('shows Open (not Join) for a server the user is already in, navigating directly', () => {
    const onJoined = vi.fn()
    render(<DiscoveryPage onJoined={onJoined} onCreateServer={vi.fn()} />)

    const openButtons = screen.getAllByTestId('discovery-open-button')
    expect(openButtons).toHaveLength(1)
    fireEvent.click(openButtons[0] as HTMLElement)

    expect(onJoined).toHaveBeenCalledWith('srv-member')
    expect(mockMutate).not.toHaveBeenCalled()
  })

  it('passes the typed search to the listing query', () => {
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    fireEvent.change(screen.getByTestId('discovery-search-input'), {
      target: { value: 'rust' },
    })

    expect(mockUseDiscoveryServers).toHaveBeenLastCalledWith('rust', null)
  })

  it('filters by category chip and toggles back to All', () => {
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    fireEvent.click(screen.getByTestId('discovery-category-tech'))
    expect(mockUseDiscoveryServers).toHaveBeenLastCalledWith('', 'tech')

    // Clicking the active chip clears the filter.
    fireEvent.click(screen.getByTestId('discovery-category-tech'))
    expect(mockUseDiscoveryServers).toHaveBeenLastCalledWith('', null)

    fireEvent.click(screen.getByTestId('discovery-category-gaming'))
    fireEvent.click(screen.getByTestId('discovery-category-all'))
    expect(mockUseDiscoveryServers).toHaveBeenLastCalledWith('', null)
  })

  it('shows the empty state with a create-your-own CTA', () => {
    mockUseDiscoveryServers.mockReturnValue(page([]))
    const onCreateServer = vi.fn()
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={onCreateServer} />)

    expect(screen.getByTestId('discovery-empty-state')).toBeDefined()
    fireEvent.click(screen.getByTestId('discovery-create-server-button'))
    expect(onCreateServer).toHaveBeenCalled()
  })

  it('shows a loading spinner while the first page is pending', () => {
    mockUseDiscoveryServers.mockReturnValue(page([], { isPending: true, data: undefined }))
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    expect(screen.getByTestId('discovery-loading')).toBeDefined()
    expect(screen.queryByTestId('discovery-empty-state')).toBeNull()
  })

  it('shows the error state when the directory query fails', () => {
    mockUseDiscoveryServers.mockReturnValue(page([], { isError: true, data: undefined }))
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    expect(screen.queryByTestId('discovery-server-card')).toBeNull()
    expect(screen.queryByTestId('discovery-empty-state')).toBeNull()
  })

  it('offers Load more only when a next page exists', () => {
    mockUseDiscoveryServers.mockReturnValue(page(SERVERS, { hasNextPage: true }))
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)
    expect(screen.getByTestId('discovery-load-more-button')).toBeDefined()

    mockUseDiscoveryServers.mockReturnValue(page(SERVERS, { hasNextPage: false }))
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)
    expect(screen.getAllByTestId('discovery-load-more-button')).toHaveLength(1)
  })

  it('closes the page from the header button', () => {
    render(<DiscoveryPage onJoined={vi.fn()} onCreateServer={vi.fn()} />)

    fireEvent.click(screen.getByTestId('discovery-close-button'))
    expect(closeDiscovery).toHaveBeenCalled()
  })
})
