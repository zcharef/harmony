/**
 * Full-screen About page — shows version, commit, links, and project info.
 *
 * WHY: Follows the same full-screen replacement pattern as ServerSettings
 * (main-layout.tsx:258-266). Accessible from the Info icon in the server sidebar.
 */

import { Button, Card, CardBody, Chip, Divider, Link } from '@heroui/react'
import { Bug, ExternalLink, Github, Heart, Star, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAboutUiStore } from '@/lib/about-ui-store'
import { buildInfo } from '@/lib/build-info'

const GITHUB_URL = 'https://github.com/zcharef/harmony'
const ISSUES_URL = 'https://github.com/zcharef/harmony/issues'
const CONTRIBUTING_URL = 'https://github.com/zcharef/harmony/blob/main/CONTRIBUTING.md'
const SPONSOR_URL = 'https://github.com/sponsors/zcharef'
const COMMIT_URL = `https://github.com/zcharef/harmony/commit/${buildInfo.commitSha}`
const LICENSE_URL = 'https://github.com/zcharef/harmony/blob/main/LICENSE'

const TECH_STACK = ['Rust', 'React', 'Tauri', 'Supabase', 'TypeScript', 'Tailwind CSS']

export function AboutPage() {
  const { t } = useTranslation('about')
  const closeAboutPage = useAboutUiStore((s) => s.closeAboutPage)

  // WHY: Escape key closes the about page — matches user expectation for fullscreen overlays.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeAboutPage()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeAboutPage])

  return (
    <div className="relative flex h-screen w-full flex-col items-center overflow-y-auto bg-background px-6 py-12">
      {/* Close button — top-right, same pattern as server-settings.tsx:92-101 */}
      <Button
        variant="light"
        isIconOnly
        size="sm"
        onPress={closeAboutPage}
        aria-label={t('close')}
        className="absolute right-4 top-4"
        data-test="close-about-button"
      >
        <X className="h-5 w-5 text-default-500" />
      </Button>

      <div className="flex w-full max-w-lg flex-col items-center gap-8">
        {/* Header: Logo + Version */}
        <div className="flex flex-col items-center gap-4">
          <img src="/brand/logo_vertical_dark.png" alt="Harmony" className="h-24 w-auto" />
          <div className="flex items-center gap-2">
            <Chip color="primary" variant="flat" size="sm">
              {t('version')} {buildInfo.version}
            </Chip>
            <Link href={COMMIT_URL} isExternal>
              <Chip variant="flat" size="sm" className="cursor-pointer">
                {buildInfo.commitSha}
              </Chip>
            </Link>
          </div>
          <p className="text-center text-default-500">{t('tagline')}</p>
        </div>

        <Divider />

        {/* Quick Links */}
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t('linksTitle')}</h2>
          <div className="flex gap-3">
            <Button
              as={Link}
              href={GITHUB_URL}
              isExternal
              variant="flat"
              startContent={<Github className="h-4 w-4" />}
              endContent={<ExternalLink className="h-3 w-3" />}
              size="sm"
            >
              {t('github')}
            </Button>
            <Button
              as={Link}
              href={ISSUES_URL}
              isExternal
              variant="flat"
              color="warning"
              startContent={<Bug className="h-4 w-4" />}
              endContent={<ExternalLink className="h-3 w-3" />}
              size="sm"
            >
              {t('reportBug')}
            </Button>
          </div>
        </div>

        <Divider />

        {/* Support Us */}
        <div className="flex w-full flex-col gap-3">
          <h2 className="text-center text-sm font-semibold text-foreground">{t('supportTitle')}</h2>

          <Card className="border border-divider bg-content1">
            <CardBody className="flex flex-col gap-4 p-4">
              <SupportRow
                icon={<Star className="h-4 w-4 text-warning" />}
                description={t('starDescription')}
                buttonLabel={t('starButton')}
                href={GITHUB_URL}
              />
              <Divider />
              <SupportRow
                icon={<Github className="h-4 w-4 text-default-500" />}
                description={t('contributeDescription')}
                buttonLabel={t('contributeButton')}
                href={CONTRIBUTING_URL}
              />
              <Divider />
              <SupportRow
                icon={<Heart className="h-4 w-4 text-danger" />}
                description={t('sponsorDescription')}
                buttonLabel={t('sponsorButton')}
                href={SPONSOR_URL}
              />
            </CardBody>
          </Card>
        </div>

        <Divider />

        {/* Built With */}
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t('builtWith')}</h2>
          <div className="flex flex-wrap justify-center gap-2">
            {TECH_STACK.map((tech) => (
              <Chip key={tech} variant="flat" size="sm">
                {tech}
              </Chip>
            ))}
          </div>
        </div>

        <Divider />

        {/* License + Footer */}
        <div className="flex flex-col items-center gap-2 pb-8">
          <Link
            href={LICENSE_URL}
            isExternal
            className="text-xs text-default-500 hover:text-foreground"
          >
            {t('license')}
          </Link>
          <p className="text-xs text-default-400">{t('madeWith')}</p>
        </div>
      </div>
    </div>
  )
}

function SupportRow({
  icon,
  description,
  buttonLabel,
  href,
}: {
  icon: React.ReactNode
  description: string
  buttonLabel: string
  href: string
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="shrink-0">{icon}</div>
      <p className="min-w-0 flex-1 text-sm text-default-500">{description}</p>
      <Button
        as={Link}
        href={href}
        isExternal
        variant="flat"
        size="sm"
        className="shrink-0"
        endContent={<ExternalLink className="h-3 w-3" />}
      >
        {buttonLabel}
      </Button>
    </div>
  )
}
