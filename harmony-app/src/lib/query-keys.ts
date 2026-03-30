/**
 * Query key factory — Single Source of Truth for TanStack Query cache keys.
 *
 * WHY: Prevents hardcoded string arrays scattered across hooks,
 * enables type-safe invalidation, and makes cache operations atomic.
 *
 * Usage:
 *   queryKey: queryKeys.messages.byChannel(channelId)
 *   queryClient.invalidateQueries({ queryKey: queryKeys.messages.all })
 */

export const queryKeys = {
  profiles: {
    all: ['profiles'] as const,
    me: () => ['profiles', 'me'] as const,
    detail: (profileId: string) => ['profiles', 'detail', profileId] as const,
    search: (query: string) => ['profiles', 'search', query] as const,
  },
  servers: {
    all: ['servers'] as const,
    list: () => ['servers', 'list'] as const,
    detail: (serverId: string) => ['servers', 'detail', serverId] as const,
    members: (serverId: string) => ['servers', serverId, 'members'] as const,
    channels: (serverId: string) => ['servers', serverId, 'channels'] as const,
    roles: (serverId: string) => ['servers', serverId, 'roles'] as const,
    invites: (serverId: string) => ['servers', serverId, 'invites'] as const,
    bans: (serverId: string) => ['servers', serverId, 'bans'] as const,
  },
  channels: {
    all: ['channels'] as const,
    byServer: (serverId: string) => ['channels', 'server', serverId] as const,
    detail: (channelId: string) => ['channels', 'detail', channelId] as const,
  },
  messages: {
    all: ['messages'] as const,
    byChannel: (channelId: string) => ['messages', 'channel', channelId] as const,
    detail: (messageId: string) => ['messages', 'detail', messageId] as const,
  },
  readStates: {
    all: ['readStates'] as const,
    byServer: (serverId: string) => ['readStates', 'server', serverId] as const,
  },
  notificationSettings: {
    all: ['notificationSettings'] as const,
    byChannel: (channelId: string) => ['notificationSettings', 'channel', channelId] as const,
  },
  dms: {
    all: ['dms'] as const,
    list: () => ['dms', 'list'] as const,
  },
  crypto: {
    all: ['crypto'] as const,
    keyCount: (deviceId: string) => ['crypto', 'keyCount', deviceId] as const,
    devices: (userId: string) => ['crypto', 'devices', userId] as const,
  },
} as const
