import type { WorkspaceConnectionState } from "./gsd-workspace-store"
import { createModeAwareEventSource } from "./embedded-gate.ts"

export interface WorkspaceEventSource {
  onopen: ((event: Event) => void) | null
  onmessage: ((message: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  close(): void
}

export type WorkspaceEventSourceFactory = (url: string) => WorkspaceEventSource

export interface WorkspaceEventStreamHandlers {
  canConnect(): boolean
  streamUrl(): string
  onOpen(event: {
    previousState: WorkspaceConnectionState
    wasDisconnected: boolean
  }): void
  onMessage(data: string): void
  onError(event: {
    nextConnectionState: Extract<WorkspaceConnectionState, "reconnecting" | "error">
    changed: boolean
  }): void
}

export class WorkspaceEventStream {
  private eventSource: WorkspaceEventSource | null = null
  private lastConnectionState: WorkspaceConnectionState = "idle"
  private readonly handlers: WorkspaceEventStreamHandlers
  private readonly createEventSource: WorkspaceEventSourceFactory

  constructor(
    handlers: WorkspaceEventStreamHandlers,
    createEventSource: WorkspaceEventSourceFactory = (url) => createModeAwareEventSource(url) as unknown as WorkspaceEventSource,
  ) {
    this.handlers = handlers
    this.createEventSource = createEventSource
  }

  isOpen(): boolean {
    return this.eventSource !== null
  }

  ensure(): void {
    if (this.eventSource || !this.handlers.canConnect()) return

    const stream = this.createEventSource(this.handlers.streamUrl())
    this.eventSource = stream

    stream.onopen = () => {
      const previousState = this.lastConnectionState
      const wasDisconnected = previousState === "reconnecting" || previousState === "disconnected" || previousState === "error"
      this.lastConnectionState = "connected"
      this.handlers.onOpen({ previousState, wasDisconnected })
    }

    stream.onmessage = (message) => {
      this.handlers.onMessage(message.data)
    }

    stream.onerror = () => {
      const nextConnectionState = this.lastConnectionState === "connected" ? "reconnecting" : "error"
      const changed = nextConnectionState !== this.lastConnectionState
      this.lastConnectionState = nextConnectionState
      this.handlers.onError({ nextConnectionState, changed })
    }
  }

  close(): void {
    this.eventSource?.close()
    this.eventSource = null
  }
}
