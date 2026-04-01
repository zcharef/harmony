import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react'
import { ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ExternalLinkWarningProps {
  isOpen: boolean
  url: string
  onClose: () => void
  onContinue: () => void
}

export function ExternalLinkWarning({
  isOpen,
  url,
  onClose,
  onContinue,
}: ExternalLinkWarningProps) {
  const { t } = useTranslation('messages')

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" data-test="external-link-warning">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-warning" />
          {t('externalLink.title')}
        </ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-600">{t('externalLink.description')}</p>

          <div className="flex flex-col gap-2 rounded-lg bg-warning-50 p-3">
            {(['phishing', 'malware', 'privacy'] as const).map((key) => (
              <div key={key} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-600" />
                <span className="text-xs text-warning-700">
                  {t(`externalLink.warnings.${key}`)}
                </span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-divider bg-default-50 p-3">
            <p className="mb-1 text-xs font-medium text-default-500">
              {t('externalLink.destination')}
            </p>
            <div className="flex items-center gap-2">
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-default-400" />
              <p
                className="break-all text-sm font-mono text-foreground"
                data-test="external-link-url"
              >
                {url}
              </p>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose} data-test="external-link-go-back">
            {t('externalLink.goBack')}
          </Button>
          <Button
            color="warning"
            variant="flat"
            onPress={onContinue}
            startContent={<ExternalLink className="h-4 w-4" />}
            data-test="external-link-continue"
          >
            {t('externalLink.continue')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
