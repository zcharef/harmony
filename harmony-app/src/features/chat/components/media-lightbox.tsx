import { Button, Modal, ModalBody, ModalContent } from '@heroui/react'
import { ExternalLink, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Centered, dark-backdrop preview for an in-message media item (image/GIF or
 * video), shown at natural size capped to the viewport (90vh/90vw). Built on
 * the app-wide HeroUI `Modal` (free backdrop + centering + focus trap +
 * `Esc`/backdrop-click close).
 *
 * WHY a secondary "open original" instead of the old primary popup: the
 * security gate (`ExternalLinkWarning`) still matters for arbitrary content
 * URLs, but it should not stand between the user and simply *viewing* their own
 * media. It is demoted here to an explicit opt-in action that routes back
 * through the caller's existing gate (`onOpenOriginal`).
 */
interface MediaLightboxProps {
  isOpen: boolean
  onClose: () => void
  src: string
  alt: string
  /** Derived by the caller from the mime/extension — never inferred here. */
  kind: 'image' | 'video'
  /** Secondary action: routes back through the caller's existing link gate. */
  onOpenOriginal: () => void
}

export function MediaLightbox({
  isOpen,
  onClose,
  src,
  alt,
  kind,
  onOpenOriginal,
}: MediaLightboxProps) {
  const { t } = useTranslation('messages')
  const label =
    alt === '' ? t(kind === 'image' ? 'lightbox.imageLabel' : 'lightbox.videoLabel') : alt

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="5xl"
      backdrop="blur"
      placement="center"
      hideCloseButton
      // WHY transparent/fit base: the media, not a card, should dominate the
      // dark backdrop; the viewport cap lives on the media element itself.
      classNames={{ base: 'max-w-fit bg-transparent shadow-none', body: 'p-0' }}
      data-test="media-lightbox"
    >
      <ModalContent>
        <ModalBody className="flex flex-col items-center gap-2">
          <div className="flex w-full items-center justify-end gap-1">
            <Button
              size="sm"
              variant="flat"
              onPress={onOpenOriginal}
              startContent={<ExternalLink className="h-4 w-4" />}
              data-test="lightbox-open-original"
            >
              {t('lightbox.openOriginal')}
            </Button>
            <Button
              isIconOnly
              size="sm"
              variant="flat"
              onPress={onClose}
              aria-label={t('lightbox.close')}
              data-test="lightbox-close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {kind === 'image' ? (
            <img
              src={src}
              alt={label}
              draggable={false}
              data-test="lightbox-image"
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            />
          ) : (
            // WHY no close-on-click on the media: play/scrub/seek clicks must
            // reach the native controls, never dismiss the lightbox.
            // biome-ignore lint/a11y/useMediaCaption: user-uploaded media has no caption track.
            <video
              src={src}
              controls
              autoPlay
              aria-label={label}
              data-test="lightbox-video"
              className="max-h-[90vh] max-w-[90vw] rounded-lg"
            />
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
