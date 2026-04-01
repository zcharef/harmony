/**
 * Global connectivity banner -- appears when the SSE connection to the API is lost.
 *
 * WHY: SOTA apps (Discord, Slack, Apple) use a thin global banner for connectivity
 * state rather than per-panel error text. Auto-hides when connection recovers.
 * Positioned fixed to avoid disrupting the flex panel layout.
 *
 * Pattern reference: update-notification.tsx (motion/react animation pattern).
 */

import { Button } from '@heroui/react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useConnectionStatus, useConnectionStore } from '@/lib/connection-store'

export function ConnectionBanner() {
  const status = useConnectionStatus()
  const errorMessage = useConnectionStore((s) => s.errorMessage)
  const requestReconnect = useConnectionStore((s) => s.requestReconnect)
  const { t } = useTranslation('common')
  const queryClient = useQueryClient()
  const [isRetrying, setIsRetrying] = useState(false)

  // WHY: Reset retry loading state when connection status changes away from
  // 'disconnected'. Either the reconnect succeeded ('connected') or the SSE
  // is actively trying ('reconnecting'/'connecting') -- either way the button
  // should be re-enabled if it shows again.
  useEffect(() => {
    if (status !== 'disconnected') {
      setIsRetrying(false)
    }
  }, [status])

  const isVisible = status !== 'connected'

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="connection-banner"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 32, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className={`fixed top-0 right-0 left-0 z-50 flex items-center justify-center gap-2 overflow-hidden text-sm font-medium ${
            status === 'disconnected'
              ? 'bg-danger-50 text-danger-700'
              : 'bg-warning-50 text-warning-700'
          }`}
          data-test="connection-banner"
        >
          {status === 'connecting' && <Wifi className="h-3.5 w-3.5 animate-pulse" />}
          {status === 'reconnecting' && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
          {status === 'disconnected' && <WifiOff className="h-3.5 w-3.5" />}

          <span>
            {status === 'connecting' && t('connecting')}
            {status === 'reconnecting' && t('reconnecting')}
            {status === 'disconnected' && (errorMessage ?? t('connectionLost'))}
          </span>

          {status === 'disconnected' && (
            <Button
              size="sm"
              variant="flat"
              color="danger"
              className="ml-2 h-6 min-w-0 px-2 text-xs"
              isLoading={isRetrying}
              isDisabled={isRetrying}
              onPress={() => {
                setIsRetrying(true)
                requestReconnect()
                queryClient.invalidateQueries()
              }}
            >
              {t('retryNow')}
            </Button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
