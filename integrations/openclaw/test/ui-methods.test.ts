import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerGsdUiMethods, type UiMethodApi, type UiHandlerOptions, type EmbeddedProjectsConfig, type UiClient } from "../src/ui-methods.ts"

const NL2 = String.fromCharCode(10)

function recordingApi() {
  const registered = new Map<string, { handler: (opts: UiHandlerOptions) => Promise<void> | void; opts?: { scope?: string; profileAccess?: string } }>()
  const api: UiMethodApi = {
    registerGatewayMethod: (method, handler, opts) => {
      registered.set(method, { handler, opts })
    },
  }
  return { api, registered }
}

interface Captured { ok: boolean; payload?: unknown; error?: { message: string } }

async function call(handler: (opts: UiHandlerOptions) => Promise<void> | void, overrides: Partial<UiHandlerOptions> = {}) {
  const responses: Captured[] = []
  const opts: UiHandlerOptions = {
    params: {},
    client: null,
    respond: (ok, payload, error) => {
      responses.push({ ok, payload, error })
    },
    context: {},
    ...overrides,
  }
  await handler(opts)
  return responses
}

function adminClient(overrides: Partial<UiClient> = {}): UiClient {
  return {
    connId: "conn-1",
    connectionSignal: new AbortController().signal,
    internal: { controlUiAdmin: true },
    ...overrides,
  }
}

function stubDaemonFetch(body: unknown = { stubbed: true }) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test("twelve methods registered; respond contract with ErrorShape third argument", async () => {
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277)
  assert.equal(registered.size, 12)
  for (const [method, entry] of registered) {
    assert.ok(method.startsWith("gsd.ui."), method)
    assert.equal(entry.opts?.profileAccess, "required", method)
  }
  const daemon = stubDaemonFetch()
  try {
    const adminDenied = await call(registered.get("gsd.ui.preferences.read")!.handler)
    assert.equal(adminDenied[0].ok, false, "preferences.read must enforce admin admission")
    const responses = await call(registered.get("gsd.ui.preferences.read")!.handler, { client: adminClient() })
    assert.deepEqual(responses, [{ ok: true, payload: { stubbed: true }, error: undefined }])
    assert.equal(daemon.calls[0].url, "http://127.0.0.1:33277/plugins/open-gsd-openclaw/web/api/preferences")
  } finally {
    daemon.restore()
  }
})

test("admin admission required by DEFAULT, even when adminOnly is omitted", async () => {
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [] })
  const denied = await call(registered.get("gsd.ui.projects.list")!.handler, { params: { root: "/x" }, client: { internal: {} } })
  assert.equal(denied[0].ok, false)
  assert.match(denied[0].error?.message ?? "", /administrator/)
  const wireForged = await call(registered.get("gsd.ui.projects.list")!.handler, {
    params: { root: "/x", admin: true },
    client: { connId: "c" },
  })
  assert.equal(wireForged[0].ok, false)
  const optedOut = recordingApi()
  registerGsdUiMethods(optedOut.api, () => 33277, { adminOnly: false, projects: [{ projectId: "p", canonicalRoot: "/definitely/not" }] })
  const nonAdmin = await call(optedOut.registered.get("gsd.ui.projects.list")!.handler, { params: { projectId: "p" }, client: { connId: "c" } })
  assert.doesNotMatch(nonAdmin[0].error?.message ?? "", /administrator/)
})

