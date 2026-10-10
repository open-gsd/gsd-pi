import test from "node:test"
import assert from "node:assert/strict"
import {
  createGsdEmbedPlugin,
  GSD_EMBED_PLUGIN_ID,
  GSD_EMBED_PROTOCOL,
  GSD_EMBED_READY_TYPE,
  GSD_EMBED_BIND_TYPE,
  GSD_EMBED_REQUEST_TYPE,
  GSD_EMBED_RESPONSE_TYPE,
  GSD_EMBED_EVENT_TYPE,
  GSD_UI_HOST_EVENT_NAME,
} from "../src/control-ui-embed.ts"

function setup(requestImpl?: (method: string, params: unknown) => Promise<unknown>) {
  const windowListeners: Array<(event: unknown) => void> = []
  const g = globalThis as unknown as Record<string, unknown>
  const originalAdd = g.addEventListener
  const originalRemove = g.removeEventListener
  g.addEventListener = (t: string, l: (event: unknown) => void) => {
    if (t === "message") windowListeners.push(l)
  }
  g.removeEventListener = (t: string, l: (event: unknown) => void) => {
    const i = windowListeners.indexOf(l)
    if (i >= 0) windowListeners.splice(i, 1)
  }
  const postMessagesToFrame: Array<{ data: unknown; transfer?: unknown[] }> = []
  const contentWindow = {
    postMessage: (data: unknown, _origin: string, transfer?: unknown[]) => {
      postMessagesToFrame.push({ data, transfer })
    },
  }
  const loadListeners: Array<() => void> = []
  const iframe = {
    contentWindow,
    src: "",
    sandbox: "",
    style: {} as Record<string, string>,
    removed: 0,
    remove() {
      this.removed += 1
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "load") loadListeners.push(listener)
    },
  }
  const container = {
    ownerDocument: { createElement: () => iframe },
    appended: [] as unknown[],
    appendChild(child: unknown) {
      this.appended.push(child)
    },
  }
  const requests: Array<{ method: string; params: unknown }> = []
  const request = requestImpl ?? (async (method: string, params: unknown) => {
    // Strict host stub: rejects unknown Gateway method names, mirroring the
    // real host - a mis-qualified automatic unsubscribe would throw here.
    if (!method.startsWith("gsd.ui.")) throw new Error(`unknown Gateway method: ${method}`)
    requests.push({ method, params })
    return { answered: method }
  })
  const hostEvents: Array<{ name: string; handler: (event: unknown) => void }> = []
  const onEvent = (name: string, handler: (event: unknown) => void) => {
    hostEvents.push({ name, handler })
    return () => {
      const i = hostEvents.findIndex((h) => h.handler === handler)
      if (i >= 0) hostEvents.splice(i, 1)
    }
  }
  let capturedPlugin: { id: string; activate: (host: unknown) => void } | undefined
  const definePlugin = (plugin: { id: string; activate: (host: unknown) => void }) => {
    capturedPlugin = plugin
    return { plugin: true }
  }
  createGsdEmbedPlugin({
    frameSrc: "/plugins/open-gsd-openclaw/web/?__gsd_embedded=1",
    request,
    allowedOperations: ["preferences.read", "workspace.events.subscribe", "workspace.events.unsubscribe"],
    definePlugin,
    onEvent,
  })
  let registeredPage: { id: string; label: string; mount: (container: unknown, context: { signal: AbortSignal }) => { dispose?: () => void } | void } | undefined
  let registeredNav: { id: string; label: string; page: { id: string } } | undefined
  capturedPlugin!.activate({
    ui: {
      registerPage: (page: typeof registeredPage) => {
        registeredPage = page
      },
      registerNavigation: (item: typeof registeredNav) => {
        registeredNav = item
      },
    },
  })
  const controller = new AbortController()
  const mountResult = registeredPage!.mount(container, { signal: controller.signal })
  const dispatchToWrapper = (data: unknown, ports: unknown[] = []) => {
    for (const l of [...windowListeners]) l({ data, source: contentWindow, ports })
  }
  const fireLoad = () => {
    for (const l of [...loadListeners]) l()
  }
  const emitHostEvent = (event: unknown) => {
    for (const h of [...hostEvents]) h.handler(event)
  }
  const restore = () => {
    g.addEventListener = originalAdd
    g.removeEventListener = originalRemove
  }
  return { windowListeners, postMessagesToFrame, iframe, container, requests, dispatchToWrapper, fireLoad, emitHostEvent, controller, mountResult, registeredPage, registeredNav, hostEvents, restore, pluginId: capturedPlugin!.id }
}

