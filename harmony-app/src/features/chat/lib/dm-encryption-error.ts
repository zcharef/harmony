/**
 * Typed error for a genuine DM encryption failure so the send hook's `onError`
 * can surface the specific, actionable reason instead of the generic
 * "Failed to send message" (ADR-027 — no swallowed diagnostics). Mirrors the
 * `AttachmentUploadError` pattern.
 *
 * WHY it carries an already-localized message: `getApiErrorDetail` only unwraps
 * RFC 9457 ProblemDetails, so a plain thrown Error collapses to the generic
 * fallback. Tagging the failure lets `onError` pass this instance's message as
 * the toast text for the encryption case, while every other error keeps its own
 * handling (ProblemDetails detail / generic fallback).
 */
export class DmEncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DmEncryptionError'
  }
}
