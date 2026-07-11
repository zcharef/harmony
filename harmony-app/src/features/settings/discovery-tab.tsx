import { Button, Select, SelectItem, Switch, Textarea } from '@heroui/react'
import { zodResolver } from '@hookform/resolvers/zod'
import type { TFunction } from 'i18next'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { DISCOVERY_CATEGORIES } from '@/features/discovery'
import type { ServerResponse } from '@/lib/api'
import { useUpdateServerDiscovery } from './hooks/use-update-server-discovery'

/** Mirrors the API cap on the public directory description. */
const MAX_DESCRIPTION_LENGTH = 300

function discoverySchema(t: TFunction<'settings'>) {
  return z
    .object({
      discoverable: z.boolean(),
      category: z.string(),
      description: z.string().max(MAX_DESCRIPTION_LENGTH, t('discoveryDescriptionMaxLength')),
    })
    .refine((values) => !values.discoverable || values.category !== '', {
      // WHY: The API requires a category to list a server — surface the rule
      // inline instead of round-tripping for a 400.
      message: t('discoveryCategoryRequired'),
      path: ['category'],
    })
}

type DiscoveryForm = z.infer<ReturnType<typeof discoverySchema>>

interface DiscoveryTabProps {
  server: ServerResponse
}

export function DiscoveryTab({ server }: DiscoveryTabProps) {
  const { t } = useTranslation('settings')
  const { t: tDiscovery } = useTranslation('discovery')
  const updateDiscovery = useUpdateServerDiscovery(server.id)
  const schema = discoverySchema(t)

  const {
    control,
    register,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<DiscoveryForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      discoverable: server.discoverable,
      category: server.discoveryCategory ?? '',
      description: server.discoveryDescription ?? '',
    },
  })

  const isListed = watch('discoverable')
  const description = watch('description')

  function onSubmit(values: DiscoveryForm) {
    updateDiscovery.mutate({
      discoverable: values.discoverable,
      category: values.category === '' ? null : values.category,
      description: values.description.trim() === '' ? null : values.description.trim(),
    })
  }

  return (
    <div data-test="settings-discovery" className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('discoveryTitle')}</h2>
        <p className="mt-1 text-sm text-default-500">{t('discoveryDescription')}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="max-w-lg space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">{t('discoveryToggleLabel')}</p>
            <p className="text-xs text-default-500">{t('discoveryToggleHelp')}</p>
          </div>
          <Controller
            control={control}
            name="discoverable"
            render={({ field }) => (
              <Switch
                isSelected={field.value}
                onValueChange={field.onChange}
                aria-label={t('discoveryToggleLabel')}
                data-test="discovery-toggle"
              />
            )}
          />
        </div>

        <Select
          label={t('discoveryCategoryLabel')}
          isDisabled={!isListed}
          isInvalid={errors.category !== undefined}
          errorMessage={errors.category?.message}
          defaultSelectedKeys={
            server.discoveryCategory === null || server.discoveryCategory === undefined
              ? []
              : [server.discoveryCategory]
          }
          data-test="discovery-category-select"
          {...register('category')}
        >
          {DISCOVERY_CATEGORIES.map((c) => (
            <SelectItem key={c}>{tDiscovery(`category.${c}`)}</SelectItem>
          ))}
        </Select>

        <Textarea
          label={t('discoveryDescriptionLabel')}
          placeholder={t('discoveryDescriptionPlaceholder')}
          maxLength={MAX_DESCRIPTION_LENGTH}
          description={t('discoveryDescriptionCounter', {
            count: description.length,
            max: MAX_DESCRIPTION_LENGTH,
          })}
          isDisabled={!isListed}
          isInvalid={errors.description !== undefined}
          errorMessage={errors.description?.message}
          data-test="discovery-description-input"
          {...register('description')}
        />

        <Button
          type="submit"
          color="primary"
          isLoading={updateDiscovery.isPending}
          isDisabled={isDirty === false}
          data-test="discovery-save-button"
        >
          {t('common:save')}
        </Button>
      </form>
    </div>
  )
}
