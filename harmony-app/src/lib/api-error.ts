/**
 * API error extraction utility.
 *
 * WHY: The @hey-api client with `throwOnError: true` throws the parsed
 * RFC 9457 ProblemDetails JSON body — a plain object, not an Error instance.
 * Every `onError` handler needs to extract the `detail` field safely,
 * showing business-logic messages (4xx) while hiding internals (5xx).
 */

/**
 * Checks whether an unknown value looks like an RFC 9457 ProblemDetails object
 * with the fields we need (status + detail).
 */
export function isProblemDetails(value: unknown): value is { status: number; detail: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof (value as Record<string, unknown>).status === 'number' &&
    'detail' in value &&
    typeof (value as Record<string, unknown>).detail === 'string'
  )
}

/**
 * Extracts a user-safe error message from a thrown API error.
 *
 * - 4xx (`status` 400–499): returns `detail` (business logic, safe to show).
 * - 5xx / unknown shape: returns `fallback` (may contain internals).
 */
export function getApiErrorDetail(error: unknown, fallback: string): string {
  if (isProblemDetails(error) && error.status >= 400 && error.status < 500) {
    return error.detail
  }
  return fallback
}