test("approved-root operations with canonical identity, containment, absolute-path normalization, daemon translation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-v3-")))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "f.txt"), "x")
  const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const client = adminClient()
  const daemon = stubDaemonFetch()
  try {
    const listed = await call(registered.get("gsd.ui.projects.list")!.handler, { params: { projectId: "p1", detail: true }, client })
    assert.equal(listed[0].ok, true)
    assert.ok(daemon.calls[0].url.includes("/api/projects?root=" + encodeURIComponent(root)))
    const dirsDefault = await call(registered.get("gsd.ui.directories.list")!.handler, { params: { projectId: "p1" }, client })
    assert.equal(dirsDefault[0].ok, true)
    assert.ok(daemon.calls[1].url.includes("path=" + encodeURIComponent(root)))
    const dirsAbsolute = await call(registered.get("gsd.ui.directories.list")!.handler, { params: { projectId: "p1", path: join(root, "src") }, client })
    assert.equal(dirsAbsolute[0].ok, true, dirsAbsolute[0].error?.message)
    assert.ok(daemon.calls[2].url.includes("path=" + encodeURIComponent(join(root, "src"))))
    const dirsEscape = await call(registered.get("gsd.ui.directories.list")!.handler, { params: { projectId: "p1", path: "../../etc" }, client })
    assert.equal(dirsEscape[0].ok, false)
    assert.match(dirsEscape[0].error?.message ?? "", /escapes/)
    const del = await call(registered.get("gsd.ui.files.delete")!.handler, { params: { project: root, root: "project", path: "src/f.txt" }, client })
    assert.equal(del[0].ok, true, del[0].error?.message)
    const delUrl = daemon.calls[3].url
    assert.ok(delUrl.includes("root=project"), delUrl)
    assert.ok(delUrl.includes("project=" + encodeURIComponent(root)), delUrl)
    assert.ok(delUrl.includes("path=src%2Ff.txt"), delUrl)
  } finally {
    daemon.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test("symlinked approved root loses canonical identity and denies", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "gsd-out-")))
  const linkParent = realpathSync(mkdtempSync(join(tmpdir(), "gsd-link-")))
  const linkPath = join(linkParent, "approved")
  try {
    symlinkSync(outside, linkPath)
    const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: linkPath }] }
    const { api, registered } = recordingApi()
    registerGsdUiMethods(api, () => 33277, config)
    const denied = await call(registered.get("gsd.ui.projects.list")!.handler, { params: { projectId: "p1" }, client: adminClient() })
    assert.equal(denied[0].ok, false)
    assert.match(denied[0].error?.message ?? "", /canonical identity/)
  } finally {
    rmSync(linkParent, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("subscriptions: policy-gated, non-starting route, exact-recipient broadcast, unsubscribe release", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-sub-")))
  const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const broadcasts: Array<{ event: string; payload: unknown; connIds: ReadonlySet<string> }> = []
  const context = {
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
      broadcasts.push({ event, payload, connIds })
    },
  }
  const controller = new AbortController()
  const client = adminClient({ connectionSignal: controller.signal })
  const original = globalThis.fetch
  const sseBody = "data: " + JSON.stringify({ kind: "a" }) + NL2 + NL2 + "data: " + JSON.stringify({ kind: "b" }) + NL2 + NL2
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(sseBody))
    },
  })
  globalThis.fetch = (async (input: unknown) => {
    assert.ok(String(input).includes("require_existing=1"), "subscription must use non-starting route: " + String(input))
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }) as typeof fetch
  try {
    const deniedNoProject = await call(registered.get("gsd.ui.workspace.events.subscribe")!.handler, {
      params: { project: "/nonexistent-root" },
      client,
      context,
    })
    assert.equal(deniedNoProject[0].ok, false)
    assert.match(deniedNoProject[0].error?.message ?? "", /no approved project/)
    const subResponses: Captured[] = []
    await registered.get("gsd.ui.workspace.events.subscribe")!.handler({
      params: { project: root },
      client,
      respond: (ok, payload, error) => {
        subResponses.push({ ok, payload, error })
      },
      context,
    })
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(subResponses.length, 1)
    assert.equal(subResponses[0].ok, true)
    const subscriptionId = (subResponses[0].payload as { subscriptionId: string }).subscriptionId
    const events = broadcasts.filter(
      (b) => b.event === "gsd.ui.event" && (b.payload as { subscriptionId?: string }).subscriptionId === subscriptionId && (b.payload as { event?: unknown }).event !== undefined,
    )
    assert.equal(events.length, 2, JSON.stringify(broadcasts))
    assert.deepEqual([...events[0].connIds], ["conn-1"])
    assert.equal((events[0].payload as { seq: number }).seq, 1)
    assert.equal((events[1].payload as { seq: number }).seq, 2)
    const unsub = await call(registered.get("gsd.ui.workspace.events.unsubscribe")!.handler, {
      params: { subscriptionId },
      client,
      context,
    })
    assert.equal(unsub[0].ok, true)
  } finally {
    globalThis.fetch = original
    controller.abort()
    rmSync(root, { recursive: true, force: true })
  }
})

