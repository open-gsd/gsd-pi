import test from "node:test"
import assert from "node:assert/strict"
import {
  negotiateEmbeddedTransport,
  isEmbeddedMode,
  EMBEDDED_PROTOCOL,
  BIND_TYPE,
  BIND_ACK_TYPE,
  REQUEST_TYPE,
  RESPONSE_TYPE,
  THEME_TYPE,
} from "../embedded-transport.ts"

type AnyPort = { postMessage(message: unknown): void; close(): void; start?(): void; onmessage: ((event: { data: unknown }) => void) | null; addEventListener(type: string, listener: (event: { data: unknown }) => void): void; removeEventListener(type: string, listener: (event: { data: unknown }) => void): void }

function fakeWindow(origin: string, marker: boolean) {
  const listeners: Array<(event: MessageEvent) => void> = []
  const parentMessages: unknown[] = []
  const parent = { postMessage: (message: unknown) => { parentMessages.push(message) } }
  const win = {
    origin,
    location: { search: marker ? "?__gsd_embedded=1" : "" },
    addEventListener: (_t: string, l: (event: MessageEvent) => void) => listeners.push(l),
    removeEventListener: (_t: string, l: (event: MessageEvent) => void) => {
      const i = listeners.indexOf(l)
      if (i >= 0) listeners.splice(i, 1)
    },
    parent,
    postMessage: () => {},
  }
  return {
    win,
    parentMessages,
    parent,
    dispatch: (data: unknown, opts?: { source?: unknown; eventOrigin?: string; ports?: unknown[] }) => {
      const source = opts && "source" in opts ? opts.source : parent
      const eventOrigin = opts?.eventOrigin ?? "https://parent.test"
      const ports = opts?.ports ?? []
      for (const l of [...listeners]) l({ data, source, origin: eventOrigin, ports } as unknown as MessageEvent)
    },
    listenerCount: () => listeners.length,
  }
}

function waitForMessage(port: AnyPort): Promise<any> {
  return new Promise((resolve) => {
    port.onmessage = (event) => {
      port.onmessage = null
      resolve(event.data)
    }
    if (typeof port.start === "function") port.start()
  })
}

async function bind(h: ReturnType<typeof fakeWindow>, generation = 7, opts?: Partial<Parameters<typeof negotiateEmbeddedTransport>[0]>) {
  const channel = new MessageChannel() as unknown as { port1: AnyPort; port2: AnyPort }
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get", "projects.list"], ...opts })
  const readyMessage = h.parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation, nonce: readyMessage?.nonce }, { ports: [channel.port2] })
  const client = await negotiation
  // The child posts a bind-ack before the negotiation promise resolves;
  // drain it so subsequent waitForMessage calls observe requests only.
  const ack = await waitForMessage(channel.port1)
  if (ack && ack.type === BIND_ACK_TYPE) {
    // drained
  }
  return { client, parentPort: channel.port1, generation }
}

test("strict embedded detection requires opaque origin, distinct parent, and marker", () => {
  assert.equal(isEmbeddedMode(fakeWindow("null", true).win), true)
  assert.equal(isEmbeddedMode(fakeWindow("null", false).win), false)
  assert.equal(isEmbeddedMode(fakeWindow("https://x.test", true).win), false)
  const topLevel: { origin: string; location: { search: string }; addEventListener: () => void; removeEventListener: () => void; parent: unknown; postMessage: () => void } = {
    origin: "null",
    location: { search: "?__gsd_embedded=1" },
    addEventListener: () => {},
    removeEventListener: () => {},
    parent: null,
    postMessage: () => {},
  }
  topLevel.parent = topLevel
  assert.equal(isEmbeddedMode(topLevel as never), false)
})

test("theme messages use the bound port and current generation, not window messages", async () => {
  const h = fakeWindow("null", true)
  const received: unknown[] = []
  const { client, parentPort, generation } = await bind(h, 7, {
    allowedOperations: ["preferences.get"],
    onTheme: (theme) => { received.push(theme) },
  })
  try {
    const theme = { mode: "light", variables: { "--background": "#fff" } }
    h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: THEME_TYPE, generation, theme })
    parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: THEME_TYPE, generation: generation - 1, theme })
    parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: THEME_TYPE, generation, theme: { ...theme, mode: "invalid" } })
    parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: THEME_TYPE, generation, theme })
    // The response is an ordering barrier after all preceding theme messages.
    const request = client.request("preferences.get")
    const frameRequest = await waitForMessage(parentPort)
    parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation, requestId: frameRequest.requestId, ok: true })
    await request
    assert.deepEqual(received, [theme])
  } finally {
    client.dispose()
    parentPort.close()
  }
})

