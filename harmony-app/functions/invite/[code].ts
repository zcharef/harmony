/**
 * Cloudflare Pages Function — GET /invite/:code
 *
 * Legacy invite-link route. Delegates to the shared, route-agnostic handler so
 * it stays in lockstep with the short `/i/:code` route (functions/i/[code].ts).
 */

export { handleInviteOgRequest as onRequestGet } from './handler'