test("subscription admission failures answer the RPC with an explicit error", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-deny-")))
  const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => undefined, config)
  try {
    const responses = await call(registered.get("gsd.ui.workspace.events.subscribe")!.handler, {
      params: { project: root },
      client: adminClient(),
      context: { broadcastToConnIds: () => {} },
    })
    assert.equal(responses.length, 1)
    assert.equal(responses[0].ok, false)
    assert.match(responses[0].error?.message ?? "", /unavailable/)
    const aborted = new AbortController()
    aborted.abort()
    const abortedResponses = await call(registered.get("gsd.ui.workspace.events.subscribe")!.handler, {
      params: { project: root },
      client: adminClient({ connectionSignal: aborted.signal }),
      context: { broadcastToConnIds: () => {} },
    })
    assert.equal(abortedResponses[0].ok, false)
    assert.match(abortedResponses[0].error?.message ?? "", /retired/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("daemon unavailability responds with an error frame", async () => {
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => undefined)
  const responses = await call(registered.get("gsd.ui.preferences.read")!.handler, { client: adminClient() })
  assert.equal(responses[0].ok, false)
  assert.match(responses[0].error?.message ?? "", /unavailable/)
})


test("setDevRoot proxies PUT preferences with the admitted canonical root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-sdr-")))
  const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const daemon = stubDaemonFetch()
  try {
    const res = await call(registered.get("gsd.ui.preferences.setDevRoot")!.handler, { params: { devRoot: root }, client: adminClient() })
    assert.equal(res[0].ok, true, res[0].error?.message)
    assert.equal(daemon.calls[0].init?.method, "PUT")
    assert.equal(daemon.calls[0].init?.body, JSON.stringify({ devRoot: root }))
    assert.ok(daemon.calls[0].url.endsWith("/api/preferences"))
  } finally {
    daemon.restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test("path-only browse pins to the single approved project", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-pin-")))
  mkdirSync(join(root, "src"), { recursive: true })
  const config: EmbeddedProjectsConfig = { adminOnly: true, projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const daemon = stubDaemonFetch()
  try {
    const dirs = await call(registered.get("gsd.ui.directories.list")!.handler, { params: { path: "src" }, client: adminClient() })
    assert.equal(dirs[0].ok, true, dirs[0].error?.message)
    assert.ok(daemon.calls[0].url.includes("path=" + encodeURIComponent(join(root, "src"))))
  } finally {
    daemon.restore()
    rmSync(root, { recursive: true, force: true })
  }
})


const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function subscriptionHarness(root: string) {
  const { api, registered } = recordingApi()
  const handles = registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const responses: Captured[] = []
  const events: Array<Record<string, unknown>> = []
  const connection = new AbortController()
  const opts = {
    params: { project: root },
    client: adminClient({ connectionSignal: connection.signal }),
    respond: (ok: boolean, payload: unknown, error: Captured["error"]) => responses.push({ ok, payload, error }),
    context: { broadcastToConnIds: (_name: string, payload: unknown, ids: ReadonlySet<string>) => {
      assert.deepEqual([...ids], ["conn-1"])
      events.push(payload as Record<string, unknown>)
    } },
  } as unknown as UiHandlerOptions
  return { registered, handles, responses, events, connection, opts }
}

function temporaryProject() {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-server-final-")))
}

test("disposeAll during pending admission responds once on a live connection and clears the record", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const root = temporaryProject()
  const h = subscriptionHarness(root)
  const original = globalThis.fetch
  let signal: AbortSignal | undefined
  globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal as AbortSignal
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })) as typeof fetch
  try {
    await h.registered.get("gsd.ui.workspace.events.subscribe")!.handler(h.opts)
    assert.equal(h.responses.length, 0)
    h.handles.disposeAll()
    await flush()
    assert.equal(signal?.aborted, true)
    assert.equal(h.handles.subscriptions.size, 0)
    assert.equal(h.responses.length, 1)
    assert.equal(h.responses[0].ok, false)
    assert.match(h.responses[0].error?.message ?? "", /disposal/)
    assert.equal(h.events.length, 0, "an unadmitted subscription has no child-visible closure")
    h.handles.disposeAll()
    t.mock.timers.tick(600_001)
    await flush()
    assert.equal(h.responses.length, 1)
  } finally {
    h.handles.disposeAll(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})

