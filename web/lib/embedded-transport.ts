/**
 * Child-side embedded operation transport for the Control UI plugin tab.
 *
 * Contract: gsd-ui/1 MessageChannel protocol. The GSD web app runs in an
 * opaque sandboxed iframe; a trusted parent adapter binds a dedicated
 * MessagePort to that exact frame and performs authenticated, allowlisted
 * server calls.
 *
 * Binding: negotiation window-messages are accepted only from the exact
 * parent window (plus the configured parent origin when known). After
 * binding, all traffic uses the dedicated port - never a global dispatcher.
 * The generation id is correlation, never authority. Duplicate binds close
 * the extra port; incomplete negotiation expires. Requests are bounded by
 * timeout and pending cap; an action timeout is an unknown result, not
 * permission to retry. The transport never handles tokens, cookies, or URLs.
 */

export const EMBEDDED_PROTOCOL = "gsd-ui/1"
export const EMBEDDED_MARKER_QUERY = "__gsd_embedded"
export const BIND_TYPE = "gsd-ui-bind"
export const BIND_ACK_TYPE = "gsd-ui-bind-ack"
export const REQUEST_TYPE = "gsd-ui-request"
export const EVENT_TYPE = "gsd-ui-event"
export const READY_TYPE = "gsd-ui-ready"
export const RESPONSE_TYPE = "gsd-ui-response"

export const DEFAULT_NEGOTIATION_TIMEOUT_MS = 30_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_PENDING = 32

export interface EmbeddedTransportWindow {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void
  parent: unknown
  postMessage(message: unknown, targetOrigin: string): void
}

interface BindMessage {
  protocol: string
  type: string
  generation: number
}

export interface FrameRequest {
  protocol: typeof EMBEDDED_PROTOCOL
  type: typeof REQUEST_TYPE
  generation: number
  requestId: string
  operation: string
  args?: unknown
}

