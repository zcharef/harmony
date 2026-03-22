import { Card, CardBody } from '@heroui/react'
import { LogIn, Plus, Shield } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CreateServerDialog, JoinServerDialog } from '@/features/server-nav'

interface WelcomeScreenProps {
  onServerCreated: (serverId: string) => void
  onServerJoined: () => void
}

export function WelcomeScreen({ onServerCreated, onServerJoined }: WelcomeScreenProps) {
  const { t } = useTranslation('servers')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [isJoinOpen, setIsJoinOpen] = useState(false)

  return (
    <div
      data-test="welcome-screen"
      className="flex h-full w-full flex-col items-center justify-center bg-background"
    >
      {/* Brand icon */}
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary/10 animate-[fade-in_0.6s_ease-out_both]">
        <Shield className="h-10 w-10 text-primary" />
      </div>

      {/* Heading */}
      <h1 className="mt-6 text-4xl font-bold tracking-tight text-foreground animate-[fade-in-up_0.5s_ease-out_0.15s_both]">
        {t('welcomeTitle')}
      </h1>

      {/* Subtitle */}
      <p className="mt-3 max-w-md text-center text-lg text-default-500 animate-[fade-in-up_0.5s_ease-out_0.25s_both]">
        {t('welcomeSubtitle')}
      </p>

      {/* Action cards */}
      <div className="mt-10 flex flex-row gap-4 animate-[fade-in-up_0.5s_ease-out_0.4s_both]">
        {/* Create Server card */}
        <Card
          data-test="welcome-create-card"
          isPressable
          onPress={() => setIsCreateOpen(true)}
          className="w-64 border border-divider bg-content1 transition-transform hover:scale-[1.02]"
        >
          <CardBody className="gap-3 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-success/10">
              <Plus className="h-6 w-6 text-success" />
            </div>
            <p className="text-lg font-semibold text-foreground">{t('welcomeCreateTitle')}</p>
            <p className="text-sm text-default-500">{t('welcomeCreateDescription')}</p>
          </CardBody>
        </Card>

        {/* Join Server card */}
        <Card
          data-test="welcome-join-card"
          isPressable
          onPress={() => setIsJoinOpen(true)}
          className="w-64 border border-divider bg-content1 transition-transform hover:scale-[1.02]"
        >
          <CardBody className="gap-3 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <LogIn className="h-6 w-6 text-primary" />
            </div>
            <p className="text-lg font-semibold text-foreground">{t('welcomeJoinTitle')}</p>
            <p className="text-sm text-default-500">{t('welcomeJoinDescription')}</p>
          </CardBody>
        </Card>
      </div>

      <CreateServerDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(serverId) => {
          setIsCreateOpen(false)
          onServerCreated(serverId)
        }}
      />

      <JoinServerDialog
        isOpen={isJoinOpen}
        onClose={() => setIsJoinOpen(false)}
        onJoined={() => {
          setIsJoinOpen(false)
          onServerJoined()
        }}
      />
    </div>
  )
}
