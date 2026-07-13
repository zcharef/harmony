import { createElement } from 'react'
import { vi } from 'vitest'

/**
 * WHY: HeroUI's ripple/popover/overlay animations wrap their content in
 * framer-motion's <LazyMotion> using a *lazy* feature bundle —
 * `() => import('@heroui/dom-animation')`. Under jsdom that dynamic import can
 * settle AFTER the test file's environment has been torn down: LazyMotion's
 * effect then calls setState on an unmounted tree, React reaches for `window`
 * (already gone), and Vitest reports an unhandled "window is not defined"
 * rejection that fails the entire run at random, surfacing from whichever test
 * last mounted an animated HeroUI overlay (ripple, popover, tooltip, modal).
 *
 * `@heroui/dom-animation` merely re-exports framer-motion's *static*
 * `domAnimation` bundle, so substituting that object for the lazy loader makes
 * LazyMotion load features synchronously (identical runtime behavior, same
 * renderer) and removes the dangling promise entirely — no async import, no
 * post-teardown state update.
 */
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>()
  const LazyMotion: typeof actual.LazyMotion = ({ features, ...rest }) =>
    createElement(actual.LazyMotion, {
      ...rest,
      features: typeof features === 'function' ? actual.domAnimation : features,
    })
  return { ...actual, LazyMotion }
})

/**
 * WHY: Node.js 22+ ships a built-in localStorage behind --localstorage-file.
 * When that flag is present without a valid path (vitest passes it internally),
 * it creates a non-functional localStorage object that shadows jsdom's working
 * implementation. This setup file installs a simple in-memory mock before any
 * test module loads, ensuring crypto-store and other code that persists to
 * localStorage works correctly in tests.
 */

const store = new Map<string, string>()

const localStorageMock: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, String(value))
  },
  removeItem: (key: string) => {
    store.delete(key)
  },
  clear: () => {
    store.clear()
  },
  get length() {
    return store.size
  },
  key: (index: number) => {
    const keys = Array.from(store.keys())
    return keys[index] ?? null
  },
}

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
})
