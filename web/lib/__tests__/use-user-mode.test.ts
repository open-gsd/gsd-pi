import test from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

// Capture the real hook's external-store callbacks without requiring a DOM renderer.
// The preference module, storage calls, and subscription lifecycle remain real.
const reactFixture = `
  let callbacks;
  export function useCallback(callback) { return callback; }
  export function useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
    callbacks = { subscribe, getSnapshot, getServerSnapshot };
    return getSnapshot();
  }
  export function getCallbacks() { return callbacks; }
`
const reactFixtureUrl = `data:text/javascript,${encodeURIComponent(reactFixture)}`
let moduleId = 0

type PreferenceModule = typeof import("../use-user-mode.ts")
type StoreCallbacks = {
  subscribe(callback: () => void): () => void
  getSnapshot(): string
  getServerSnapshot(): string
}

function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem(key: string) {
      assert.equal(key, "gsd-user-mode")
      return value
    },
    setItem(key: string, next: string) {
      assert.equal(key, "gsd-user-mode")
      value = next
    },
    removeItem(key: string) {
      assert.equal(key, "gsd-user-mode")
      value = null
    },
  }
}

function denied(): never {
  throw new DOMException("The operation is insecure", "SecurityError")
}

async function withPreference(
  descriptor: PropertyDescriptor,
  run: (mode: PreferenceModule, callbacks: () => Promise<StoreCallbacks>) => void | Promise<void>,
  browser = true,
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const restore = (name: string, previous: PropertyDescriptor | undefined) => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
  if (browser) Object.defineProperty(globalThis, "window", { configurable: true, value: {} })
  else Reflect.deleteProperty(globalThis, "window")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor })
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "react"
        ? { url: reactFixtureUrl, shortCircuit: true }
        : nextResolve(specifier, context)
    },
  })
  try {
    const moduleUrl = new URL("../use-user-mode.ts", import.meta.url)
    moduleUrl.searchParams.set("test", String(++moduleId))
    const mode = await import(moduleUrl.href) as PreferenceModule
    const fixture = await import(reactFixtureUrl) as { getCallbacks(): StoreCallbacks }
    await run(mode, async () => fixture.getCallbacks())
  } finally {
    hooks.deregister()
    restore("window", previousWindow)
    restore("localStorage", previousStorage)
  }
}

test("available storage preserves saved modes, updates, clearing, and external changes", async () => {
  const saved = storage("vibe-coder")
  await withPreference({ value: saved }, (mode) => {
    assert.equal(mode.getUserMode(), "vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    mode.setUserMode("expert")
    assert.equal(saved.getItem("gsd-user-mode"), "expert")
    saved.setItem("gsd-user-mode", "vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    mode.clearUserMode()
    assert.equal(saved.getItem("gsd-user-mode"), null)
    assert.equal(mode.getUserMode(), "expert")
  })
})

test("missing or invalid persisted values retain the expert default", async () => {
  const saved = storage("unknown")
  await withPreference({ value: saved }, (mode) => {
    assert.equal(mode.getUserMode(), "expert")
    saved.removeItem("gsd-user-mode")
    assert.equal(mode.getUserMode(), "expert")
  })
})

test("denied storage getter permits import and stable in-memory read, write, and clear", async () => {
  await withPreference({ get: denied }, (mode) => {
    assert.equal(mode.getUserMode(), "expert")
    mode.setUserMode("vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    mode.clearUserMode()
    assert.equal(mode.getUserMode(), "expert")
  })
})

test("denied getItem retains the last readable mode and recovers when reading resumes", async () => {
  const saved = storage("vibe-coder")
  const read = saved.getItem
  await withPreference({ value: saved }, (mode) => {
    assert.equal(mode.getUserMode(), "vibe-coder")
    saved.getItem = denied
    assert.equal(mode.getUserMode(), "vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    saved.getItem = read
    saved.setItem("gsd-user-mode", "expert")
    assert.equal(mode.getUserMode(), "expert")
  })
})

test("denied setItem keeps the new choice despite readable stale storage", async () => {
  const saved = storage("expert")
  const write = saved.setItem
  saved.setItem = denied
  await withPreference({ value: saved }, (mode) => {
    mode.setUserMode("vibe-coder")
    assert.equal(saved.getItem("gsd-user-mode"), "expert")
    assert.equal(mode.getUserMode(), "vibe-coder")
    assert.equal(mode.getUserMode(), "vibe-coder")
    saved.setItem = write
    mode.setUserMode("vibe-coder")
    assert.equal(saved.getItem("gsd-user-mode"), "vibe-coder")
    saved.setItem("gsd-user-mode", "expert")
    assert.equal(mode.getUserMode(), "expert")
  })
})

test("denied removeItem resets this tab without reviving the old persisted choice", async () => {
  const saved = storage("vibe-coder")
  const remove = saved.removeItem
  saved.removeItem = denied
  await withPreference({ value: saved }, (mode) => {
    assert.equal(mode.getUserMode(), "vibe-coder")
    mode.clearUserMode()
    assert.equal(saved.getItem("gsd-user-mode"), "vibe-coder")
    assert.equal(mode.getUserMode(), "expert")
    saved.removeItem = remove
    mode.clearUserMode()
    assert.equal(saved.getItem("gsd-user-mode"), null)
  })
})

test("hook subscribers observe denied-storage updates and stop after unsubscribe", async () => {
  await withPreference({ get: denied }, async (mode, getCallbacks) => {
    const [initial, setMode] = mode.useUserMode()
    assert.equal(initial, "expert")
    const callbacks = await getCallbacks()
    const observed: string[] = []
    const unsubscribe = callbacks.subscribe(() => observed.push(callbacks.getSnapshot()))
    setMode("vibe-coder")
    assert.equal(callbacks.getSnapshot(), "vibe-coder")
    assert.equal(callbacks.getSnapshot(), "vibe-coder")
    mode.clearUserMode()
    assert.deepEqual(observed, ["vibe-coder", "expert"])
    assert.equal(callbacks.getServerSnapshot(), "expert")
    unsubscribe()
    setMode("vibe-coder")
    assert.deepEqual(observed, ["vibe-coder", "expert"])
  })
})

test("non-browser reads preserve the server default without acquiring storage", async () => {
  await withPreference({ get: denied }, (mode) => {
    assert.equal(mode.getUserMode(), "expert")
    mode.setUserMode("vibe-coder")
    assert.equal(mode.getUserMode(), "expert")
  }, false)
})
