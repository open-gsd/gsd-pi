"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  dispatchBrowserSlashCommand,
  getBrowserSlashCommandTerminalNotice,
  GSD_HELP_TEXT,
  type BrowserSlashCommandDispatchResult,
  type BrowserSlashCommandSurface,
} from "./browser-slash-command-dispatch"
import {
  closeCommandSurfaceState,
  createInitialCommandSurfaceState,
  openCommandSurfaceState,
  selectCommandSurfaceStateTarget,
  setCommandSurfaceSection,
  type CommandSurfaceSection,
  type CommandSurfaceTarget,
  type WorkspaceRecoverySummary,
  type WorkspaceCommandSurfaceState,
} from "./command-surface-contract"
import type { PendingImage } from "./image-utils"
import type { ChatMessage } from "./pty-chat-parser"
import { WorkspaceEventStream } from "./workspace-event-stream"
import { createTerminalLine, withTerminalLine } from "./workspace-terminal-log"
import { authFetch, appendAuthParam } from "./auth"
import { ContextualTips } from "@gsd/agent-core/contextual-tips.js"
import {
  applyBootToLiveState,
  createInitialWorkspaceLiveState,
  createWorkspaceRecoverySummary,
  resolveResumableSessions,
  withEntitySliceFailed,
  withEntitySliceInvalidated,
  withEntitySliceRequested,
  withEntitySliceSucceeded,
  withFreshnessFailed,
  withFreshnessInvalidated,
  withFreshnessRequested,
  withFreshnessSucceeded,
} from "./workspace-live-state"
import type {
  WorkspaceIndex,
  WorkspaceScopeTarget,
  WorkspaceSliceTarget,
  WorkspaceValidationIssue,
} from "../../src/shared/workspace-types.ts"
import type { RpcExtensionUIRequest } from "@opengsd/contracts"

export {
  createWorkspaceRecoverySummary,
  resolveAutoDashboard,
  resolveResumableSessions,
  resolveWorkspaceIndex,
  type EntitySlice,
} from "./workspace-live-state"
import {
  applyTextDelta,
  applyThinkingDelta,
  appendToolSegment,
  completeTurn,
  finalizeThinkingStream,
  pickTranscriptState,
  pushPendingUserMessage,
  type CompletedTurn,
  type CompletedToolExecution,
  type TurnSegment,
} from "./transcript-store"
import {
  applyExtensionUiSnapshotToWebFields,
  extensionUiSnapshotFromWebFields,
  type ExtensionUiSnapshot,
} from "./extension-ui-snapshot"

export type { CompletedTurn, TurnSegment } from "./transcript-store"
export { getFlatTranscript } from "./transcript-store"
import {
  CommandSurfaceStore,
  refreshOpenCommandSurfacesForInvalidation,
} from "./command-surface-store"
import {
  findOnboardingProviderLabel,
  getCurrentModelSelection,
  getPreferredOnboardingProviderId,
  markRecoveryStateInvalidated,
  normalizeClientError,
  overlayLiveBridgeSessionState,
  syncSessionBrowserStateWithBridge,
} from "./command-surface-helpers"
import {
  cloneBootWithBridge,
} from "./workspace-boot-helpers"
import {
  dispatchWorkspaceEvent,
  routeLiveInteractionEvent,
} from "./workspace-coordinator"

export type WorkspaceStatus = "idle" | "loading" | "ready" | "error" | "unauthenticated"
export type WorkspaceConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error"
export type TerminalLineType = "input" | "output" | "system" | "success" | "error"
export type BridgePhase = "idle" | "starting" | "ready" | "failed"
export type WorkspaceStatusTone = "muted" | "info" | "success" | "warning" | "danger"

export interface WorkspaceModelRef {
  id?: string
  provider?: string
  providerId?: string
}

export interface BridgeLastError {
  message: string
  at: string
  phase: BridgePhase
  afterSessionAttachment: boolean
  commandType?: string
}

export interface WorkspaceSessionState {
  model?: WorkspaceModelRef
  thinkingLevel: string
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: "all" | "one-at-a-time"
  followUpMode: "all" | "one-at-a-time"
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  autoRetryEnabled: boolean
  retryInProgress: boolean
  retryAttempt: number
  messageCount: number
  pendingMessageCount: number
}

export interface BridgeRuntimeSnapshot {
  phase: BridgePhase
  projectCwd: string
  projectSessionsDir: string
  packageRoot: string
  startedAt: string | null
  updatedAt: string
  connectionCount: number
  lastCommandType: string | null
  activeSessionId: string | null
  activeSessionFile: string | null
  sessionState: WorkspaceSessionState | null
  lastError: BridgeLastError | null
}

export type { WorkspaceTaskTarget, RiskLevel, WorkspaceSliceTarget, WorkspaceMilestoneTarget } from "./workspace-types.js"
export type { WorkspaceIndex, WorkspaceScopeTarget, WorkspaceValidationIssue }

export interface RtkSessionSavings {
  commands: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPct: number
  totalTimeMs: number
  avgTimeMs: number
  updatedAt: string
}

export interface AutoDashboardData {
  active: boolean
  paused: boolean
  stepMode: boolean
  startTime: number
  elapsed: number
  currentUnit: { type: string; id: string; startedAt: number } | null
  completedUnits: { type: string; id: string; startedAt: number; finishedAt: number }[]
  basePath: string
  totalCost: number
  totalTokens: number
  rtkSavings?: RtkSessionSavings | null
  /** Whether RTK is enabled via experimental.rtk preference. False when not opted in. */
  rtkEnabled?: boolean
}

export interface BootResumableSession {
  id: string
  path: string
  cwd: string
  name?: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  isActive: boolean
}

export interface WorkspaceOnboardingProviderState {
  id: string
  label: string
  required: true
  recommended: boolean
  configured: boolean
  configuredVia: "auth_file" | "environment" | "runtime" | "external_cli" | null
  supports: {
    apiKey: boolean
    oauth: boolean
    oauthAvailable: boolean
    usesCallbackServer: boolean
    externalCli: boolean
  }
}

export interface WorkspaceOnboardingOptionalSectionState {
  id: string
  label: string
  blocking: false
  skippable: true
  configured: boolean
  configuredItems: string[]
}

export interface WorkspaceOnboardingValidationResult {
  status: "succeeded" | "failed"
  providerId: string
  method: "api_key" | "oauth"
  checkedAt: string
  message: string
  persisted: boolean
}

export interface WorkspaceOnboardingFlowState {
  flowId: string
  providerId: string
  providerLabel: string
  status: "idle" | "running" | "awaiting_browser_auth" | "awaiting_input" | "succeeded" | "failed" | "cancelled"
  updatedAt: string
  auth: {
    url: string
    instructions?: string
  } | null
  prompt: {
    kind: "text" | "manual_code"
    message: string
    placeholder?: string
    allowEmpty?: boolean
  } | null
  progress: string[]
  error: string | null
}

export interface WorkspaceOnboardingBridgeAuthRefreshState {
  phase: "idle" | "pending" | "succeeded" | "failed"
  strategy: "restart" | null
  startedAt: string | null
  completedAt: string | null
  error: string | null
}

/**
 * CLI-side onboarding wizard completion record (mirrors the server-side
 * OnboardingState.completionRecord field). Optional to keep the contract
 * back-compat with workspaces still on older bridge versions that don't
 * include this field.
 */
export interface WorkspaceOnboardingCompletionRecord {
  /** ISO timestamp of when the wizard last completed, or null if never. */
  completedAt: string | null
  /** Step IDs that were completed. */
  completedSteps: string[]
  /** Step IDs that were explicitly skipped. */
  skippedSteps: string[]
  /** Last step the wizard was on, used by /gsd onboarding --resume. */
  lastResumePoint: string | null
  /** Bumped on the CLI side when a new required step is added; signals re-onboarding need. */
  flowVersion: number
}

export interface WorkspaceOnboardingState {
  status: "blocked" | "ready"
  locked: boolean
  lockReason: "required_setup" | "bridge_refresh_pending" | "bridge_refresh_failed" | null
  required: {
    blocking: true
    skippable: false
    satisfied: boolean
    satisfiedBy: { providerId: string; source: "auth_file" | "environment" | "runtime" | "external_cli" } | null
    providers: WorkspaceOnboardingProviderState[]
  }
  optional: {
    blocking: false
    skippable: true
    sections: WorkspaceOnboardingOptionalSectionState[]
  }
  lastValidation: WorkspaceOnboardingValidationResult | null
  activeFlow: WorkspaceOnboardingFlowState | null
  bridgeAuthRefresh: WorkspaceOnboardingBridgeAuthRefreshState
  /** CLI-side wizard completion record. Null if never completed; undefined if the bridge predates this field. */
  completionRecord?: WorkspaceOnboardingCompletionRecord | null
}

// ─── Project Detection ──────────────────────────────────────────────────────

export type ProjectDetectionKind =
  | "active-gsd"
  | "empty-gsd"
  | "v1-legacy"
  | "brownfield"
  | "blank"

export interface ProjectDetectionSignals {
  hasGsdFolder: boolean
  hasPlanningFolder: boolean
  hasGitRepo: boolean
  hasPackageJson: boolean
  isMonorepo?: boolean
  fileCount: number
}

export interface ProjectDetection {
  kind: ProjectDetectionKind
  signals: ProjectDetectionSignals
}

// ─── Boot Payload ───────────────────────────────────────────────────────────

export interface WorkspaceBootPayload {
  project: {
    cwd: string
    sessionsDir: string
    packageRoot: string
  }
  workspace: WorkspaceIndex
  auto: AutoDashboardData
  onboarding: WorkspaceOnboardingState
  onboardingNeeded: boolean
  resumableSessions: BootResumableSession[]
  bridge: BridgeRuntimeSnapshot
  projectDetection?: ProjectDetection
}

export interface BridgeStatusEvent {
  type: "bridge_status"
  bridge: BridgeRuntimeSnapshot
}

export type LiveStateInvalidationDomain = "auto" | "workspace" | "recovery" | "resumable_sessions"
export type LiveStateInvalidationSource = "bridge_event" | "rpc_command" | "session_manage"
export type LiveStateInvalidationReason =
  | "agent_end"
  | "turn_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "new_session"
  | "switch_session"
  | "fork"
  | "set_session_name"

export interface LiveStateInvalidationEvent {
  type: "live_state_invalidation"
  at: string
  reason: LiveStateInvalidationReason
  source: LiveStateInvalidationSource
  domains: LiveStateInvalidationDomain[]
  workspaceIndexCacheInvalidated: boolean
}

export type WorkspaceFreshnessStatus = "idle" | "fresh" | "refreshing" | "stale" | "error"

export interface WorkspaceFreshnessBucket {
  status: WorkspaceFreshnessStatus
  stale: boolean
  reloadCount: number
  lastRequestedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailure: string | null
  invalidatedAt: string | null
  invalidationReason: LiveStateInvalidationReason | null
  invalidationSource: LiveStateInvalidationSource | null
}

export interface WorkspaceLiveFreshnessState {
  recovery: WorkspaceFreshnessBucket
  gitSummary: WorkspaceFreshnessBucket
  sessionBrowser: WorkspaceFreshnessBucket
  sessionStats: WorkspaceFreshnessBucket
}

