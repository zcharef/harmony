import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import about from '@/lib/locales/en/about.json'
import auth from '@/lib/locales/en/auth.json'
import channels from '@/lib/locales/en/channels.json'
import chat from '@/lib/locales/en/chat.json'
import common from '@/lib/locales/en/common.json'
import crypto from '@/lib/locales/en/crypto.json'
import dms from '@/lib/locales/en/dms.json'
import members from '@/lib/locales/en/members.json'
import messages from '@/lib/locales/en/messages.json'
import servers from '@/lib/locales/en/servers.json'
import settings from '@/lib/locales/en/settings.json'
import { logger } from '@/lib/logger'

const defaultNS = 'common' as const

const resources = {
  en: {
    about,
    common,
    auth,
    chat,
    crypto,
    dms,
    messages,
    channels,
    servers,
    members,
    settings,
  },
} as const

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: [
    'about',
    'common',
    'auth',
    'chat',
    'crypto',
    'dms',
    'messages',
    'channels',
    'servers',
    'members',
    'settings',
  ],
  defaultNS,
  resources,
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
  saveMissing: true,
  missingKeyHandler: (_lngs, ns, key) => {
    logger.error('Missing i18n key', { ns, key })
  },
})

// WHY: Side-effect module — imported via `import '@/lib/i18n'` in main.tsx.
// No default export needed; the side-effect (i18n.init) runs on import.
