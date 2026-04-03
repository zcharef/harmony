import { Chip, Spinner, Switch } from '@heroui/react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useModerationSettings } from './hooks/use-moderation-settings'
import { useRealtimeModerationSettings } from './hooks/use-realtime-moderation-settings'
import { useUpdateModerationSettings } from './hooks/use-update-moderation-settings'

/** WHY: Human-readable labels for OpenAI category machine names. */
const CATEGORY_LABELS: Record<string, { label: string; description: string }> = {
  violence: {
    label: 'Violence',
    description: 'Auto-delete messages with violent content (may affect gaming banter)',
  },
  harassment: {
    label: 'Harassment',
    description: 'Auto-delete messages containing harassment',
  },
  'harassment/threatening': {
    label: 'Threatening Harassment',
    description: 'Auto-delete threatening harassment',
  },
  hate: {
    label: 'Hate Speech',
    description: 'Auto-delete hate speech content',
  },
  'hate/threatening': {
    label: 'Threatening Hate Speech',
    description: 'Auto-delete threatening hate speech',
  },
  sexual: {
    label: 'Sexual Content',
    description: 'Auto-delete sexual content',
  },
  'self-harm': {
    label: 'Self-Harm Discussion',
    description: 'Auto-delete self-harm discussion (instructions/intent are always blocked)',
  },
}

const TIER1_LABELS: Record<string, string> = {
  'self-harm/instructions': 'Self-Harm Instructions',
  'self-harm/intent': 'Self-Harm Intent',
  'sexual/minors': 'Child Sexual Abuse Material',
  'violence/graphic': 'Graphic Violence',
}

interface ModerationTabProps {
  serverId: string
  isOwner: boolean
}

export function ModerationTab({ serverId, isOwner }: ModerationTabProps) {
  const { t } = useTranslation('settings')
  const { data, isPending } = useModerationSettings(serverId)
  const updateSettings = useUpdateModerationSettings(serverId)
  useRealtimeModerationSettings(serverId)

  function handleCategoryToggle(category: string, enabled: boolean) {
    if (!data) return

    // WHY: Replace semantics — send full desired state, not a merge.
    const updated = { ...data.categories, [category]: enabled }
    updateSettings.mutate({ categories: updated })
  }

  if (isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Tier 1: Always enforced */}
      <section>
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <ShieldCheck className="h-5 w-5 text-danger" />
            {t('moderationTier1Title', { defaultValue: 'Safety Categories (Always Enforced)' })}
          </h2>
          <p className="mt-1 text-sm text-default-500">
            {t('moderationTier1Description', {
              defaultValue: 'These categories are always active and cannot be disabled.',
            })}
          </p>
        </div>
        <div className="space-y-2">
          {data?.tier1Categories.map((category) => (
            <div
              key={category}
              className="flex items-center gap-3 rounded-lg bg-danger-50 px-4 py-3"
              data-test={`tier1-category-${category}`}
            >
              <ShieldAlert className="h-4 w-4 shrink-0 text-danger" />
              <span className="text-sm font-medium text-foreground">
                {TIER1_LABELS[category] ?? category}
              </span>
              <Chip size="sm" color="danger" variant="flat" className="ml-auto">
                {t('moderationAlwaysOn', { defaultValue: 'Always On' })}
              </Chip>
            </div>
          ))}
        </div>
      </section>

      {/* Tier 2: Configurable */}
      <section>
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {t('moderationTier2Title', { defaultValue: 'Configurable Categories' })}
          </h2>
          <p className="mt-1 text-sm text-default-500">
            {t('moderationTier2Description', {
              defaultValue: 'Enable auto-deletion for specific content types. Off by default.',
            })}
          </p>
          {!isOwner && (
            <p className="mt-2 text-xs text-warning">
              {t('moderationOwnerOnly', {
                defaultValue: 'Only the server owner can change these settings.',
              })}
            </p>
          )}
        </div>
        <div className="space-y-1">
          {data?.tier2Available.map((category) => {
            const info = CATEGORY_LABELS[category]
            const isEnabled = data.categories[category] === true

            return (
              <div
                key={category}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-default-50"
                data-test={`tier2-category-${category}`}
              >
                <div className="flex-1">
                  <span className="text-sm font-medium text-foreground">
                    {info?.label ?? category}
                  </span>
                  {info?.description !== undefined && (
                    <p className="text-xs text-default-400">{info.description}</p>
                  )}
                </div>
                <Switch
                  size="sm"
                  isSelected={isEnabled}
                  isDisabled={!isOwner || updateSettings.isPending}
                  onValueChange={(value) => handleCategoryToggle(category, value)}
                  aria-label={info?.label ?? category}
                  data-test={`moderation-toggle-${category}`}
                />
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