test("stream admission timeout replies once; a healthy body survives that deadline and closes once on disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const root = temporaryProject()
  const h = subscriptionHarness(root)
  const original = globalThis.fetch
  let streamSignal: AbortSignal | undefined
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel() { cancelled += 1 } })
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    streamSignal = init.signal as AbortSignal
    return new Response(body)
  }) as typeof fetch
  try {
    await h.registered.get("gsd.ui.workspace.events.subscribe")!.handler(h.opts)
    await flush()
    assert.equal(h.responses.length, 1)
    assert.equal(h.responses[0].ok, true)
    t.mock.timers.tick(10_001)
    await flush()
    assert.equal(streamSignal?.aborted, false)
    controller.enqueue(new TextEncoder().encode('data: {"still":"live"}\n\n'))
    await flush()
    assert.deepEqual(h.events[0].event, { still: "live" })
    h.handles.disposeAll()
    await flush()
    assert.equal(h.responses.length, 1)
    assert.equal(h.events.filter((e) => e.closed === true).length, 1)
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
    h.handles.disposeAll()
    assert.equal(h.events.filter((e) => e.closed === true).length, 1)

    const pending = subscriptionHarness(root)
    globalThis.fetch = ((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true })
    })) as typeof fetch
    await pending.registered.get("gsd.ui.workspace.events.subscribe")!.handler(pending.opts)
    t.mock.timers.tick(10_000)
    await flush()
    assert.equal(pending.responses.length, 1)
    assert.equal(pending.responses[0].ok, false)
    assert.equal(pending.handles.subscriptions.size, 0)
    assert.equal(pending.events.length, 0)
  } finally {
    h.handles.disposeAll(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})

test("SSE enforces raw UTF-8 byte budget and cancels/releases an oversized reader", async () => {
  const root = temporaryProject()
  const h = subscriptionHarness(root)
  const original = globalThis.fetch
  const text = "界".repeat(Math.floor(1_048_576 / 3) + 1)
  assert.ok(text.length < 1_048_576)
  const bytes = new TextEncoder().encode(text)
  assert.ok(bytes.byteLength > 1_048_576)
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes.subarray(0, 500_000)); c.enqueue(bytes.subarray(500_000)) },
    cancel() { cancelled += 1 },
  })
  globalThis.fetch = (async () => new Response(body)) as typeof fetch
  try {
    await h.registered.get("gsd.ui.workspace.events.subscribe")!.handler(h.opts)
    await flush()
    assert.equal(h.responses.length, 1)
    assert.equal(h.responses[0].ok, true)
    assert.equal(h.handles.subscriptions.size, 0)
    assert.equal(h.events.filter((e) => e.closed === true).length, 1)
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
  } finally {
    h.handles.disposeAll(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})

