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
  // -- profiles -----------------------------------------------------------

  describe('profiles', () => {
    it('all is a static key array', () => {
      expect(queryKeys.profiles.all).toEqual(['profiles'])
      expect(Array.isArray(queryKeys.profiles.all)).toBe(true)
    })

    it('me() returns a key array', () => {
      const key = queryKeys.profiles.me()
      expect(key).toEqual(['profiles', 'me'])
      expect(Array.isArray(key)).toBe(true)
    })

    it('detail() interpolates profileId', () => {
      expect(queryKeys.profiles.detail('p1')).toEqual(['profiles', 'detail', 'p1'])
      expect(queryKeys.profiles.detail('p2')).toEqual(['profiles', 'detail', 'p2'])
    })

    it('detail() with different IDs produces different keys', () => {
      const a = queryKeys.profiles.detail('aaa')
      const b = queryKeys.profiles.detail('bbb')
      expect(a).not.toEqual(b)
    })

    it('search() interpolates query string', () => {
      expect(queryKeys.profiles.search('john')).toEqual(['profiles', 'search', 'john'])
    })

    it('all is a prefix of every specific key (enables invalidation)', () => {
      const { all } = queryKeys.profiles
      expect(isPrefix(all, queryKeys.profiles.me())).toBe(true)
      expect(isPrefix(all, queryKeys.profiles.detail('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.profiles.search('q'))).toBe(true)
    })
  })

  // -- servers ------------------------------------------------------------

  describe('servers', () => {
    it('all is a static key array', () => {
      expect(queryKeys.servers.all).toEqual(['servers'])
      expect(Array.isArray(queryKeys.servers.all)).toBe(true)
    })

    it('list() returns a key array', () => {
      const key = queryKeys.servers.list()
      expect(key).toEqual(['servers', 'list'])
      expect(Array.isArray(key)).toBe(true)
    })

    it('detail() interpolates serverId', () => {
      expect(queryKeys.servers.detail('s1')).toEqual(['servers', 'detail', 's1'])
    })

    it('members() interpolates serverId', () => {
      expect(queryKeys.servers.members('s1')).toEqual(['servers', 's1', 'members'])
    })

    it('channels() interpolates serverId', () => {
      expect(queryKeys.servers.channels('s1')).toEqual(['servers', 's1', 'channels'])
    })

    it('roles() interpolates serverId', () => {
      expect(queryKeys.servers.roles('s1')).toEqual(['servers', 's1', 'roles'])
    })

    it('invites() interpolates serverId', () => {
      expect(queryKeys.servers.invites('s1')).toEqual(['servers', 's1', 'invites'])
    })

    it('different IDs produce different keys', () => {
      expect(queryKeys.servers.detail('a')).not.toEqual(queryKeys.servers.detail('b'))
      expect(queryKeys.servers.members('a')).not.toEqual(queryKeys.servers.members('b'))
    })

    it('all is a prefix of every specific key (enables invalidation)', () => {
      const { all } = queryKeys.servers
      expect(isPrefix(all, queryKeys.servers.list())).toBe(true)
      expect(isPrefix(all, queryKeys.servers.detail('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.members('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.channels('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.roles('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.servers.invites('x'))).toBe(true)
    })
  })

  // -- channels -----------------------------------------------------------

  describe('channels', () => {
    it('all is a static key array', () => {
      expect(queryKeys.channels.all).toEqual(['channels'])
      expect(Array.isArray(queryKeys.channels.all)).toBe(true)
    })

    it('byServer() interpolates serverId', () => {
      expect(queryKeys.channels.byServer('s1')).toEqual(['channels', 'server', 's1'])
    })

    it('detail() interpolates channelId', () => {
      expect(queryKeys.channels.detail('c1')).toEqual(['channels', 'detail', 'c1'])
    })

    it('different IDs produce different keys', () => {
      expect(queryKeys.channels.byServer('a')).not.toEqual(queryKeys.channels.byServer('b'))
      expect(queryKeys.channels.detail('a')).not.toEqual(queryKeys.channels.detail('b'))
    })

    it('all is a prefix of every specific key (enables invalidation)', () => {
      const { all } = queryKeys.channels
      expect(isPrefix(all, queryKeys.channels.byServer('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.channels.detail('x'))).toBe(true)
    })
  })

  // -- messages -----------------------------------------------------------

  describe('messages', () => {
    it('all is a static key array', () => {
      expect(queryKeys.messages.all).toEqual(['messages'])
      expect(Array.isArray(queryKeys.messages.all)).toBe(true)
    })

    it('byChannel() interpolates channelId', () => {
      expect(queryKeys.messages.byChannel('c1')).toEqual(['messages', 'channel', 'c1'])
    })

    it('detail() interpolates messageId', () => {
      expect(queryKeys.messages.detail('m1')).toEqual(['messages', 'detail', 'm1'])
    })

    it('different IDs produce different keys', () => {
      expect(queryKeys.messages.byChannel('a')).not.toEqual(queryKeys.messages.byChannel('b'))
      expect(queryKeys.messages.detail('a')).not.toEqual(queryKeys.messages.detail('b'))
    })

    it('all is a prefix of every specific key (enables invalidation)', () => {
      const { all } = queryKeys.messages
      expect(isPrefix(all, queryKeys.messages.byChannel('x'))).toBe(true)
      expect(isPrefix(all, queryKeys.messages.detail('x'))).toBe(true)
    })
  })

  // -- cross-domain isolation ---------------------------------------------

  describe('cross-domain isolation', () => {
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
  })
})
