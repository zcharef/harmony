import { Button, Input } from '@heroui/react'
import { UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { addFriendErrorKey, useSendFriendRequest } from '../hooks/use-send-friend-request'

/** Mirror of the DB `CHECK` + the server rule (UX-only; the API is authoritative). */
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/)

type Feedback = { kind: 'success'; username: string } | { kind: 'error'; message: string } | null

export function AddFriendBar() {
  const { t } = useTranslation('friends')
  const [value, setValue] = useState('')
  const [feedback, setFeedback] = useState<Feedback>(null)
  const sendRequest = useSendFriendRequest()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)

    const parsed = usernameSchema.safeParse(value)
    if (!parsed.success) {
      setFeedback({ kind: 'error', message: t('invalidUsername') })
      return
    }
    const username = parsed.data

    sendRequest.mutate(
      { username },
      {
        onSuccess: (result) => {
          setValue('')
          setFeedback(
            result.state === 'alreadyFriends'
              ? { kind: 'error', message: t('alreadyFriends') }
              : { kind: 'success', username },
          )
        },
        onError: (error) => {
          setFeedback({ kind: 'error', message: t(addFriendErrorKey(error)) })
        },
      },
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onValueChange={(v) => setValue(v.toLowerCase())}
          placeholder={t('addFriendPlaceholder')}
          size="sm"
          variant="bordered"
          startContent={<UserPlus className="h-4 w-4 text-default-400" />}
          aria-label={t('addFriend')}
          data-test="add-friend-input"
        />
        <Button
          type="submit"
          color="primary"
          size="sm"
          isDisabled={value.trim().length === 0}
          isLoading={sendRequest.isPending}
          data-test="add-friend-submit"
        >
          {t('addFriend')}
        </Button>
      </div>
      {feedback !== null && (
        <p
          className={feedback.kind === 'success' ? 'text-xs text-success' : 'text-xs text-danger'}
          data-test="add-friend-feedback"
        >
          {feedback.kind === 'success'
            ? t('requestSent', { username: feedback.username })
            : feedback.message}
        </p>
      )}
    </form>
  )
}
