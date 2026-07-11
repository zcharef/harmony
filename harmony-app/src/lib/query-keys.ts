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
    memberSearch: (serverId: string, q: string) =>
      ['servers', serverId, 'members', 'search', q] as const,
    channels: (serverId: string) => ['servers', serverId, 'channels'] as const,
    roles: (serverId: string) => ['servers', serverId, 'roles'] as const,
    invites: (serverId: string) => ['servers', serverId, 'invites'] as const,
    bans: (serverId: string) => ['servers', serverId, 'bans'] as const,
    moderation: (serverId: string) => ['servers', serverId, 'moderation'] as const,
    migrationProgress: (serverId: string) =>
      ['servers', serverId, 'migration', 'progress'] as const,
    migrationCohort: (serverId: string) => ['servers', serverId, 'migration', 'cohort'] as const,
  },
  channels: {
    all: ['channels'] as const,
    byServer: (serverId: string) => ['channels', 'server', serverId] as const,
    detail: (channelId: string) => ['channels', 'detail', channelId] as const,
    roleAccess: (channelId: string) => ['channels', 'roleAccess', channelId] as const,
  },
  messages: {
    all: ['messages'] as const,
    byChannel: (channelId: string) => ['messages', 'channel', channelId] as const,
    around: (channelId: string, messageId: string) =>
      ['messages', 'channel', channelId, 'around', messageId] as const,
    detail: (messageId: string) => ['messages', 'detail', messageId] as const,
  },
  readState: {
    all: ['readState'] as const,
    byChannel: (channelId: string) => ['readState', 'channel', channelId] as const,
  },
  notificationSettings: {
    all: ['notificationSettings'] as const,
    // WHY 'mine' (no per-channel keys): ONE bulk query holds every override —
    // per-channel reads select from it (single source of truth, D9).
    mine: () => ['notificationSettings', 'mine'] as const,
  },
  dms: {
    all: ['dms'] as const,
    list: () => ['dms', 'list'] as const,
  },
  friends: {
    all: ['friends'] as const,
    list: () => ['friends', 'list'] as const,
    requests: (direction: 'incoming' | 'outgoing') => ['friends', 'requests', direction] as const,
    blocks: () => ['friends', 'blocks'] as const,
  },
  crypto: {
    all: ['crypto'] as const,
    keyCount: (deviceId: string) => ['crypto', 'keyCount', deviceId] as const,
    devices: (userId: string) => ['crypto', 'devices', userId] as const,
  },
  preferences: {
    all: ['preferences'] as const,
    me: () => ['preferences', 'me'] as const,
  },
  voice: {
    all: ['voice'] as const,
    participants: (channelId: string) => ['voice', 'participants', channelId] as const,
  },
  gifs: {
    all: ['gifs'] as const,
    capability: () => ['gifs', 'capability'] as const,
    trending: () => ['gifs', 'trending'] as const,
    search: (query: string) => ['gifs', 'search', query] as const,
  },
  invites: {
    all: ['invites'] as const,
    preview: (code: string) => ['invites', 'preview', code] as const,
  },
} as const