test("SSE reader error releases its lock and sends one closure after admission", async () => {
  const root = temporaryProject()
  const h = subscriptionHarness(root)
  const original = globalThis.fetch
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  globalThis.fetch = (async () => new Response(body)) as typeof fetch
  try {
    await h.registered.get("gsd.ui.workspace.events.subscribe")!.handler(h.opts)
    await flush()
    controller.error(new Error("read failed"))
    await flush()
    assert.equal(h.responses.length, 1)
    assert.equal(h.events.filter((e) => e.closed === true).length, 1)
    assert.equal(body.locked, false)
    assert.equal(h.handles.subscriptions.size, 0)
  } finally {
    h.handles.disposeAll(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})

test("ordinary daemon responses count bytes while reading and cancel/release on oversize", async () => {
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277)
  const original = globalThis.fetch
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("界".repeat(350_000))) },
    cancel() { cancelled += 1 },
  })
  globalThis.fetch = (async () => new Response(body)) as typeof fetch
  try {
    const responses = await call(registered.get("gsd.ui.preferences.read")!.handler, { client: adminClient() })
    assert.equal(responses.length, 1)
    assert.equal(responses[0].ok, false)
    assert.match(responses[0].error?.message ?? "", /size bound/)
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
  } finally { globalThis.fetch = original }
})

test("terminal subscription forwards admitted canonical project and never starts the daemon route", async () => {
  const root = temporaryProject()
  const h = subscriptionHarness(root)
  const original = globalThis.fetch
  let requested: URL | undefined
  const body = new ReadableStream<Uint8Array>({ start() {} })
  globalThis.fetch = (async (url: unknown) => { requested = new URL(String(url)); return new Response(body) }) as typeof fetch
  try {
    await h.registered.get("gsd.ui.terminal.output.subscribe")!.handler({ ...h.opts, params: { project: root, terminalId: "terminal-a" } })
    await flush()
    assert.equal(requested?.searchParams.get("project"), root)
    assert.equal(requested?.searchParams.get("id"), "terminal-a")
    assert.equal(requested?.searchParams.get("require_existing"), "1")
    assert.equal(h.responses[0].ok, true)
  } finally {
    h.handles.disposeAll(); await flush(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true })
  }
})

test("workspace bootstrap requires write scope, profile, admin and approved project; preserves a project-bound boot DTO", async () => {
  const root = temporaryProject()
  const { api, registered } = recordingApi()
  const config: EmbeddedProjectsConfig = { projects: [{ projectId: "p1", canonicalRoot: root }] }
  registerGsdUiMethods(api, () => 33277, config)
  const method = registered.get("gsd.ui.workspace.bootstrap")!
  assert.equal(method.opts?.scope, "operator.write")
  assert.equal(method.opts?.profileAccess, "required")
  const boot = { project: { cwd: root }, workspace: {}, bridge: { projectCwd: root }, onboarding: { locked: false }, resumableSessions: [], onboardingNeeded: false }
  const daemon = stubDaemonFetch(boot)
  try {
    const denied = await call(method.handler, { params: { project: root }, client: { connId: "reader" } })
    assert.equal(denied[0].ok, false)
    const outside = await call(method.handler, { params: { project: "/outside" }, client: adminClient() })
    assert.equal(outside[0].ok, false)
    assert.equal(daemon.calls.length, 0)
    const response = await call(method.handler, { params: { project: root }, client: adminClient() })
    assert.equal(response[0].ok, true)
    assert.deepEqual(response[0].payload, boot)
    assert.equal(new URL(daemon.calls[0].url).searchParams.get("project"), root)
    assert.equal(new URL(daemon.calls[0].url).pathname.endsWith("/api/boot"), true)
    config.projects = []
    assert.equal((await call(method.handler, { params: { project: root }, client: adminClient() }))[0].ok, false)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }) }
})

test("workspace bootstrap rejects a daemon payload bound to another project", async () => {
  const root = temporaryProject()
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const daemon = stubDaemonFetch({ project: { cwd: "/other" }, workspace: {}, bridge: {}, onboarding: { locked: false }, resumableSessions: [] })
  try {
    const responses = await call(registered.get("gsd.ui.workspace.bootstrap")!.handler, { params: { project: root }, client: adminClient() })
    assert.equal(responses[0].ok, false)
    assert.match(responses[0].error?.message ?? "", /invalid boot payload/)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }) }
})