export interface FrameResponse {
  protocol: string
  type: typeof RESPONSE_TYPE
  generation: number
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface EmbeddedPortLike {
  postMessage(message: unknown): void
  close(): void
  start?(): void
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void
}

export interface EmbeddedChannelStatus {
  embedded: boolean
}

/** Strict detection: opaque origin AND distinct parent AND the non-credential
 * embedded-mode marker. A top-level opaque document never qualifies. */
export function detectEmbeddedChannel(win?: EmbeddedTransportWindow & { location?: { search?: string } }): EmbeddedChannelStatus {
  const w = win ?? (typeof window !== "undefined" ? (window as unknown as EmbeddedTransportWindow & { location?: { search?: string } }) : undefined)
  if (!w) return { embedded: false }
  try {
    if ((w as { origin?: string }).origin !== "null") return { embedded: false }
    if (w.parent === (w as unknown)) return { embedded: false }
    const marker = w.location?.search ? new URLSearchParams(w.location.search).get(EMBEDDED_MARKER_QUERY) : null
    return { embedded: marker === "1" }
  } catch {
    return { embedded: false }
  }
}

export function isEmbeddedMode(win?: EmbeddedTransportWindow & { location?: { search?: string } }): boolean {
  return detectEmbeddedChannel(win).embedded
}

export interface FrameEventMessage {
  protocol: string
  type: typeof EVENT_TYPE
  generation: number
  subscriptionId: string
  seq: number
  event?: unknown
  closed?: boolean
  reason?: string
}

export interface EmbeddedOperationClient {
  request(operation: string, args?: unknown): Promise<unknown>
  onEvent(handler: (message: FrameEventMessage) => void): () => void
  dispose(): void
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function freshRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
}

export function negotiateEmbeddedTransport(options: {
  window?: EmbeddedTransportWindow
  allowedOperations: Iterable<string>
  expectedParentOrigin?: string
  negotiationTimeoutMs?: number
  requestTimeoutMs?: number
  maxPending?: number
}): Promise<EmbeddedOperationClient> {
  const allowed = new Set(options.allowedOperations)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  const w = options.window ?? (window as unknown as EmbeddedTransportWindow)
  return new Promise((resolveNegotiation, rejectNegotiation) => {
    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(negotiationTimer)
      w.removeEventListener("message", listener)
      run()
    }
    const negotiationTimer = setTimeout(
      () => finish(() => rejectNegotiation(new Error("embedded transport negotiation timed out"))),
      options.negotiationTimeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS,
    )
    function makeClient(port: EmbeddedPortLike, generation: number, onDispose?: () => void): EmbeddedOperationClient {
      const pending = new Map<string, PendingEntry>()
      const eventHandlers = new Set<(message: FrameEventMessage) => void>()
      let disposed = false
      const settle = (requestId: string, entry: PendingEntry, run: (entry: PendingEntry) => void) => {
        clearTimeout(entry.timer)
        if (pending.get(requestId) !== entry) return
        pending.delete(requestId)
        run(entry)
      }
      const portListener = (event: MessageEvent) => {
        const data = event.data as FrameResponse | FrameEventMessage | undefined
        if (!data || data.protocol !== EMBEDDED_PROTOCOL || data.generation !== generation) return
        if (data.type === EVENT_TYPE) {
          if (typeof (data as FrameEventMessage).subscriptionId !== "string" || typeof (data as FrameEventMessage).seq !== "number") return
          for (const handler of [...eventHandlers]) handler(data as FrameEventMessage)
          return
        }
        if (data.type !== RESPONSE_TYPE) return
        if (typeof data.requestId !== "string" || typeof data.ok !== "boolean") return
        const entry = pending.get(data.requestId)
        if (!entry) return
        if (data.ok) settle(data.requestId, entry, (e) => e.resolve(data.result))
        else settle(data.requestId, entry, (e) => e.reject(new Error(data.error ?? "embedded operation failed")))
      }
      if (typeof port.start === "function") port.start()
      port.addEventListener("message", portListener)
      return {
        onEvent(handler: (message: FrameEventMessage) => void): () => void {
          eventHandlers.add(handler)
          return () => eventHandlers.delete(handler)
        },
        request(operation: string, args?: unknown): Promise<unknown> {
          if (disposed) return Promise.reject(new Error("embedded transport disposed"))
          if (!allowed.has(operation)) return Promise.reject(new Error("embedded operation not allowed: " + operation))
          if (pending.size >= maxPending) return Promise.reject(new Error("embedded transport pending cap reached"))
          const requestId = freshRequestId()
          return new Promise((resolve, reject) => {
            const entry: PendingEntry = {
              resolve,
              reject,
              timer: setTimeout(() => {
                settle(requestId, entry, (e) => e.reject(new Error("embedded operation timed out: unknown result")))
              }, requestTimeoutMs),
            }
            pending.set(requestId, entry)
            try {
              port.postMessage({ protocol: EMBEDDED_PROTOCOL, type: REQUEST_TYPE, generation, requestId, operation, args })
            } catch (error) {
              settle(requestId, entry, (e) => e.reject(error instanceof Error ? error : new Error(String(error))))
            }
          })
        },
        dispose() {
          if (disposed) return
          disposed = true
          port.removeEventListener("message", portListener)
          try {
            port.close()
          } catch {
            // port already closed
          }
          for (const [requestId, entry] of pending) {
            settle(requestId, entry, (e) => e.reject(new Error("embedded transport disposed")))
          }
          pending.clear()
          eventHandlers.clear()
          onDispose?.()
        },
      }
    }
    const listener = (event: MessageEvent) => {
      if (event.source !== w.parent) return
      if (options.expectedParentOrigin && event.origin !== options.expectedParentOrigin) return
      const data = event.data as BindMessage | undefined
      if (!data || data.protocol !== EMBEDDED_PROTOCOL || data.type !== BIND_TYPE) return
      if ((data as { nonce?: unknown }).nonce !== nonce) {
        // Not our document: close the transferred ports so they never pin
        // the event loop or linger as phantom channels.
        const rejected = (event as unknown as { ports?: unknown[] }).ports
        if (Array.isArray(rejected)) {
          for (const candidate of rejected) {
            try {
              ;(candidate as EmbeddedPortLike).close()
            } catch {
              // already closed
            }
          }
        }
        return
      }
      const ports = (event as unknown as { ports?: unknown[] }).ports
      const closeAll = (list: unknown) => {
        if (!Array.isArray(list)) return
        for (const candidate of list) {
          try {
            ;(candidate as EmbeddedPortLike).close()
          } catch {
            // already closed
          }
        }
      }
      if (!Array.isArray(ports) || ports.length !== 1) {
        closeAll(ports)
        return
      }
      const port = ports[0] as EmbeddedPortLike | undefined
      if (!port || typeof port.postMessage !== "function" || typeof port.close !== "function") {
        closeAll(ports)
        return
      }
      if (typeof data.generation !== "number" || !Number.isFinite(data.generation)) {
        closeAll(ports)
        return
      }
      if (settled) {
        closeAll(ports)
        return
      }
      settled = true
      clearTimeout(negotiationTimer)
      w.removeEventListener("message", listener)
      // Narrow guard retained through client disposal: any later bind attempt
      // from the parent has its transferred ports closed; the established
      // channel is untouched.
      const guard = (guardEvent: MessageEvent) => {
        if (guardEvent.source !== w.parent) return
        const guardData = guardEvent.data as BindMessage | undefined
        if (!guardData || guardData.protocol !== EMBEDDED_PROTOCOL || guardData.type !== BIND_TYPE) return
        closeAll((guardEvent as unknown as { ports?: unknown[] }).ports)
      }
      w.addEventListener("message", guard)
      const client = makeClient(port, data.generation, () => w.removeEventListener("message", guard))
      try {
        port.postMessage({ protocol: EMBEDDED_PROTOCOL, type: BIND_ACK_TYPE, generation: data.generation })
      } catch (error) {
        client.dispose()
        rejectNegotiation(error instanceof Error ? error : new Error("embedded transport bind acknowledgement failed"))
        return
      }
      resolveNegotiation(client)
    }
    w.addEventListener("message", listener)
    // Per-document correlation nonce: fresh for THIS negotiation, and the
    // parent must echo it in the bind - a bind without our exact nonce is
    // not our document. Correlation only, never authority.
    const nonce = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "doc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
    try {
      ;(w.parent as { postMessage(message: unknown, origin: string): void }).postMessage({ protocol: EMBEDDED_PROTOCOL, type: READY_TYPE, nonce }, "*")
    } catch {
      // parent unreachable; negotiation expires on its own timer
    }
  })
}