export interface WorkspaceLiveState {
  auto: import("./workspace-live-state").EntitySlice<AutoDashboardData>
  workspace: import("./workspace-live-state").EntitySlice<WorkspaceIndex>
  resumableSessions: import("./workspace-live-state").EntitySlice<BootResumableSession[]>
  recoverySummary: WorkspaceRecoverySummary
  freshness: WorkspaceLiveFreshnessState
  softBootRefreshCount: number
  targetedRefreshCount: number
}

// Blocking methods queue in pendingUiRequests; fire-and-forget methods update state maps directly.
export type ExtensionUiRequestEvent = RpcExtensionUIRequest

export interface ExtensionErrorEvent {
  type: "extension_error"
  extensionPath?: string
  event?: string
  error: string
}

export interface MessageUpdateEvent {
  type: "message_update"
  assistantMessageEvent?: {
    type: string
    delta?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start"
  toolCallId: string
  toolName: string
  [key: string]: unknown
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update"
  toolCallId: string
  toolName: string
  partialResult?: {
    content?: Array<{ type: string; text?: string }>
    details?: Record<string, unknown>
    isError?: boolean
  }
  [key: string]: unknown
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end"
  toolCallId: string
  toolName: string
  isError?: boolean
  [key: string]: unknown
}

export interface AgentEndEvent {
  type: "agent_end"
  [key: string]: unknown
}

export interface TurnEndEvent {
  type: "turn_end"
  [key: string]: unknown
}

export interface ExtensionUiSnapshotEvent {
  type: "extension_ui_snapshot"
  snapshot: ExtensionUiSnapshot
}

export type WorkspaceEvent =
  | BridgeStatusEvent
  | LiveStateInvalidationEvent
  | ExtensionUiRequestEvent
  | ExtensionUiSnapshotEvent
  | ExtensionErrorEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | AgentEndEvent
  | TurnEndEvent
  | ({ type: Exclude<string, "bridge_status" | "live_state_invalidation" | "extension_ui_request" | "extension_error" | "message_update" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "agent_end" | "turn_end">; [key: string]: unknown } & Record<string, unknown>)

export function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string"
}

export interface WorkspaceCommandResponse {
  type: "response"
  command: string
  success: boolean
  error?: string
  data?: unknown
  id?: string
  code?: string
  details?: {
    reason?: "required_setup" | "bridge_refresh_pending" | "bridge_refresh_failed"
    onboarding?: Partial<WorkspaceOnboardingState>
  }
}

export interface WorkspaceBridgeCommand {
  type: string
  [key: string]: unknown
}

export interface WorkspaceTerminalLine {
  id: string
  type: TerminalLineType
  content: string
  timestamp: string
}

export type WorkspaceOnboardingRequestState =
  | "idle"
  | "refreshing"
  | "saving_api_key"
  | "starting_provider_flow"
  | "submitting_provider_flow_input"
  | "cancelling_provider_flow"
  | "logging_out_provider"

// A blocking UI request that needs user response before the agent can continue.
// The `method` field discriminates the payload shape.
export type PendingUiRequest = Extract<
  ExtensionUiRequestEvent,
  { method: "select" | "confirm" | "input" | "editor" }
>

export interface ActiveToolExecution {
  id: string
  name: string
  args?: Record<string, unknown>
  result?: {
    content?: Array<{ type: string; text?: string }>
    details?: Record<string, unknown>
    isError?: boolean
  }
}

/** Completed tool execution with result — kept for chat rendering */
export type { CompletedToolExecution } from "./transcript-store"

/**
 * A chronologically-ordered segment within a single assistant turn.
 * The sequence `thinking → text → tool → thinking → text → tool …`
 * is captured as separate segments so the chat UI can render them
 * in the correct interleaved order.
 */

export interface WidgetContent {
  lines: string[] | undefined
  placement?: "aboveEditor" | "belowEditor"
}

export interface WorkspaceStoreState {
  bootStatus: WorkspaceStatus
  connectionState: WorkspaceConnectionState
  boot: WorkspaceBootPayload | null
  live: WorkspaceLiveState
  terminalLines: WorkspaceTerminalLine[]
  lastClientError: string | null
  lastBridgeError: BridgeLastError | null
  sessionAttached: boolean
  lastEventType: string | null
  commandInFlight: string | null
  lastSlashCommandOutcome: BrowserSlashCommandDispatchResult | null
  commandSurface: WorkspaceCommandSurfaceState
  onboardingRequestState: WorkspaceOnboardingRequestState
  onboardingRequestProviderId: string | null
  // Live interaction state
  pendingUiRequests: PendingUiRequest[]
  streamingAssistantText: string
  streamingThinkingText: string
  completedTurns: CompletedTurn[]
  pendingUserMessage: ChatMessage | null
  currentTurnSegments: TurnSegment[]
  completedToolExecutions: CompletedToolExecution[]
  activeToolExecution: ActiveToolExecution | null
  statusTexts: Record<string, string>
  widgetContents: Record<string, WidgetContent>
  titleOverride: string | null
  editorTextBuffer: string | null
  workingMessage: string | null
}

export const MAX_TRANSCRIPT_BLOCKS = 100
export const COMMAND_TIMEOUT_MS = 90_000
export const VISIBILITY_REFRESH_THRESHOLD_MS = 30_000
const IMPLEMENTED_BROWSER_COMMAND_SURFACES = new Set<BrowserSlashCommandSurface>([
  "settings",
  "model",
  "thinking",
  "git",
  "resume",
  "name",
  "fork",
  "compact",
  "login",
  "logout",
  "session",
  "export",
  // GSD subcommand surfaces (S02)
  "gsd-visualize",
  "gsd-forensics",
  "gsd-doctor",
  "gsd-skill-health",
  "gsd-knowledge",
  "gsd-capture",
  "gsd-triage",
  "gsd-quick",
  "gsd-history",
  "gsd-undo",
  "gsd-inspect",
  "gsd-prefs",
  "gsd-config",
  "gsd-hooks",
  "gsd-mode",
  "gsd-steer",
  "gsd-report",
  "gsd-export",
  "gsd-cleanup",
  "gsd-queue",
])

function hasAttachedSession(bridge: BridgeRuntimeSnapshot | null | undefined): boolean {
  return Boolean(bridge?.activeSessionId || bridge?.sessionState?.sessionId)
}

function getCommandInputLabel(command: WorkspaceBridgeCommand): string {
  return typeof command.message === "string" ? command.message : `/${command.type}`
}

function summarizeBridgeStatus(bridge: BridgeRuntimeSnapshot): { type: TerminalLineType; message: string } {
  if (bridge.phase === "failed") {
    return {
      type: "error",
      message: `Bridge failed${bridge.lastError?.message ? ` — ${bridge.lastError.message}` : ""}`,
    }
  }

  if (bridge.phase === "starting") {
    return {
      type: "system",
      message: "Bridge starting for the current project…",
    }
  }

  if (bridge.phase === "ready") {
    const sessionLabel = getSessionLabelFromBridge(bridge)
    return {
      type: "success",
      message: sessionLabel
        ? `Live bridge ready — attached to ${sessionLabel}`
        : "Live bridge ready — session attachment pending",
    }
  }

  return {
    type: "system",
    message: "Bridge idle",
  }
}

function summarizeEvent(event: WorkspaceEvent): { type: TerminalLineType; message: string } | null {
  switch (event.type) {
    case "bridge_status":
      return summarizeBridgeStatus((event as BridgeStatusEvent).bridge)
    case "live_state_invalidation":
      return {
        type: "system",
        message: `[Live] Refreshing ${Array.isArray(event.domains) ? event.domains.join(", ") : "state"} after ${String(event.reason).replaceAll("_", " ")}`,
      }
    case "agent_start":
      return { type: "system", message: "[Agent] Run started" }
    case "agent_end":
      return { type: "success", message: "[Agent] Run finished" }
    case "turn_start":
      return { type: "system", message: "[Agent] Turn started" }
    case "turn_end":
      return { type: "success", message: "[Agent] Turn complete" }
    case "tool_execution_start":
      return {
        type: "output",
        message: `[Tool] ${typeof event.toolName === "string" ? event.toolName : "tool"} started`,
      }
    case "tool_execution_update":
      return null
    case "tool_execution_end":
      return {
        type: event.isError ? "error" : "success",
        message: `[Tool] ${typeof event.toolName === "string" ? event.toolName : "tool"} ${event.isError ? "failed" : "completed"}`,
      }
    case "auto_compaction_start":
      return { type: "system", message: "[Auto] Compaction started" }
    case "auto_compaction_end":
      return {
        type: event.aborted ? "error" : "success",
        message: event.aborted ? "[Auto] Compaction aborted" : "[Auto] Compaction finished",
      }
    case "auto_retry_start":
      return {
        type: "system",
        message: `[Auto] Retry ${String(event.attempt)}/${String(event.maxAttempts)} scheduled`,
      }
    case "auto_retry_end":
      return {
        type: event.success ? "success" : "error",
        message: event.success ? "[Auto] Retry recovered the run" : "[Auto] Retry exhausted",
      }
    case "extension_ui_request": {
      const uiEvent = event as ExtensionUiRequestEvent
      const detail =
        "title" in uiEvent && typeof uiEvent.title === "string" && uiEvent.title.trim().length > 0
          ? uiEvent.title
          : "message" in uiEvent && typeof uiEvent.message === "string" && uiEvent.message.trim().length > 0
            ? uiEvent.message
            : uiEvent.method
      return {
        type: ("notifyType" in uiEvent && uiEvent.notifyType === "error") ? "error" : "system",
        message: `[UI] ${detail}`,
      }
    }
    case "extension_error":
      return { type: "error", message: `[Extension] ${event.error}` }
    default:
      return null
  }
}

type OnboardingApiPayload = {
  onboarding?: WorkspaceOnboardingState
  error?: string
}

const ACTIVE_ONBOARDING_FLOW_STATUSES = new Set<WorkspaceOnboardingFlowState["status"]>([
  "running",
  "awaiting_browser_auth",
  "awaiting_input",
])

const TERMINAL_ONBOARDING_FLOW_STATUSES = new Set<WorkspaceOnboardingFlowState["status"]>([
  "succeeded",
  "failed",
  "cancelled",
])

function mergeOnboardingState(
  current: WorkspaceOnboardingState,
  patch: Partial<WorkspaceOnboardingState>,
): WorkspaceOnboardingState {
  return {
    ...current,
    ...patch,
    required: {
      ...current.required,
      ...(patch.required ?? {}),
      providers: patch.required?.providers ?? current.required.providers,
    },
    optional: {
      ...current.optional,
      ...(patch.optional ?? {}),
      sections: patch.optional?.sections ?? current.optional.sections,
    },
    bridgeAuthRefresh: {
      ...current.bridgeAuthRefresh,
      ...(patch.bridgeAuthRefresh ?? {}),
    },
  }
}

function cloneBootWithOnboarding(
  boot: WorkspaceBootPayload | null,
  onboarding: WorkspaceOnboardingState,
): WorkspaceBootPayload | null {
  if (!boot) return null
  return {
    ...boot,
    onboarding,
    onboardingNeeded: onboarding.locked,
  }
}

function cloneBootWithPartialOnboarding(
  boot: WorkspaceBootPayload | null,
  onboarding: Partial<WorkspaceOnboardingState>,
): WorkspaceBootPayload | null {
  if (!boot) return null
  return cloneBootWithOnboarding(boot, mergeOnboardingState(boot.onboarding, onboarding))
}