test("file deletion separates selector from project identity and rejects traversal or external .gsd symlinks", async () => {
  const root = temporaryProject()
  const outside = temporaryProject()
  mkdirSync(join(root, ".gsd"))
  writeFileSync(join(root, ".gsd", "state.md"), "state")
  writeFileSync(join(root, "file.txt"), "project")
  writeFileSync(join(outside, "secret.txt"), "outside")
  symlinkSync(outside, join(root, "escape"))
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const method = registered.get("gsd.ui.files.delete")!
  const daemon = stubDaemonFetch({ success: true })
  try {
    for (const [selector, path] of [["project", "file.txt"], ["gsd", "state.md"]]) {
      assert.equal((await call(method.handler, { params: { project: root, root: selector, path }, client: adminClient() }))[0].ok, true)
      const requested = new URL(daemon.calls.at(-1)!.url)
      assert.equal(requested.searchParams.get("root"), selector)
      assert.equal(requested.searchParams.get("project"), root)
      assert.equal(requested.searchParams.get("path"), path)
    }
    const validCount = daemon.calls.length
    for (const params of [
      { root: root, path: "file.txt" },
      { project: root, root: root, path: "file.txt" },
      { project: root, root: "project", path: "../outside" },
      { project: root, root: "project", path: "." },
      { project: root, root: "project", path: join(root, "file.txt") },
      { project: root, root: "project", path: "escape/secret.txt" },
    ]) assert.equal((await call(method.handler, { params, client: adminClient() }))[0].ok, false)
    rmSync(join(root, ".gsd"), { recursive: true })
    symlinkSync(outside, join(root, ".gsd"))
    assert.equal((await call(method.handler, { params: { project: root, root: "gsd", path: "secret.txt" }, client: adminClient() }))[0].ok, false)
    assert.equal(daemon.calls.length, validCount)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test("admission observes policy updates after registration and defaults back to admin required", async () => {
  const root = temporaryProject()
  const config: EmbeddedProjectsConfig = { projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const method = registered.get("gsd.ui.projects.list")!
  const daemon = stubDaemonFetch([])
  const opts = { params: { project: root }, client: { connId: "non-admin" } as UiClient }
  try {
    assert.equal((await call(method.handler, opts))[0].ok, false)
    config.adminOnly = false
    assert.equal((await call(method.handler, opts))[0].ok, true)
    delete config.adminOnly
    assert.equal((await call(method.handler, opts))[0].ok, false)
    config.adminOnly = false
    config.projects = []
    assert.equal((await call(method.handler, opts))[0].ok, false)
    assert.equal(daemon.calls.length, 1)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }) }
})


test("file reads bind tree and content requests to approved selectors with read scope", async () => {
  const root = temporaryProject()
  mkdirSync(join(root, ".gsd"))
  writeFileSync(join(root, ".gsd", "STATE.md"), "state")
  writeFileSync(join(root, "read me.md"), "project")
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const method = registered.get("gsd.ui.files.read")!
  assert.ok(method, "file GET must have its own named server operation")
  assert.deepEqual(method.opts, { scope: "operator.read", profileAccess: "required" })
  try {
    for (const selector of ["project", "gsd"]) {
      for (const path of [undefined, "", selector === "gsd" ? "STATE.md" : "read me.md"]) {
        const payload = path ? { content: "file content" } : { tree: [{ name: "entry", type: "file" }] }
        const daemon = stubDaemonFetch(payload)
        try {
          const responses = await call(method.handler, { params: { project: root, root: selector, path }, client: adminClient() })
          assert.deepEqual(responses, [{ ok: true, payload, error: undefined }])
          assert.equal(daemon.calls.length, 1)
          const requested = new URL(daemon.calls[0].url)
          assert.equal(requested.origin, "http://127.0.0.1:33277")
          assert.equal(requested.pathname, "/plugins/open-gsd-openclaw/web/api/files")
          assert.equal(requested.searchParams.get("root"), selector)
          assert.equal(requested.searchParams.get("project"), root)
          assert.equal(requested.searchParams.get("path"), path || null)
          assert.equal(daemon.calls[0].init?.method ?? "GET", "GET")
        } finally { daemon.restore() }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("file reads deny missing identity, unauthorized clients, policy withdrawal, and path escapes before fetch", async () => {
  const root = temporaryProject()
  const outside = temporaryProject()
  mkdirSync(join(root, ".gsd"))
  writeFileSync(join(root, "file.txt"), "project")
  writeFileSync(join(outside, "outside.txt"), "outside")
  symlinkSync(outside, join(root, "escape"))
  symlinkSync(join(root, "file.txt"), join(root, ".gsd", "outside-selected-root"))
  const config: EmbeddedProjectsConfig = { projects: [{ projectId: "p1", canonicalRoot: root }] }
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, config)
  const method = registered.get("gsd.ui.files.read")!
  assert.ok(method)
  const daemon = stubDaemonFetch({ tree: [] })
  try {
    for (const params of [
      { root: "project" },
      { project: outside, root: "project" },
      { project: root, root: root },
      { project: root, root: "project", path: 123 },
      { project: root, root: "project", path: "../outside" },
      { project: root, root: "project", path: "." },
      { project: root, root: "project", path: join(root, "file.txt") },
      { project: root, root: "project", path: "escape/outside.txt" },
      { project: root, root: "gsd", path: "outside-selected-root" },
    ]) {
      const responses = await call(method.handler, { params, client: adminClient() })
      assert.equal(responses[0].ok, false, JSON.stringify(params))
    }
    for (const client of [null, { connId: "forged" }, adminClient({ invalidated: true })]) {
      assert.equal((await call(method.handler, { params: { root: "project", project: root, admin: true }, client }))[0].ok, false)
    }
    config.projects = []
    assert.equal((await call(method.handler, { params: { root: "project", project: root }, client: adminClient() }))[0].ok, false)
    assert.equal(daemon.calls.length, 0)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test("file reads return an empty absent .gsd tree but deny external or dangling .gsd links", async () => {
  const root = temporaryProject()
  const outside = temporaryProject()
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const method = registered.get("gsd.ui.files.read")!
  assert.ok(method)
  const daemon = stubDaemonFetch({ tree: [] })
  try {
    const opts = { params: { project: root, root: "gsd" }, client: adminClient() }
    assert.deepEqual(await call(method.handler, opts), [{ ok: true, payload: { tree: [] }, error: undefined }])
    symlinkSync(outside, join(root, ".gsd"))
    assert.equal((await call(method.handler, opts))[0].ok, false)
    rmSync(join(root, ".gsd"))
    symlinkSync(join(outside, "missing"), join(root, ".gsd"))
    assert.equal((await call(method.handler, opts))[0].ok, false)
    assert.equal(daemon.calls.length, 0)
  } finally { daemon.restore(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test("file reads reject malformed DTOs and enforce raw JSON and UTF-8 content bounds", async () => {
  const root = temporaryProject()
  writeFileSync(join(root, "file.txt"), "file")
  const { api, registered } = recordingApi()
  registerGsdUiMethods(api, () => 33277, { projects: [{ projectId: "p1", canonicalRoot: root }] })
  const method = registered.get("gsd.ui.files.read")!
  assert.ok(method)
  try {
    for (const [path, payload, pattern] of [
      [undefined, { content: "wrong shape" }, /invalid file tree/],
      ["file.txt", { content: 123 }, /invalid file content/],
      ["file.txt", { content: "é".repeat(131073) }, /file content exceeds size bound/],
      [undefined, { tree: [], padding: "é".repeat(524289) }, /response exceeds size bound/],
    ] as const) {
      const daemon = stubDaemonFetch(payload)
      try {
        const responses = await call(method.handler, { params: { project: root, root: "project", path }, client: adminClient() })
        assert.equal(responses[0].ok, false)
        assert.match(responses[0].error?.message ?? "", pattern)
      } finally { daemon.restore() }
    }
    const content = "é".repeat(131072)
    const daemon = stubDaemonFetch({ content })
    try {
      const responses = await call(method.handler, { params: { projectId: "p1", root: "project", path: "file.txt" }, client: adminClient() })
      assert.equal(responses[0].ok, true, responses[0].error?.message)
      assert.deepEqual(responses[0].payload, { content })
    } finally { daemon.restore() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