test("valid parent bind resolves a client and sends a bind-ack over the port", async () => {
  const h = fakeWindow("null", true)
  const channel = new MessageChannel() as unknown as { port1: AnyPort; port2: AnyPort }
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"] })
  const readyMessage = h.parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 7, nonce: readyMessage?.nonce }, { ports: [channel.port2] })
  const client = await negotiation
  const ackMessage = await waitForMessage(channel.port1)
  assert.equal(ackMessage.protocol, EMBEDDED_PROTOCOL)
  assert.equal(ackMessage.type, BIND_ACK_TYPE)
  assert.equal(ackMessage.generation, 7)
  // The duplicate-bind guard listener is retained through disposal by design;
  // only after dispose are no listeners left.
  client.dispose()
  assert.equal(h.listenerCount(), 0)
})

test("binds from a non-parent source or wrong protocol are ignored and negotiation expires", async () => {
  const h = fakeWindow("null", true)
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], negotiationTimeoutMs: 25 })
  const stranger = { postMessage: () => {} }
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1 }, { source: stranger, ports: [new MessageChannel().port1] })
  h.dispatch({ protocol: "other/9", type: BIND_TYPE, generation: 1 })
  await assert.rejects(() => negotiation, /negotiation timed out/)
})

test("duplicate bind after settlement is ignored and the established client keeps working", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort } = await bind(h)
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 99 }, { ports: [new MessageChannel().port1] })
  const promise = client.request("preferences.get")
  const request = await waitForMessage(parentPort)
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: request.generation, requestId: request.requestId, ok: true, result: "still-works" })
  assert.equal(await promise, "still-works")
  client.dispose()
})

test("allowlisted request carries the contract envelope and resolves on response", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort } = await bind(h, 42)
  const promise = client.request("preferences.get", { detail: true })
  const request = await waitForMessage(parentPort)
  assert.equal(request.protocol, EMBEDDED_PROTOCOL)
  assert.equal(request.type, REQUEST_TYPE)
  assert.equal(request.generation, 42)
  assert.equal(typeof request.requestId, "string")
  assert.notEqual(request.requestId.length, 0)
  assert.equal(request.operation, "preferences.get")
  assert.deepEqual(request.args, { detail: true })
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 42, requestId: request.requestId, ok: true, result: { launchCwd: null } })
  const result = (await promise) as { launchCwd: string | null }
  assert.equal(result.launchCwd, null)
  client.dispose()
})

test("non-allowlisted operations fail closed without port traffic", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort, ...rest } = await bind(h)
  let sawTraffic = false
  parentPort.onmessage = () => {
    sawTraffic = true
  }
  await assert.rejects(() => client.request("evil.op"), /not allowed/)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(sawTraffic, false)
  client.dispose()
})

test("responses with a stale generation are ignored", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort } = await bind(h, 5)
  const promise = client.request("preferences.get")
  const request = await waitForMessage(parentPort)
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 4, requestId: request.requestId, ok: true, result: "stale" })
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 5, requestId: request.requestId, ok: true, result: "current" })
  assert.equal(await promise, "current")
  client.dispose()
})

test("parent silence times out as unknown result and late responses are ignored", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort } = await bind(h, 3, { requestTimeoutMs: 25 })
  const promise = client.request("preferences.get")
  const request = await waitForMessage(parentPort)
  await assert.rejects(() => promise, /timed out: unknown result/)
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 3, requestId: request.requestId, ok: true, result: "late" })
  await new Promise((r) => setTimeout(r, 10))
  client.dispose()
})

test("pending cap rejects excess requests under a silent parent", async () => {
  const h = fakeWindow("null", true)
  const { client } = await bind(h, 3, { requestTimeoutMs: 60_000, maxPending: 1 })
  const first = client.request("preferences.get")
  await assert.rejects(() => client.request("projects.list"), /pending cap/)
  client.dispose()
  await assert.rejects(() => first, /disposed/)
})

test("dispose rejects pending requests and closes the channel", async () => {
  const h = fakeWindow("null", true)
  const { client } = await bind(h, 3, { requestTimeoutMs: 60_000 })
  const promise = client.request("preferences.get")
  client.dispose()
  await assert.rejects(() => promise, /disposed/)
  await assert.rejects(() => client.request("preferences.get"), /disposed/)
})

test("a request postMessage throw rejects the request and drains pending after a healthy ack", async () => {
  const h = fakeWindow("null", true)
  let calls = 0
  const flakyPort = {
    postMessage: () => {
      calls += 1
      if (calls >= 2) throw new Error("could not be cloned")
    },
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], maxPending: 1 })
  const readyMessage = h.parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce: readyMessage?.nonce }, { ports: [flakyPort] })
  const client = await negotiation
  await assert.rejects(() => client.request("preferences.get"), /could not be cloned/)
  client.dispose()
})