function summarizeOnboardingState(onboarding: WorkspaceOnboardingState): { type: TerminalLineType; message: string } | null {
  if (onboarding.bridgeAuthRefresh.phase === "failed") {
    return {
      type: "error",
      message: onboarding.bridgeAuthRefresh.error
        ? `Bridge auth refresh failed — ${onboarding.bridgeAuthRefresh.error}`
        : "Bridge auth refresh failed after setup",
    }
  }

  if (onboarding.bridgeAuthRefresh.phase === "pending") {
    return {
      type: "system",
      message: "Credentials saved — refreshing bridge auth before the workspace unlocks…",
    }
  }

  if (onboarding.lastValidation?.status === "failed") {
    return {
      type: "error",
      message: `Credential validation failed — ${onboarding.lastValidation.message}`,
    }
  }

  if (!onboarding.locked && onboarding.lastValidation?.status === "succeeded") {
    return {
      type: "success",
      message: `${findOnboardingProviderLabel(onboarding, onboarding.lastValidation.providerId)} is ready — workspace unlocked`,
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_browser_auth") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in is waiting for browser confirmation`,
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_input") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in needs one more input step`,
    }
  }

  if (onboarding.activeFlow?.status === "cancelled") {
    return {
      type: "system",
      message: `${onboarding.activeFlow.providerLabel} sign-in was cancelled`,
    }
  }

  if (onboarding.activeFlow?.status === "failed") {
    return {
      type: "error",
      message: onboarding.activeFlow.error
        ? `${onboarding.activeFlow.providerLabel} sign-in failed — ${onboarding.activeFlow.error}`
        : `${onboarding.activeFlow.providerLabel} sign-in failed`,
    }
  }

  if (onboarding.lockReason === "required_setup") {
    return {
      type: "system",
      message: "Onboarding is still required before model-backed prompts will run",
    }
  }

  return null
}

function bootSeedLines(boot: WorkspaceBootPayload): WorkspaceTerminalLine[] {
  const lines = [
    createTerminalLine("system", `GSD web workspace attached to ${boot.project.cwd}`),
    createTerminalLine("system", `Workspace scope: ${getCurrentScopeLabel(boot.workspace)}`),
  ]

  const bridgeSummary = summarizeBridgeStatus(boot.bridge)
  lines.push(createTerminalLine(bridgeSummary.type, bridgeSummary.message))

  if (boot.bridge.lastError) {
    lines.push(createTerminalLine("error", `Bridge error: ${boot.bridge.lastError.message}`))
  }

  const onboardingSummary = summarizeOnboardingState(boot.onboarding)
  if (onboardingSummary) {
    lines.push(createTerminalLine(onboardingSummary.type, onboardingSummary.message))
  }

  return lines
}

function responseToLine(response: WorkspaceCommandResponse): WorkspaceTerminalLine {
  if (!response.success) {
    return createTerminalLine("error", `Command failed (${response.command}) — ${response.error ?? "unknown error"}`)
  }

  switch (response.command) {
    case "get_state":
      return createTerminalLine("success", "Session state refreshed")
    case "new_session":
      return createTerminalLine("success", "Started a new session")
    case "prompt":
      return createTerminalLine("success", "Prompt accepted by the live bridge")
    case "follow_up":
      return createTerminalLine("success", "Follow-up queued on the live bridge")
    case "bash": {
      const data = response.data as
        | { output?: string; exitCode?: number; cancelled?: boolean }
        | undefined
      if (data?.output?.trim()) {
        return createTerminalLine("output", data.output.trimEnd())
      }
      if (data?.cancelled) {
        return createTerminalLine("system", "Bash command cancelled")
      }
      const exitCode = data?.exitCode ?? 0
      return createTerminalLine(
        exitCode === 0 ? "success" : "error",
        exitCode === 0 ? "Bash command completed" : `Bash command exited with code ${exitCode}`,
      )
    }
    default:
      return createTerminalLine("success", `Command accepted (${response.command})`)
  }
}

export function shortenPath(path: string | undefined, segmentCount = 3): string {
  if (!path) return "—"
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segmentCount) {
    return path.startsWith("/") ? `/${parts.join("/")}` : parts.join("/")
  }
  const tail = parts.slice(-segmentCount).join("/")
  return `…/${tail}`
}

export function getProjectDisplayName(path: string | undefined): string {
  if (!path) return "Current project"
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || path
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return "0m"
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(Math.round(tokens))
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00"
  return `$${cost.toFixed(2)}`
}

export function getCurrentScopeLabel(workspace: WorkspaceIndex | null | undefined): string {
  if (!workspace) return "Project scope pending"
  const scope = [workspace.active.milestoneId, workspace.active.sliceId, workspace.active.taskId]
    .filter(Boolean)
    .join("/")
  return scope ? `${scope} — ${workspace.active.phase}` : `project — ${workspace.active.phase}`
}

export function getCurrentBranch(workspace: WorkspaceIndex | null | undefined): string | null {
  if (!workspace?.active.milestoneId || !workspace.active.sliceId) {
    return null
  }

  const milestone = workspace.milestones.find((entry) => entry.id === workspace.active.milestoneId)
  const slice = milestone?.slices.find((entry) => entry.id === workspace.active.sliceId)
  return slice?.branch ?? null
}

export function getCurrentSlice(workspace: WorkspaceIndex | null | undefined): WorkspaceSliceTarget | null {
  if (!workspace?.active.milestoneId || !workspace.active.sliceId) return null
  const milestone = workspace.milestones.find((entry) => entry.id === workspace.active.milestoneId)
  return milestone?.slices.find((entry) => entry.id === workspace.active.sliceId) ?? null
}

export function getSessionLabelFromBridge(bridge: BridgeRuntimeSnapshot | null | undefined): string | null {
  if (!bridge?.sessionState && !bridge?.activeSessionId) return null
  const sessionName = bridge.sessionState?.sessionName?.trim()
  if (sessionName) return sessionName
  if (bridge.activeSessionId) return `session ${bridge.activeSessionId}`
  return bridge.sessionState?.sessionId ?? null
}

export function getModelLabel(bridge: BridgeRuntimeSnapshot | null | undefined): string {
  const model = bridge?.sessionState?.model
  if (!model) return "model pending"
  return model.id || model.providerId || model.provider || "model pending"
}

export { describeSessionPath } from "./workspace-boot-helpers"

export interface WorkspaceOnboardingPresentation {
  phase:
    | "loading"
    | "locked"
    | "validating"
    | "running_flow"
    | "awaiting_browser_auth"
    | "awaiting_input"
    | "refreshing"
    | "failure"
    | "ready"
  label: string
  detail: string
  tone: WorkspaceStatusTone
}

export function getOnboardingPresentation(
  state: Pick<WorkspaceStoreState, "bootStatus" | "boot" | "onboardingRequestState">,
): WorkspaceOnboardingPresentation {
  if (state.bootStatus === "loading" || !state.boot) {
    return {
      phase: "loading",
      label: "Loading setup state",
      detail: "Resolving the current project, bridge, and onboarding contract…",
      tone: "info",
    }
  }

  const onboarding = state.boot.onboarding
  if (onboarding.activeFlow?.status === "awaiting_browser_auth") {
    return {
      phase: "awaiting_browser_auth",
      label: "Continue sign-in in your browser",
      detail: `${onboarding.activeFlow.providerLabel} is waiting for browser confirmation before the workspace can unlock.`,
      tone: "info",
    }
  }

  if (onboarding.activeFlow?.status === "awaiting_input") {
    return {
      phase: "awaiting_input",
      label: "One more sign-in step is required",
      detail: onboarding.activeFlow.prompt?.message ?? `${onboarding.activeFlow.providerLabel} needs one more input step.`,
      tone: "info",
    }
  }

  if (onboarding.lockReason === "bridge_refresh_pending") {
    return {
      phase: "refreshing",
      label: "Refreshing bridge auth",
      detail: "Credentials validated. The live bridge is restarting onto the new auth view before the shell unlocks.",
      tone: "info",
    }
  }

  if (onboarding.lockReason === "bridge_refresh_failed") {
    return {
      phase: "failure",
      label: "Setup completed, but the shell is still locked",
      detail: onboarding.bridgeAuthRefresh.error ?? "The bridge could not reload auth after setup.",
      tone: "danger",
    }
  }

  if (onboarding.lastValidation?.status === "failed") {
    return {
      phase: "failure",
      label: "Credential validation failed",
      detail: onboarding.lastValidation.message,
      tone: "danger",
    }
  }

  if (state.onboardingRequestState === "saving_api_key") {
    return {
      phase: "validating",
      label: "Validating credentials",
      detail: "Checking the provider key and saving it only if validation succeeds.",
      tone: "info",
    }
  }

  if (state.onboardingRequestState === "starting_provider_flow" || state.onboardingRequestState === "submitting_provider_flow_input") {
    return {
      phase: "running_flow",
      label: "Advancing provider sign-in",
      detail: "The onboarding flow is running and will update here as soon as the next step is ready.",
      tone: "info",
    }
  }

  if (onboarding.locked) {
    return {
      phase: "locked",
      label: "Required setup needed",
      detail: "Choose a required provider, validate it here, and the workspace will unlock without restarting the host.",
      tone: "warning",
    }
  }

  return {
    phase: "ready",
    label: "Workspace unlocked",
    detail:
      onboarding.lastValidation?.status === "succeeded"
        ? `${findOnboardingProviderLabel(onboarding, onboarding.lastValidation.providerId)} is ready and the workspace is live.`
        : "Required setup is satisfied and the shell is ready for live commands.",
    tone: "success",
  }
}

export function getVisibleWorkspaceError(
  state: Pick<WorkspaceStoreState, "boot" | "lastBridgeError" | "lastClientError">,
): string | null {
  const onboarding = state.boot?.onboarding
  if (onboarding?.bridgeAuthRefresh.phase === "failed" && onboarding.bridgeAuthRefresh.error) {
    return onboarding.bridgeAuthRefresh.error
  }
  if (onboarding?.lastValidation?.status === "failed") {
    return onboarding.lastValidation.message
  }
  return state.lastBridgeError?.message ?? state.lastClientError
}

export function getStatusPresentation(
  state: Pick<WorkspaceStoreState, "bootStatus" | "connectionState" | "boot" | "onboardingRequestState">,
): {
  label: string
  tone: WorkspaceStatusTone
} {
  if (state.bootStatus === "loading") {
    return { label: "Loading workspace", tone: "info" }
  }

  if (state.bootStatus === "error") {
    return { label: "Boot failed", tone: "danger" }
  }

  const onboardingPresentation = getOnboardingPresentation(state)
  if (onboardingPresentation.phase !== "ready") {
    return {
      label: onboardingPresentation.label,
      tone: onboardingPresentation.tone,
    }
  }

  if (state.boot?.bridge.phase === "failed") {
    return { label: "Bridge failed", tone: "danger" }
  }

  switch (state.connectionState) {
    case "connected":
      return { label: "Bridge connected", tone: "success" }
    case "connecting":
      return { label: "Connecting stream", tone: "info" }
    case "reconnecting":
      return { label: "Reconnecting stream", tone: "warning" }
    case "disconnected":
      return { label: "Stream disconnected", tone: "warning" }
    case "error":
      return { label: "Stream error", tone: "danger" }
    default:
      return { label: "Workspace idle", tone: "muted" }
  }
}

