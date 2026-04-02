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
