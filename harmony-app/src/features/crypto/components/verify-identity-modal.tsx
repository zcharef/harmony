/**
 * Verify Identity Modal — allows users to compare safety numbers and set trust level.
 *
 * WHY: Signal-style identity verification. Both users see the same 75-digit
 * safety number (15 groups of 5). Comparing it out-of-band (in person, phone)
 * confirms that no MITM attack is occurring.
 *
 * Only rendered on desktop (caller must guard with isTauri()).
 */

import {
  Button,
  Divider,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react'
import { Ban, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TrustLevel } from '@/lib/crypto-cache'

interface VerifyIdentityModalProps {
  isOpen: boolean
  onClose: () => void
  recipientName: string
  safetyNumber: string | null
  isLoadingSafetyNumber: boolean
  trustLevel: TrustLevel
  onSetTrustLevel: (level: TrustLevel) => Promise<void>
}

export function VerifyIdentityModal({
  isOpen,
  onClose,
  recipientName,
  safetyNumber,
  isLoadingSafetyNumber,
  trustLevel,
  onSetTrustLevel,
}: VerifyIdentityModalProps) {
  const { t } = useTranslation('crypto')

  async function handleVerify() {
    await onSetTrustLevel('verified')
    onClose()
  }

  async function handleBlock() {
    await onSetTrustLevel('blocked')
    onClose()
  }

  async function handleUnblock() {
    await onSetTrustLevel('unverified')
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <span>{t('verifyIdentityTitle', { name: recipientName })}</span>
          <span className="text-sm font-normal text-default-500">
            {t('verifyIdentityDescription')}
          </span>
        </ModalHeader>

        <ModalBody>
          {isLoadingSafetyNumber && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {safetyNumber !== null && isLoadingSafetyNumber === false && (
            <div className="rounded-lg bg-default-100 p-4">
              <p className="mb-2 text-xs font-medium text-default-500">{t('safetyNumberLabel')}</p>
              <p
                className="text-center font-mono text-lg leading-relaxed tracking-wider text-foreground"
                data-test="safety-number"
              >
                {safetyNumber}
              </p>
            </div>
          )}

          {safetyNumber === null && isLoadingSafetyNumber === false && (
            <p className="py-4 text-center text-sm text-default-500">
              {t('safetyNumberUnavailable')}
            </p>
          )}

          <Divider />

          <p className="text-xs text-default-500">{t('verifyInstructions')}</p>
        </ModalBody>

        <ModalFooter className="flex-col gap-2 sm:flex-row">
          {trustLevel === 'blocked' ? (
            <Button
              variant="flat"
              color="default"
              className="w-full sm:w-auto"
              onPress={handleUnblock}
            >
              {t('unblock')}
            </Button>
          ) : (
            <Button
              variant="flat"
              color="danger"
              startContent={<Ban className="h-4 w-4" />}
              className="w-full sm:w-auto"
              onPress={handleBlock}
            >
              {t('blockContact')}
            </Button>
          )}

          {trustLevel !== 'blocked' && (
            <Button
              color="success"
              startContent={<ShieldCheck className="h-4 w-4" />}
              className="w-full sm:w-auto"
              isDisabled={safetyNumber === null}
              onPress={handleVerify}
            >
              {trustLevel === 'verified' ? t('reverify') : t('markVerified')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