function framePortAt(h: ReturnType<typeof setup>, index: number) {
  return h.postMessagesToFrame[index].transfer![0] as { postMessage(m: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null }
}

function waitForPortMessage(port: { onmessage: ((ev: { data: unknown }) => void) | null }): Promise<any> {
  return new Promise((resolve) => {
    port.onmessage = (ev) => {
      port.onmessage = null
      resolve(ev.data)
    }
  })
}

test("loader contract: plugin id, label, navigation, dispose-shaped mount result", () => {
  const h = setup()
  try {
    assert.equal(h.pluginId, GSD_EMBED_PLUGIN_ID)
    assert.equal(h.pluginId, "open-gsd-openclaw")
    assert.equal(h.registeredPage!.id, "open-gsd-openclaw-web")
    assert.equal(h.registeredNav!.id, "open-gsd-openclaw-web")
    assert.equal(h.registeredNav!.page.id, "open-gsd-openclaw-web")
    assert.equal(h.iframe.src, "/plugins/open-gsd-openclaw/web/?__gsd_embedded=1")
    assert.equal(h.registeredPage!.label, "GSD")
    assert.equal(h.registeredNav!.label, "GSD")
    assert.equal(typeof (h.mountResult as { dispose?: () => void }).dispose, "function")
    ;(h.mountResult as { dispose: () => void }).dispose()
    assert.equal(h.iframe.removed, 1)
    assert.equal(h.windowListeners.length, 0)
  } finally {
    h.restore()
  }
})

test("document generation SURVIVES its own load; load without ready retires; duplicate ready ignored", async () => {
  const h = setup()
  try {
    // Real child order: ready fires BEFORE its own load event.
    h.dispatchToWrapper({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_READY_TYPE, nonce: "doc-alpha" })
    assert.equal(h.postMessagesToFrame.length, 1)
    const port1 = framePortAt(h, 0)
    // Duplicate ready with the SAME nonce is ignored - no rebind, no kill.
    h.dispatchToWrapper({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_READY_TYPE, nonce: "doc-alpha" })
    assert.equal(h.postMessagesToFrame.length, 1)
    h.fireLoad()
    // The channel that announced ready survives its own load.
    const reply = waitForPortMessage(port1)
    port1.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 1, requestId: "r1", operation: "preferences.read" })
    const response = await reply
    assert.equal(response.ok, true)
    assert.equal(h.requests.length, 1)
    // Load ordering is irrelevant to identity: fireLoad never retires.
    h.fireLoad()
    const afterLoadReply = waitForPortMessage(port1)
    port1.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 1, requestId: "postload", operation: "preferences.read" })
    const afterLoad = await afterLoadReply
    assert.equal(afterLoad.ok, true, "channel survives arbitrary loads")
    // The new document announces itself and binds generation 2.
    h.dispatchToWrapper({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_READY_TYPE, nonce: "doc-beta" })
    assert.equal(h.postMessagesToFrame.length, 2)
    const port2 = framePortAt(h, 1)
    assert.equal((h.postMessagesToFrame[1].data as { generation: number }).generation, 2)
    assert.equal((h.postMessagesToFrame[1].data as { nonce?: string }).nonce, "doc-beta", "bind must echo the fresh document nonce")
    assert.equal((h.postMessagesToFrame[0].data as { nonce?: string }).nonce, "doc-alpha")
    const reply2 = waitForPortMessage(port2)
    port2.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 2, requestId: "r2", operation: "preferences.read" })
    const response2 = await reply2
    assert.equal(response2.ok, true)
    // Stale generation on the new port is ignored.
    port2.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 1, requestId: "stale2", operation: "preferences.read" })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(h.requests.length, 3)
  } finally {
    ;(h.mountResult as { dispose: () => void }).dispose()
    h.restore()
  }
})

