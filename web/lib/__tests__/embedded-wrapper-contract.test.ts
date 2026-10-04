import test from "node:test"
import assert from "node:assert/strict"
import {
  EMBEDDED_ALLOWED_OPERATIONS,
  embeddedStartup,
  resetEmbeddedGate,
  embeddedEventSourceForUrl,
} from "../embedded-gate.ts"
import { authFetch } from "../auth.ts"
import { buildProjectPath } from "../project-url.ts"
import {
  createGsdEmbedPlugin,
  EMBED_ALLOWED_OPERATIONS,
  type EmbedHost,
} from "../../../integrations/openclaw/src/control-ui-embed.ts"

type Message = { data: unknown; source: unknown; origin: string; ports: unknown[] }
type Listener = (message: Message) => void
type Call = { method: string; params: unknown }

// Only the two Window message endpoints and mount DOM are simulated. The
// mapper, both production allowlists, nonce negotiation, MessageChannel,
// child request client and wrapper dispatcher all execute their real code.
function mountContract(basePath = "") {
  const previousBasePath = process.env.NEXT_PUBLIC_BASE_PATH
  process.env.NEXT_PUBLIC_BASE_PATH = basePath
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = new Map(["window", "addEventListener", "removeEventListener", "fetch"]
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const))
  const parentListeners = new Set<Listener>()
  const childListeners = new Set<Listener>()
  const loadListeners: Array<() => void> = []
  const readyMessages: unknown[] = []
  const binds: unknown[] = []
  const calls: Call[] = []
  const waiting = new Map<string, (call: Call) => void>()
  let directFetches = 0
  let subscriptionNumber = 0
  const postToParent = (data: unknown) => queueMicrotask(() => {
    for (const listener of [...parentListeners]) listener({ data, source: child, origin: "null", ports: [] })
  })
  const parent = { postMessage(data: unknown) { readyMessages.push(data); postToParent(data) } }
  const child = {
    origin: "null",
    location: { search: "?__gsd_embedded=1" },
    parent,
    addEventListener(type: string, listener: Listener) { if (type === "message") childListeners.add(listener) },
    removeEventListener(type: string, listener: Listener) { if (type === "message") childListeners.delete(listener) },
    postMessage(data: unknown, _origin: string, ports: unknown[] = []) {
      binds.push(data)
      queueMicrotask(() => {
        for (const listener of [...childListeners]) listener({ data, source: parent, origin: "https://gateway.test", ports })
      })
    },
  }
  const iframe = {
    contentWindow: child, src: "", sandbox: "", style: {},
    remove() {},
    addEventListener(type: string, listener: () => void) { if (type === "load") loadListeners.push(listener) },
  }
  globals.window = child
  globals.addEventListener = (type: string, listener: Listener) => { if (type === "message") parentListeners.add(listener) }
  globals.removeEventListener = (type: string, listener: Listener) => { if (type === "message") parentListeners.delete(listener) }
  globals.fetch = () => { directFetches += 1; throw new Error("embedded contract attempted direct fetch") }
  let plugin!: { activate(host: EmbedHost): void }
  let page!: Parameters<EmbedHost["ui"]["registerPage"]>[0]
  const request: EmbedHost["request"] = async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const call = { method, params }
    calls.push(call)
    waiting.get(method)?.(call)
    waiting.delete(method)
    const result = method.endsWith(".subscribe")
      ? { subscriptionId: `subscription-${++subscriptionNumber}` }
      : { method, params }
    return result as T
  }
  createGsdEmbedPlugin({
    frameSrc: "/plugins/open-gsd-openclaw/web/?__gsd_embedded=1",
    allowedOperations: EMBED_ALLOWED_OPERATIONS,
    request,
    definePlugin(definition) { plugin = definition; return definition },
  })
  plugin.activate({ ui: {
    registerPage(value: typeof page) { page = value },
    registerNavigation() {},
  } } as unknown as EmbedHost)
  const abort = new AbortController()
  const mount = page.mount({ ownerDocument: { createElement: () => iframe }, appendChild() {} } as unknown as HTMLElement,
    { signal: abort.signal } as Parameters<typeof page.mount>[1])
  return {
    calls, binds, readyMessages,
    start: () => embeddedStartup(),
    fireLoad: () => { for (const listener of loadListeners) listener() },
    duplicateReady: () => postToParent(readyMessages.at(-1)),
    nextCall(method: string): Promise<Call> {
      const existing = calls.find((call) => call.method === method)
      return existing ? Promise.resolve(existing) : new Promise((resolve) => waiting.set(method, resolve))
    },
    dispose() {
      resetEmbeddedGate()
      abort.abort()
      mount?.dispose?.()
      if (previousBasePath === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH
      else process.env.NEXT_PUBLIC_BASE_PATH = previousBasePath
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globals[key]
      }
      assert.equal(parentListeners.size, 0)
      assert.equal(childListeners.size, 0)
      assert.equal(directFetches, 0)
    },
  }
}