test("bind acknowledgement failure rejects the negotiation instead of resolving a broken client", async () => {
  const h = fakeWindow("null", true)
  const themes: unknown[] = []
  const deadPort = {
    postMessage: () => {
      throw new Error("port closed")
    },
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], onTheme: (theme) => { themes.push(theme) } })
  const readyMessage = h.parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce: readyMessage?.nonce, theme: { mode: "light", variables: {} } }, { ports: [deadPort] })
  await assert.rejects(() => negotiation, /port closed/)
  assert.deepEqual(themes, [])
  assert.equal(h.listenerCount(), 0)
})

test("initial theme requires the bound parent source, expected origin, and echoed document nonce", async () => {
  const h = fakeWindow("null", true)
  const themes: unknown[] = []
  const channel = new MessageChannel() as unknown as { port1: AnyPort; port2: AnyPort }
  const negotiation = negotiateEmbeddedTransport({
    window: h.win,
    allowedOperations: [],
    expectedParentOrigin: "https://parent.test",
    onTheme: (theme) => { themes.push(theme) },
  })
  const { nonce } = h.parentMessages.at(-1) as { nonce: string }
  const theme = { mode: "light", variables: { "--background": "#eee" } }
  const message = { protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce, theme }
  h.dispatch(message, { source: {}, ports: [channel.port2] })
  h.dispatch(message, { eventOrigin: "https://untrusted.test", ports: [channel.port2] })
  h.dispatch({ ...message, nonce: "another-document" })
  assert.deepEqual(themes, [])
  h.dispatch(message, { ports: [channel.port2] })
  const client = await negotiation
  assert.deepEqual(themes, [theme])
  client.dispose()
  channel.port1.close()
})

test("disposed theme channels ignore queued messages and remove their listeners", async () => {
  const h = fakeWindow("null", true)
  const themes: unknown[] = []
  let listener: ((event: MessageEvent) => void) | undefined
  let removed = false
  const port = {
    postMessage() {}, close() {},
    addEventListener(_type: string, callback: (event: MessageEvent) => void) { listener = callback },
    removeEventListener(_type: string, callback: (event: MessageEvent) => void) { removed = callback === listener },
  }
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: [], onTheme: (theme) => { themes.push(theme) } })
  const { nonce } = h.parentMessages.at(-1) as { nonce: string }
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 3, nonce }, { ports: [port] })
  const client = await negotiation
  client.dispose()
  listener?.({ data: { protocol: EMBEDDED_PROTOCOL, type: THEME_TYPE, generation: 3, theme: { mode: "dark", variables: {} } } } as MessageEvent)
  assert.equal(removed, true)
  assert.equal(h.listenerCount(), 0)
  assert.deepEqual(themes, [])
})

test("binds with multiple transferred ports are rejected and negotiation expires", async () => {
  const h = fakeWindow("null", true)
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], negotiationTimeoutMs: 25 })
  const first = new MessageChannel()
  const second = new MessageChannel()
  const readyMessage = h.parentMessages.findLast((m) => (m as { type?: string })?.type === "gsd-ui-ready") as { nonce?: string } | undefined
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce: readyMessage?.nonce }, { ports: [first.port2, second.port2] })
  await assert.rejects(() => negotiation, /negotiation timed out/)
})

test("binds with a non-number generation are rejected and negotiation expires", async () => {
  const h = fakeWindow("null", true)
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], negotiationTimeoutMs: 25 })
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: "7", nonce: "whatever" }, { ports: [new MessageChannel().port2] })
  await assert.rejects(() => negotiation, /negotiation timed out/)
})

test("responses without a boolean ok or string requestId are ignored", async () => {
  const h = fakeWindow("null", true)
  const { client, parentPort } = await bind(h, 9)
  const promise = client.request("preferences.get")
  const request = await waitForMessage(parentPort)
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 9, requestId: request.requestId, ok: "yes", result: "bad" })
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 9, requestId: 42, ok: true, result: "bad2" })
  parentPort.postMessage({ protocol: EMBEDDED_PROTOCOL, type: RESPONSE_TYPE, generation: 9, requestId: request.requestId, ok: true, result: "good" })
  assert.equal(await promise, "good")
  client.dispose()
})


test("bind without the exact echoed nonce is ignored", async () => {
  const h = fakeWindow("null", true)
  const negotiation = negotiateEmbeddedTransport({ window: h.win, allowedOperations: ["preferences.get"], negotiationTimeoutMs: 40 })
  h.dispatch({ protocol: EMBEDDED_PROTOCOL, type: BIND_TYPE, generation: 1, nonce: "wrong-nonce-entirely" }, { ports: [new MessageChannel().port2] })
  await assert.rejects(() => negotiation, /negotiation timed out/)
})
