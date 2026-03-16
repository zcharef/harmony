export interface Server {
  id: string
  name: string
  imageUrl?: string
  initials: string
}

export interface Channel {
  id: string
  name: string
  type: 'text' | 'voice'
}

export interface ChannelCategory {
  id: string
  name: string
  channels: Channel[]
}

export interface Message {
  id: string
  authorName: string
  authorAvatar?: string
  authorInitials: string
  content: string
  timestamp: string
}

export interface Member {
  id: string
  name: string
  avatar?: string
  initials: string
  status: 'online' | 'idle' | 'dnd' | 'offline'
  role: string
}

export const servers: Server[] = [
  { id: 'home', name: 'Direct Messages', initials: 'DM' },
  { id: '1', name: 'Tailwind CSS', initials: 'TW' },
  { id: '2', name: 'TypeScript', initials: 'TS' },
  { id: '3', name: 'React Developers', initials: 'RD' },
  { id: '4', name: 'Rust Lang', initials: 'RS' },
  { id: '5', name: 'Design Systems', initials: 'DS' },
  { id: '6', name: 'Open Source', initials: 'OS' },
  { id: '7', name: 'Gaming Hub', initials: 'GH' },
]

export const channelCategories: ChannelCategory[] = [
  {
    id: 'cat-1',
    name: 'Text Channels',
    channels: [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'introductions', type: 'text' },
      { id: 'ch-3', name: 'help', type: 'text' },
      { id: 'ch-4', name: 'showcase', type: 'text' },
    ],
  },
  {
    id: 'cat-2',
    name: 'Voice Channels',
    channels: [
      { id: 'ch-5', name: 'General Voice', type: 'voice' },
      { id: 'ch-6', name: 'Music', type: 'voice' },
      { id: 'ch-7', name: 'Pair Programming', type: 'voice' },
    ],
  },
]

export const messages: Message[] = [
  {
    id: 'msg-1',
    authorName: 'Sarah Chen',
    authorInitials: 'SC',
    content:
      'Hey everyone! Just pushed the new component library. Check it out and let me know what you think.',
    timestamp: 'Today at 10:32 AM',
  },
  {
    id: 'msg-2',
    authorName: 'Marcus Johnson',
    authorInitials: 'MJ',
    content:
      'Nice work Sarah! The button variants look really clean. I especially like the ghost variant.',
    timestamp: 'Today at 10:35 AM',
  },
  {
    id: 'msg-3',
    authorName: 'Aisha Patel',
    authorInitials: 'AP',
    content:
      "I've been testing the responsive breakpoints. Everything looks solid on mobile. One question though - should we add a `compact` size variant for the sidebar?",
    timestamp: 'Today at 10:41 AM',
  },
  {
    id: 'msg-4',
    authorName: 'Tom Rivera',
    authorInitials: 'TR',
    content:
      'Just reviewed the PR. Left a few comments on the tooltip positioning. Otherwise LGTM!',
    timestamp: 'Today at 11:02 AM',
  },
  {
    id: 'msg-5',
    authorName: 'Sarah Chen',
    authorInitials: 'SC',
    content:
      "Thanks Tom! I'll address those comments this afternoon. The tooltip z-index issue was a known thing, I'll bump it up.",
    timestamp: 'Today at 11:05 AM',
  },
  {
    id: 'msg-6',
    authorName: 'Lena Kowalski',
    authorInitials: 'LK',
    content:
      "Has anyone tried the new scroll area component? It's silky smooth. Great job on the custom scrollbar styling.",
    timestamp: 'Today at 11:15 AM',
  },
  {
    id: 'msg-7',
    authorName: 'Marcus Johnson',
    authorInitials: 'MJ',
    content: 'Yep! Used it in the member list panel. Works perfectly with virtualization too.',
    timestamp: 'Today at 11:18 AM',
  },
  {
    id: 'msg-8',
    authorName: 'Dev Bot',
    authorInitials: 'DB',
    content: 'Build #1847 passed. All 342 tests green. Coverage: 94.2%',
    timestamp: 'Today at 11:30 AM',
  },
  {
    id: 'msg-9',
    authorName: 'Aisha Patel',
    authorInitials: 'AP',
    content:
      "Quick heads up - I'm refactoring the resizable panel logic. The handle hitbox was too small on touch devices. Should be done by EOD.",
    timestamp: 'Today at 12:01 PM',
  },
  {
    id: 'msg-10',
    authorName: 'Tom Rivera',
    authorInitials: 'TR',
    content:
      'Good catch Aisha. I noticed that on my tablet too. Maybe we should add a hover indicator as well?',
    timestamp: 'Today at 12:05 PM',
  },
]

export const members: Member[] = [
  { id: 'm-1', name: 'Sarah Chen', initials: 'SC', status: 'online', role: 'Admin' },
  { id: 'm-2', name: 'Marcus Johnson', initials: 'MJ', status: 'online', role: 'Admin' },
  { id: 'm-3', name: 'Aisha Patel', initials: 'AP', status: 'online', role: 'Moderator' },
  { id: 'm-4', name: 'Tom Rivera', initials: 'TR', status: 'online', role: 'Moderator' },
  { id: 'm-5', name: 'Lena Kowalski', initials: 'LK', status: 'idle', role: 'Member' },
  { id: 'm-6', name: 'Dev Bot', initials: 'DB', status: 'online', role: 'Bot' },
  { id: 'm-7', name: 'James Wilson', initials: 'JW', status: 'dnd', role: 'Member' },
  { id: 'm-8', name: 'Nina Olsen', initials: 'NO', status: 'offline', role: 'Member' },
  { id: 'm-9', name: 'Carlos Diaz', initials: 'CD', status: 'offline', role: 'Member' },
  { id: 'm-10', name: 'Priya Sharma', initials: 'PS', status: 'offline', role: 'Member' },
  { id: 'm-11', name: 'Alex Turner', initials: 'AT', status: 'offline', role: 'Member' },
  { id: 'm-12', name: 'Mei Lin', initials: 'ML', status: 'offline', role: 'Member' },
]

export const currentUser = {
  name: 'You',
  discriminator: '#0001',
  initials: 'YO',
  status: 'online' as const,
}
