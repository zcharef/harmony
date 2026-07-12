/**
 * Static external URLs — SSoT for all outbound links in the UI.
 *
 * WHY centralized: The no-hardcoded-URLs arch test prevents scattered URLs
 * across feature code. This file is the canonical home for all static
 * display links (not API URLs — those come from env.ts).
 */

export const EXTERNAL_LINKS = {
  WEB_APP: 'https://app.joinharmony.app',
  // Default host for shareable invite links (joinharmony.app/i/<code>). The apex
  // is the short, memorable share domain; deployments that serve the SPA from a
  // different host override this with VITE_INVITE_BASE_URL (see env.ts).
  INVITE_BASE: 'https://joinharmony.app',
  GITHUB_RELEASES: 'https://github.com/zcharef/harmony/releases',
  // Klipy attribution target — the "Powered by KLIPY" label links here (ToS).
  KLIPY: 'https://klipy.com',
} as const
