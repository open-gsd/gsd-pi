import test from "node:test"
import assert from "node:assert/strict"
import {
  mapRouteToOperation,
  embeddedApiFetch,
  embeddedStartup,
  resetEmbeddedGate,
  getEmbeddedTransport,
  EmbeddedEventSourceAdapter,
  embeddedEventSourceForUrl,
  shouldSuppressShutdownBeacon,
} from "../embedded-gate.ts"
import { EMBEDDED_PROTOCOL, EVENT_TYPE } from "../embedded-transport.ts"

function stubWindow(embedded: boolean): () => void {
  const g = globalThis as unknown as { window?: unknown }
  g.window = embedded
    ? { origin: "null", location: { search: "?__gsd_embedded=1" }, parent: { postMessage: () => {} }, addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {} }
    : { origin: "https://standalone.test", location: { search: "" }, parent: {}, addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {} }
  return () => {
    delete g.window
  }
}

function fakeTransport(result?: unknown, error?: Error) {
  const requests: Array<{ operation: string; args?: unknown }> = []
  const handlers = new Set<(message: unknown) => void>()
  return {
    requests,
    emit: (message: unknown) => {
      for (const h of [...handlers]) h(message)
    },
    client: {
      request: async (operation: string, args?: unknown) => {
        requests.push({ operation, args })
        if (error) throw error
        return result
      },
      onEvent: (handler: (message: unknown) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      dispose: () => {},
    },
  }
}

test("known routes map to named operations with parsed args", () => {
  assert.deepEqual(mapRouteToOperation("GET", "/api/preferences", null), { operation: "preferences.read", args: {} })
  assert.deepEqual(
    mapRouteToOperation("GET", "/api/projects?root=%2Fhome%2Fx&detail=true", null),
    { operation: "projects.list", args: { root: "/home/x", detail: true } },
  )
  assert.deepEqual(
    mapRouteToOperation("POST", "/api/switch-root", JSON.stringify({ devRoot: "/home/y", extra: "dropped" })),
    { operation: "preferences.selectRoot", args: { devRoot: "/home/y" } },
  )
  assert.deepEqual(
    mapRouteToOperation("DELETE", "/api/files?root=project&project=%2Fhome%2Fx&path=src", null),
    { operation: "files.delete", args: { root: "project", project: "/home/x", path: "src" } },
  )
})

test("unknown routes and mismatched methods fail closed", () => {
  assert.equal(mapRouteToOperation("GET", "/api/unknown", null), undefined)
  assert.equal(mapRouteToOperation("PATCH", "/api/preferences", null), undefined)
  assert.equal(mapRouteToOperation("POST", "/api/preferences", null), undefined)
})

test("embeddedApiFetch without a transport returns 503 and never throws", async () => {
  const restore = stubWindow(true)
  try {
    resetEmbeddedGate()
    const res = await embeddedApiFetch("/api/preferences")
    assert.equal(res.ok, false)
    assert.equal(res.status, 503)
  } finally {
    restore()
    resetEmbeddedGate()
  }
})

test("embeddedApiFetch maps, calls the transport, and wraps typed results", async () => {
  const restore = stubWindow(true)
  try {
    const fake = fakeTransport({ launchCwd: null })
    await embeddedStartup({ allowedOperations: ["preferences.read"], negotiate: async () => fake.client })
    const res = await embeddedApiFetch("/api/preferences")
    assert.equal(res.status, 200)
    assert.equal(res.ok, true)
    assert.deepEqual(await res.json(), { launchCwd: null })
    assert.deepEqual(fake.requests, [{ operation: "preferences.read", args: {} }])
  } finally {
    restore()
    resetEmbeddedGate()
  }
})

test("embeddedApiFetch rejects unmapped routes with 501 and transport failures with 502", async () => {
  const restore = stubWindow(true)
  try {
    const fake = fakeTransport(undefined, new Error("operation denied"))
    await embeddedStartup({ allowedOperations: ["preferences.read"], negotiate: async () => fake.client })
    const unmapped = await embeddedApiFetch("/api/session/command", { method: "POST", body: "{}" })
    assert.equal(unmapped.status, 501)
    const denied = await embeddedApiFetch("/api/preferences")
    assert.equal(denied.status, 502)
    assert.equal(denied.ok, false)
  } finally {
    restore()
    resetEmbeddedGate()
  }
})

test("startup resolves standalone, embedded-ready, and embedded-unavailable states", async () => {
  const restoreStandalone = stubWindow(false)
  resetEmbeddedGate()
  assert.equal(await embeddedStartup(), "standalone")
  restoreStandalone()
  const restoreEmbedded = stubWindow(true)
  try {
    const fake = fakeTransport()
    assert.equal(await embeddedStartup({ allowedOperations: [], negotiate: async () => fake.client }), "embedded-ready")
    assert.equal(getEmbeddedTransport(), fake.client)
    resetEmbeddedGate()
    assert.equal(
      await embeddedStartup({ allowedOperations: [], negotiate: async () => Promise.reject(new Error("no bridge")) }),
      "embedded-unavailable",
    )
    assert.equal(getEmbeddedTransport(), null)
  } finally {
    restoreEmbedded()
    resetEmbeddedGate()
  }
})

test("SSE adapter opens on subscribe, delivers only its subscription events, and closes", async () => {
  const fake = fakeTransport({ subscriptionId: "sub-1" })
  const received: string[] = []
  let opened = false
  let errored = false
  const adapter = new EmbeddedEventSourceAdapter(fake.client, "workspace.events.subscribe", { project: "/p" })
  adapter.onopen = () => {
    opened = true
  }
  adapter.onmessage = (ev) => {
    received.push(ev.data)
  }
  adapter.onerror = () => {
    errored = true
  }
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(opened, true)
  assert.equal(errored, false)
  assert.deepEqual(fake.requests, [{ operation: "workspace.events.subscribe", args: { project: "/p" } }])
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-1", seq: 1, event: { kind: "tick" } })
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-other", seq: 1, event: { kind: "not-mine" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(received, [JSON.stringify({ kind: "tick" })])
  adapter.close()
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-1", seq: 2, event: { kind: "after-close" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(received, [JSON.stringify({ kind: "tick" })])
})

test("stream URL mapping returns undefined without a transport; beacon suppression tracks embedded mode", () => {
  const restore = stubWindow(true)
  try {
    resetEmbeddedGate()
    assert.equal(embeddedEventSourceForUrl("/api/session/events?project=%2Fp"), undefined)
    assert.equal(shouldSuppressShutdownBeacon(), true)
  } finally {
    restore()
    resetEmbeddedGate()
  }
  const restoreStandalone = stubWindow(false)
  try {
    assert.equal(shouldSuppressShutdownBeacon(), false)
  } finally {
    restoreStandalone()
  }
})


test("reset during negotiation disposes the stale completion and never installs it", async () => {
  const restore = stubWindow(true)
  try {
    let resolveNegotiation!: (client: unknown) => void
    const disposed: number[] = []
    const slowClient = { request: async () => ({}), onEvent: () => () => {}, dispose: () => { disposed.push(1) } }
    const negotiation = embeddedStartup({ allowedOperations: [], negotiate: () => new Promise((r) => { resolveNegotiation = r }) as never })
    resetEmbeddedGate()
    resolveNegotiation(slowClient)
    assert.equal(await negotiation, "embedded-unavailable")
    assert.equal(getEmbeddedTransport(), null)
    assert.equal(disposed.length, 1)
  } finally {
    restore()
    resetEmbeddedGate()
  }
})

test("adapter delivers nothing before the subscribe reply establishes readiness", async () => {
  const fake = fakeTransport()
  let resolveSubscribe!: (value: unknown) => void
  fake.client.request = (async () => new Promise((r) => { resolveSubscribe = r })) as never
  const received: string[] = []
  const adapter = new EmbeddedEventSourceAdapter(fake.client, "workspace.events.subscribe", {})
  adapter.onmessage = (ev) => { received.push(ev.data) }
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-9", seq: 1, event: { kind: "early" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(received, [])
  resolveSubscribe({ subscriptionId: "sub-9" })
  await new Promise((r) => setTimeout(r, 5))
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-9", seq: 2, event: { kind: "late" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(received, [JSON.stringify({ kind: "late" })])
  adapter.close()
})

test("subscribe failure surfaces onerror and detaches the event handler", async () => {
  const fake = fakeTransport()
  fake.client.request = (async () => {
    throw new Error("denied")
  }) as never
  let errored = false
  const received: string[] = []
  const adapter = new EmbeddedEventSourceAdapter(fake.client, "workspace.events.subscribe", {})
  adapter.onerror = () => { errored = true }
  adapter.onmessage = (ev) => { received.push(ev.data) }
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(errored, true)
  fake.emit({ protocol: EMBEDDED_PROTOCOL, type: EVENT_TYPE, generation: 1, subscriptionId: "sub-x", seq: 1, event: "zombie" })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(received, [])
})

test("close releases the backend subscription and late replies release too", async () => {
  const fake = fakeTransport({ subscriptionId: "sub-7" })
  const adapter = new EmbeddedEventSourceAdapter(fake.client, "workspace.events.subscribe", {})
  await new Promise((r) => setTimeout(r, 5))
  adapter.close()
  assert.deepEqual(fake.requests.map((r) => r.operation), ["workspace.events.subscribe", "workspace.events.unsubscribe"])
  assert.deepEqual(fake.requests[1].args, { subscriptionId: "sub-7" })

  const fake2 = fakeTransport()
  let resolveSubscribe!: (value: unknown) => void
  fake2.client.request = (async (operation: string, args?: unknown) => {
    fake2.requests.push({ operation, args })
    return new Promise((r) => { resolveSubscribe = r })
  }) as never
  let opened = false
  const adapter2 = new EmbeddedEventSourceAdapter(fake2.client, "terminal.output.subscribe", {})
  adapter2.onopen = () => { opened = true }
  adapter2.close()
  resolveSubscribe({ subscriptionId: "sub-late" })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(opened, false)
  assert.deepEqual(fake2.requests.map((r) => r.operation), ["terminal.output.subscribe", "terminal.output.unsubscribe"])
  assert.deepEqual(fake2.requests[1].args, { subscriptionId: "sub-late" })
})

test("stream mapping normalizes absolute base-pathed URLs and keeps create out of subscribe", async () => {
  const restore = stubWindow(true)
  try {
    process.env.NEXT_PUBLIC_BASE_PATH = "/plugins/open-gsd-openclaw/web"
    const fake = fakeTransport({ subscriptionId: "s" })
    await embeddedStartup({ allowedOperations: [], negotiate: async () => fake.client })
    const adapter = embeddedEventSourceForUrl("http://127.0.0.1:33277/plugins/open-gsd-openclaw/web/api/terminal/stream?id=t1&command=rm")
    assert.notEqual(adapter, undefined)
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(fake.requests, [{ operation: "terminal.output.subscribe", args: { terminalId: "t1", project: null } }])
    adapter?.close()
  } finally {
    delete process.env.NEXT_PUBLIC_BASE_PATH
    restore()
    resetEmbeddedGate()
  }
})

test("bootstrap and file selectors never infer project identity from root", () => {
  assert.deepEqual(mapRouteToOperation("GET", "/api/boot?project=%2Fapproved%2Fp", null), {
    operation: "workspace.bootstrap", args: { project: "/approved/p" },
  })
  assert.deepEqual(mapRouteToOperation("GET", "/api/boot?root=%2Fapproved%2Fp", null), {
    operation: "workspace.bootstrap", args: { project: null },
  })
  assert.deepEqual(mapRouteToOperation("DELETE", "/api/files?root=gsd&path=STATE.md", null), {
    operation: "files.delete", args: { root: "gsd", project: null, path: "STATE.md" },
  })
  assert.deepEqual(mapRouteToOperation("DELETE", "/api/files?project=%2Fapproved%2Fp&path=STATE.md", null), {
    operation: "files.delete", args: { root: null, project: "/approved/p", path: "STATE.md" },
  })
})


test("Files GET tree/content preserves the selector and explicit project independently", () => {
  const previousBase = process.env.NEXT_PUBLIC_BASE_PATH
  process.env.NEXT_PUBLIC_BASE_PATH = "/plugins/open-gsd-openclaw/web"
  try {
    const prefix = process.env.NEXT_PUBLIC_BASE_PATH
    assert.deepEqual(mapRouteToOperation("GET", `${prefix}/api/files?root=gsd&project=%2Fapproved%2Fp`, null), {
      operation: "files.read", args: { root: "gsd", project: "/approved/p", path: null },
    })
    assert.deepEqual(mapRouteToOperation("GET", `${prefix}/api/files?root=project&project=%2Fapproved%2Fp&path=src%2Fread%20me.md`, null), {
      operation: "files.read", args: { root: "project", project: "/approved/p", path: "src/read me.md" },
    })
    assert.deepEqual(mapRouteToOperation("GET", `${prefix}/api/files?root=gsd`, null), {
      operation: "files.read", args: { root: "gsd", project: null, path: null },
    })
    assert.equal(mapRouteToOperation("GET", "/other/api/files?root=gsd&project=%2Fapproved%2Fp", null), undefined)
    for (const method of ["POST", "PUT", "PATCH"]) {
      assert.equal(mapRouteToOperation(method, `${prefix}/api/files?project=%2Fapproved%2Fp`, "{}"), undefined)
    }
  } finally {
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH
    else process.env.NEXT_PUBLIC_BASE_PATH = previousBase
  }
})
