import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { useCreateInvite } from './hooks/use-create-invite'

function getExpiryOptions(t: TFunction<'servers'>) {
  return [
    { label: t('expiry30min'), value: '0.5' },
    { label: t('expiry1h'), value: '1' },
    { label: t('expiry6h'), value: '6' },
    { label: t('expiry12h'), value: '12' },
    { label: t('expiry1d'), value: '24' },
    { label: t('expiry7d'), value: '168' },
    { label: t('expiryNever'), value: '' },
  ] as const
}

const createInviteSchema = z.object({
  maxUses: z.string(),
  expiresInHours: z.string(),
})

type CreateInviteForm = z.infer<typeof createInviteSchema>

interface CreateInviteDialogProps {
  serverId: string
  isOpen: boolean
  onClose: () => void
}

export function CreateInviteDialog({ serverId, isOpen, onClose }: CreateInviteDialogProps) {
  const { t } = useTranslation('servers')
  const createInvite = useCreateInvite(serverId)
  const [generatedCode, setGeneratedCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const expiryOptions = getExpiryOptions(t)

  const { register, handleSubmit, reset } = useForm<CreateInviteForm>({
    resolver: zodResolver(createInviteSchema),
    defaultValues: { maxUses: '', expiresInHours: '24' },
  })

  function onSubmit(values: CreateInviteForm) {
    const maxUses = values.maxUses === '' ? null : Number(values.maxUses)
    const expiresInHours = values.expiresInHours === '' ? null : Number(values.expiresInHours)

    createInvite.mutate(
      { maxUses, expiresInHours },
      {
        onSuccess: (data) => {
          setGeneratedCode(data.code)
        },
      },
    )
  }

  function handleCopy() {
    if (generatedCode === null) return
    navigator.clipboard.writeText(generatedCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleClose() {
    reset()
    setGeneratedCode(null)
    setCopied(false)
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="create-invite-dialog">
      <ModalContent>
        {generatedCode !== null ? (
          <>
            <ModalHeader>{t('yourInviteCode')}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-default-500">{t('shareInviteCode')}</p>
              <div className="flex items-center gap-2">
                <Input
                  value={generatedCode}
                  isReadOnly
                  variant="bordered"
                  classNames={{ input: 'font-mono text-lg' }}
                  data-test="invite-code-display"
                />
                <Button
                  isIconOnly
                  variant="flat"
                  onPress={handleCopy}
                  data-test="invite-copy-button"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button color="primary" onPress={handleClose} data-test="invite-done-button">
                {t('common:done')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)}>
            <ModalHeader>{t('invitePeople')}</ModalHeader>
            <ModalBody>
              <Input
                label={t('maxUses')}
                placeholder={t('maxUsesPlaceholder')}
                type="number"
                min={1}
                data-test="invite-max-uses-input"
                {...register('maxUses')}
              />
              <Select
                label={t('expireAfter')}
                defaultSelectedKeys={['24']}
                data-test="invite-expires-select"
                {...register('expiresInHours')}
              >
                {expiryOptions.map((option) => (
                  <SelectItem key={option.value}>{option.label}</SelectItem>
                ))}
              </Select>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={handleClose} data-test="invite-cancel-button">
                {t('common:cancel')}
              </Button>
              <Button
                type="submit"
                color="primary"
                isLoading={createInvite.isPending}
                data-test="invite-submit-button"
              >
                {t('createInvite')}
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  )
}
