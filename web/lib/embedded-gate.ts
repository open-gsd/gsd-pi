/**
 * Embedded-mode integration gate for the Control UI plugin tab.
 *
 * In embedded mode the app never uses legacy boot/fetch/EventSource/beacon
 * paths directly: application requests map through an exact route-to-
 * operation table onto the gsd-ui/1 named-operation transport. Unknown
 * routes, methods, and negotiation failures all fail closed - there is NO
 * fallback to direct credentialed HTTP. Standalone behavior is untouched.
 */

import {
  detectEmbeddedChannel,
  negotiateEmbeddedTransport,
  type EmbeddedOperationClient,
  type FrameEventMessage,
} from "./embedded-transport.ts"

export type EmbeddedStartupState = "standalone" | "embedded-ready" | "embedded-unavailable"

/** The fixed operation set the embedded frame may request. The parent
 * wrapper and the app startup MUST use this same list. */
export const EMBEDDED_ALLOWED_OPERATIONS: readonly string[] = [
  "workspace.bootstrap",
  "preferences.read",
  "projects.list",
  "directories.list",
  "preferences.selectRoot",
  "preferences.setDevRoot",
  "files.read",
  "files.delete",
  "workspace.events.subscribe",
  "workspace.events.unsubscribe",
  "terminal.output.subscribe",
  "terminal.output.unsubscribe",
]

let cachedTransport: EmbeddedOperationClient | null = null
let startupPromise: Promise<EmbeddedStartupState> | null = null
let gateGeneration = 0

export function embeddedModeActive(): boolean {
  if (typeof window === "undefined") return false
  return detectEmbeddedChannel(window as never).embedded
}

/** Bounded startup: standalone resolves immediately; embedded negotiates once
 * and never falls back to direct HTTP. A reset during negotiation invalidates
 * the in-flight completion - it is disposed, never installed. */
export function embeddedStartup(options?: {
  allowedOperations?: Iterable<string>
  negotiate?: (opts: { allowedOperations: Iterable<string> }) => Promise<EmbeddedOperationClient>
}): Promise<EmbeddedStartupState> {
  if (!embeddedModeActive()) return Promise.resolve("standalone")
  if (startupPromise) return startupPromise
  const allowed = options?.allowedOperations ?? EMBEDDED_ALLOWED_OPERATIONS
  const negotiate = options?.negotiate ?? ((opts) => negotiateEmbeddedTransport({ ...opts, window: window as never }))
  const generation = gateGeneration
  startupPromise = negotiate({ allowedOperations: allowed })
    .then((client) => {
      if (generation !== gateGeneration) {
        // Stale completion after reset/shutdown: dispose it, never install it.
        client.dispose()
        return "embedded-unavailable" as const
      }
      cachedTransport = client
      return "embedded-ready" as const
    })
    .catch(() => "embedded-unavailable" as const)
  return startupPromise
}

export function getEmbeddedTransport(): EmbeddedOperationClient | null {
  return cachedTransport
}

/** Testing and shutdown seam: resets the singleton and invalidates any
 * in-flight negotiation via the generation counter. */
export function resetEmbeddedGate(): void {
  gateGeneration += 1
  cachedTransport?.dispose()
  cachedTransport = null
  startupPromise = null
}

interface RouteMapping {
  method: string
  pattern: RegExp
  operation: string
  buildArgs: (url: URL, bodyText: string | null) => unknown
}

