/**
 * gsd.ui.* Gateway RPC methods for the embedded Control UI frame.
 *
 * Vendor contracts: handlers take one options object and return void, with
 * results through respond(ok, payload, error?) using ErrorShape frames; event
 * delivery uses broadcastToConnIds(event, payload, ReadonlySet<connId>, opts?).
 * Admin admission is required by default (adminOnly: false opts out
 * explicitly). Subscriptions require an admitted approved project, use
 * non-starting daemon routes (require_existing), are byte-bounded while
 * reading, capped per connection, and fully released on unsubscribe, lease
 * expiry, connection retirement, or disposeAll - with liveness rechecked
 * before every emission and late replies dropped.
 */

import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core"

/** Real vendor contracts: handler options and registration shapes derive
 * from the installed SDK - never hand-rolled substitutes. */
export type UiHandlerOptions = GatewayRequestHandlerOptions
export type UiGatewayRegistrationOptions = NonNullable<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2]>
export type UiClient = NonNullable<GatewayRequestHandlerOptions["client"]>
export type UiHandlerContext = GatewayRequestHandlerOptions["context"]
export type UiRespond = GatewayRequestHandlerOptions["respond"]

export interface ApprovedProject {
  projectId: string
  canonicalRoot: string
}

export interface EmbeddedProjectsConfig {
  adminOnly?: boolean
  projects?: ApprovedProject[]
}

export interface UiMethodApi {
  registerGatewayMethod: (
    method: string,
    handler: (opts: UiHandlerOptions) => Promise<void> | void,
    opts?: UiGatewayRegistrationOptions,
  ) => void
}

const GSD_UI_BASE_PATH = "/plugins/open-gsd-openclaw/web"
const DAEMON_TIMEOUT_MS = 10_000
const DAEMON_MAX_BYTES = 1_048_576
const FILE_CONTENT_MAX_BYTES = 256 * 1024
const STREAM_LEASE_MS = 600_000
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 16
const GSD_UI_EVENT = "gsd.ui.event"

/** Vendor ErrorShape requires nonempty code AND message. */
const frame = (code: string, message: string): { code: string; message: string } => ({ code, message: message.length > 0 ? message : code })

function approvedProjects(config: EmbeddedProjectsConfig | undefined): ApprovedProject[] {
  return (config?.projects ?? []).filter(
    (p): p is ApprovedProject =>
      typeof p?.projectId === "string" && p.projectId.length > 0 && typeof p?.canonicalRoot === "string" && isAbsolute(p.canonicalRoot),
  )
}

export function canonicalRootIsCurrent(root: string): boolean {
  try {
    return realpathSync(root) === root
  } catch {
    return false
  }
}

export function containsCanonically(root: string, target: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(resolve(root, target))
    return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
  } catch {
    return false
  }
}

function findApproved(config: EmbeddedProjectsConfig | undefined, key: { projectId?: string; root?: string }): ApprovedProject | undefined {
  return approvedProjects(config).find((p) =>
    key.projectId ? p.projectId === key.projectId : key.root ? p.canonicalRoot === key.root : false,
  )
}

