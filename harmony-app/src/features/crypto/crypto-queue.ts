/**
 * Sequential decryption queue — prevents concurrent Olm operations on the same session.
 *
 * WHY: Olm sessions are stateful (ratchet-based). Concurrent decrypt calls on the
 * same session corrupt the ratchet state, causing permanent message loss. This queue
 * serializes operations per session ID while allowing different sessions to run in parallel.
 */

type QueuedTask<T> = () => Promise<T>

const sessionQueues = new Map<string, Promise<unknown>>()

/**
 * Enqueue an async operation for a specific session, guaranteeing sequential execution.
 * Operations for different sessions run in parallel.
 */
export function enqueueForSession<T>(sessionId: string, task: QueuedTask<T>): Promise<T> {
  const current = sessionQueues.get(sessionId) ?? Promise.resolve()

  // WHY: Two-arg .then() only catches `current`'s rejection, not `task()`'s.
  // If task() itself fails, the error propagates to the caller — no implicit retry
  // that could corrupt the Olm ratchet.
  const next = current.then(() => task(), () => task())

  sessionQueues.set(sessionId, next)

  // WHY: Clean up the queue entry when the chain completes to prevent memory leak.
  // Only clean if this is still the latest entry (another task may have been queued).
  next.finally(() => {
    if (sessionQueues.get(sessionId) === next) {
      sessionQueues.delete(sessionId)
    }
  })

  return next
}