function createInitialState(): WorkspaceStoreState {
  return {
    bootStatus: "idle",
    connectionState: "idle",
    boot: null,
    live: createInitialWorkspaceLiveState(),
    terminalLines: [createTerminalLine("system", "Preparing the live GSD workspace…")],
    lastClientError: null,
    lastBridgeError: null,
    sessionAttached: false,
    lastEventType: null,
    commandInFlight: null,
    lastSlashCommandOutcome: null,
    commandSurface: createInitialCommandSurfaceState(),
    onboardingRequestState: "idle",
    onboardingRequestProviderId: null,
    // Live interaction state
    pendingUiRequests: [],
    streamingAssistantText: "",
    streamingThinkingText: "",
    completedTurns: [],
    pendingUserMessage: null,
    currentTurnSegments: [],
    completedToolExecutions: [],
    activeToolExecution: null,
    statusTexts: {},
    widgetContents: {},
    titleOverride: null,
    editorTextBuffer: null,
    workingMessage: null,
  }
}

export function buildProjectUrl(path: string, projectCwd?: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  const prefixed = base && path.startsWith("/") ? `${base}${path}` : path
  if (!projectCwd) return prefixed
  const url = new URL(prefixed, "http://localhost")
  url.searchParams.set("project", projectCwd)
  return url.pathname + url.search
}

export class GSDWorkspaceStore {
  constructor(private readonly projectCwd?: string) {
    this.commandSurfaceActions = new CommandSurfaceStore({
      getState: () => this.state,
      patchState: (patch) => this.patchState(patch),
      buildUrl: (path) => this.buildUrl(path),
      sendCommand: (command, options) => this.sendCommand(command, options),
      refreshBoot: (options) => this.refreshBoot(options),
      refreshOnboarding: () => this.refreshOnboarding(),
      logoutProvider: (providerId) => this.logoutProvider(providerId),
      saveApiKey: (providerId, apiKey) => this.saveApiKey(providerId, apiKey),
      startProviderFlow: (providerId) => this.startProviderFlow(providerId),
      submitProviderFlowInput: (flowId, input) => this.submitProviderFlowInput(flowId, input),
      cancelProviderFlow: (flowId) => this.cancelProviderFlow(flowId),
    })
  }

  private readonly commandSurfaceActions: CommandSurfaceStore

  private buildUrl(path: string): string {
    return buildProjectUrl(path, this.projectCwd)
  }