const project = "/approved/project with spaces"
type HttpScenario = { operation: string; path: string; method?: string; body?: unknown; args: unknown }
const httpCases: HttpScenario[] = [
  { operation: "workspace.bootstrap", path: buildProjectPath("/api/boot", project), args: { project } },
  { operation: "preferences.read", path: "/api/preferences", args: {} },
  { operation: "projects.list", path: `/api/projects?root=${encodeURIComponent(project)}&detail=true`, args: { root: project, detail: true } },
  { operation: "directories.list", path: `/api/browse-directories?path=${encodeURIComponent(project)}`, args: { root: null, path: project } },
  { operation: "preferences.selectRoot", path: "/api/switch-root", method: "POST", body: { devRoot: project }, args: { devRoot: project } },
  { operation: "preferences.setDevRoot", path: "/api/preferences", method: "PUT", body: { devRoot: project }, args: { devRoot: project } },
  // FilesView.fetchTree and openFileTab use these two GET shapes.
  ...["project", "gsd"].flatMap((root) => [
    { operation: "files.read", path: buildProjectPath(`/api/files?root=${root}`, project), args: { root, project, path: null } },
    { operation: "files.read", path: buildProjectPath(`/api/files?root=${root}&path=notes%2Fread%20me.md`, project), args: { root, project, path: "notes/read me.md" } },
  ]),
  ...["project", "gsd"].map((root) => ({
    operation: "files.delete", path: buildProjectPath(`/api/files?root=${root}&path=notes%2Fdraft.md`, project), method: "DELETE",
    args: { root, project, path: "notes/draft.md" },
  })),
]
const streamCases = [
  { operation: "workspace.events.subscribe", path: buildProjectPath("/api/session/events", project), args: { project } },
  { operation: "terminal.output.subscribe", path: buildProjectPath("/api/terminal/stream?id=terminal-1&command=ignored&arg=ignored", project), args: { terminalId: "terminal-1", project } },
]

test("every production operation has a contract case and is admitted by the real wrapper", () => {
  const exercised = new Set([
    ...httpCases.map(({ operation }) => operation),
    ...streamCases.flatMap(({ operation }) => [operation, operation.replace(/\.subscribe$/, ".unsubscribe")]),
  ])
  assert.deepEqual([...exercised].sort(), [...EMBEDDED_ALLOWED_OPERATIONS].sort())
  assert.deepEqual([...EMBED_ALLOWED_OPERATIONS].sort(), [...EMBEDDED_ALLOWED_OPERATIONS].sort())
})

for (const basePath of ["", "/plugins/open-gsd-openclaw/web"]) {
  for (const scenario of httpCases) {
    test(`actual HTTP mapper → child transport → wrapper: ${scenario.operation} ${basePath}${scenario.path}`, { timeout: 5000 }, async () => {
      const h = mountContract(basePath)
      try {
        assert.equal(await h.start(), "embedded-ready")
        const init = { method: scenario.method ?? "GET", ...(scenario.body === undefined ? {} : { body: JSON.stringify(scenario.body) }) }
        const response = await authFetch(basePath + scenario.path, init)
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
        const expected = { method: `gsd.ui.${scenario.operation}`, params: scenario.args }
        assert.deepEqual(await response.json(), expected)
        assert.deepEqual(h.calls, [expected])
      } finally { h.dispose() }
    })
  }

  for (const scenario of streamCases) {
    test(`actual stream mapper → child transport → wrapper: ${scenario.operation} ${basePath} and release`, { timeout: 5000 }, async () => {
      const h = mountContract(basePath)
      try {
        assert.equal(await h.start(), "embedded-ready")
        const stream = embeddedEventSourceForUrl(basePath + scenario.path)
        assert.ok(stream)
        await new Promise<void>((resolve, reject) => {
          stream.onopen = resolve
          stream.onerror = () => reject(new Error("stream subscription failed"))
        })
        assert.deepEqual(h.calls, [{ method: `gsd.ui.${scenario.operation}`, params: scenario.args }])
        stream.close()
        const release = await h.nextCall(`gsd.ui.${scenario.operation.replace(/\.subscribe$/, ".unsubscribe")}`)
        assert.deepEqual(release.params, { subscriptionId: "subscription-1" })
      } finally { h.dispose() }
    })
  }

}

test("unmapped routes and methods never dispatch through the authenticated wrapper", { timeout: 5000 }, async () => {
  const h = mountContract("/plugins/open-gsd-openclaw/web")
  try {
    assert.equal(await h.start(), "embedded-ready")
    for (const [path, method] of [
      ["/api/session/command", "POST"],
      ["/api/boot", "POST"],
      ["/plugins/open-gsd-openclaw/web-other/api/boot", "GET"],
    ]) {
      assert.equal((await authFetch(path, { method })).status, 501)
    }
    assert.deepEqual(h.calls, [])
  } finally { h.dispose() }
})

test("real child nonce survives both load orders and duplicate ready across reload", { timeout: 5000 }, async () => {
  const h = mountContract()
  try {
    h.fireLoad()
    assert.equal(await h.start(), "embedded-ready")
    h.fireLoad()
    h.duplicateReady()
    assert.equal((await authFetch("/api/preferences")).status, 200)
    assert.equal(h.binds.length, 1)
    resetEmbeddedGate()
    assert.equal(await h.start(), "embedded-ready")
    h.fireLoad()
    h.duplicateReady()
    assert.equal((await authFetch("/api/preferences")).status, 200)
    assert.equal(h.binds.length, 2)
    assert.notEqual((h.binds[0] as { nonce: string }).nonce, (h.binds[1] as { nonce: string }).nonce)
  } finally { h.dispose() }
})