test("per-mount subscription ownership: only owned ids forward; closed events release", async () => {
  let subscriptionCounter = 0
  const h = setup(async (method, params) => {
    h.requests.push({ method, params })
    if (method.endsWith(".subscribe")) {
      subscriptionCounter += 1
      return { subscriptionId: "owned-" + subscriptionCounter }
    }
    return { ok: true }
  })
  try {
    h.dispatchToWrapper({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_READY_TYPE, nonce: "doc-alpha" })
    const port = framePortAt(h, 0)
    const subReply = waitForPortMessage(port)
    port.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 1, requestId: "s1", operation: "workspace.events.subscribe", args: {} })
    const subResult = await subReply
    assert.equal(subResult.ok, true)
    assert.equal(subResult.result.subscriptionId, "owned-1")
    // Owned subscription events forward.
    const eventReply = waitForPortMessage(port)
    h.emitHostEvent({ type: GSD_UI_HOST_EVENT_NAME, subscriptionId: "owned-1", seq: 1, event: { kind: "tick" } })
    const forwarded = await eventReply
    assert.equal(forwarded.type, GSD_EMBED_EVENT_TYPE)
    assert.equal(forwarded.subscriptionId, "owned-1")
    assert.deepEqual(forwarded.event, { kind: "tick" })
    // Foreign subscription ids never forward (another mount on the same
    // Gateway connection).
    const foreignHeard = await new Promise<boolean>((resolve) => {
      port.onmessage = () => resolve(true)
      h.emitHostEvent({ type: GSD_UI_HOST_EVENT_NAME, subscriptionId: "foreign-9", seq: 1, event: { kind: "nope" } })
      setTimeout(() => resolve(false), 15)
    })
    assert.equal(foreignHeard, false)
    // Closure forwards with closed:true and releases ownership.
    const closedReply = waitForPortMessage(port)
    h.emitHostEvent({ type: GSD_UI_HOST_EVENT_NAME, subscriptionId: "owned-1", closed: true, reason: "lease expired" })
    const closed = await closedReply
    assert.equal(closed.closed, true)
    assert.equal(closed.reason, "lease expired")
    const afterCloseHeard = await new Promise<boolean>((resolve) => {
      port.onmessage = () => resolve(true)
      h.emitHostEvent({ type: GSD_UI_HOST_EVENT_NAME, subscriptionId: "owned-1", seq: 2, event: { kind: "gone" } })
      setTimeout(() => resolve(false), 15)
    })
    assert.equal(afterCloseHeard, false, "released subscription must not forward")
    // Establish a LIVE subscription, then retire: the automatic release must
    // fire the fully qualified unsubscribe for it on the strict host.
    const sub2Reply = waitForPortMessage(port)
    port.postMessage({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_REQUEST_TYPE, generation: 1, requestId: "s2", operation: "workspace.events.subscribe", args: {} })
    const sub2 = await sub2Reply
    assert.equal(sub2.ok, true)
    assert.equal(sub2.result.subscriptionId, "owned-2")
    // Retire the channel while owning a subscription: the automatic release
    // must call the FULLY QUALIFIED unsubscribe method on the strict host.
    ;(h.mountResult as { dispose: () => void }).dispose()
    await new Promise((r) => setTimeout(r, 10))
    const unsubCalls = h.requests.filter((rq) => rq.method.includes("unsubscribe"))
    assert.ok(unsubCalls.length >= 1, "retirement must release owned subscriptions")
    for (const rq of unsubCalls) {
      assert.ok(rq.method.startsWith("gsd.ui."), `unqualified method: ${rq.method}`)
    }
  } finally {
    h.restore()
  }
})

test("dispose unsubscribes host events and closes the channel", async () => {
  const h = setup()
  try {
    h.dispatchToWrapper({ protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_READY_TYPE, nonce: "doc-alpha" })
    assert.equal(h.hostEvents.length, 1)
    ;(h.mountResult as { dispose: () => void }).dispose()
    assert.equal(h.hostEvents.length, 0)
    assert.equal(h.iframe.removed, 1)
    assert.equal(h.windowListeners.length, 0)
  } finally {
    h.restore()
  }
})
