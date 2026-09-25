import test from "node:test"
import assert from "node:assert/strict"
import { embeddedStartup, resetEmbeddedGate, EMBEDDED_ALLOWED_OPERATIONS } from "../embedded-gate.ts"
import { authFetch } from "../auth.ts"
import { EMBEDDED_PROTOCOL, BIND_TYPE, BIND_ACK_TYPE, REQUEST_TYPE, RESPONSE_TYPE } from "../embedded-transport.ts"

test("startup-to-first-request: bounded negotiation precedes and enables authFetch over a real MessageChannel", async () => {
  const g = globalThis as unknown as { window?: unknown }
  const listeners: Array<(event: { data: unknown; source?: unknown; origin?: string; ports?: unknown[] }) => void> = []
  const parentMessages: unknown[] = []
  const parent = { postMessage: (message: unknown) => { parentMessages.push(message) } }
  g.window = {
    origin: "null",
    location: { search: "?__gsd_embedded=1" },
    parent,
    addEventListener: (_t: string, l: (event: { data: unknown; source?: unknown; origin?: string; ports?: unknown[] }) => void) => listeners.push(l),
    removeEventListener: (_t: string, l: (event: { data: unknown }) => void) => {
      const i = listeners.indexOf(l as never)
      if (i >= 0) listeners.splice(i, 1)
    },
    postMessage: () => {},
  }
  const directFetchCalls: unknown[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    directFetchCalls.push({ input, init })
    return Promise.resolve(new Response("{}", { status: 200 }))
  }) as typeof fetch
  try {
    // 1. Pre-negotiation: embedded mode with no transport fails closed - 503,
    //    and NEVER a direct network fetch.
    const before = await authFetch("/api/preferences")
    assert.equal(before.status, 503)
    assert.equal(directFetchCalls.length, 0)

    // 2. Bounded startup with the REAL default negotiation path.
    const startupPromise = embeddedStartup()
    const channel = new MessageChannel() as unknown as { port1: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage(m: unknown): void }; port2: unknown }
    const requestsSeen: unknown[] = []
    channel.port1.onmessage = (ev) => {
      const message = ev.data as { type: string; requestId?: string; operation?: string; args?: unknown }
      if (message.type === BIND_ACK_TYPE) return
      if (message.type !== REQUEST_TYPE) return
      requestsSeen.push(message)
      channel.port1.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 1, requestId: message.requestId, ok: true, result: { launchCwd: "/home/x" } })
    }
    const readyMessage = parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
    assert.ok(readyMessage?.nonce, "ready ping must carry the document nonce")
    for (const l of [...listeners]) l({ data: { protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce: readyMessage.nonce }, source: parent, origin: "https://parent.test", ports: [channel.port2] })
    assert.equal(await startupPromise, "embedded-ready")

    // 3. First request flows through negotiation-established transport.
    const res = await authFetch("/api/preferences")
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { launchCwd: "/home/x" })
    assert.equal(requestsSeen.length, 1)
    assert.equal((requestsSeen[0] as { operation: string }).operation, "preferences.read")
    assert.equal(directFetchCalls.length, 0)
    assert.ok(EMBEDDED_ALLOWED_OPERATIONS.includes("preferences.read"))
  } finally {
    globalThis.fetch = originalFetch
    delete g.window
    resetEmbeddedGate()
  }
})