  private state = createInitialState()
  private readonly listeners = new Set<() => void>()
  private readonly contextualTips = new ContextualTips()
  private readonly eventStream = new WorkspaceEventStream({
    canConnect: () => !this.disposed && !this.state.boot?.onboarding.locked,
    streamUrl: () => appendAuthParam(this.buildUrl("/api/session/events")),
    onOpen: ({ wasDisconnected }) => this.handleEventStreamOpen(wasDisconnected),
    onMessage: (data) => this.handleEventStreamMessage(data),
    onError: ({ nextConnectionState, changed }) => this.handleEventStreamError(nextConnectionState, changed),
  })
  private bootPromise: Promise<void> | null = null
  private onboardingPollTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private disposed = false
  private lastBridgeDigest: string | null = null
  private commandTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private lastBootRefreshAt = 0
  private visibilityHandler: (() => void) | null = null
  private emitScheduled = false
  private emitFrame: number | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): WorkspaceStoreState => this.state

  start = (): void => {
    if (this.started || this.disposed) return
    this.started = true

    if (typeof document !== "undefined") {
      this.visibilityHandler = () => {
        if (document.visibilityState === "visible" && Date.now() - this.lastBootRefreshAt >= VISIBILITY_REFRESH_THRESHOLD_MS) {
          void this.refreshBoot({ soft: true })
        }
      }
      document.addEventListener("visibilitychange", this.visibilityHandler)
    }

    void this.refreshBoot()
  }

  dispose = (): void => {
    this.disposed = true
    this.started = false
    this.cancelScheduledEmit()
    this.stopOnboardingPoller()
    this.closeEventStream()
    this.clearCommandTimeout()
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler)
      this.visibilityHandler = null
    }
  }

  disconnectSSE = (): void => {
    this.closeEventStream()
  }

  reconnectSSE = (): void => {
    if (this.disposed) return
    this.ensureEventStream()
    void this.refreshBoot({ soft: true })
  }

  clearTerminalLines = (): void => {
    const replacement = this.state.boot ? bootSeedLines(this.state.boot) : [createTerminalLine("system", "Terminal cleared")]
    this.patchState({ terminalLines: replacement })
  }

  consumeEditorTextBuffer = (): string | null => {
    const next = this.state.editorTextBuffer
    if (next !== null) {
      this.patchState({ editorTextBuffer: null })
    }
    return next
  }

  openCommandSurface = (
    surface: BrowserSlashCommandSurface,
    options: { source?: "slash" | "sidebar" | "surface"; args?: string; selectedTarget?: CommandSurfaceTarget | null } = {},
  ): void => {
    const resumableSessions = resolveResumableSessions(this.state)
    this.patchState({
      commandSurface: openCommandSurfaceState(this.state.commandSurface, {
        surface,
        source: options.source ?? "surface",
        args: options.args ?? "",
        selectedTarget: options.selectedTarget,
        onboardingLocked: this.state.boot?.onboarding.locked,
        currentModel: getCurrentModelSelection(this.state.boot?.bridge),
        currentThinkingLevel: this.state.boot?.bridge.sessionState?.thinkingLevel ?? null,
        preferredProviderId: getPreferredOnboardingProviderId(this.state.boot?.onboarding),
        resumableSessions: resumableSessions.map((session) => ({
          id: session.id,
          path: session.path,
          name: session.name,
          isActive: session.isActive,
        })),
        currentSessionPath: this.state.boot?.bridge.activeSessionFile ?? this.state.boot?.bridge.sessionState?.sessionFile ?? null,
        currentSessionName: this.state.boot?.bridge.sessionState?.sessionName ?? null,
        projectCwd: this.state.boot?.project.cwd ?? null,
        projectSessionsDir: this.state.boot?.project.sessionsDir ?? null,
      }),
    })
  }

  closeCommandSurface = (): void => {
    this.patchState({
      commandSurface: closeCommandSurfaceState(this.state.commandSurface),
    })
  }

  setCommandSurfaceSection = (section: CommandSurfaceSection): void => {
    const resumableSessions = resolveResumableSessions(this.state)
    this.patchState({
      commandSurface: setCommandSurfaceSection(this.state.commandSurface, section, {
        onboardingLocked: this.state.boot?.onboarding.locked,
        currentModel: getCurrentModelSelection(this.state.boot?.bridge),
        currentThinkingLevel: this.state.boot?.bridge.sessionState?.thinkingLevel ?? null,
        preferredProviderId: getPreferredOnboardingProviderId(this.state.boot?.onboarding),
        resumableSessions: resumableSessions.map((session) => ({
          id: session.id,
          path: session.path,
          name: session.name,
          isActive: session.isActive,
        })),
        currentSessionPath: this.state.boot?.bridge.activeSessionFile ?? this.state.boot?.bridge.sessionState?.sessionFile ?? null,
        currentSessionName: this.state.boot?.bridge.sessionState?.sessionName ?? null,
        projectCwd: this.state.boot?.project.cwd ?? null,
        projectSessionsDir: this.state.boot?.project.sessionsDir ?? null,
      }),
    })
  }

  selectCommandSurfaceTarget = (target: CommandSurfaceTarget): void => {
    this.patchState({
      commandSurface: selectCommandSurfaceStateTarget(this.state.commandSurface, target),
    })
  }
  // Command surface loaders/actions — delegated to CommandSurfaceStore
  loadGitSummary = (...args: Parameters<CommandSurfaceStore["loadGitSummary"]>) => this.commandSurfaceActions.loadGitSummary(...args)
  loadRecoveryDiagnostics = (...args: Parameters<CommandSurfaceStore["loadRecoveryDiagnostics"]>) => this.commandSurfaceActions.loadRecoveryDiagnostics(...args)
  loadForensicsDiagnostics = (...args: Parameters<CommandSurfaceStore["loadForensicsDiagnostics"]>) => this.commandSurfaceActions.loadForensicsDiagnostics(...args)
  loadDoctorDiagnostics = (...args: Parameters<CommandSurfaceStore["loadDoctorDiagnostics"]>) => this.commandSurfaceActions.loadDoctorDiagnostics(...args)
  applyDoctorFixes = (...args: Parameters<CommandSurfaceStore["applyDoctorFixes"]>) => this.commandSurfaceActions.applyDoctorFixes(...args)
  loadSkillHealthDiagnostics = (...args: Parameters<CommandSurfaceStore["loadSkillHealthDiagnostics"]>) => this.commandSurfaceActions.loadSkillHealthDiagnostics(...args)
  loadKnowledgeData = (...args: Parameters<CommandSurfaceStore["loadKnowledgeData"]>) => this.commandSurfaceActions.loadKnowledgeData(...args)
  loadCapturesData = (...args: Parameters<CommandSurfaceStore["loadCapturesData"]>) => this.commandSurfaceActions.loadCapturesData(...args)
  loadSettingsData = (...args: Parameters<CommandSurfaceStore["loadSettingsData"]>) => this.commandSurfaceActions.loadSettingsData(...args)
  loadHistoryData = (...args: Parameters<CommandSurfaceStore["loadHistoryData"]>) => this.commandSurfaceActions.loadHistoryData(...args)
  loadInspectData = (...args: Parameters<CommandSurfaceStore["loadInspectData"]>) => this.commandSurfaceActions.loadInspectData(...args)
  loadHooksData = (...args: Parameters<CommandSurfaceStore["loadHooksData"]>) => this.commandSurfaceActions.loadHooksData(...args)
  loadExportData = (...args: Parameters<CommandSurfaceStore["loadExportData"]>) => this.commandSurfaceActions.loadExportData(...args)
  loadUndoInfo = (...args: Parameters<CommandSurfaceStore["loadUndoInfo"]>) => this.commandSurfaceActions.loadUndoInfo(...args)
  loadCleanupData = (...args: Parameters<CommandSurfaceStore["loadCleanupData"]>) => this.commandSurfaceActions.loadCleanupData(...args)
  loadSteerData = (...args: Parameters<CommandSurfaceStore["loadSteerData"]>) => this.commandSurfaceActions.loadSteerData(...args)
  executeUndoAction = (...args: Parameters<CommandSurfaceStore["executeUndoAction"]>) => this.commandSurfaceActions.executeUndoAction(...args)
  executeCleanupAction = (...args: Parameters<CommandSurfaceStore["executeCleanupAction"]>) => this.commandSurfaceActions.executeCleanupAction(...args)
  resolveCaptureAction = (...args: Parameters<CommandSurfaceStore["resolveCaptureAction"]>) => this.commandSurfaceActions.resolveCaptureAction(...args)
  updateSessionBrowserState = (...args: Parameters<CommandSurfaceStore["updateSessionBrowserState"]>) => this.commandSurfaceActions.updateSessionBrowserState(...args)
  loadSessionBrowser = (...args: Parameters<CommandSurfaceStore["loadSessionBrowser"]>) => this.commandSurfaceActions.loadSessionBrowser(...args)
  renameSessionFromSurface = (...args: Parameters<CommandSurfaceStore["renameSessionFromSurface"]>) => this.commandSurfaceActions.renameSessionFromSurface(...args)
  loadAvailableModels = (...args: Parameters<CommandSurfaceStore["loadAvailableModels"]>) => this.commandSurfaceActions.loadAvailableModels(...args)
  applyModelSelection = (...args: Parameters<CommandSurfaceStore["applyModelSelection"]>) => this.commandSurfaceActions.applyModelSelection(...args)
  applyThinkingLevel = (...args: Parameters<CommandSurfaceStore["applyThinkingLevel"]>) => this.commandSurfaceActions.applyThinkingLevel(...args)
  setSteeringModeFromSurface = (...args: Parameters<CommandSurfaceStore["setSteeringModeFromSurface"]>) => this.commandSurfaceActions.setSteeringModeFromSurface(...args)
  setFollowUpModeFromSurface = (...args: Parameters<CommandSurfaceStore["setFollowUpModeFromSurface"]>) => this.commandSurfaceActions.setFollowUpModeFromSurface(...args)
  setAutoCompactionFromSurface = (...args: Parameters<CommandSurfaceStore["setAutoCompactionFromSurface"]>) => this.commandSurfaceActions.setAutoCompactionFromSurface(...args)
  setAutoRetryFromSurface = (...args: Parameters<CommandSurfaceStore["setAutoRetryFromSurface"]>) => this.commandSurfaceActions.setAutoRetryFromSurface(...args)
  abortRetryFromSurface = (...args: Parameters<CommandSurfaceStore["abortRetryFromSurface"]>) => this.commandSurfaceActions.abortRetryFromSurface(...args)
  switchSessionFromSurface = (...args: Parameters<CommandSurfaceStore["switchSessionFromSurface"]>) => this.commandSurfaceActions.switchSessionFromSurface(...args)
  loadSessionStats = (...args: Parameters<CommandSurfaceStore["loadSessionStats"]>) => this.commandSurfaceActions.loadSessionStats(...args)
  exportSessionFromSurface = (...args: Parameters<CommandSurfaceStore["exportSessionFromSurface"]>) => this.commandSurfaceActions.exportSessionFromSurface(...args)
  loadForkMessages = (...args: Parameters<CommandSurfaceStore["loadForkMessages"]>) => this.commandSurfaceActions.loadForkMessages(...args)
  forkSessionFromSurface = (...args: Parameters<CommandSurfaceStore["forkSessionFromSurface"]>) => this.commandSurfaceActions.forkSessionFromSurface(...args)
  compactSessionFromSurface = (...args: Parameters<CommandSurfaceStore["compactSessionFromSurface"]>) => this.commandSurfaceActions.compactSessionFromSurface(...args)
  saveApiKeyFromSurface = (...args: Parameters<CommandSurfaceStore["saveApiKeyFromSurface"]>) => this.commandSurfaceActions.saveApiKeyFromSurface(...args)
  startProviderFlowFromSurface = (...args: Parameters<CommandSurfaceStore["startProviderFlowFromSurface"]>) => this.commandSurfaceActions.startProviderFlowFromSurface(...args)
  submitProviderFlowInputFromSurface = (...args: Parameters<CommandSurfaceStore["submitProviderFlowInputFromSurface"]>) => this.commandSurfaceActions.submitProviderFlowInputFromSurface(...args)
  cancelProviderFlowFromSurface = (...args: Parameters<CommandSurfaceStore["cancelProviderFlowFromSurface"]>) => this.commandSurfaceActions.cancelProviderFlowFromSurface(...args)
  logoutProviderFromSurface = (...args: Parameters<CommandSurfaceStore["logoutProviderFromSurface"]>) => this.commandSurfaceActions.logoutProviderFromSurface(...args)

  respondToUiRequest = async (id: string, response: Record<string, unknown>): Promise<void> => {
    this.patchState({ commandInFlight: "extension_ui_response" })
    try {
      const result = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "extension_ui_response", id, ...response }),
      })
      if (!result.ok) {
        const body = await result.json().catch(() => ({ error: `HTTP ${result.status}` })) as { error?: string }
        throw new Error(body.error ?? `extension_ui_response failed with ${result.status}`)
      }
      this.patchState({
        pendingUiRequests: this.state.pendingUiRequests.filter((r) => r.id !== id),
      })
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `UI response failed — ${message}`)),
      })
    } finally {
      this.patchState({ commandInFlight: null })
    }
  }

  dismissUiRequest = async (id: string): Promise<void> => {
    this.patchState({ commandInFlight: "extension_ui_response" })
    try {
      const result = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "extension_ui_response", id, cancelled: true }),
      })
      if (!result.ok) {
        const body = await result.json().catch(() => ({ error: `HTTP ${result.status}` })) as { error?: string }
        throw new Error(body.error ?? `extension_ui_response cancel failed with ${result.status}`)
      }
      this.patchState({
        pendingUiRequests: this.state.pendingUiRequests.filter((r) => r.id !== id),
      })
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `UI dismiss failed — ${message}`)),
      })
    } finally {
      this.patchState({ commandInFlight: null })
    }
  }

  sendSteer = async (message: string): Promise<void> => {
    await this.sendCommand({ type: "steer", message })
  }

  sendAbort = async (): Promise<void> => {
    await this.sendCommand({ type: "abort" })
  }

  pushChatUserMessage = (msg: ChatMessage) => {
    this.patchTranscript((transcript) => pushPendingUserMessage(transcript, msg))
  }

  submitInput = async (input: string, images?: PendingImage[]): Promise<BrowserSlashCommandDispatchResult | null> => {
    const trimmed = input.trim()
    if (!trimmed) return null

    const outcome = dispatchBrowserSlashCommand(trimmed, {
      isStreaming: this.state.boot?.bridge.sessionState?.isStreaming,
    })

    this.patchState({
      lastSlashCommandOutcome: trimmed.startsWith("/") ? outcome : null,
    })

    // Evaluate contextual tips before sending to agent
    if (outcome.kind === "prompt") {
      const sessionState = this.state.boot?.bridge.sessionState
      const tip = this.contextualTips.evaluate({
        input: trimmed,
        isStreaming: Boolean(sessionState?.isStreaming),
        thinkingLevel: sessionState?.thinkingLevel,
        // contextPercent not available in web — compaction nudge won't fire here
        contextPercent: undefined,
      })
      if (tip) {
        this.patchState({
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine("system", `💡 ${tip}`),
          ),
        })
      }
    }

    switch (outcome.kind) {
      case "bash":
        await this.sendCommand(outcome.command, { displayInput: trimmed })
        return outcome
      case "prompt":
      case "rpc": {
        const imagePayload = images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))
        const command = imagePayload && imagePayload.length > 0
          ? { ...outcome.command, images: imagePayload }
          : outcome.command
        await this.sendCommand(command, { displayInput: trimmed })
        return outcome
      }
      case "local":
        if (outcome.action === "clear_terminal") {
          this.clearTerminalLines()
          return outcome
        }
        if (outcome.action === "refresh_workspace") {
          await this.refreshBoot()
          return outcome
        }
        if (outcome.action === "gsd_help") {
          this.patchState({
            terminalLines: withTerminalLine(
              withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed)),
              createTerminalLine("system", GSD_HELP_TEXT),
            ),
          })
          return outcome
        }
        return outcome
      case "surface": {
        if (IMPLEMENTED_BROWSER_COMMAND_SURFACES.has(outcome.surface)) {
          this.patchState({
            terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed)),
          })
          this.openCommandSurface(outcome.surface, { source: "slash", args: outcome.args })
          return outcome
        }

        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        let nextLines = withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed))
        if (notice) {
          nextLines = withTerminalLine(nextLines, createTerminalLine(notice.type, notice.message))
        }
        this.patchState({ terminalLines: nextLines })
        return outcome
      }
      case "reject": {
        const notice = getBrowserSlashCommandTerminalNotice(outcome)
        let nextLines = withTerminalLine(this.state.terminalLines, createTerminalLine("input", trimmed))
        if (notice) {
          nextLines = withTerminalLine(nextLines, createTerminalLine(notice.type, notice.message))
        }
        this.patchState({ terminalLines: nextLines })
        return outcome
      }
      case "view-navigate": {
        this.patchState({
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine("system", `Navigating to ${outcome.view} view`),
          ),
        })
        window.dispatchEvent(
          new CustomEvent("gsd:navigate-view", { detail: { view: outcome.view } }),
        )
        return outcome
      }
    }
  }

  refreshBoot = async (options: { soft?: boolean } = {}): Promise<void> => {
    if (this.bootPromise) return await this.bootPromise

    this.lastBootRefreshAt = Date.now()
    const softRefresh = Boolean(options.soft && this.state.boot)

    this.bootPromise = (async () => {
      if (!softRefresh) {
        this.patchState({
          bootStatus: "loading",
          connectionState: this.state.connectionState === "connected" ? "connected" : "connecting",
          lastClientError: null,
        })
      } else {
        this.patchState({
          lastClientError: null,
        })
      }

      try {
        const response = await authFetch(this.buildUrl("/api/boot"), {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
          },
        })

        if (!response.ok) {
          if (response.status === 401) {
            this.patchState({
              bootStatus: "unauthenticated",
              connectionState: "error",
            })
            return
          }
          throw new Error(`Boot request failed with ${response.status}`)
        }

        const bootPayload = (await response.json()) as WorkspaceBootPayload
        const boot = cloneBootWithBridge(bootPayload, bootPayload.bridge) ?? bootPayload
        const live = applyBootToLiveState(this.state.live, boot, { soft: softRefresh })
        this.lastBridgeDigest = null
        this.lastBridgeDigest = [boot.bridge.phase, boot.bridge.activeSessionId, boot.bridge.lastError?.at, boot.bridge.lastError?.message].join("::")
        this.patchState({
          bootStatus: "ready",
          boot,
          live,
          connectionState: boot.onboarding.locked
            ? "idle"
            : this.eventStream.isOpen()
              ? this.state.connectionState
              : "connecting",
          lastBridgeError: boot.bridge.lastError,
          sessionAttached: hasAttachedSession(boot.bridge),
          lastClientError: null,
          ...(softRefresh ? {} : { terminalLines: bootSeedLines(boot) }),
        })
        if (boot.onboarding.locked) {
          this.closeEventStream()
        } else {
          this.ensureEventStream()
        }
      } catch (error) {
        const message = normalizeClientError(error)
        if (softRefresh) {
          this.patchState({
            lastClientError: message,
            terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Workspace refresh failed — ${message}`)),
          })
          return
        }

        this.patchState({
          bootStatus: "error",
          connectionState: "error",
          lastClientError: message,
          terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Boot failed — ${message}`)),
        })
      }
    })().finally(() => {
      this.bootPromise = null
    })

    await this.bootPromise
  }

  private async refreshBootAfterCurrentSettles(options: { soft?: boolean } = {}): Promise<void> {
    if (this.bootPromise) {
      try {
        await this.bootPromise
      } catch {
        // Preserve the original boot failure surface, then issue a fresh refresh.
      }
    }

    await this.refreshBoot(options)
  }

  private invalidateLiveFreshness(
    domains: LiveStateInvalidationDomain[],
    reason: LiveStateInvalidationReason,
    source: LiveStateInvalidationSource,
  ): WorkspaceLiveState {
    const nextLive: WorkspaceLiveState = {
      ...this.state.live,
      freshness: { ...this.state.live.freshness },
    }

    if (domains.includes("auto")) {
      nextLive.auto = withEntitySliceInvalidated(nextLive.auto, reason, source)
    }
    if (domains.includes("workspace")) {
      nextLive.workspace = withEntitySliceInvalidated(nextLive.workspace, reason, source)
      nextLive.freshness.gitSummary = withFreshnessInvalidated(nextLive.freshness.gitSummary, reason, source)
    }
    if (domains.includes("recovery")) {
      nextLive.freshness.recovery = withFreshnessInvalidated(nextLive.freshness.recovery, reason, source)
      nextLive.freshness.sessionStats = withFreshnessInvalidated(nextLive.freshness.sessionStats, reason, source)
    }
    if (domains.includes("resumable_sessions")) {
      nextLive.resumableSessions = withEntitySliceInvalidated(nextLive.resumableSessions, reason, source)
      nextLive.freshness.sessionBrowser = withFreshnessInvalidated(nextLive.freshness.sessionBrowser, reason, source)
      nextLive.freshness.sessionStats = withFreshnessInvalidated(nextLive.freshness.sessionStats, reason, source)
    }

    return {
      ...nextLive,
      recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
    }
  }

  private refreshOpenCommandSurfacesForInvalidation(event: LiveStateInvalidationEvent): void {
    refreshOpenCommandSurfacesForInvalidation(
      {
        getState: () => this.state,
        patchState: (patch) => this.patchState(patch),
        buildUrl: (path) => this.buildUrl(path),
        sendCommand: (command, options) => this.sendCommand(command, options),
        refreshBoot: (options) => this.refreshBoot(options),
        refreshOnboarding: () => this.refreshOnboarding(),
        logoutProvider: (providerId) => this.logoutProvider(providerId),
        saveApiKey: (providerId, apiKey) => this.saveApiKey(providerId, apiKey),
        startProviderFlow: (providerId) => this.startProviderFlow(providerId),
        submitProviderFlowInput: (flowId, input) => this.submitProviderFlowInput(flowId, input),
        cancelProviderFlow: (flowId) => this.cancelProviderFlow(flowId),
      },
      this.commandSurfaceActions,
      event,
    )
  }

  private async reloadLiveState(
    domains: LiveStateInvalidationDomain[],
    reason: LiveStateInvalidationReason,
  ): Promise<void> {
    const requestedDomains = domains.filter((domain) => domain === "auto" || domain === "workspace" || domain === "resumable_sessions")

    if (requestedDomains.length === 0) {
      if (domains.includes("recovery")) {
        await this.refreshBoot({ soft: true })
        return
      }

      const nextLive = {
        ...this.state.live,
        freshness: {
          ...this.state.live.freshness,
          recovery: withFreshnessSucceeded(this.state.live.freshness.recovery),
        },
      }
      this.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: nextLive }),
        },
      })
      return
    }

    const nextFreshness = { ...this.state.live.freshness }
    let nextAuto = this.state.live.auto
    let nextWorkspace = this.state.live.workspace
    let nextResumableSessions = this.state.live.resumableSessions

    if (requestedDomains.includes("auto")) {
      nextAuto = withEntitySliceRequested(nextAuto)
    }
    if (requestedDomains.includes("workspace")) {
      nextWorkspace = withEntitySliceRequested(nextWorkspace)
    }
    if (requestedDomains.includes("resumable_sessions")) {
      nextResumableSessions = withEntitySliceRequested(nextResumableSessions)
    }
    nextFreshness.recovery = withFreshnessRequested(nextFreshness.recovery)

    const requestedLive: WorkspaceLiveState = {
      ...this.state.live,
      auto: nextAuto,
      workspace: nextWorkspace,
      resumableSessions: nextResumableSessions,
      freshness: nextFreshness,
      targetedRefreshCount: this.state.live.targetedRefreshCount + 1,
    }
    this.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: requestedLive }),
      },
    })

    const params = new URLSearchParams()
    for (const domain of requestedDomains) {
      params.append("domain", domain)
    }

    try {
      const response = await authFetch(this.buildUrl(`/api/live-state?${params.toString()}`), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
      const payload = await response.json().catch(() => null) as {
        auto?: AutoDashboardData
        workspace?: WorkspaceIndex
        resumableSessions?: BootResumableSession[]
        error?: string
      } | null

      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? `Live state request failed with ${response.status}`)
      }

      let nextBoot = this.state.boot
      const nextLive: WorkspaceLiveState = {
        ...this.state.live,
        freshness: { ...this.state.live.freshness },
      }

      if (requestedDomains.includes("auto") && payload.auto) {
        nextLive.auto = withEntitySliceSucceeded(nextLive.auto, payload.auto)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              auto: payload.auto,
            }
          : nextBoot
      }

      if (requestedDomains.includes("workspace") && payload.workspace) {
        nextLive.workspace = withEntitySliceSucceeded(nextLive.workspace, payload.workspace)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              workspace: payload.workspace,
            }
          : nextBoot
      }

      if (requestedDomains.includes("resumable_sessions") && payload.resumableSessions) {
        const nextSessions = overlayLiveBridgeSessionState(payload.resumableSessions, nextBoot)
        nextLive.resumableSessions = withEntitySliceSucceeded(nextLive.resumableSessions, nextSessions)
        nextBoot = nextBoot
          ? {
              ...nextBoot,
              resumableSessions: nextSessions,
            }
          : nextBoot
      }

      nextLive.freshness.recovery = withFreshnessSucceeded(nextLive.freshness.recovery)
      nextLive.recoverySummary = createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLive })
      this.patchState({
        ...(nextBoot ? { boot: nextBoot } : {}),
        live: nextLive,
      })
    } catch (error) {
      const message = normalizeClientError(error)
      const failedLive: WorkspaceLiveState = {
        ...this.state.live,
        auto: requestedDomains.includes("auto")
          ? withEntitySliceFailed(this.state.live.auto, message)
          : this.state.live.auto,
        workspace: requestedDomains.includes("workspace")
          ? withEntitySliceFailed(this.state.live.workspace, message)
          : this.state.live.workspace,
        resumableSessions: requestedDomains.includes("resumable_sessions")
          ? withEntitySliceFailed(this.state.live.resumableSessions, message)
          : this.state.live.resumableSessions,
        freshness: {
          ...this.state.live.freshness,
          recovery: withFreshnessFailed(this.state.live.freshness.recovery, message),
        },
      }

      this.patchState({
        lastClientError: message,
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.state.boot, live: failedLive }),
        },
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Live refresh failed (${reason}) — ${message}`)),
      })
    }
  }

  private handleLiveStateInvalidation(event: LiveStateInvalidationEvent): void {
    this.patchState({
      live: this.invalidateLiveFreshness(event.domains, event.reason, event.source),
      commandSurface: event.domains.includes("recovery")
        ? {
            ...this.state.commandSurface,
            recovery: markRecoveryStateInvalidated(this.state.commandSurface.recovery),
          }
        : this.state.commandSurface,
    })
    this.refreshOpenCommandSurfacesForInvalidation(event)
    void this.reloadLiveState(event.domains, event.reason)
  }

  refreshOnboarding = async (): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "refreshing",
      onboardingRequestProviderId: null,
      lastClientError: null,
    })

    try {
      return await this.fetchOnboardingState()
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Onboarding refresh failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  saveApiKey = async (providerId: string, apiKey: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "saving_api_key",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "save_api_key",
        providerId,
        apiKey,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Credential setup failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  startProviderFlow = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "starting_provider_flow",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "start_provider_flow",
        providerId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in failed to start — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  submitProviderFlowInput = async (flowId: string, input: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "submitting_provider_flow_input",
      onboardingRequestProviderId: this.state.boot?.onboarding.activeFlow?.providerId ?? null,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "continue_provider_flow",
        flowId,
        input,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in input failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  cancelProviderFlow = async (flowId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "cancelling_provider_flow",
      onboardingRequestProviderId: this.state.boot?.onboarding.activeFlow?.providerId ?? null,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "cancel_provider_flow",
        flowId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider sign-in cancellation failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  logoutProvider = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    this.patchState({
      onboardingRequestState: "logging_out_provider",
      onboardingRequestProviderId: providerId,
      lastClientError: null,
    })

    try {
      const onboarding = await this.postOnboardingAction({
        action: "logout_provider",
        providerId,
      })
      await this.syncAfterOnboardingMutation(onboarding)
      return onboarding
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Provider logout failed — ${message}`)),
      })
      return null
    } finally {
      this.patchState({
        onboardingRequestState: "idle",
        onboardingRequestProviderId: null,
      })
    }
  }

  sendCommand = async (
    command: WorkspaceBridgeCommand,
    options: { displayInput?: string; appendInputLine?: boolean; appendResponseLine?: boolean } = {},
  ): Promise<WorkspaceCommandResponse | null> => {
    this.clearCommandTimeout()

    const nextPatch: Partial<WorkspaceStoreState> = {
      commandInFlight: command.type,
    }

    if (options.appendInputLine !== false) {
      nextPatch.terminalLines = withTerminalLine(
        this.state.terminalLines,
        createTerminalLine("input", options.displayInput ?? getCommandInputLabel(command)),
      )
    }

    this.patchState(nextPatch)

    this.commandTimeoutTimer = setTimeout(() => {
      if (this.state.commandInFlight) {
        this.patchState({
          commandInFlight: null,
          lastClientError: "Command timed out — controls re-enabled",
          terminalLines: withTerminalLine(
            this.state.terminalLines,
            createTerminalLine("error", "Command timed out — controls re-enabled"),
          ),
        })
      }
    }, COMMAND_TIMEOUT_MS)

    try {
      const response = await authFetch(this.buildUrl("/api/session/command"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(command),
      })

      const payload = (await response.json()) as WorkspaceCommandResponse | { ok: true }
      if ("ok" in payload) {
        return null
      }

      if (payload.command === "get_state" && payload.success && this.state.boot) {
        const nextBridge = {
          ...this.state.boot.bridge,
          sessionState: payload.data as WorkspaceSessionState,
          activeSessionId: (payload.data as WorkspaceSessionState).sessionId,
          activeSessionFile: (payload.data as WorkspaceSessionState).sessionFile ?? this.state.boot.bridge.activeSessionFile,
          lastCommandType: "get_state",
          updatedAt: new Date().toISOString(),
        }

        this.patchState({
          boot: cloneBootWithBridge(this.state.boot, nextBridge),
          lastBridgeError: nextBridge.lastError,
          sessionAttached: hasAttachedSession(nextBridge),
        })
      }

      // Reset contextual tips on new session
      if (payload.command === "new_session" && payload.success) {
        this.contextualTips.reset()
      }

      if (payload.code === "onboarding_locked" && payload.details?.onboarding && this.state.boot) {
        this.patchState({
          boot: cloneBootWithPartialOnboarding(this.state.boot, payload.details.onboarding),
        })
      }

      this.patchState({
        ...(options.appendResponseLine === false
          ? {}
          : { terminalLines: withTerminalLine(this.state.terminalLines, responseToLine(payload)) }),
        lastBridgeError: payload.success ? this.state.lastBridgeError : this.state.boot?.bridge.lastError ?? this.state.lastBridgeError,
      })
      return payload
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchState({
        lastClientError: message,
        terminalLines: withTerminalLine(
          this.state.terminalLines,
          createTerminalLine("error", `Command failed (${command.type}) — ${message}`),
        ),
      })
      return {
        type: "response",
        command: command.type,
        success: false,
        error: message,
      }
    } finally {
      this.clearCommandTimeout()
      this.patchState({ commandInFlight: null })
    }
  }

  private clearCommandTimeout(): void {
    if (this.commandTimeoutTimer) {
      clearTimeout(this.commandTimeoutTimer)
      this.commandTimeoutTimer = null
    }
  }

  private async fetchOnboardingState(silent = false): Promise<WorkspaceOnboardingState> {
    const previousFlowStatus = this.state.boot?.onboarding.activeFlow?.status ?? null
    const response = await authFetch(this.buildUrl("/api/onboarding"), {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
    const payload = (await response.json()) as OnboardingApiPayload
    if (!response.ok || !payload.onboarding) {
      throw new Error(payload.error ?? `Onboarding request failed with ${response.status}`)
    }

    this.applyOnboardingState(payload.onboarding)

    if (
      previousFlowStatus &&
      ACTIVE_ONBOARDING_FLOW_STATUSES.has(previousFlowStatus) &&
      payload.onboarding.activeFlow &&
      TERMINAL_ONBOARDING_FLOW_STATUSES.has(payload.onboarding.activeFlow.status)
    ) {
      await this.syncAfterOnboardingMutation(payload.onboarding)
    } else if (!silent) {
      this.appendOnboardingSummaryLine(payload.onboarding)
    }

    return payload.onboarding
  }

  private async postOnboardingAction(body: Record<string, unknown>): Promise<WorkspaceOnboardingState> {
    const response = await authFetch(this.buildUrl("/api/onboarding"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    })

    const payload = (await response.json()) as OnboardingApiPayload
    if (!response.ok) {
      if (payload.onboarding) {
        this.applyOnboardingState(payload.onboarding)
      }
      throw new Error(payload.error ?? `Onboarding action failed with ${response.status}`)
    }

    if (!payload.onboarding) {
      throw new Error(`Onboarding action returned no state (${response.status})`)
    }

    this.applyOnboardingState(payload.onboarding)
    return payload.onboarding
  }

  private applyOnboardingState(onboarding: WorkspaceOnboardingState): void {
    if (!this.state.boot) return
    this.patchState({
      boot: cloneBootWithOnboarding(this.state.boot, onboarding),
    })
  }

  private async syncAfterOnboardingMutation(onboarding: WorkspaceOnboardingState): Promise<void> {
    this.applyOnboardingState(onboarding)
    this.appendOnboardingSummaryLine(onboarding)

    if (onboarding.lastValidation?.status === "succeeded" || onboarding.bridgeAuthRefresh.phase !== "idle") {
      void this.refreshBootAfterCurrentSettles({ soft: true })
    }
  }

  private appendOnboardingSummaryLine(onboarding: WorkspaceOnboardingState): void {
    const summary = summarizeOnboardingState(onboarding)
    if (!summary) return

    const lastLine = this.state.terminalLines.at(-1)
    if (lastLine?.type === summary.type && lastLine.content === summary.message) {
      return
    }

    this.patchState({
      terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine(summary.type, summary.message)),
    })
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private scheduleEmit(): void {
    if (this.emitScheduled || this.listeners.size === 0) return
    this.emitScheduled = true

    if (typeof requestAnimationFrame === "function") {
      this.emitFrame = requestAnimationFrame(this.flushEmit)
      return
    }

    this.emitTimer = setTimeout(this.flushEmit, 0)
  }

  private flushEmit = (): void => {
    this.emitScheduled = false
    this.emitFrame = null
    this.emitTimer = null
    if (this.disposed) return
    this.emit()
  }

  private cancelScheduledEmit(): void {
    if (!this.emitScheduled) return
    if (this.emitFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.emitFrame)
    }
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer)
    }
    this.emitScheduled = false
    this.emitFrame = null
    this.emitTimer = null
  }

  private patchTranscript(updater: (transcript: ReturnType<typeof pickTranscriptState>) => ReturnType<typeof pickTranscriptState>): void {
    const next = updater(pickTranscriptState(this.state))
    this.patchState({
      completedTurns: next.completedTurns,
      pendingUserMessage: next.pendingUserMessage,
      currentTurnSegments: next.currentTurnSegments,
      streamingAssistantText: next.streamingAssistantText,
      streamingThinkingText: next.streamingThinkingText,
    })
  }

  private patchState(patch: Partial<WorkspaceStoreState>): void {
    this.state = { ...this.state, ...patch }
    this.syncOnboardingPoller()
    this.scheduleEmit()
  }

  private syncOnboardingPoller(): void {
    if (this.disposed) {
      this.stopOnboardingPoller()
      return
    }

    const flowStatus = this.state.boot?.onboarding.activeFlow?.status
    const shouldPoll = Boolean(flowStatus && ACTIVE_ONBOARDING_FLOW_STATUSES.has(flowStatus))
    if (shouldPoll && !this.onboardingPollTimer) {
      this.onboardingPollTimer = setInterval(() => {
        if (this.state.onboardingRequestState !== "idle") return
        void this.fetchOnboardingState(true).catch((error) => {
          const message = normalizeClientError(error)
          this.patchState({
            lastClientError: message,
          })
        })
      }, 1500)
      return
    }

    if (!shouldPoll) {
      this.stopOnboardingPoller()
    }
  }

  private stopOnboardingPoller(): void {
    if (!this.onboardingPollTimer) return
    clearInterval(this.onboardingPollTimer)
    this.onboardingPollTimer = null
  }

  private ensureEventStream(): void {
    this.eventStream.ensure()
  }

  private closeEventStream(): void {
    this.eventStream.close()
  }

  private handleEventStreamOpen(wasDisconnected: boolean): void {
    if (wasDisconnected) {
      this.patchState({
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("success", "Live event stream reconnected")),
      })
    }
    this.patchState({ connectionState: "connected", lastClientError: null })
    if (wasDisconnected) {
      void this.refreshBoot({ soft: true })
    }
  }

  private handleEventStreamMessage(data: string): void {
    try {
      const parsed: unknown = JSON.parse(data)
      if (!isWorkspaceEvent(parsed)) {
        this.patchState({
          lastClientError: "Malformed event received from stream",
          terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", "Malformed event received from stream")),
        })
        return
      }
      this.handleEvent(parsed)
    } catch (error) {
      const text = normalizeClientError(error)
      this.patchState({
        lastClientError: text,
        terminalLines: withTerminalLine(this.state.terminalLines, createTerminalLine("error", `Failed to parse stream event — ${text}`)),
      })
    }
  }

  private handleEventStreamError(
    nextConnectionState: Extract<WorkspaceConnectionState, "reconnecting" | "error">,
    changed: boolean,
  ): void {
    if (changed) {
      this.patchState({
        connectionState: nextConnectionState,
        terminalLines: withTerminalLine(
          this.state.terminalLines,
          createTerminalLine(
            nextConnectionState === "reconnecting" ? "system" : "error",
            nextConnectionState === "reconnecting"
              ? "Live event stream disconnected — retrying…"
              : "Live event stream failed before connection was established",
          ),
        ),
      })
      return
    }

    this.patchState({ connectionState: nextConnectionState })
  }

  private handleEvent(event: WorkspaceEvent): void {
    dispatchWorkspaceEvent(
      event,
      {
        onLastEventType: (type) => this.patchState({ lastEventType: type }),
        onBridgeStatus: (bridgeEvent) => this.recordBridgeStatus(bridgeEvent.bridge),
        onLiveStateInvalidation: (invalidation) => this.handleLiveStateInvalidation(invalidation),
        onLiveInteraction: (liveEvent) => this.routeLiveInteractionEvent(liveEvent),
        onTerminalSummary: (summary) => {
          this.patchState({
            terminalLines: withTerminalLine(
              this.state.terminalLines,
              createTerminalLine(summary.type as TerminalLineType, summary.message),
            ),
          })
        },
      },
      summarizeEvent,
    )
  }

  private routeLiveInteractionEvent(event: WorkspaceEvent): void {
    if (event.type === "extension_ui_snapshot") {
      this.handleExtensionUiSnapshot(event.snapshot)
      return
    }
    routeLiveInteractionEvent(event, {
      onExtensionUiRequest: (uiEvent) => this.handleExtensionUiRequest(uiEvent),
      onMessageUpdate: (messageEvent) => this.handleMessageUpdate(messageEvent),
      onTurnBoundary: () => this.handleTurnBoundary(),
      onToolExecutionStart: (toolEvent) => this.handleToolExecutionStart(toolEvent),
      onToolExecutionUpdate: (toolEvent) => this.handleToolExecutionUpdate(toolEvent),
      onToolExecutionEnd: (toolEvent) => this.handleToolExecutionEnd(toolEvent),
    })
  }

  private handleExtensionUiSnapshot(snapshot: ExtensionUiSnapshot): void {
    const fields = applyExtensionUiSnapshotToWebFields(
      {
        statusTexts: this.state.statusTexts,
        widgetContents: this.state.widgetContents,
        titleOverride: this.state.titleOverride,
        editorTextBuffer: this.state.editorTextBuffer,
        workingMessage: this.state.workingMessage,
      },
      snapshot,
    )
    this.patchState({
      statusTexts: fields.statusTexts,
      widgetContents: fields.widgetContents,
      titleOverride: fields.titleOverride,
      editorTextBuffer: fields.editorTextBuffer,
      workingMessage: fields.workingMessage ?? null,
    })
  }

  getExtensionUiSnapshot(): ExtensionUiSnapshot {
    return extensionUiSnapshotFromWebFields({
      statusTexts: this.state.statusTexts,
      widgetContents: this.state.widgetContents,
      titleOverride: this.state.titleOverride,
      editorTextBuffer: this.state.editorTextBuffer,
      workingMessage: this.state.workingMessage,
    })
  }

  private handleExtensionUiRequest(event: ExtensionUiRequestEvent): void {
    const method = event.method
    switch (method) {
      // Blocking methods → queue in pendingUiRequests
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.patchState({
          pendingUiRequests: [...this.state.pendingUiRequests, event as PendingUiRequest],
        })
        break
      // Fire-and-forget methods → update state maps
      case "notify":
        // notify still produces a terminal line (via summarizeEvent), but we don't store it in pendingUiRequests
        break
      case "setStatus":
        if (event.method === "setStatus") {
          const next = { ...this.state.statusTexts }
          if (event.statusText === undefined) {
            delete next[event.statusKey]
          } else {
            next[event.statusKey] = event.statusText
          }
          this.patchState({ statusTexts: next })
        }
        break
      case "setWidget":
        if (event.method === "setWidget") {
          const next = { ...this.state.widgetContents }
          if (event.widgetLines === undefined) {
            delete next[event.widgetKey]
          } else {
            next[event.widgetKey] = { lines: event.widgetLines, placement: event.widgetPlacement }
          }
          this.patchState({ widgetContents: next })
        }
        break
      case "setTitle":
        if (event.method === "setTitle") {
          const nextTitle = event.title.trim()
          this.patchState({ titleOverride: nextTitle ? nextTitle : null })
        }
        break
      case "set_editor_text":
        if (event.method === "set_editor_text") {
          this.patchState({ editorTextBuffer: event.text })
        }
        break
    }
  }

  private handleMessageUpdate(event: MessageUpdateEvent): void {
    const assistantEvent = event.assistantMessageEvent
    if (!assistantEvent) return
    if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
      this.patchTranscript((transcript) => applyTextDelta(transcript, assistantEvent.delta as string))
    } else if (assistantEvent.type === "thinking_delta" && typeof assistantEvent.delta === "string") {
      this.patchTranscript((transcript) => applyThinkingDelta(transcript, assistantEvent.delta as string))
    } else if (assistantEvent.type === "thinking_end") {
      this.patchTranscript((transcript) => finalizeThinkingStream(transcript))
    }
  }

  private handleTurnBoundary(): void {
    this.patchTranscript((transcript) => completeTurn(transcript))
    this.patchState({ completedToolExecutions: [] })
  }

  private handleToolExecutionStart(event: ToolExecutionStartEvent): void {
    this.patchState({
      activeToolExecution: {
        id: event.toolCallId,
        name: event.toolName,
        args: (event as Record<string, unknown>).args as Record<string, unknown> | undefined,
      },
      // Treat pre-tool streaming text as ephemeral. Claude Code can emit
      // provisional assistant text before a tool call, then replace it with
      // the real final text after the tool completes. If we finalize that
      // interim text here, the chat timeline shows stale text above the tool.
      streamingAssistantText: "",
      streamingThinkingText: "",
    })
  }

  private handleToolExecutionUpdate(event: ToolExecutionUpdateEvent): void {
    const active = this.state.activeToolExecution
    if (!active || active.id !== event.toolCallId) return
    this.patchState({
      activeToolExecution: {
        ...active,
        result: event.partialResult
          ? {
              content: event.partialResult.content,
              details: event.partialResult.details,
              isError: Boolean(event.partialResult.isError),
            }
          : active.result,
      },
    })
  }

  private handleToolExecutionEnd(event: ToolExecutionEndEvent): void {
    const active = this.state.activeToolExecution
    if (active) {
      const completed: CompletedToolExecution = {
        id: active.id,
        name: active.name,
        args: active.args ?? {},
        result: {
          content: ((event as Record<string, unknown>).result as NonNullable<CompletedToolExecution["result"]> | undefined)?.content,
          details: ((event as Record<string, unknown>).result as NonNullable<CompletedToolExecution["result"]> | undefined)?.details,
          isError: event.isError,
        },
      }
      const next = [...this.state.completedToolExecutions, completed]
      this.patchState({
        activeToolExecution: null,
        completedToolExecutions: next.length > 50 ? next.slice(next.length - 50) : next,
      })
      this.patchTranscript((transcript) => appendToolSegment(transcript, completed))
    } else {
      this.patchState({ activeToolExecution: null })
    }
  }

  private recordBridgeStatus(bridge: BridgeRuntimeSnapshot): void {
    const digest = [bridge.phase, bridge.activeSessionId, bridge.lastError?.at, bridge.lastError?.message].join("::")
    const shouldEmitLine = digest !== this.lastBridgeDigest
    this.lastBridgeDigest = digest

    const nextBoot = cloneBootWithBridge(this.state.boot, bridge)
    const nextSessions = overlayLiveBridgeSessionState(resolveResumableSessions(this.state), nextBoot)
    const nextLiveBase: WorkspaceLiveState = {
      ...this.state.live,
      resumableSessions: withEntitySliceSucceeded(this.state.live.resumableSessions, nextSessions),
    }
    const nextLive = {
      ...nextLiveBase,
      recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
    }

    const nextPatch: Partial<WorkspaceStoreState> = {
      boot: nextBoot,
      live: nextLive,
      lastBridgeError: bridge.lastError,
      sessionAttached: hasAttachedSession(bridge),
      commandSurface: {
        ...this.state.commandSurface,
        sessionBrowser: syncSessionBrowserStateWithBridge(this.state.commandSurface.sessionBrowser, nextBoot),
      },
    }

    if (shouldEmitLine) {
      const summary = summarizeBridgeStatus(bridge)
      nextPatch.terminalLines = withTerminalLine(this.state.terminalLines, createTerminalLine(summary.type, summary.message))
    }

    this.patchState(nextPatch)
  }
}

