/**
 * Static external URLs — SSoT for all outbound links in the UI.
 *
 * WHY centralized: The no-hardcoded-URLs arch test prevents scattered URLs
 * across feature code. This file is the canonical home for all static
 * display links (not API URLs — those come from env.ts).
 */

export const EXTERNAL_LINKS = {
  WEB_APP: 'https://app.joinharmony.app',
  GITHUB_RELEASES: 'https://github.com/zcharef/harmony/releases',
} as const
