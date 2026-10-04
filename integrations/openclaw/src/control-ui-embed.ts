/**
 * Trusted native Control UI wrapper for the embedded GSD frame.
 *
 * Document identity is a per-negotiation nonce from the child: each document
 * ready ping carries a fresh nonce, the bind echoes it, and the child accepts
 * only its own nonce. Duplicate ready with the current nonce is ignored; a
 * fresh nonce retires the old channel (releasing its backend subscriptions)
 * and binds the new document. Load ordering NEVER defines identity. Per-mount
 * subscription ownership: only subscriptionIds established through this
 * mount forward and unsubscribe; retirement releases them on the backend.
 * host.request stays private - allowlisted operations dispatch to
 * individually registered gsd.ui.* methods.
 */

export const GSD_EMBED_PLUGIN_ID = "open-gsd-openclaw"
export const GSD_EMBED_PROTOCOL = "gsd-ui/1"
export const GSD_EMBED_BIND_TYPE = "gsd-ui-bind"
export const GSD_EMBED_READY_TYPE = "gsd-ui-ready"
export const GSD_EMBED_REQUEST_TYPE = "gsd-ui-request"
export const GSD_EMBED_RESPONSE_TYPE = "gsd-ui-response"
export const GSD_EMBED_EVENT_TYPE = "gsd-ui-event"
export const GSD_UI_HOST_EVENT_NAME = "gsd.ui.event"

export interface EmbedFrameRequest {
  protocol: string
  type: string
  generation: number
  requestId: string
  operation: string
  args?: unknown
}

export interface EmbedContainerLike {
  ownerDocument?: unknown
  appendChild(child: unknown): void
}

/** The wrapper consumes the REAL vendor host type - never a substitute. */
export type EmbedHost = import("openclaw/plugin-sdk/control-ui").ControlUiHost
export type EmbedHostRequest = NonNullable<EmbedHost["request"]>

export interface EmbedDefinePlugin {
  (plugin: { id: string; activate: (host: EmbedHost) => void }): unknown
}

export interface GsdEmbedOptions {
  frameSrc: string
  request: EmbedHostRequest
  allowedOperations: readonly string[]
  definePlugin: EmbedDefinePlugin
  onEvent?: (eventName: string, handler: (event: unknown) => void) => () => void
}

