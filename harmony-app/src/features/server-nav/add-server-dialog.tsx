import { Card, CardBody, Modal, ModalBody, ModalContent, ModalHeader } from '@heroui/react'
import { LogIn, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CreateServerForm } from './create-server-dialog'
import { JoinServerForm } from './join-server-dialog'

/** WHY a step discriminant (not booleans): CLAUDE.md forbids complex boolean state combos. */
type Step = 'choose' | 'create' | 'join'

interface AddServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (serverId: string) => void
  onJoined: (serverId: string) => void
  /** Opens the dialog straight to a step (welcome-screen cards). Defaults to the chooser. */
  initialStep?: Step
}

/** The chooser step — mirrors the Create/Join cards from welcome-screen, no template option. */
function ChooseStep({
  onCreateSelect,
  onJoinSelect,
}: {
  onCreateSelect: () => void
  onJoinSelect: () => void
}) {
  const { t } = useTranslation('servers')

  return (
    <>
      <ModalHeader>{t('addServer')}</ModalHeader>
      <ModalBody className="gap-3 pb-6">
        <Card
          data-test="add-server-create-option"
          isPressable
          onPress={onCreateSelect}
          className="w-full border border-divider bg-content1 transition-transform hover:scale-[1.01]"
        >
          <CardBody className="flex-row items-center gap-3 p-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-success/10">
              <Plus className="h-5 w-5 text-success" />
            </div>
            <div className="flex flex-col">
              <p className="text-base font-semibold text-foreground">{t('addServerCreateTitle')}</p>
              <p className="text-sm text-default-500">{t('addServerCreateDescription')}</p>
            </div>
          </CardBody>
        </Card>

        <Card
          data-test="add-server-join-option"
          isPressable
          onPress={onJoinSelect}
          className="w-full border border-divider bg-content1 transition-transform hover:scale-[1.01]"
        >
          <CardBody className="flex-row items-center gap-3 p-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10">
              <LogIn className="h-5 w-5 text-primary" />
            </div>
            <div className="flex flex-col">
              <p className="text-base font-semibold text-foreground">{t('addServerJoinTitle')}</p>
              <p className="text-sm text-default-500">{t('addServerJoinDescription')}</p>
            </div>
          </CardBody>
        </Card>
      </ModalBody>
    </>
  )
}

/**
 * The server rail's single "Add a Server" popup: a step-based modal offering
 * Create My Own / Join a Server (Discord-style), with a Back link from either
 * step to the chooser. Reuses the CreateServerForm / JoinServerForm building
 * blocks — no duplicated create/join logic.
 */
export function AddServerDialog({
  isOpen,
  onClose,
  onCreated,
  onJoined,
  initialStep = 'choose',
}: AddServerDialogProps) {
  const { t } = useTranslation('servers')
  const [step, setStep] = useState<Step>(initialStep)

  // WHY: reset to the caller's entry step each time the popup opens. The Modal
  // unmounts its content on close, but this component stays mounted (the rail
  // renders it unconditionally), so `step` would otherwise persist stale. This
  // is ephemeral UI state, not a query-derived shadow (ADR-045 does not apply).
  useEffect(() => {
    if (isOpen) setStep(initialStep)
  }, [isOpen, initialStep])

  function handleCreated(serverId: string) {
    onClose()
    onCreated(serverId)
  }

  function handleJoined(serverId: string) {
    onClose()
    onJoined(serverId)
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" data-test="add-server-dialog">
      <ModalContent>
        {step === 'choose' && (
          <ChooseStep
            onCreateSelect={() => setStep('create')}
            onJoinSelect={() => setStep('join')}
          />
        )}
        {step === 'create' && (
          <CreateServerForm
            onCreated={handleCreated}
            onCancel={() => setStep('choose')}
            cancelLabel={t('common:back')}
          />
        )}
        {step === 'join' && (
          <JoinServerForm
            onJoined={handleJoined}
            onCancel={() => setStep('choose')}
            cancelLabel={t('common:back')}
          />
        )}
      </ModalContent>
    </Modal>
  )
}
