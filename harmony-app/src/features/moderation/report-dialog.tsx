import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Radio,
  RadioGroup,
  Textarea,
} from '@heroui/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReportReason } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { toast } from '@/lib/toast'
import { useReportMessage } from './hooks/use-report-message'

interface ReportDialogProps {
  isOpen: boolean
  onClose: () => void
  channelId: string
  messageId: string
}

const REASONS: ReportReason[] = ['spam', 'harassment', 'nsfw', 'violence', 'other']
const REASON_SET = new Set<string>(REASONS)
const MAX_DETAIL = 512

/** Narrow a RadioGroup string value to `ReportReason` without an `as` cast. */
function isReportReason(value: string): value is ReportReason {
  return REASON_SET.has(value)
}

export function ReportDialog({ isOpen, onClose, channelId, messageId }: ReportDialogProps) {
  const { t } = useTranslation('moderation')
  const report = useReportMessage()
  const [reason, setReason] = useState<ReportReason>('spam')
  const [detail, setDetail] = useState('')

  function handleClose() {
    setReason('spam')
    setDetail('')
    report.reset()
    onClose()
  }

  function handleSubmit() {
    const trimmed = detail.trim()
    report.mutate(
      {
        channelId,
        messageId,
        reason,
        detail: trimmed.length > 0 ? trimmed : undefined,
      },
      {
        onSuccess: () => {
          toast.success(t('reportSubmitted'))
          handleClose()
        },
      },
    )
  }

  const detailRequired = reason === 'other'
  const submitDisabled = report.isPending || (detailRequired && detail.trim().length === 0)

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="sm" data-test="report-dialog">
      <ModalContent>
        <ModalHeader>{t('reportMessage')}</ModalHeader>
        <ModalBody>
          <RadioGroup
            label={t('reportReasonLabel')}
            value={reason}
            onValueChange={(v) => {
              if (isReportReason(v)) setReason(v)
            }}
          >
            {REASONS.map((r) => (
              <Radio key={r} value={r} data-test={`report-reason-${r}`}>
                {t(`reason.${r}`)}
              </Radio>
            ))}
          </RadioGroup>
          <Textarea
            label={t('reportDetailLabel')}
            placeholder={detailRequired ? t('reportDetailRequired') : t('reportDetailPlaceholder')}
            maxLength={MAX_DETAIL}
            value={detail}
            onValueChange={setDetail}
            minRows={2}
            maxRows={4}
            data-test="report-detail-input"
          />
          {report.isError && (
            <p className="text-sm text-danger" data-test="report-error">
              {getApiErrorDetail(report.error, t('reportFailed'))}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={handleClose} data-test="report-cancel">
            {t('common:cancel')}
          </Button>
          <Button
            color="primary"
            onPress={handleSubmit}
            isLoading={report.isPending}
            isDisabled={submitDisabled}
            data-test="report-submit"
          >
            {t('reportSubmit')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