interface PortLike {
  onmessage: ((ev: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  close(): void
}

interface ContentWindowLike {
  postMessage(message: unknown, origin: string, transfer?: unknown[]): void
}

interface IframeLike {
  contentWindow: ContentWindowLike | null
  src: string
  sandbox: string
  style: Record<string, string>
  remove(): void
  addEventListener?(type: string, listener: () => void): void
}

interface DocumentLike {
  createElement(tag: string): IframeLike
}

export const EMBED_ALLOWED_OPERATIONS: readonly string[] = [
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

export function createGsdEmbedPlugin(options: GsdEmbedOptions): unknown {
  const allowed = new Set(options.allowedOperations)
  return options.definePlugin({
    id: GSD_EMBED_PLUGIN_ID,
    activate(host: EmbedHost) {
      const page = {
        id: "open-gsd-openclaw-web",
        label: "GSD",
        mount: (container: EmbedContainerLike, context: { signal: AbortSignal }) => {
          const doc = (container.ownerDocument ?? (globalThis as { document?: DocumentLike }).document) as DocumentLike
          const iframe = doc.createElement("iframe")
          iframe.sandbox = "allow-scripts"
          iframe.src = options.frameSrc
          iframe.style.width = "100%"
          iframe.style.height = "100%"
          iframe.style.border = "none"
          ;(container as { appendChild(child: unknown): void }).appendChild(iframe)

          let bound = false
          let generation = 0
          let port: PortLike | null = null
          let disposed = false
          let documentNonce: string | null = null
          const ownedSubscriptions = new Map<string, string>()

          const respond = (requestId: string, ok: boolean, payload: unknown, error?: string) => {
            port?.postMessage({
              protocol: GSD_EMBED_PROTOCOL,
              type: GSD_EMBED_RESPONSE_TYPE,
              generation,
              requestId,
              ok,
              ...(ok ? { result: payload } : { error }),
            })
          }

          const forwardHostEvent = (event: unknown) => {
            if (!port || !bound) return
            const data = event as { type?: string; subscriptionId?: unknown; seq?: unknown; event?: unknown; closed?: unknown; reason?: unknown } | undefined
            if (!data || data.type !== GSD_UI_HOST_EVENT_NAME) return
            if (typeof data.subscriptionId !== "string") return
            if (!ownedSubscriptions.has(data.subscriptionId)) return
            if (data.closed === true) ownedSubscriptions.delete(data.subscriptionId)
            port.postMessage({
              protocol: GSD_EMBED_PROTOCOL,
              type: GSD_EMBED_EVENT_TYPE,
              generation,
              subscriptionId: data.subscriptionId,
              ...(typeof data.seq === "number" ? { seq: data.seq } : { seq: 0 }),
              ...(data.event !== undefined ? { event: data.event } : {}),
              ...(data.closed === true ? { closed: true, reason: typeof data.reason === "string" ? data.reason : "closed" } : {}),
            })
          }

          const releaseSubscription = (subscriptionId: string, unsubscribeOp: string) => {
            // Exact fully qualified registered method name - never unprefixed.
            const method = unsubscribeOp.startsWith("gsd.ui.") ? unsubscribeOp : "gsd.ui." + unsubscribeOp
            void options.request(method, { subscriptionId } as Record<string, unknown>).catch(() => {
              // best-effort release; server lease retirement covers crashes
            })
          }

          const retireChannel = () => {
            for (const [subscriptionId, unsubscribeOp] of ownedSubscriptions) {
              releaseSubscription(subscriptionId, unsubscribeOp)
            }
            ownedSubscriptions.clear()
            try {
              port?.close()
            } catch {
              // already closed
            }
            port = null
            bound = false
          }

          const bindChannel = (nonce: string) => {
            retireChannel()
            generation += 1
            const localGeneration = generation
            const channel = new MessageChannel() as unknown as { port1: PortLike; port2: unknown }
            channel.port1.onmessage = (ev) => {
              const message = ev.data as EmbedFrameRequest | undefined
              if (!message || message.protocol !== GSD_EMBED_PROTOCOL || message.type !== GSD_EMBED_REQUEST_TYPE) return
              if (typeof message.requestId !== "string" || typeof message.operation !== "string" || message.generation !== localGeneration) return
              if (message.operation.endsWith(".unsubscribe")) {
                const targetSubscription = (message.args as { subscriptionId?: unknown } | null | undefined)?.subscriptionId
                if (typeof targetSubscription !== "string" || !ownedSubscriptions.has(targetSubscription)) {
                  respond(message.requestId, false, undefined, "unsubscribe refused: subscription not owned by this mount")
                  return
                }
              }
              if (!allowed.has(message.operation)) {
                respond(message.requestId, false, undefined, "operation not allowed: " + message.operation)
                return
              }
              void options
                .request("gsd.ui." + message.operation, message.args as Record<string, unknown> | undefined)
                .then(
                  (result) => {
                    const subscriptionId = (result as { subscriptionId?: unknown } | null)?.subscriptionId
                    if (typeof subscriptionId === "string" && message.operation.endsWith(".subscribe")) {
                      const unsubscribeOp = message.operation.replace(/\.subscribe$/, ".unsubscribe")
                      if (disposed || generation !== localGeneration) {
                        // Late subscribe after disposal or a generation
                        // change: release THAT exact backend subscription,
                        // never adopt it into the abandoned ownership map.
                        releaseSubscription(subscriptionId, unsubscribeOp)
                        return
                      }
                      ownedSubscriptions.set(subscriptionId, unsubscribeOp)
                    }
                    if (generation !== localGeneration) return
                    respond(message.requestId, true, result)
                  },
                  (error: unknown) => {
                    if (generation === localGeneration) respond(message.requestId, false, undefined, error instanceof Error ? error.message : String(error))
                  },
                )
            }
            port = channel.port1
            bound = true
            ;(iframe.contentWindow as ContentWindowLike | null)?.postMessage(
              { protocol: GSD_EMBED_PROTOCOL, type: GSD_EMBED_BIND_TYPE, generation, nonce },
              "*",
              [channel.port2],
            )
          }

          const windowListener = (event: MessageEvent) => {
            if (event.source !== (iframe.contentWindow as unknown)) return
            const data = event.data as { protocol?: string; type?: string; nonce?: unknown } | undefined
            if (!data || data.protocol !== GSD_EMBED_PROTOCOL) return
            if (data.type === GSD_EMBED_READY_TYPE) {
              const nonce = data.nonce
              if (typeof nonce !== "string" || nonce.length === 0) return
              if (nonce === documentNonce) return
              documentNonce = nonce
              bindChannel(nonce)
              return
            }
            if (data.type === GSD_EMBED_BIND_TYPE) {
              const ports = (event as unknown as { ports?: unknown[] }).ports
              if (Array.isArray(ports)) {
                for (const candidate of ports) {
                  try {
                    ;(candidate as { close(): void }).close()
                  } catch {
                    // already closed
                  }
                }
              }
            }
          }

          ;(globalThis as unknown as { addEventListener(t: string, l: unknown): void }).addEventListener("message", windowListener)

          // Load ordering never defines document identity: the nonce protocol
          // alone decides binds and retirements. A load with no fresh-nonce
          // ready leaves the old channel idle until dispose or a new document.
          iframe.addEventListener?.("load", () => {
            void 0
          })

          const unsubscribeHostEvents = options.onEvent
            ? options.onEvent(GSD_UI_HOST_EVENT_NAME, forwardHostEvent)
            : undefined

          const teardown = () => {
            if (disposed) return
            disposed = true
            // Invalidate the generation so pending completions cannot adopt
            // subscriptions into an abandoned ownership map.
            generation += 1
            retireChannel()
            documentNonce = null
            unsubscribeHostEvents?.()
            ;(globalThis as unknown as { removeEventListener(t: string, l: unknown): void }).removeEventListener("message", windowListener)
            try {
              iframe.remove()
            } catch {
              // already removed
            }
          }
          context.signal.addEventListener("abort", teardown, { once: true })
          return { dispose: teardown }
        },
      }
      ;(host.ui as unknown as { registerPage(page: unknown): void }).registerPage(page)
      ;(host.ui as unknown as { registerNavigation?(item: unknown): void }).registerNavigation?.({ id: "open-gsd-openclaw-web", label: "GSD", page: { id: "open-gsd-openclaw-web" } })
    },
  })
}
