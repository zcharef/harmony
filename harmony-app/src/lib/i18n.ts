import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import auth from '@/lib/locales/en/auth.json'
import channels from '@/lib/locales/en/channels.json'
import chat from '@/lib/locales/en/chat.json'
import common from '@/lib/locales/en/common.json'
import members from '@/lib/locales/en/members.json'
import messages from '@/lib/locales/en/messages.json'
import servers from '@/lib/locales/en/servers.json'
import { logger } from '@/lib/logger'

export const defaultNS = 'common' as const

export const resources = {
  en: {
    common,
    auth,
    chat,
    messages,
    channels,
    servers,
    members,
  },
} as const

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common', 'auth', 'chat', 'messages', 'channels', 'servers', 'members'],
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

export default i18n
