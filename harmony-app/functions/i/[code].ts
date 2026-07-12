/**
 * Cloudflare Pages Function — GET /i/:code
 *
 * Short invite-link route (joinharmony.app/i/XXXXX). Delegates to the shared,
 * route-agnostic handler so `/i/` links unfurl as rich cards exactly like the
 * legacy `/invite/:code` route (functions/invite/[code].ts).
 */

export { handleInviteOgRequest as onRequestGet } from '../invite/handler'
