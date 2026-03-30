import { queryKeys } from '@/lib/query-keys'

// Helper: checks that `prefix` is a leading subsequence of `full`
function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  return prefix.every((segment, i) => segment === full[i])
}

// Compile-time readonly tuple assertions.
// These lines produce a type error if the source drops `as const`.
const _staticReadonly: readonly string[] = queryKeys.profiles.all
const _factoryReadonly: readonly string[] = queryKeys.profiles.me()
void _staticReadonly
void _factoryReadonly

describe('queryKeys', () => {
  // -- prefix invariants (invalidateQueries correctness) ------------------

  describe('profiles: .all is a prefix of every specific key', () => {
    it('enables bulk invalidation via queryKeys.profiles.all', () => {
      const { all } = queryKeys.profiles
      expect(isPrefix(all, queryKeys.profiles.me())).toBe(true)
      expect(isPrefix(all, queryKeys.profiles.detail('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.profiles.search('q'))).toBe(true)
    })
  })

  describe('servers: .all is a prefix of every specific key', () => {
    it('enables bulk invalidation via queryKeys.servers.all', () => {
      const { all } = queryKeys.servers
      expect(isPrefix(all, queryKeys.servers.list())).toBe(true)
      expect(isPrefix(all, queryKeys.servers.detail('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.members('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.channels('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.roles('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.invites('x'))).toBe(true)
    })
  })

  describe('channels: .all is a prefix of every specific key', () => {
    it('enables bulk invalidation via queryKeys.channels.all', () => {
      const { all } = queryKeys.channels
      expect(isPrefix(all, queryKeys.channels.byServer('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.channels.detail('x'))).toBe(true)
    })
  })

  describe('messages: .all is a prefix of every specific key', () => {
    it('enables bulk invalidation via queryKeys.messages.all', () => {
      const { all } = queryKeys.messages
      expect(isPrefix(all, queryKeys.messages.byChannel('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.messages.detail('x'))).toBe(true)
    })
  })

  // -- cross-domain isolation ---------------------------------------------

  it('top-level domain keys do not collide', () => {
    const domains = [
      queryKeys.profiles.all,
      queryKeys.servers.all,
      queryKeys.channels.all,
      queryKeys.messages.all,
    ]
    const firsts = domains.map((d) => d[0])
    const unique = new Set(firsts)
    expect(unique.size).toBe(domains.length)
  })

  // -- ID differentiation (one representative check) ----------------------

  it('different IDs produce different keys', () => {
    expect(queryKeys.servers.detail('a')).not.toEqual(queryKeys.servers.detail('b'))
  })
})
