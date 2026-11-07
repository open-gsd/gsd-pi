import test from "node:test"
import assert from "node:assert/strict"
import { withBasePath, authFetch } from "../auth.ts"

const B = "/plugins/open-gsd-openclaw/web"

test("withBasePath prefixes root-relative API paths", () => {
  assert.equal(withBasePath("/api/projects", B), `${B}/api/projects`)
  assert.equal(withBasePath("/api/preferences", B), `${B}/api/preferences`)
})

test("withBasePath prefixes public assets", () => {
  assert.equal(withBasePath("/logo-black.svg", B), `${B}/logo-black.svg`)
  assert.equal(withBasePath("/logo-icon-white.svg", B), `${B}/logo-icon-white.svg`)
})

test("withBasePath does not double-prefix", () => {
  assert.equal(withBasePath(`${B}/api/boot`, B), `${B}/api/boot`)
  assert.equal(withBasePath(B, B), B)
})

test("withBasePath passes through non-root-relative inputs", () => {
  assert.equal(withBasePath("http://127.0.0.1:38429/api/x", B), "http://127.0.0.1:38429/api/x")
  assert.equal(withBasePath("//cdn.example.com/x", B), "//cdn.example.com/x")
  assert.equal(withBasePath("relative/path", B), "relative/path")
})

test("withBasePath is identity without a base path", () => {
  assert.equal(withBasePath("/api/x", ""), "/api/x")
})

function stubFetch() {
  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test("authFetch sends credentials include for first-party root-relative paths", async () => {
  const stub = stubFetch()
  try {
    await authFetch("/api/projects")
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].input, "/api/projects")
    assert.equal(stub.calls[0].init?.credentials, "include")
  } finally { stub.restore() }
})

test("authFetch preserves explicit credentials overrides", async () => {
  const stub = stubFetch()
  try {
    await authFetch("/api/projects", { credentials: "omit" })
    assert.equal(stub.calls[0].init?.credentials, "omit")
  } finally { stub.restore() }
})

test("authFetch does not enable credentials for absolute external URLs", async () => {
  const stub = stubFetch()
  try {
    await authFetch("https://external.example/api")
    assert.equal(stub.calls[0].init?.credentials, undefined)
  } finally { stub.restore() }
})

test("authFetch does not enable credentials for protocol-relative or relative inputs", async () => {
  const stub = stubFetch()
  try {
    await authFetch("//cdn.example.com/x")
    await authFetch("relative/path")
    assert.equal(stub.calls[0].init?.credentials, undefined)
    assert.equal(stub.calls[1].init?.credentials, undefined)
  } finally { stub.restore() }
})

test("authFetch preserves Request credentials policy when no init is passed", async () => {
  const stub = stubFetch()
  try {
    const req = new Request("https://example.test/api", { credentials: "omit" })
    await authFetch(req)
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].input, req)
    assert.equal(stub.calls[0].init, undefined)
  } finally { stub.restore() }
})

test("authFetch passes caller init through for Request inputs without adding credentials", async () => {
  const stub = stubFetch()
  try {
    const req = new Request("https://example.test/api", { method: "POST" })
    await authFetch(req, { method: "POST", body: "x" })
    assert.equal(stub.calls[0].init?.credentials, undefined)
    assert.equal(stub.calls[0].init?.body, "x")
  } finally { stub.restore() }
})

test("authFetch no-token flow stays Authorization-free", async () => {
  const stub = stubFetch()
  try {
    await authFetch("/api/projects")
    const headers = stub.calls[0].init?.headers as Headers
    assert.equal(headers instanceof Headers, true)
    assert.equal(headers.has("Authorization"), false)
  } finally { stub.restore() }
})

test("authFetch preserves POST body and headers for first-party strings", async () => {
  const stub = stubFetch()
  try {
    await authFetch("/api/switch-root", { method: "POST", body: JSON.stringify({ root: "/tmp" }), headers: { "Content-Type": "application/json" } })
    assert.equal(stub.calls[0].init?.method, "POST")
    assert.equal(stub.calls[0].init?.body, JSON.stringify({ root: "/tmp" }))
    assert.equal(stub.calls[0].init?.credentials, "include")
    const headers = stub.calls[0].init?.headers as Headers
    assert.equal(headers.get("Content-Type"), "application/json")
  } finally { stub.restore() }
})

import { embeddedStartup, resetEmbeddedGate } from "../embedded-gate.ts"

function embeddedWindow(): () => void {
  const g = globalThis as unknown as { window?: unknown }
  g.window = {
    origin: "null",
    location: { search: "?__gsd_embedded=1" },
    parent: { postMessage: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  }
  return () => {
    delete g.window
  }
}

test("authFetch routes first-party strings through the embedded gate and never direct fetch", async () => {
  const restore = embeddedWindow()
  try {
    const directFetchCalls: unknown[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      directFetchCalls.push({ input, init })
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as typeof fetch
    await embeddedStartup({
      allowedOperations: ["preferences.read"],
      negotiate: async () => ({
        request: async () => ({ embedded: true }),
        onEvent: () => () => {},
        dispose: () => {},
      }),
    })
    const res = await authFetch("/api/preferences")
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { embedded: true })
    assert.equal(directFetchCalls.length, 0)
    const unmapped = await authFetch("/api/not-mapped")
    assert.equal(unmapped.status, 501)
    globalThis.fetch = originalFetch
  } finally {
    restore()
    resetEmbeddedGate()
  }
})
