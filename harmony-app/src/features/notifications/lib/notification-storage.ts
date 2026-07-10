/**
 * WHY localStorage (not user_preferences): browser notification permission is
 * inherently per-device, so the one-time banner dismissal is per-device too.
 */
export const NOTIF_PROMPT_DISMISSED_KEY = 'harmony:notif-prompt-dismissed'
