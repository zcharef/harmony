/**
 * Bottom-right notification shown when a new app version is downloaded and ready.
 *
 * WHY: Tauri auto-update downloads in the background. When the app is already
 * open, we prompt the user to restart rather than interrupting their session.
 * Positioned above the AlphaBadge (bottom-2 right-2) to avoid overlap.
 */

import { Button, Card, CardBody } from '@heroui/react'
import { Download, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'

interface UpdateNotificationProps {
  version: string
  onRestart: () => void
  onDismiss: () => void
}

// WHY: AnimatePresence lives in App.tsx (the parent that controls mount/unmount).
// If it were here, exit animations would never fire — AnimatePresence unmounts
// with the component before it can orchestrate the exit.
export function UpdateNotification({ version, onRestart, onDismiss }: UpdateNotificationProps) {
  const { t } = useTranslation('common')

  return (
    <motion.div
      key="update-notification"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed bottom-12 right-3 z-50"
    >
      <Card className="w-72 border border-divider bg-content1 shadow-lg">
        <CardBody className="flex flex-row items-center gap-3 p-3">
          <Download className="h-5 w-5 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t('updateAvailable')}</p>
            <p className="text-xs text-foreground-500">{t('updatePrompt', { version })}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" color="success" variant="flat" onPress={onRestart}>
              {t('updateAction')}
            </Button>
            <Button size="sm" variant="light" isIconOnly onPress={onDismiss} aria-label={t('dismiss')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardBody>
      </Card>
    </motion.div>
  )
}
