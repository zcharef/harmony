/**
 * Centralized route constants — Single Source of Truth (ADR-033).
 *
 * WHY: Prevents hardcoded route strings in components.
 * Builder functions provide type safety for route parameters.
 *
 * Usage: ROUTES.servers.detail('abc') → '/servers/abc'
 * NEVER: `/servers/${serverId}` in component code
 */

export const ROUTES = {
  home: () => '/' as const,

  servers: {
    detail: (serverId: string) => `/servers/${serverId}` as const,
    channels: {
      detail: (serverId: string, channelId: string) =>
        `/servers/${serverId}/channels/${channelId}` as const,
    },
  },

  settings: {
    root: () => '/settings' as const,
    profile: () => '/settings/profile' as const,
    appearance: () => '/settings/appearance' as const,
  },

  auth: {
    login: () => '/login' as const,
    register: () => '/register' as const,
  },
} as const