const ROUTE_MAP: RouteMapping[] = [
  {
    // Legacy GET boot starts the selected workspace. The named operation is
    // admitted as operator.write on the server, separately from subscriptions.
    method: "GET",
    pattern: /^\/api\/boot$/,
    operation: "workspace.bootstrap",
    buildArgs: (url) => ({ project: url.searchParams.get("project") }),
  },
  {
    method: "GET",
    pattern: /^\/api\/preferences$/,
    operation: "preferences.read",
    buildArgs: () => ({}),
  },
  {
    method: "GET",
    pattern: /^\/api\/projects$/,
    operation: "projects.list",
    buildArgs: (url) => ({ root: url.searchParams.get("root"), detail: url.searchParams.get("detail") === "true" }),
  },
  {
    method: "GET",
    pattern: /^\/api\/browse-directories$/,
    operation: "directories.list",
    buildArgs: (url) => ({ root: url.searchParams.get("root") ?? url.searchParams.get("project"), path: url.searchParams.get("path") }),
  },
  {
    method: "PUT",
    pattern: /^\/api\/preferences$/,
    operation: "preferences.setDevRoot",
    buildArgs: (_url, bodyText) => {
      // Validated DTO: only the known devRoot field crosses.
      try {
        const parsed = bodyText ? JSON.parse(bodyText) : {}
        const devRoot = typeof (parsed as { devRoot?: unknown })?.devRoot === "string" ? (parsed as { devRoot: string }).devRoot : undefined
        return { devRoot }
      } catch {
        return { devRoot: undefined }
      }
    },
  },  {
    method: "POST",
    pattern: /^\/api\/switch-root$/,
    operation: "preferences.selectRoot",
    buildArgs: (_url, bodyText) => {
      // Validated DTO: only the known devRoot field crosses; arbitrary JSON
      // from the request body is never forwarded wholesale.
      try {
        const parsed = bodyText ? JSON.parse(bodyText) : {}
        const devRoot = typeof (parsed as { devRoot?: unknown })?.devRoot === "string" ? (parsed as { devRoot: string }).devRoot : undefined
        return { devRoot }
      } catch {
        return { devRoot: undefined }
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/files$/,
    operation: "files.read",
    // No path lists the tree; a path reads content within that selected tree.
    buildArgs: (url) => ({ root: url.searchParams.get("root"), project: url.searchParams.get("project"), path: url.searchParams.get("path") }),
  },
  {
    method: "DELETE",
    pattern: /^\/api\/files$/,
    operation: "files.delete",
    // root selects the file tree; project is the independent project identity.
    // Missing identity must stay missing so the server can deny it.
    buildArgs: (url) => ({ root: url.searchParams.get("root"), project: url.searchParams.get("project"), path: url.searchParams.get("path") }),
  },
]

export function mapRouteToOperation(method: string, path: string, bodyText: string | null): { operation: string; args: unknown } | undefined {
  const url = new URL("http://embedded.invalid" + path)
  // Workspace callers already include the configured deployment base path.
  // Strip only that exact prefix; unrelated paths still fail closed.
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  if (base && url.pathname.startsWith(base + "/")) url.pathname = url.pathname.slice(base.length)
  for (const mapping of ROUTE_MAP) {
    if (mapping.method !== method) continue
    if (!mapping.pattern.test(url.pathname)) continue
    return { operation: mapping.operation, args: mapping.buildArgs(url, bodyText) }
  }
  return undefined
}

function unavailableResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } })
}

/** authFetch-compatible wrapper for embedded mode. Fails closed for unknown
 * routes/methods and for transport failures; never performs network IO. */
export async function embeddedApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const transport = getEmbeddedTransport()
  if (!transport) return unavailableResponse("embedded transport unavailable", 503)
  const method = (init?.method ?? "GET").toUpperCase()
  const bodyText = typeof init?.body === "string" ? init.body : null
  const mapped = mapRouteToOperation(method, path, bodyText)
  if (!mapped) return unavailableResponse("embedded mode refuses unmapped route: " + method + " " + path, 501)
  try {
    const result = await transport.request(mapped.operation, mapped.args)
    return new Response(JSON.stringify(result ?? null), { status: 200, headers: { "Content-Type": "application/json" } })
  } catch (error) {
    return unavailableResponse(error instanceof Error ? error.message : "embedded operation failed", 502)
  }
}

/** Embedded pagehide must never send the shutdown beacon; the adapter closes
 * instead. */
export function shouldSuppressShutdownBeacon(): boolean {
  return embeddedModeActive()
}

export function embeddedShutdown(): void {
  resetEmbeddedGate()
}

/** EventSource-compatible adapter over subscription operations.
 *
 * Validated readiness: nothing is delivered before an exact subscriptionId
 * arrives from the subscribe reply; non-matching subscriptionIds never
 * deliver. close() releases the backend subscription, and a late subscribe
 * reply after close also releases rather than leaking. Subscribe failures
 * tear down the event handler and surface onerror. */
export class EmbeddedEventSourceAdapter {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  private closed = false
  private subscriptionId: string | null = null
  private unsubscribeEvents: () => void
  private transportRef: EmbeddedOperationClient
  private operationRef: string

