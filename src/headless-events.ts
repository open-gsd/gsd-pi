/**
 * Headless Event Detection — notification classification and command detection
 *
 * Detects terminal notifications, blocked notifications, milestone-ready signals,
 * and classifies commands as quick (single-turn) vs long-running.
 *
 * Also defines exit code constants and the status→exit-code mapping function.
 *
 * The stop/pause notice vocabulary itself (prefixes + message classifiers)
 * lives in the Stop Notice module — the same module the emitters format with,
 * so wording stays in lockstep with detection.
 */

import {
  isBlockedNoticeMessage,
  isInteractiveMenuUnavailableNotice,
  isManualResolutionNotice,
  isPauseNotice,
  isTerminalNotice,
} from './resources/extensions/gsd/stop-notice.js'
import { canonicalToolName } from './resources/extensions/gsd/engine-hook-contract.js'

// ---------------------------------------------------------------------------
// Exit Code Constants
// ---------------------------------------------------------------------------

export const EXIT_SUCCESS = 0
export const EXIT_ERROR = 1
export const EXIT_BLOCKED = 10
export const EXIT_CANCELLED = 11

/**
 * Map a headless session status string to its standardized exit code.
 *
 *   success   → 0
 *   complete  → 0
 *   completed → 0
 *   error     → 1
 *   timeout   → 1
 *   blocked   → 10
 *   paused    → 10
 *   cancelled → 11
 *
 * Unknown statuses default to EXIT_ERROR (1).
 */
export function mapStatusToExitCode(status: string): number {
  switch (status) {
    case 'success':
    case 'complete':
    case 'completed':
      return EXIT_SUCCESS
    case 'error':
    case 'timeout':
      return EXIT_ERROR
    case 'blocked':
    case 'paused':
      return EXIT_BLOCKED
    case 'cancelled':
      return EXIT_CANCELLED
    default:
      return EXIT_ERROR
  }
}

// ---------------------------------------------------------------------------
// Completion Detection
// ---------------------------------------------------------------------------

/**
 * Detect genuine auto-mode termination notifications.
 *
 * Matches the actual stop/pause signals emitted by stopAuto()/pauseAuto():
 *   "Auto-mode stopped..."
 *   "Step-mode stopped..."
 *   "Auto-mode paused..."
 *   "Step-mode paused..."
 * plus bootstrap-time manual-resolution failures that return before auto-mode
 * can emit a formal pause/stop notification, plus interactive menus that could
 * not render headlessly (a dead-end that returns without dispatching). (#1294)
 *
 * Does NOT match progress notifications that happen to contain words like
 * "complete" or "stopped" (e.g., "Override resolved — rewrite-docs completed",
 * "All slices are complete — nothing to discuss", "Skipped 5+ completed units").
 *
 * Blocked detection is separate — checked via isBlockedNotification.
 */
export const IDLE_TIMEOUT_MS = 15_000
// new-milestone is a long-running creative task where the LLM may pause
// between tool calls (e.g. after mkdir, before writing files). Use a
// longer idle timeout to avoid killing the session prematurely (#808).
export const NEW_MILESTONE_IDLE_TIMEOUT_MS = 120_000
const INTERACTIVE_HEADLESS_TOOLS = new Set(['ask_user_questions', 'secure_env_collect'])

// Delegates to the shared normalizer seam (engine-hook-contract.ts) instead of
// a hand-rolled parser. Behavior differs from the old parser only on malformed
// MCP names: `mcp____tool` (empty server) and `mcp__server__` (empty tool) are
// now returned unchanged rather than partially stripped — neither can match a
// real tool name, so detection behavior is unaffected.
export function canonicalHeadlessToolName(toolName: string | undefined): string {
  return canonicalToolName(String(toolName ?? ''))
}

function getCommandBlockContent(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_start' && event.type !== 'message_end') return null
  const message = event.message as Record<string, unknown> | undefined
  if (message?.customType !== 'gsd-command-block') return null
  return String(message.content ?? '').toLowerCase()
}

function isBlockingCommandBlock(event: Record<string, unknown>): boolean {
  const content = getCommandBlockContent(event)
  if (!content) return false

  return (
    (
      content.includes('cannot start new workflow work') &&
      content.includes('complete but not merged')
    ) ||
    content.includes('cannot run because the active milestone is blocked by validation')
  )
}

export function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (isOrchestratorPausedEvent(event)) return true
  if (isBlockingCommandBlock(event)) return true
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  const message = String(event.message ?? '').toLowerCase()
  // A menu that could not render headlessly is a terminal dead-end: the
  // extension already returned without dispatching, so nothing else will fire.
  // Resolve the run (as blocked, via isBlockedNotification) instead of idling
  // forever waiting for a completion signal. (#1294)
  return (
    isTerminalNotice(message) ||
    isPauseNotice(message) ||
    isManualResolutionNotice(message) ||
    isInteractiveMenuUnavailableNotice(message)
  )
}

export function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (isOrchestratorPausedEvent(event)) return true
  if (isBlockingCommandBlock(event)) return true
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  // Recoverable pauses need operator intervention in headless mode.
  return isBlockedNoticeMessage(String(event.message ?? '').toLowerCase())
}