const WorkspaceStoreContext = createContext<GSDWorkspaceStore | null>(null)

export function GSDWorkspaceProvider({ children, store: externalStore }: { children: ReactNode; store?: GSDWorkspaceStore }) {
  const [internalStore] = useState(() => new GSDWorkspaceStore())
  const store = externalStore ?? internalStore

  useEffect(() => {
    // Only start/dispose if using internal store (not externally managed)
    if (!externalStore) {
      store.start()
      return () => store.dispose()
    }
  }, [store, externalStore])

  return <WorkspaceStoreContext.Provider value={store}>{children}</WorkspaceStoreContext.Provider>
}

function useWorkspaceStore(): GSDWorkspaceStore {
  const store = useContext(WorkspaceStoreContext)
  if (!store) {
    throw new Error("useWorkspaceStore must be used within GSDWorkspaceProvider")
  }
  return store
}

export function useGSDWorkspaceState(): WorkspaceStoreState {
  const store = useWorkspaceStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useGSDWorkspaceActions(): Pick<
  GSDWorkspaceStore,
  | "sendCommand"
  | "submitInput"
  | "clearTerminalLines"
  | "consumeEditorTextBuffer"
  | "refreshBoot"
  | "refreshOnboarding"
  | "openCommandSurface"
  | "closeCommandSurface"
  | "setCommandSurfaceSection"
  | "selectCommandSurfaceTarget"
  | "loadGitSummary"
  | "loadRecoveryDiagnostics"
  | "loadForensicsDiagnostics"
  | "loadDoctorDiagnostics"
  | "applyDoctorFixes"
  | "loadSkillHealthDiagnostics"
  | "loadKnowledgeData"
  | "loadCapturesData"
  | "loadSettingsData"
  | "loadHistoryData"
  | "loadInspectData"
  | "loadHooksData"
  | "loadExportData"
  | "loadUndoInfo"
  | "loadCleanupData"
  | "loadSteerData"
  | "executeUndoAction"
  | "executeCleanupAction"
  | "resolveCaptureAction"
  | "updateSessionBrowserState"
  | "loadSessionBrowser"
  | "renameSessionFromSurface"
  | "loadAvailableModels"
  | "applyModelSelection"
  | "applyThinkingLevel"
  | "setSteeringModeFromSurface"
  | "setFollowUpModeFromSurface"
  | "setAutoCompactionFromSurface"
  | "setAutoRetryFromSurface"
  | "abortRetryFromSurface"
  | "switchSessionFromSurface"
  | "loadSessionStats"
  | "exportSessionFromSurface"
  | "loadForkMessages"
  | "forkSessionFromSurface"
  | "compactSessionFromSurface"
  | "saveApiKey"
  | "saveApiKeyFromSurface"
  | "startProviderFlow"
  | "startProviderFlowFromSurface"
  | "submitProviderFlowInput"
  | "submitProviderFlowInputFromSurface"
  | "cancelProviderFlow"
  | "cancelProviderFlowFromSurface"
  | "logoutProvider"
  | "logoutProviderFromSurface"
  | "respondToUiRequest"
  | "dismissUiRequest"
  | "sendSteer"
  | "sendAbort"
  | "pushChatUserMessage"
> {
  const store = useWorkspaceStore()
  return {
    sendCommand: store.sendCommand,
    submitInput: store.submitInput,
    clearTerminalLines: store.clearTerminalLines,
    consumeEditorTextBuffer: store.consumeEditorTextBuffer,
    refreshBoot: store.refreshBoot,
    refreshOnboarding: store.refreshOnboarding,
    openCommandSurface: store.openCommandSurface,
    closeCommandSurface: store.closeCommandSurface,
    setCommandSurfaceSection: store.setCommandSurfaceSection,
    selectCommandSurfaceTarget: store.selectCommandSurfaceTarget,
    loadGitSummary: store.loadGitSummary,
    loadRecoveryDiagnostics: store.loadRecoveryDiagnostics,
    loadForensicsDiagnostics: store.loadForensicsDiagnostics,
    loadDoctorDiagnostics: store.loadDoctorDiagnostics,
    applyDoctorFixes: store.applyDoctorFixes,
    loadSkillHealthDiagnostics: store.loadSkillHealthDiagnostics,
    loadKnowledgeData: store.loadKnowledgeData,
    loadCapturesData: store.loadCapturesData,
    loadSettingsData: store.loadSettingsData,
    loadHistoryData: store.loadHistoryData,
    loadInspectData: store.loadInspectData,
    loadHooksData: store.loadHooksData,
    loadExportData: store.loadExportData,
    loadUndoInfo: store.loadUndoInfo,
    loadCleanupData: store.loadCleanupData,
    loadSteerData: store.loadSteerData,
    executeUndoAction: store.executeUndoAction,
    executeCleanupAction: store.executeCleanupAction,
    resolveCaptureAction: store.resolveCaptureAction,
    updateSessionBrowserState: store.updateSessionBrowserState,
    loadSessionBrowser: store.loadSessionBrowser,
    renameSessionFromSurface: store.renameSessionFromSurface,
    loadAvailableModels: store.loadAvailableModels,
    applyModelSelection: store.applyModelSelection,
    applyThinkingLevel: store.applyThinkingLevel,
    setSteeringModeFromSurface: store.setSteeringModeFromSurface,
    setFollowUpModeFromSurface: store.setFollowUpModeFromSurface,
    setAutoCompactionFromSurface: store.setAutoCompactionFromSurface,
    setAutoRetryFromSurface: store.setAutoRetryFromSurface,
    abortRetryFromSurface: store.abortRetryFromSurface,
    switchSessionFromSurface: store.switchSessionFromSurface,
    loadSessionStats: store.loadSessionStats,
    exportSessionFromSurface: store.exportSessionFromSurface,
    loadForkMessages: store.loadForkMessages,
    forkSessionFromSurface: store.forkSessionFromSurface,
    compactSessionFromSurface: store.compactSessionFromSurface,
    saveApiKey: store.saveApiKey,
    saveApiKeyFromSurface: store.saveApiKeyFromSurface,
    startProviderFlow: store.startProviderFlow,
    startProviderFlowFromSurface: store.startProviderFlowFromSurface,
    submitProviderFlowInput: store.submitProviderFlowInput,
    submitProviderFlowInputFromSurface: store.submitProviderFlowInputFromSurface,
    cancelProviderFlow: store.cancelProviderFlow,
    cancelProviderFlowFromSurface: store.cancelProviderFlowFromSurface,
    logoutProvider: store.logoutProvider,
    logoutProviderFromSurface: store.logoutProviderFromSurface,
    respondToUiRequest: store.respondToUiRequest,
    dismissUiRequest: store.dismissUiRequest,
    sendSteer: store.sendSteer,
    sendAbort: store.sendAbort,
    pushChatUserMessage: store.pushChatUserMessage,
  }
}

export function buildPromptCommand(
  input: string,
  bridge: BridgeRuntimeSnapshot | null | undefined,
): WorkspaceBridgeCommand {
  const outcome = dispatchBrowserSlashCommand(input, {
    isStreaming: bridge?.sessionState?.isStreaming,
  })

  if (outcome.kind === "prompt" || outcome.kind === "rpc") {
    return outcome.command
  }

  throw new Error(
    `buildPromptCommand cannot serialize ${outcome.input || input} because browser dispatch resolved it to ${outcome.kind}; use submitInput() instead.`,
  )
}