  constructor(transport: EmbeddedOperationClient, operation: string, args: unknown) {
    this.transportRef = transport
    this.operationRef = operation
    this.unsubscribeEvents = transport.onEvent((message: FrameEventMessage) => {
      if (this.closed || this.subscriptionId === null) return
      if (message.subscriptionId !== this.subscriptionId) return
      if (message.closed === true) {
        // Server closure: explicit disconnected state, local teardown -
        // never leave the UI appearing live with no events arriving.
        this.teardown()
        this.onerror?.()
        return
      }
      if (message.event === undefined) return
      this.onmessage?.({ data: typeof message.event === "string" ? message.event : JSON.stringify(message.event) })
    })
    transport.request(operation, args).then(
      (result) => {
        const id = (result as { subscriptionId?: unknown } | null)?.subscriptionId
        if (typeof id !== "string") {
          this.teardown()
          if (!this.closed) this.onerror?.()
          return
        }
        if (this.closed) {
          // Late subscribe reply after close: the backend holds a live
          // subscription that must still be released.
          this.releaseBackend(id)
          return
        }
        this.subscriptionId = id
        this.onopen?.()
      },
      () => {
        this.teardown()
        if (!this.closed) this.onerror?.()
      },
    )
  }

  private releaseBackend(subscriptionId: string): void {
    const unsubscribeOperation = this.operationRef.replace(/\.subscribe$/, ".unsubscribe")
    void this.transportRef.request(unsubscribeOperation, { subscriptionId }).catch(() => {
      // best-effort release; server-side lease retirement covers crashes
    })
  }

  private teardown(): void {
    this.unsubscribeEvents()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.teardown()
    if (this.subscriptionId !== null) this.releaseBackend(this.subscriptionId)
  }
}

function normalizeStreamUrl(rawUrl: string): { pathname: string; searchParams: URLSearchParams } | undefined {
  try {
    const url = new URL(rawUrl, "http://embedded.invalid")
    let pathname = url.pathname
    const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ""
    if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length)
    return { pathname, searchParams: url.searchParams }
  } catch {
    return undefined
  }
}

const STREAM_MAP: Array<{ pattern: RegExp; operation: string; buildArgs: (params: URLSearchParams) => unknown }> = [
  {
    pattern: /^\/api\/session\/events$/,
    operation: "workspace.events.subscribe",
    buildArgs: (params) => ({ project: params.get("project") }),
  },
  {
    // Output subscription only: terminalId identifies an existing terminal.
    // Creation (with command) is a separate reviewed operation, never here.
    pattern: /^\/api\/terminal\/stream$/,
    operation: "terminal.output.subscribe",
    buildArgs: (params) => ({ terminalId: params.get("id"), project: params.get("project") }),
  },
]

export function embeddedEventSourceForUrl(url: string): EmbeddedEventSourceAdapter | undefined {
  const transport = getEmbeddedTransport()
  if (!transport) return undefined
  const normalized = normalizeStreamUrl(url)
  if (!normalized) return undefined
  for (const mapping of STREAM_MAP) {
    if (!mapping.pattern.test(normalized.pathname)) continue
    return new EmbeddedEventSourceAdapter(transport, mapping.operation, mapping.buildArgs(normalized.searchParams))
  }
  return undefined
}

export interface ModeAwareEventSourceLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  close(): void
}

class UnmappedEmbeddedEventSource implements ModeAwareEventSourceLike {
  onopen = null
  onmessage = null
  onerror: (() => void) | null = null
  constructor() {
    setTimeout(() => this.onerror?.(), 0)
  }
  close() {}
}

/** Standalone keeps the real credentialed EventSource; embedded mode uses
 * the subscription adapter, and unmapped stream URLs FAIL CLOSED - never a
 * direct EventSource. */
export function createModeAwareEventSource(url: string): ModeAwareEventSourceLike {
  if (embeddedModeActive()) {
    const adapter = embeddedEventSourceForUrl(url)
    if (adapter) return adapter
    return new UnmappedEmbeddedEventSource()
  }
  return new EventSource(url, { withCredentials: true }) as unknown as ModeAwareEventSourceLike
}
export { EMBEDDED_MARKER_QUERY } from "./embedded-transport.ts"