function isOrchestratorPausedEvent(event: Record<string, unknown>): boolean {
  const data = event.data as Record<string, unknown> | undefined
  const eventType = String(event.eventType ?? '')
  const name = String(data?.name ?? '')
  const reason = String(data?.reason ?? '').toLowerCase()
  return (
    eventType === 'orchestrator-guard-block' && name === 'advance-paused'
  ) || (
    eventType === 'orchestrator-terminal' && name === 'stop' && reason === 'pause'
  )
}

export function isMilestoneReadyNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false
  return /milestone\s+m\d+.*ready/i.test(String(event.message ?? ''))
}

export function isInteractiveHeadlessTool(toolName: string | undefined): boolean {
  return INTERACTIVE_HEADLESS_TOOLS.has(canonicalHeadlessToolName(toolName))
}

/**
 * Decide whether to arm the headless idle-completion timer.
 *
 * Arms once at least one tool call has started (and no interactive tool —
 * ask_user_questions / secure_env_collect — is still awaiting a human answer),
 * so a multi-step command that pauses between tool calls still resolves.
 *
 * Also arms for *quick commands* that are handled entirely in the extension
 * layer (e.g. `/gsd status`, `/gsd history`, `/gsd help`). These never enter
 * the LLM agent loop, so they emit no `agent_end` / `execution_complete` and
 * make zero tool calls. Without this branch the idle timer never arms, the
 * completion promise never resolves, and the process exits with a spurious
 * "cancelled" (11) code once the event loop drains. See live-regression
 * scenario `headless status exits 0 on a seeded project`.
 */
export function shouldArmHeadlessIdleTimeout(
  toolCallCount: number,
  interactiveToolCount: number,
  isQuickCommand = false,
): boolean {
  if (interactiveToolCount > 0) return false
  return toolCallCount > 0 || isQuickCommand
}

export interface HeadlessTrackedEventLike {
  type: string
  detail?: string
}

export type HeadlessFinalStatus = 'complete' | 'blocked' | 'cancelled' | 'error' | 'timeout' | 'no-work-deterministic'

export interface HeadlessRunSummary {
  exitCode: number
  interrupted: boolean
  totalEvents: number
  toolCallCount: number
  recentEvents: readonly HeadlessTrackedEventLike[]
}

function hasCancelledDetail(detail: string | undefined): boolean {
  return /\bcancelled\b/i.test(String(detail ?? ''))
}

/**
 * Detect deterministic no-work tails seen in repeatable headless failures:
 * select -> input -> notify(cancelled)
 */
export function hasDeterministicNoWorkTail(recentEvents: readonly HeadlessTrackedEventLike[]): boolean {
  const uiTail = recentEvents
    .filter((event) => event.type === 'extension_ui_request')
    .slice(-3)

  if (uiTail.length < 3) return false
  const [first, second, third] = uiTail
  return first.detail?.startsWith('select:') === true
    && second.detail?.startsWith('input:') === true
    && third.detail?.startsWith('notify:') === true
    && hasCancelledDetail(third.detail)
}

/**
 * Classify final status for summary/logging. Keeps legacy semantics except
 * for deterministic no-work tails, which are labeled distinctly.
 */
export function classifyHeadlessFinalStatus(args: {
  blocked: boolean
  exitCode: number
  totalEvents: number
  recentEvents: readonly HeadlessTrackedEventLike[]
}): HeadlessFinalStatus {
  if (args.blocked) return 'blocked'
  if (args.exitCode === EXIT_CANCELLED) return 'cancelled'
  if (args.exitCode === EXIT_ERROR) {
    if (hasDeterministicNoWorkTail(args.recentEvents)) return 'no-work-deterministic'
    return args.totalEvents === 0 ? 'error' : 'timeout'
  }
  return 'complete'
}

/**
 * Map a child-process exit observed before any terminal notification to the
 * run's exit code. A clean child exit (code 0) counts as success only when
 * the parent-initiated overall timeout has NOT fired: after the deadline the
 * parent SIGTERMs the child, and a clean shutdown must keep the timeout's
 * error exit code instead of masking the incomplete run as success (#1967).
 */
export function classifyChildExitWithoutTerminal(code: number | null, timedOut: boolean): number {
  return code === 0 && !timedOut ? EXIT_SUCCESS : EXIT_ERROR
}

/**
 * Decide whether a failed run is restart-eligible.
 */
export function shouldRestartHeadlessRun(summary: HeadlessRunSummary): boolean {
  if (summary.interrupted) return false
  if (summary.exitCode !== EXIT_ERROR) return false
  if (hasDeterministicNoWorkTail(summary.recentEvents)) return false
  if (summary.totalEvents === 0) return true
  if (summary.toolCallCount > 0 && summary.totalEvents > 5) return true
  return false
}

// ---------------------------------------------------------------------------
// Quick Command Detection
// ---------------------------------------------------------------------------

export const FIRE_AND_FORGET_METHODS = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'])

const QUICK_COMMANDS = new Set([
  'status', 'queue', 'history', 'hooks', 'export', 'stop', 'pause',
  'capture', 'skip', 'undo', 'knowledge', 'config', 'prefs',
  'cleanup', 'migrate', 'doctor', 'remote', 'help', 'steer',
  'triage', 'visualize',
])

const QUICK_WORKFLOW_SUBCOMMANDS = new Set(['list', 'validate'])

export function isQuickCommand(command: string, commandArgs: readonly string[] = []): boolean {
  if (QUICK_COMMANDS.has(command)) return true
  return command === 'workflow' && QUICK_WORKFLOW_SUBCOMMANDS.has(commandArgs[0] ?? '')
}
