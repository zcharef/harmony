import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { bioSanitizeSchema } from '../lib/bio-sanitize-schema'

/**
 * Renders a profile bio as links-only markdown (ticket §5.4).
 *
 * `remark-gfm` autolinks bare URLs; `bioSanitizeSchema` strips everything but
 * anchors and paragraph/line breaks and blocks unsafe protocols. Newlines are
 * preserved via `whitespace-pre-wrap` so a multi-line bio keeps its shape.
 */
export function ProfileBio({ bio }: { bio: string }) {
  return (
    <div
      className="whitespace-pre-wrap break-words text-sm text-default-600"
      data-test="profile-bio"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, bioSanitizeSchema]]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {bio}
      </ReactMarkdown>
    </div>
  )
}
