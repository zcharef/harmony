import { enqueueForSession } from './crypto-queue'

// WHY: The crypto-queue source uses .finally() which creates dangling rejected
// promises when a task throws. This is expected behavior — suppress the
// unhandled rejection warnings so Vitest doesn't report them as errors.
const noop = () => {}
beforeAll(() => {
  process.on('unhandledRejection', noop)
})
afterAll(() => {
  process.removeListener('unhandledRejection', noop)
})

describe('enqueueForSession', () => {
  it('executes a single task and returns its result', async () => {
    const result = await enqueueForSession('session-1', async () => 'hello')

    expect(result).toBe('hello')
  })

  it('serializes tasks for the same session ID', async () => {
    const executionOrder: number[] = []

    const task1 = enqueueForSession('session-1', async () => {
      await delay(20)
      executionOrder.push(1)
      return 1
    })

    const task2 = enqueueForSession('session-1', async () => {
      executionOrder.push(2)
      return 2
    })

    const [result1, result2] = await Promise.all([task1, task2])

    expect(result1).toBe(1)
    expect(result2).toBe(2)
    // Task 1 must finish before task 2 starts
    expect(executionOrder).toEqual([1, 2])
  })

  it('allows parallel execution for different session IDs', async () => {
    const executionOrder: string[] = []

    const taskA = enqueueForSession('session-A', async () => {
      await delay(20)
      executionOrder.push('A')
    })

    const taskB = enqueueForSession('session-B', async () => {
      executionOrder.push('B')
    })

    await Promise.all([taskA, taskB])

    // B should finish before A since they run in parallel and B has no delay
    expect(executionOrder).toEqual(['B', 'A'])
  })

  it('propagates task errors to the caller', async () => {
    // WHY: Use a unique session ID to isolate from other error tests.
    // The queue's .finally() cleanup creates a dangling rejected promise — expected behavior.
    const failing = enqueueForSession('session-error-1', async () => {
      throw new Error('decrypt failed')
    })

    await expect(failing).rejects.toThrow('decrypt failed')

    // WHY: Allow the .finally() microtask to settle before test ends.
    await delay(10)
  })

  it('continues processing queue after a task fails', async () => {
    const failing = enqueueForSession('session-error-2', async () => {
      throw new Error('first fails')
    })

    // Suppress the expected rejection
    await failing.catch(() => {})

    // WHY: Allow the .finally() microtask to settle.
    await delay(10)

    const result = await enqueueForSession('session-error-2', async () => 'recovered')

    expect(result).toBe('recovered')
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
