import { ROUTES } from '@/lib/routes'

describe('ROUTES', () => {
  // ── home ──────────────────────────────────────────────────────────

  describe('home', () => {
    it('returns root path', () => {
      expect(ROUTES.home()).toBe('/')
    })

    it('starts with /', () => {
      expect(ROUTES.home().startsWith('/')).toBe(true)
    })
  })

  // ── servers ───────────────────────────────────────────────────────

  describe('servers', () => {
    it('detail() interpolates serverId', () => {
      expect(ROUTES.servers.detail('s1')).toBe('/servers/s1')
    })

    it('detail() with different IDs produces different routes', () => {
      expect(ROUTES.servers.detail('aaa')).not.toBe(ROUTES.servers.detail('bbb'))
    })

    it('detail() starts with /', () => {
      expect(ROUTES.servers.detail('s1').startsWith('/')).toBe(true)
    })

    it('channels.detail() interpolates both serverId and channelId', () => {
      expect(ROUTES.servers.channels.detail('s1', 'c1')).toBe('/servers/s1/channels/c1')
    })

    it('channels.detail() with different params produces different routes', () => {
      const a = ROUTES.servers.channels.detail('s1', 'c1')
      const b = ROUTES.servers.channels.detail('s1', 'c2')
      const c = ROUTES.servers.channels.detail('s2', 'c1')
      expect(a).not.toBe(b)
      expect(a).not.toBe(c)
    })

    it('channels.detail() starts with /', () => {
      expect(ROUTES.servers.channels.detail('s1', 'c1').startsWith('/')).toBe(true)
    })

    it('channel route contains server detail route as prefix', () => {
      const serverRoute = ROUTES.servers.detail('s1')
      const channelRoute = ROUTES.servers.channels.detail('s1', 'c1')
      expect(channelRoute.startsWith(serverRoute)).toBe(true)
    })
  })

  // ── settings ──────────────────────────────────────────────────────

  describe('settings', () => {
    it('root() returns /settings', () => {
      expect(ROUTES.settings.root()).toBe('/settings')
    })

    it('profile() returns /settings/profile', () => {
      expect(ROUTES.settings.profile()).toBe('/settings/profile')
    })

    it('appearance() returns /settings/appearance', () => {
      expect(ROUTES.settings.appearance()).toBe('/settings/appearance')
    })

    it('all settings routes start with /', () => {
      expect(ROUTES.settings.root().startsWith('/')).toBe(true)
      expect(ROUTES.settings.profile().startsWith('/')).toBe(true)
      expect(ROUTES.settings.appearance().startsWith('/')).toBe(true)
    })

    it('profile and appearance routes are prefixed by settings root', () => {
      const root = ROUTES.settings.root()
      expect(ROUTES.settings.profile().startsWith(root)).toBe(true)
      expect(ROUTES.settings.appearance().startsWith(root)).toBe(true)
    })
  })

  // ── auth ──────────────────────────────────────────────────────────

  describe('auth', () => {
    it('login() returns /login', () => {
      expect(ROUTES.auth.login()).toBe('/login')
    })

    it('register() returns /register', () => {
      expect(ROUTES.auth.register()).toBe('/register')
    })

    it('all auth routes start with /', () => {
      expect(ROUTES.auth.login().startsWith('/')).toBe(true)
      expect(ROUTES.auth.register().startsWith('/')).toBe(true)
    })
  })

  // ── route uniqueness ─────────────────────────────────────────────

  describe('uniqueness', () => {
    it('all static routes produce unique paths', () => {
      const routes = [
        ROUTES.home(),
        ROUTES.settings.root(),
        ROUTES.settings.profile(),
        ROUTES.settings.appearance(),
        ROUTES.auth.login(),
        ROUTES.auth.register(),
      ]
      const unique = new Set(routes)
      expect(unique.size).toBe(routes.length)
    })
  })
})