export function registerGsdUiMethods(
  api: UiMethodApi,
  getWebHostPort: () => number | undefined,
  config?: EmbeddedProjectsConfig,
): { subscriptions: Map<string, { connId: string }>; disposeAll(): void } {
  const daemonBase = (): string | null => {
    const port = getWebHostPort()
    return typeof port === "number" ? `http://127.0.0.1:${port}${GSD_UI_BASE_PATH}` : null
  }

  const daemonFetch = async (route: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const base = daemonBase()
    if (!base) throw new Error("GSD web host unavailable")
    const res = await fetch(base + route, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`GSD route ${route} returned ${res.status}`)
    }
    if (!res.body) throw new Error("GSD response has no body")
    const bodyReader = res.body.getReader()
    let complete = false
    let received = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const { done, value } = await bodyReader.read()
        if (done) { complete = true; break }
        received += value.byteLength
        if (received > DAEMON_MAX_BYTES) throw new Error("GSD response exceeds size bound")
        chunks.push(value)
      }
    } finally {
      try { if (!complete) await bodyReader.cancel() } finally { bodyReader.releaseLock() }
    }
    const text = await new Blob(chunks).text()
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== "object" || parsed === null) throw new Error("GSD response is not a JSON object")
    return parsed
  }

  const paramString = (params: Record<string, unknown>, key: string): string | undefined => {
    const value = params[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  // Admin admission is required by DEFAULT; only an explicit adminOnly:false
  // opts out. Identity is always the server-owned client, never params.
  const admissionDenied = (client: UiClient | null): string | null => {
    if (client?.invalidated) return "GSD_UI_CLIENT_INVALIDATED|client invalidated"
    if (config?.adminOnly === false) return null
    if (client?.internal?.controlUiAdmin !== true) return "GSD_UI_ADMIN_REQUIRED|administrator admission required"
    return null
  }

  const requireApprovedProject = (
    params: Record<string, unknown>,
    client: UiClient | null,
  ): { project: ApprovedProject; denied: { code: string; message: string } | null } => {
    const denied = admissionDenied(client)
    if (denied) {
      const separator = denied.indexOf("|")
      return { project: undefined as never, denied: frame(denied.slice(0, separator), denied.slice(separator + 1)) }
    }
    const projectId = paramString(params, "projectId")
    const root = paramString(params, "root") ?? paramString(params, "project")
    let project = findApproved(config, { projectId, root })
    if (!project && !projectId && !root) {
      // No explicit context: pin to the single approved project when exactly
      // one exists - never to an arbitrary first entry of many.
      const all = approvedProjects(config)
      if (all.length === 1) project = all[0]
    }
    if (!project) return { project: undefined as never, denied: frame("GSD_UI_NO_APPROVED_PROJECT", "no approved project matches") }
    if (!canonicalRootIsCurrent(project.canonicalRoot)) {
      return { project: undefined as never, denied: frame("GSD_UI_ROOT_IDENTITY_CHANGED", "approved root canonical identity changed") }
    }
    return { project, denied: null }
  }

  const guard = (opts: UiHandlerOptions, run: () => unknown): Promise<void> =>
    (async () => {
      try {
        opts.respond(true, await run())
      } catch (error) {
        const thrown = error as { message?: unknown } | null
        const message = error instanceof Error
          ? error.message
          : typeof thrown?.message === "string"
            ? thrown.message
            : String(error)
        opts.respond(false, undefined, frame("GSD_UI_ERROR", message))
      }
    })() as Promise<void>

  api.registerGatewayMethod(
    "gsd.ui.preferences.read",
    (opts) =>
      guard(opts, async () => {
        // Admin-only surface: admission is enforced consistently here too.
        const denied = admissionDenied(opts.client)
        if (denied) {
          const separator = denied.indexOf("|")
          throw frame(denied.slice(0, separator), denied.slice(separator + 1))
        }
        return daemonFetch("/api/preferences")
      }),
    { scope: "operator.read", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.projects.list",
    (opts) =>
      guard(opts, async () => {
        const { project, denied } = requireApprovedProject(opts.params, opts.client)
        if (denied) throw denied
        const detail = opts.params.detail === true
        return daemonFetch(`/api/projects?root=${encodeURIComponent(project.canonicalRoot)}&detail=${detail ? "true" : "false"}`)
      }),
    { scope: "operator.read", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.directories.list",
    (opts) =>
      guard(opts, async () => {
        const { project, denied } = requireApprovedProject(opts.params, opts.client)
        if (denied) throw denied
        const rawPath = paramString(opts.params, "path")
        // Daemon paths are absolute; normalize either form before containment.
        // Path-only browse is pinned to the admitted project when exactly one
        // is approved; multiple approved projects require explicit context.
        const target = rawPath ? (isAbsolute(rawPath) ? rawPath : join(project.canonicalRoot, rawPath)) : project.canonicalRoot
        if (!containsCanonically(project.canonicalRoot, target)) throw frame("GSD_UI_PATH_ESCAPE", "path escapes the approved root")
        return daemonFetch(`/api/browse-directories?path=${encodeURIComponent(target)}`)
      }),
    { scope: "operator.read", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.preferences.selectRoot",
    (opts) =>
      guard(opts, async () => {
        const devRoot = paramString(opts.params, "devRoot")
        if (!devRoot) throw frame("GSD_UI_MISSING_PARAM", "missing devRoot")
        const { project, denied } = requireApprovedProject({ root: devRoot }, opts.client)
        if (denied) throw denied
        return daemonFetch("/api/switch-root", { method: "POST", body: JSON.stringify({ devRoot: project.canonicalRoot }) })
      }),
    { scope: "operator.write", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.preferences.setDevRoot",
    (opts) =>
      guard(opts, async () => {
        const devRoot = paramString(opts.params, "devRoot")
        if (!devRoot) throw frame("GSD_UI_MISSING_PARAM", "missing devRoot")
        const { project, denied } = requireApprovedProject({ root: devRoot }, opts.client)
        if (denied) throw denied
        return daemonFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ devRoot: project.canonicalRoot }) })
      }),
    { scope: "operator.write", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.workspace.bootstrap",
    (opts) => guard(opts, async () => {
      const { project, denied } = requireApprovedProject(opts.params, opts.client)
      if (denied) throw denied
      // The legacy boot route may start the bridge: this is a write operation,
      // separate from passive subscriptions, even though the daemon uses GET.
      const payload = await daemonFetch(`/api/boot?project=${encodeURIComponent(project.canonicalRoot)}`)
      const object = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
      if (!object(payload) || !object(payload.project) || payload.project.cwd !== project.canonicalRoot ||
          !object(payload.bridge) || payload.bridge.projectCwd !== project.canonicalRoot ||
          !object(payload.workspace) || !object(payload.onboarding) || typeof payload.onboarding.locked !== "boolean" ||
          !Array.isArray(payload.resumableSessions)) {
        throw frame("GSD_UI_INVALID_BOOT", "invalid boot payload for the approved project")
      }
      return payload
    }),
    { scope: "operator.write", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.files.read",
    (opts) => guard(opts, async () => {
      const projectId = paramString(opts.params, "projectId")
      const projectIdentity = paramString(opts.params, "project")
      if (!projectId && !projectIdentity) throw frame("GSD_UI_MISSING_PARAM", "missing project identity")
      const { project, denied } = requireApprovedProject({ projectId, project: projectIdentity }, opts.client)
      if (denied) throw denied
      const root = paramString(opts.params, "root")
      if (root !== "project" && root !== "gsd") throw frame("GSD_UI_INVALID_ROOT", "root must be project or gsd")
      if (opts.params.path != null && typeof opts.params.path !== "string") {
        throw frame("GSD_UI_INVALID_PATH", "path must be a string")
      }
      const path = paramString(opts.params, "path")
      if (path && (isAbsolute(path) || path.startsWith("\\") || path.includes(".."))) {
        throw frame("GSD_UI_PATH_ESCAPE", "path must be relative within the selected root")
      }
      const selectedRoot = root === "project" ? project.canonicalRoot : join(project.canonicalRoot, ".gsd")
      if (root === "gsd" && !path) {
        try {
          // lstat distinguishes an absent .gsd tree from a dangling symlink.
          lstatSync(selectedRoot)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tree: [] }
          throw error
        }
      }
      // Tree listing also needs this check: the daemon follows its root itself.
      if (!containsCanonically(project.canonicalRoot, selectedRoot)) {
        throw frame("GSD_UI_PATH_ESCAPE", "selected root escapes the approved project")
      }
      if (path) {
        const target = resolve(selectedRoot, path)
        if (target === selectedRoot || !containsCanonically(project.canonicalRoot, target) ||
            !containsCanonically(selectedRoot, target)) {
          throw frame("GSD_UI_PATH_ESCAPE", "path escapes the selected approved root")
        }
      }
      const payload = await daemonFetch(
        `/api/files?root=${root}&project=${encodeURIComponent(project.canonicalRoot)}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
      ) as Record<string, unknown>
      if (!path) {
        if (!Array.isArray(payload.tree)) throw frame("GSD_UI_INVALID_FILES", "invalid file tree payload")
        return { tree: payload.tree }
      }
      if (typeof payload.content !== "string") throw frame("GSD_UI_INVALID_FILES", "invalid file content payload")
      if (Buffer.byteLength(payload.content, "utf8") > FILE_CONTENT_MAX_BYTES) {
        throw frame("GSD_UI_FILE_TOO_LARGE", "file content exceeds size bound")
      }
      return { content: payload.content }
    }),
    { scope: "operator.read", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.files.delete",
    (opts) =>
      guard(opts, async () => {
        const projectId = paramString(opts.params, "projectId")
        const projectIdentity = paramString(opts.params, "project")
        if (!projectId && !projectIdentity) throw frame("GSD_UI_MISSING_PARAM", "missing project identity")
        const { project, denied } = requireApprovedProject({ projectId, project: projectIdentity }, opts.client)
        if (denied) throw denied
        const root = paramString(opts.params, "root")
        if (root !== "project" && root !== "gsd") throw frame("GSD_UI_INVALID_ROOT", "root must be project or gsd")
        const path = paramString(opts.params, "path")
        if (!path || isAbsolute(path) || path.startsWith("\\") || path.includes("..")) {
          throw frame("GSD_UI_PATH_ESCAPE", "path must be relative within the selected root")
        }
        const selectedRoot = root === "project" ? project.canonicalRoot : join(project.canonicalRoot, ".gsd")
        const target = resolve(selectedRoot, path)
        if (target === selectedRoot || !containsCanonically(project.canonicalRoot, target) ||
            !containsCanonically(selectedRoot, target)) {
          throw frame("GSD_UI_PATH_ESCAPE", "path escapes the selected approved root")
        }
        return daemonFetch(
          `/api/files?root=${root}&path=${encodeURIComponent(path)}&project=${encodeURIComponent(project.canonicalRoot)}`,
          { method: "DELETE" },
        )
      }),
    { scope: "operator.write", profileAccess: "required" },
  )

  interface SubscriptionRecord {
    connId: string
    controller: AbortController
    lease: ReturnType<typeof setTimeout>
    subscriptionId: string
    seq: number
    removeConnectionListener: () => void
    connectionSignal: AbortSignal
    finish: (reason: string) => void
    reader?: ReadableStreamDefaultReader<Uint8Array>
  }
  const subscriptions = new Map<string, SubscriptionRecord>()

  const release = (subscriptionId: string, reason: string) => {
    const record = subscriptions.get(subscriptionId)
    if (!record) return
    subscriptions.delete(subscriptionId)
    clearTimeout(record.lease)
    record.removeConnectionListener()
    void record.reader?.cancel().catch(() => {})
    record.controller.abort()
    record.finish(reason)
  }

  const startSubscription = (opts: UiHandlerOptions, streamRoute: (project: ApprovedProject) => string): void => {
    let initialResponded = false
    let admitted = false
    const respondOnce: UiRespond = (ok, payload, error) => {
      if (initialResponded) return
      initialResponded = true
      opts.respond(ok, payload, error)
    }
    const fail = (code: string, message: string) => respondOnce(false, undefined, frame(code, message))
    const connId = opts.client?.connId
    const connectionSignal = opts.client?.connectionSignal
    const broadcast = opts.context.broadcastToConnIds
    if (!connId || !connectionSignal || !broadcast) {
      fail("GSD_UI_DELIVERY_UNAVAILABLE", "connection-targeted delivery unavailable")
      return
    }
    if (connectionSignal.aborted || opts.client?.invalidated) {
      fail("GSD_UI_CONNECTION_RETIRED", "client connection already retired")
      return
    }
    const { project, denied } = requireApprovedProject(opts.params, opts.client)
    if (denied) {
      fail(denied.code, denied.message)
      return
    }
    let perConnection = 0
    for (const record of subscriptions.values()) if (record.connId === connId) perConnection += 1
    if (perConnection >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      fail("GSD_UI_SUBSCRIPTION_CAP", "subscription cap reached for this connection")
      return
    }
    let route: string
    try {
      const selectedRoute = streamRoute(project)
      route = selectedRoute + (selectedRoute.includes("?") ? "&" : "?") + "require_existing=1"
    } catch {
      fail("GSD_UI_MISSING_PARAM", "invalid stream arguments")
      return
    }
    const subscriptionId = `sub-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
    const onConnectionAbort = () => release(subscriptionId, "connection retired")
    const record: SubscriptionRecord = {
      connId,
      controller: new AbortController(),
      lease: setTimeout(() => release(subscriptionId, "lease expired"), STREAM_LEASE_MS),
      subscriptionId,
      seq: 0,
      removeConnectionListener: () => connectionSignal.removeEventListener("abort", onConnectionAbort),
      connectionSignal,
      finish(reason) {
        if (connectionSignal.aborted || opts.client?.invalidated) {
          initialResponded = true
          return
        }
        if (!initialResponded) {
          fail("GSD_UI_ADMISSION_CANCELLED", reason)
        } else if (admitted) {
          try {
            broadcast(GSD_UI_EVENT, { type: GSD_UI_EVENT, subscriptionId, seq: ++record.seq, closed: true, reason }, new Set([connId]))
          } catch { /* connection already gone */ }
        }
      },
    }
    subscriptions.set(subscriptionId, record)
    connectionSignal.addEventListener("abort", onConnectionAbort, { once: true })
    const emit = (payload: unknown): boolean => {
      // Liveness recheck before every emission.
      if (subscriptions.get(subscriptionId) !== record) return false
      if (connectionSignal.aborted) {
        release(subscriptionId, "connection retired")
        return false
      }
      broadcast(GSD_UI_EVENT, payload, new Set([connId]))
      return true
    }
    void (async () => {
      const base = daemonBase()
      if (!base) {
        fail("GSD_UI_HOST_UNAVAILABLE", "GSD web host unavailable")
        release(subscriptionId, "daemon unavailable")
        return
      }
      const admission = new AbortController()
      const admissionTimer = setTimeout(() => admission.abort(), DAEMON_TIMEOUT_MS)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let complete = false
      try {
        const res = await fetch(base + route, {
          redirect: "manual",
          signal: AbortSignal.any([record.controller.signal, admission.signal]),
        })
        // Only opening the stream has a short deadline. The body is governed
        // by the lease and explicit connection/plugin disposal afterwards.
        clearTimeout(admissionTimer)
        if (!res.ok || !res.body) {
          if (res.status === 409) fail("GSD_UI_NOT_STARTED", "workspace or terminal not started; start it first")
          else fail("GSD_UI_STREAM_ERROR", `stream route returned ${res.status}`)
          await res.body?.cancel()
          release(subscriptionId, `stream route returned ${res.status}`)
          return
        }
        reader = res.body.getReader()
        record.reader = reader
        if (subscriptions.get(subscriptionId) !== record) return
        admitted = true
        respondOnce(true, { subscriptionId })
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let buffer = ""
        let bufferedBytes = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) { complete = true; break }
          bufferedBytes += value.byteLength
          if (bufferedBytes > DAEMON_MAX_BYTES) throw new Error("stream buffer exceeds byte bound")
          buffer += decoder.decode(value, { stream: true })
          let index: number
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            bufferedBytes -= Buffer.byteLength(chunk, "utf8") + 2
            const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))
            if (!dataLine) continue
            const payload = dataLine.slice(5).trim()
            if (!payload) continue
            let event: unknown
            try { event = JSON.parse(payload) } catch { event = payload }
            record.seq += 1
            if (!emit({ type: GSD_UI_EVENT, subscriptionId, seq: record.seq, event })) return
          }
        }
        release(subscriptionId, "stream ended")
      } catch {
        if (subscriptions.get(subscriptionId) === record) {
          if (!admitted) fail("GSD_UI_STREAM_ERROR", "stream admission failed")
          release(subscriptionId, "stream failed")
        }
      } finally {
        clearTimeout(admissionTimer)
        if (reader) {
          try { if (!complete) await reader.cancel() } catch { /* already aborted */ }
          finally { reader.releaseLock() }
        }
      }
    })()
  }

  api.registerGatewayMethod(
    "gsd.ui.workspace.events.subscribe",
    (opts) =>
      startSubscription(opts, (project) => `/api/session/events?project=${encodeURIComponent(project.canonicalRoot)}`),
    { scope: "operator.read", profileAccess: "required" },
  )

  api.registerGatewayMethod(
    "gsd.ui.terminal.output.subscribe",
    (opts) =>
      startSubscription(opts, (project) => {
        const terminalId = paramString(opts.params, "terminalId")
        if (!terminalId) throw frame("GSD_UI_MISSING_PARAM", "missing terminalId")
        return `/api/terminal/stream?id=${encodeURIComponent(terminalId)}&project=${encodeURIComponent(project.canonicalRoot)}`
      }),
    { scope: "operator.read", profileAccess: "required" },
  )

  for (const [method, scope] of [
    ["gsd.ui.workspace.events.unsubscribe", "operator.write"],
    ["gsd.ui.terminal.output.unsubscribe", "operator.write"],
  ] as const) {
    api.registerGatewayMethod(
      method,
      (opts) =>
        guard(opts, () => {
          const subscriptionId = paramString(opts.params, "subscriptionId")
          if (!subscriptionId) throw frame("GSD_UI_MISSING_PARAM", "missing subscriptionId")
          const record = subscriptions.get(subscriptionId)
          if (!record || record.connId !== opts.client?.connId) throw frame("GSD_UI_UNKNOWN_SUBSCRIPTION", "unknown subscription for this connection")
          release(subscriptionId, "unsubscribed")
          return { released: subscriptionId }
        }),
      { scope, profileAccess: "required" },
    )
  }

  return {
    subscriptions,
    disposeAll() {
      for (const id of [...subscriptions.keys()]) release(id, "plugin disposal")
    },
  }
}
