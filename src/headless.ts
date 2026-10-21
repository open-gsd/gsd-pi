/**
 * Headless Orchestrator — `gsd headless`
 *
 * Runs any /gsd subcommand without a TUI by spawning a child process in
 * RPC mode, auto-responding to extension UI requests, and streaming
 * progress to stderr.
 *
 * Exit codes:
 *   0  — complete (command finished successfully)
 *   1  — error or timeout
 *   10 — blocked (command reported a blocker)
 *   11 — cancelled (SIGINT/SIGTERM received)
 */

import { existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { ChildProcess } from 'node:child_process'

import { RpcClient } from '@gsd/agent-modes/modes/rpc/rpc-client.js'
import { SessionManager } from '@gsd/pi-coding-agent'
import type { SessionInfo } from '@gsd/pi-coding-agent'
import { getProjectSessionsDir } from './project-sessions.js'
import { loadAndValidateAnswerFile, AnswerInjector } from './headless-answers.js'

import {
  isTerminalNotification,
  isBlockedNotification,
  isMilestoneReadyNotification,
  isQuickCommand,
  FIRE_AND_FORGET_METHODS,
  IDLE_TIMEOUT_MS,
  NEW_MILESTONE_IDLE_TIMEOUT_MS,
  isInteractiveHeadlessTool,
  shouldArmHeadlessIdleTimeout,
  shouldRestartHeadlessRun,
  classifyHeadlessFinalStatus,
  classifyChildExitWithoutTerminal,
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  mapStatusToExitCode,
} from './headless-events.js'

import type { OutputFormat, HeadlessJsonResult } from './headless-types.js'
import { VALID_OUTPUT_FORMATS } from './headless-types.js'
import {
  captureQuickTaskGitState,
  collectQuickTaskResult,
  parseQuickTaskNotification,
} from './headless-quick-result.js'
import type { QuickTaskMetadata, QuickTaskResultDetails } from './headless-quick-result.js'

import {
  handleExtensionUIRequest,
  formatProgressOutput,
  formatThinkingLine,
  formatTextStart,
  formatTextEnd,
  formatThinkingStart,
  formatThinkingEnd,
  startSupervisedStdinReader,
} from './headless-ui.js'
import type { ExtensionUIRequest, ProgressContext } from './headless-ui.js'

import {
  loadContext,
  bootstrapGsdProject,
} from './headless-context.js'
import {
  captureMilestoneExecutionSnapshot,
  isMilestoneExecutableInDb,
} from './headless-milestone-readiness.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessOptions {
  timeout: number
  timeoutExplicit?: boolean
  json: boolean
  outputFormat: OutputFormat
  model?: string
  thinking?: HeadlessThinkingLevel
  command: string
  commandArgs: string[]
  context?: string       // file path or '-' for stdin
  contextText?: string   // inline text
  auto?: boolean         // chain into auto-mode after milestone creation
  verbose?: boolean      // show tool calls in output
  maxRestarts?: number   // auto-restart on crash (default 3, 0 to disable)
  supervised?: boolean   // supervised mode: forward interactive requests to orchestrator
  responseTimeout?: number // timeout for orchestrator response (default 30000ms)
  answers?: string       // path to answers JSON file
  eventFilter?: Set<string>  // filter JSONL output to specific event types
  resumeSession?: string // session ID to resume (--resume <id>)
  bare?: boolean         // --bare: suppress CLAUDE.md/AGENTS.md, user skills, project preferences
}

const HEADLESS_CHAIN_AUTO_FLAG = '--headless-chain-auto'
type HeadlessThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const VALID_THINKING_LEVELS = new Set<HeadlessThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function isHeadlessThinkingLevel(value: string): value is HeadlessThinkingLevel {
  return VALID_THINKING_LEVELS.has(value as HeadlessThinkingLevel)
}

export function buildHeadlessSlashCommand(options: Pick<HeadlessOptions, 'command' | 'commandArgs' | 'auto'>): string {
  const commandArgs = [...options.commandArgs]
  if (options.command === 'new-milestone' && options.auto && !commandArgs.includes(HEADLESS_CHAIN_AUTO_FLAG)) {
    commandArgs.push(HEADLESS_CHAIN_AUTO_FLAG)
  }
  const serializedArgs = commandArgs.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg)
  return `/gsd ${options.command}${serializedArgs.length > 0 ? ' ' + serializedArgs.join(' ') : ''}`
}

/**
 * Commands classified as multi-turn in headless mode: they involve multiple
 * question rounds, codebase scanning, and artifact writing before the workflow
 * completes (#3547). Multi-turn commands suppress single-execution-complete
 * exit and disable the default 5-minute timeout.
 *
 * Exported so the regression test can exercise the real classifier rather
 * than grepping the source for identifier names.
 */
export function isMultiTurnHeadlessCommand(command: string): boolean {
  return (
    command === 'auto' ||
    command === 'next' ||
    command === 'discuss' ||
    command === 'plan'
  )
}

interface TrackedEvent {
  type: string
  timestamp: number
  detail?: string
}

// ---------------------------------------------------------------------------
// Resume Session Resolution
// ---------------------------------------------------------------------------

export interface ResumeSessionResult {
  session?: SessionInfo
  error?: string
}

/**
 * Resolve a session prefix to a single session.
 * Exact id match is preferred over prefix match.
 * Returns `{ session }` on unique match or `{ error }` on 0/ambiguous matches.
 */
function resolveResumeSession(sessions: SessionInfo[], prefix: string): ResumeSessionResult {
  // Exact match takes priority
  const exact = sessions.find(s => s.id === prefix)
  if (exact) {
    return { session: exact }
  }

  // Prefix match
  const matches = sessions.filter(s => s.id.startsWith(prefix))
  if (matches.length === 0) {
    return { error: `No session matching '${prefix}' found` }
  }
  if (matches.length > 1) {
    const list = matches.map(s => `  ${s.id}`).join('\n')
    return { error: `Ambiguous session prefix '${prefix}' matches ${matches.length} sessions:\n${list}` }
  }
  return { session: matches[0] }
}

// ---------------------------------------------------------------------------
// CLI Argument Parser
// ---------------------------------------------------------------------------

export function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    json: false,
    outputFormat: 'text',
    command: 'auto',
    commandArgs: [],
  }

  const args = argv.slice(2)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'headless') continue

    if (arg.startsWith('--')) {
      if (arg === '--timeout' && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10)
        options.timeoutExplicit = true
        if (Number.isNaN(options.timeout) || options.timeout < 0) {
          process.stderr.write('[headless] Error: --timeout must be a non-negative integer (milliseconds, 0 to disable)\n')
          process.exit(1)
        }
      } else if (arg === '--json') {
        options.json = true
        options.outputFormat = 'stream-json'
      } else if (arg === '--output-format' && i + 1 < args.length) {
        const fmt = args[++i]
        if (!VALID_OUTPUT_FORMATS.has(fmt)) {
          process.stderr.write(`[headless] Error: --output-format must be one of: text, json, stream-json (got '${fmt}')\n`)
          process.exit(1)
        }
        options.outputFormat = fmt as OutputFormat
        if (fmt === 'stream-json' || fmt === 'json') {
          options.json = true
        }
      } else if (arg === '--model' && i + 1 < args.length) {
        // --model can also be passed from the main CLI; headless-specific takes precedence
        options.model = args[++i]
      } else if (arg === '--thinking' && i + 1 < args.length) {
        const level = args[++i]
        if (!isHeadlessThinkingLevel(level)) {
          process.stderr.write(`[headless] Error: --thinking must be one of: ${[...VALID_THINKING_LEVELS].join(', ')} (got '${level}')\n`)
          process.exit(1)
        }
        options.thinking = level
      } else if (arg === '--context' && i + 1 < args.length) {
        options.context = args[++i]
      } else if (arg === '--context-text' && i + 1 < args.length) {
        options.contextText = args[++i]
      } else if (arg === '--auto') {
        options.auto = true
      } else if (arg === '--verbose') {
        options.verbose = true
      } else if (arg === '--max-restarts' && i + 1 < args.length) {
        options.maxRestarts = parseInt(args[++i], 10)
        if (Number.isNaN(options.maxRestarts) || options.maxRestarts < 0) {
          process.stderr.write('[headless] Error: --max-restarts must be a non-negative integer\n')
          process.exit(1)
        }
      } else if (arg === '--answers' && i + 1 < args.length) {
        options.answers = args[++i]
      } else if (arg === '--events' && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(','))
        options.json = true  // --events implies --json
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true  // supervised implies json
        if (options.outputFormat === 'text') {
          options.outputFormat = 'stream-json'
        }
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
        if (Number.isNaN(options.responseTimeout) || options.responseTimeout <= 0) {
          process.stderr.write('[headless] Error: --response-timeout must be a positive integer (milliseconds)\n')
          process.exit(1)
        }
      } else if (arg === '--resume' && i + 1 < args.length) {
        options.resumeSession = args[++i]
      } else if (arg === '--resume-wedge' && i + 1 < args.length) {
        // ADR-047 wedge acknowledgment: consume the id here so the bare value
        // positional cannot clobber the subcommand, then pass both through to
        // the assembled `/gsd auto --resume-wedge <id>` verbatim.
        options.commandArgs.push(arg, args[++i])
      } else if (arg === '--bare') {
        options.bare = true
      } else {
        // Unrecognized flag: pass it through to the slash command verbatim
        // instead of silently dropping it. This lets subcommand flags such as
        // `verdict pass --rationale "..."` reach the assembled slash command
        // (#1297). Known headless flags above still win regardless of position.
        options.commandArgs.push(arg)
      }
    } else if (options.command === 'auto') {
      options.command = arg
    } else {
      options.commandArgs.push(arg)
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// Main Orchestrator
// ---------------------------------------------------------------------------

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  if (options.command === 'quick' && options.commandArgs.join(' ').trim().length === 0) {
    process.stderr.write('[headless] Error: quick requires a task description.\n')
    process.stderr.write('[headless] Usage: gsd headless quick "<task description>"\n')
    if (options.outputFormat === 'json') {
      const result: HeadlessJsonResult = {
        status: 'error',
        exitCode: EXIT_ERROR,
        duration: 0,
        cost: {
          total: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        toolCalls: 0,
        events: 0,
      }
      process.stdout.write(JSON.stringify(result) + '\n')
    }
    process.exit(EXIT_ERROR)
  }

  const maxRestarts = options.maxRestarts ?? 3
  let restartCount = 0

  while (true) {
    const result = await runHeadlessOnce(options, restartCount)

    // Success or blocked — exit normally
    if (result.exitCode === EXIT_SUCCESS || result.exitCode === EXIT_BLOCKED) {
      process.exit(result.exitCode)
    }

    // A quick task mutates the repository and must never be replayed after a
    // failed result: retrying could create a second task/branch/commit.
    if (options.command === 'quick') {
      process.exit(result.exitCode)
    }

    // Don't restart if SIGINT/SIGTERM was received
    if (result.interrupted) {
      process.exit(result.exitCode)
    }

    if (!shouldRestartHeadlessRun(result)) {
      process.stderr.write(`[headless] Restart suppressed: ${result.status}\n`)
      process.exit(result.exitCode)
    }

    // Crash/error — check if we should restart
    if (restartCount >= maxRestarts) {
      process.stderr.write(`[headless] Max restarts (${maxRestarts}) reached. Exiting.\n`)
      process.exit(result.exitCode)
    }

    restartCount++
    const backoffMs = Math.min(5000 * restartCount, 30_000)
    process.stderr.write(`[headless] Restarting in ${(backoffMs / 1000).toFixed(0)}s (attempt ${restartCount}/${maxRestarts})...\n`)
    await new Promise(resolve => setTimeout(resolve, backoffMs))
  }
}

async function runHeadlessOnce(options: HeadlessOptions, restartCount: number): Promise<{ exitCode: number; interrupted: boolean; totalEvents: number; toolCallCount: number; recentEvents: TrackedEvent[]; status: string }> {
  let interrupted = false
  const startTime = Date.now()
  const isNewMilestone = options.command === 'new-milestone'
  const isQuickTask = options.command === 'quick'
  const quickTaskGitState = isQuickTask ? captureQuickTaskGitState(process.cwd()) : undefined

  // new-milestone involves codebase investigation + artifact writing — needs more time
  if (isNewMilestone && options.timeout === 300_000) {
    options.timeout = 600_000 // 10 minutes
  }

  // auto-mode sessions are long-running (minutes to hours) with their own internal
  // per-unit timeout via auto-supervisor. Disable the overall timeout unless the
  // user explicitly set --timeout.
  const isAutoMode = options.command === 'auto'
  // discuss and plan are multi-turn: they involve multiple question rounds,
  // codebase scanning, and artifact writing before the workflow completes (#3547).
  let isMultiTurnCommand = isMultiTurnHeadlessCommand(options.command)
  if (isAutoMode && !options.timeoutExplicit && options.timeout === 300_000) {
    options.timeout = 0
  }

  // Supervised mode cannot share stdin with --context -
  if (options.supervised && options.context === '-') {
    process.stderr.write('[headless] Error: --supervised cannot be used with --context - (both require stdin)\n')
    process.exit(1)
  }

  // Load answer injection file
  let injector: AnswerInjector | undefined
  let answerFilePath: string | undefined
  if (options.answers) {
    try {
      answerFilePath = resolve(options.answers)
      const answerFile = loadAndValidateAnswerFile(answerFilePath)
      injector = new AnswerInjector(answerFile)
      if (!options.json) {
        process.stderr.write(`[headless] Loaded answer file: ${options.answers}\n`)
      }
    } catch (err) {
      process.stderr.write(`[headless] Error loading answer file: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  // For new-milestone, load context and bootstrap .gsd/ before spawning RPC child
  if (isNewMilestone) {
    if (!options.context && !options.contextText) {
      process.stderr.write('[headless] Error: new-milestone requires --context <file> or --context-text <text>\n')
      process.exit(1)
    }

    let contextContent: string
    try {
      contextContent = await loadContext(options)
    } catch (err) {
      process.stderr.write(`[headless] Error loading context: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }

    // Bootstrap .gsd/ if needed
    const gsdDir = join(process.cwd(), '.gsd')
    if (!existsSync(gsdDir)) {
      if (!options.json) {
        process.stderr.write('[headless] Bootstrapping .gsd/ project structure...\n')
      }
      bootstrapGsdProject(process.cwd())
    }

    // Write context to temp file for the RPC child to read
    const runtimeDir = join(gsdDir, 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'headless-context.md'), contextContent, 'utf-8')
  }

  // Validate .gsd/ directory (skip for new-milestone since we just bootstrapped it)
  const gsdDir = join(process.cwd(), '.gsd')
  if (!isNewMilestone && !existsSync(gsdDir)) {
    process.stderr.write('[headless] Error: No .gsd/ directory found in current directory.\n')
    process.stderr.write("[headless] Run 'gsd' interactively first to initialize a project.\n")
    process.exit(1)
  }

  // Query: read-only state snapshot, no RPC child needed
  if (options.command === 'query') {
    const { handleQuery } = await import('./headless-query.js')
    const result = await handleQuery(process.cwd())
    // query is a read-only snapshot: no RPC child, no tracked events.
    return {
      exitCode: result.exitCode,
      interrupted: false,
      totalEvents: 0,
      toolCallCount: 0,
      recentEvents: [],
      status: result.exitCode === 0 ? 'success' : 'error',
    }
  }

  // Selective DB-only orphan cleanup: direct one-shot path with no RPC child,
  // extension bootstrap, or projection reconciliation.
  if (options.command === 'discard-milestone') {
    const { handleDiscardMilestone } = await import('./headless-discard-milestone.js')
    const result = await handleDiscardMilestone(process.cwd(), options.commandArgs)
    process.exit(result.exitCode)
  }

  // Recover: apply a verified legacy import and assess or execute its recovery
  // action, with no RPC child needed. This is the one mutating headless
  // subcommand, for CI and automation without an interactive TTY-bound runtime.
  if (options.command === 'recover') {
    const { handleRecover } = await import('./headless-recover.js')
    const result = await handleRecover(process.cwd(), options.commandArgs)
    process.exit(result.exitCode)
  }

  // Doctor: read-only health check, no RPC child needed (#4904 live-regression).
  // The interactive `/gsd doctor` command lives in the GSD extension; this CLI
  // path lets non-interactive callers (CI, recovery scripts, the live-regression
  // suite) get the same diagnostic without a TTY.
  if (options.command === 'doctor') {
    const wantsJson = options.json || options.commandArgs.includes('--json')
    const { runGSDDoctor } = await import('./resources/extensions/gsd/doctor.js')
    const { formatDoctorReport, formatDoctorReportJson } = await import('./resources/extensions/gsd/doctor-format.js')
    let exitCode = 1
    try {
      const report = await runGSDDoctor(process.cwd())
      const out = wantsJson ? formatDoctorReportJson(report) : formatDoctorReport(report)
      process.stdout.write(`${out}\n`)
      exitCode = report.ok ? 0 : 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[headless] doctor failed: ${msg}\n`)
      exitCode = 1
    }
    // Bypass the auto-restart loop in runHeadless — doctor is a one-shot
    // diagnostic; exit 1 means "issues detected", not "crashed".
    process.exit(exitCode)
  }

  // Resolve CLI path for the child process
  const cliPath = process.env.GSD_BIN_PATH || process.argv[1]
  if (!cliPath) {
    process.stderr.write('[headless] Error: Cannot determine CLI path. Set GSD_BIN_PATH or run via gsd.\n')
    process.exit(1)
  }

  // Create RPC client
  const clientOptions: Record<string, unknown> = {
    cliPath,
    cwd: process.cwd(),
  }
  if (options.model) {
    clientOptions.model = options.model
  }
  if (options.thinking) {
    clientOptions.args = [...((clientOptions.args as string[]) || []), '--thinking', options.thinking]
  }
  if (injector) {
    clientOptions.env = injector.getSecretEnvVars()
  }
  // Signal headless mode to the GSD extension (skips UAT human pause, etc.)
  clientOptions.env = { ...(clientOptions.env as Record<string, string> || {}), GSD_HEADLESS: '1' }
  if (answerFilePath) {
    clientOptions.env = { ...(clientOptions.env as Record<string, string> || {}), GSD_HEADLESS_ANSWERS_PATH: answerFilePath }
  }
  // Propagate --bare to the child process
  if (options.bare) {
    clientOptions.args = [...((clientOptions.args as string[]) || []), '--bare']
  }

  const client = new RpcClient(clientOptions)

  // Event tracking
  let totalEvents = 0
  let toolCallCount = 0
  let blocked = false
  let completed = false
  let exitCode = 0
  let milestoneReady = false  // tracks "Milestone X ready." for auto-chaining
  const recentEvents: TrackedEvent[] = []
  const interactiveToolCallIds = new Set<string>()

  // JSON batch mode: cost aggregation (cumulative-max pattern per K004)
  let cumulativeCostUsd = 0
  let cumulativeInputTokens = 0
  let cumulativeOutputTokens = 0
  let cumulativeCacheReadTokens = 0
  let cumulativeCacheWriteTokens = 0
  let lastSessionId: string | undefined
  let quickTaskMetadata: QuickTaskMetadata | undefined
  let quickTaskDetails: QuickTaskResultDetails | undefined

  // Verbose text-mode state
  const toolStartTimes = new Map<string, number>()
  let lastCostData: { costUsd: number; inputTokens: number; outputTokens: number } | undefined
  let thinkingBuffer = ''
  // Streaming state: tracks whether we're inside a text or thinking block
  let inTextBlock = false
  let inThinkingBlock = false

  function buildStructuredResult(): HeadlessJsonResult {
    const duration = Date.now() - startTime
    const finalStatus = classifyHeadlessFinalStatus({ blocked, exitCode, totalEvents, recentEvents })
    const status: HeadlessJsonResult['status'] = finalStatus === 'complete' ? 'success' : finalStatus
    return {
      status,
      exitCode,
      sessionId: lastSessionId,
      duration,
      cost: {
        total: cumulativeCostUsd,
        input_tokens: cumulativeInputTokens,
        output_tokens: cumulativeOutputTokens,
        cache_read_tokens: cumulativeCacheReadTokens,
        cache_write_tokens: cumulativeCacheWriteTokens,
      },
      toolCalls: toolCallCount,
      events: totalEvents,
      task: quickTaskDetails?.task ?? quickTaskMetadata?.task,
      branch: quickTaskDetails?.branch ?? quickTaskMetadata?.branch,
      artifacts: quickTaskDetails?.artifacts ?? (quickTaskMetadata ? [quickTaskMetadata.artifact] : undefined),
      commits: quickTaskDetails?.commits,
    }
  }

  // Batch JSON emits one object; stream-json emits the same terminal result as
  // a typed JSONL event after the raw RPC event stream.
  function structuredResultLine(): string | undefined {
    const result = buildStructuredResult()
    if (options.outputFormat === 'json') {
      return JSON.stringify(result) + '\n'
    }
    if (options.outputFormat === 'stream-json') {
      return JSON.stringify({ type: 'headless_result', ...result }) + '\n'
    }
    return undefined
  }

  async function emitStructuredResult(): Promise<void> {
    const line = structuredResultLine()
    if (!line) return
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve())
    })
  }

  function emitStructuredResultSync(): void {
    const line = structuredResultLine()
    if (line) writeSync(1, line)
  }

  function trackEvent(event: Record<string, unknown>): void {
    totalEvents++
    const type = String(event.type ?? 'unknown')

    if (type === 'tool_execution_start') {
      toolCallCount++
    }

    // Keep last 20 events for diagnostics
    const detail =
      type === 'tool_execution_start'
        ? String(event.toolName ?? '')
        : type === 'extension_ui_request'
          ? `${event.method}: ${event.title ?? event.message ?? ''}`
          : undefined

    recentEvents.push({ type, timestamp: Date.now(), detail })
    if (recentEvents.length > 20) recentEvents.shift()
  }

  // Client started flag — replaces old stdinWriter null-check
  let clientStarted = false
  // Adapter for AnswerInjector — wraps client.sendUIResponse in a writeToStdin-compatible callback
  // Initialized after client.start(); events won't fire before then
  let injectorStdinAdapter: (data: string) => void = () => {}

  // Supervised mode state
  const pendingResponseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let supervisedFallback = false
  let stopSupervisedReader: (() => void) | null = null
  const onStdinClose = () => {
    supervisedFallback = true
    process.stderr.write('[headless] Warning: orchestrator stdin closed, falling back to auto-response\n')
  }
  if (options.supervised) {
    process.stdin.on('close', onStdinClose)
  }

  // Completion promise
  let resolveCompletion: () => void
  const completionPromise = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  // Idle timeout — fallback completion detection
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // Quick commands (status, history, help, …) are short extension-layer
  // operations that never enter the LLM agent loop, so they emit no
  // execution_complete and make no tool calls. The idle timer is what
  // resolves them; without arming it for zero-tool quick commands the run
  // hangs and exits with a spurious "cancelled" (11). See
  // shouldArmHeadlessIdleTimeout.
  const isQuickCmd = isQuickCommand(options.command, options.commandArgs)
  let effectiveIdleTimeout = isNewMilestone
    ? NEW_MILESTONE_IDLE_TIMEOUT_MS
    : isAutoMode
      ? 0
      : IDLE_TIMEOUT_MS

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer)
    if (
      effectiveIdleTimeout > 0 &&
      shouldArmHeadlessIdleTimeout(toolCallCount, interactiveToolCallIds.size, isQuickCmd)
    ) {
      idleTimer = setTimeout(() => {
        completed = true
        resolveCompletion()
      }, effectiveIdleTimeout)
    }
  }

  // Precompute supervised response timeout
  const responseTimeout = options.responseTimeout ?? 30_000

  // Overall timeout (disabled when options.timeout === 0, e.g. auto-mode)
  let timedOut = false
  const timeoutTimer = options.timeout > 0
    ? setTimeout(() => {
        // A terminal notification that already completed the run wins the race
        // against the deadline — keep its success/blocked outcome.
        if (completed) return
        timedOut = true
        process.stderr.write(`[headless] Timeout after ${options.timeout / 1000}s\n`)
        exitCode = EXIT_ERROR
        resolveCompletion()
      }, options.timeout)
    : null

  // Event handler
  client.onEvent((event) => {
    const eventObj = event as unknown as Record<string, unknown>
    trackEvent(eventObj)

    const eventType = String(eventObj.type ?? '')
    if (isQuickTask && !quickTaskMetadata && eventType === 'extension_ui_request' && eventObj.method === 'notify') {
      quickTaskMetadata = parseQuickTaskNotification(String(eventObj.message ?? ''))
    }
    if (eventType === 'tool_execution_start') {
      const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
      if (toolCallId && isInteractiveHeadlessTool(String(eventObj.toolName ?? ''))) {
        interactiveToolCallIds.add(toolCallId)
      }
    } else if (eventType === 'tool_execution_end') {
      const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
      if (toolCallId) {
        interactiveToolCallIds.delete(toolCallId)
      }
    }

    resetIdleTimer()

    // Answer injector: observe events for question metadata
    injector?.observeEvent(eventObj)

    // --json / --output-format stream-json: forward events as JSONL to stdout (filtered if --events)
    // --output-format json (batch mode): suppress streaming, track cost for final result
    if (options.json && options.outputFormat === 'stream-json') {
      if (!options.eventFilter || options.eventFilter.has(eventType)) {
        process.stdout.write(JSON.stringify(eventObj) + '\n')
      }
    } else if (options.outputFormat === 'json') {
      // Batch mode: silently track cost_update events (cumulative-max per K004)
      const eventType = String(eventObj.type ?? '')
      if (eventType === 'cost_update') {
        const data = eventObj as Record<string, unknown>
        const cumCost = data.cumulativeCost as Record<string, unknown> | undefined
        if (cumCost) {
          cumulativeCostUsd = Math.max(cumulativeCostUsd, Number(cumCost.costUsd ?? 0))
          const tokens = data.tokens as Record<string, number> | undefined
          if (tokens) {
            cumulativeInputTokens = Math.max(cumulativeInputTokens, tokens.input ?? 0)
            cumulativeOutputTokens = Math.max(cumulativeOutputTokens, tokens.output ?? 0)
            cumulativeCacheReadTokens = Math.max(cumulativeCacheReadTokens, tokens.cacheRead ?? 0)
            cumulativeCacheWriteTokens = Math.max(cumulativeCacheWriteTokens, tokens.cacheWrite ?? 0)
          }
        }
      }
      // Track sessionId from init_result
      if (eventType === 'init_result') {
        lastSessionId = String((eventObj as Record<string, unknown>).sessionId ?? '')
      }
    } else if (!options.json) {
      // Progress output to stderr with verbose state tracking
      const eventType = String(eventObj.type ?? '')

      // Track cost_update events for agent_end summary
      if (eventType === 'cost_update') {
        const data = eventObj as Record<string, unknown>
        const cumCost = data.cumulativeCost as Record<string, unknown> | undefined
        if (cumCost) {
          const tokens = data.tokens as Record<string, number> | undefined
          lastCostData = {
            costUsd: Number(cumCost.costUsd ?? 0),
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
          }
        }
      }

      // Stream assistant text and thinking deltas in verbose mode
      if (eventType === 'message_update') {
        const ame = eventObj.assistantMessageEvent as Record<string, unknown> | undefined
        if (ame && options.verbose) {
          const ameType = String(ame.type ?? '')

          // --- Text streaming ---
          if (ameType === 'text_start') {
            inTextBlock = true
            process.stderr.write(formatTextStart())
          } else if (ameType === 'text_delta') {
            const delta = String(ame.delta ?? ame.text ?? '')
            if (delta) {
              if (!inTextBlock) {
                // Edge case: delta without start
                inTextBlock = true
                process.stderr.write(formatTextStart())
              }
              process.stderr.write(delta)
            }
          } else if (ameType === 'text_end') {
            if (inTextBlock) {
              process.stderr.write(formatTextEnd() + '\n')
              inTextBlock = false
            }
          }

          // --- Thinking streaming ---
          else if (ameType === 'thinking_start') {
            inThinkingBlock = true
            process.stderr.write(formatThinkingStart())
          } else if (ameType === 'thinking_delta') {
            const delta = String(ame.delta ?? ame.text ?? '')
            if (delta) {
              if (!inThinkingBlock) {
                inThinkingBlock = true
                process.stderr.write(formatThinkingStart())
              }
              process.stderr.write(delta)
            }
          } else if (ameType === 'thinking_end') {
            if (inThinkingBlock) {
              process.stderr.write(formatThinkingEnd() + '\n')
              inThinkingBlock = false
            }
          }
        }
        // Non-verbose: accumulate text_delta for truncated one-liner
        else if (ame?.type === 'text_delta') {
          thinkingBuffer += String(ame.delta ?? ame.text ?? '')
        }
      }

      // Track tool execution start timestamps
      if (eventType === 'tool_execution_start') {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
        if (toolCallId) toolStartTimes.set(toolCallId, Date.now())
      }

      // Close any open streaming blocks before tool calls or message end
      if (options.verbose && (eventType === 'tool_execution_start' || eventType === 'message_end')) {
        if (inTextBlock) {
          process.stderr.write('\n')
          inTextBlock = false
        }
        if (inThinkingBlock) {
          process.stderr.write('\n')
          inThinkingBlock = false
        }
      }
      // Non-verbose: flush accumulated buffer as truncated one-liner
      else if (!options.verbose && thinkingBuffer.trim() &&
          (eventType === 'tool_execution_start' || eventType === 'message_end')) {
        process.stderr.write(formatThinkingLine(thinkingBuffer) + '\n')
        thinkingBuffer = ''
      }

      // Compute tool duration for tool_execution_end
      let toolDuration: number | undefined
      let isToolError = false
      if (eventType === 'tool_execution_end') {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? '')
        const startTime = toolStartTimes.get(toolCallId)
        if (startTime) {
          toolDuration = Date.now() - startTime
          toolStartTimes.delete(toolCallId)
        }
        isToolError = eventObj.isError === true || eventObj.error != null
      }

      const ctx: ProgressContext = {
        verbose: !!options.verbose,
        toolDuration,
        isError: isToolError,
        lastCost: eventType === 'agent_end' ? lastCostData : undefined,
      }

      const streamOpen = !!options.verbose && (inTextBlock || inThinkingBlock)
      const output = formatProgressOutput(eventObj, ctx, streamOpen)
      if (output) {
        process.stderr.write(output)
        if (streamOpen) {
          inTextBlock = false
          inThinkingBlock = false
        }
      }
    }

    // Handle execution_complete (v2 structured completion)
    // Skip for multi-turn commands (auto, next) — their completion is detected via
    // isTerminalNotification("Auto-mode stopped..."/"Step-mode stopped..."), not per-turn events
    if (eventObj.type === 'execution_complete' && !completed && !isMultiTurnCommand) {
      completed = true
      const status = String(eventObj.status ?? 'success')
      exitCode = mapStatusToExitCode(status)
      if (eventObj.status === 'blocked') blocked = true
      resolveCompletion()
      return
    }

    // Blocking command blocks are rendered as assistant messages instead of
    // extension UI notifications, but headless still needs to stop immediately.
    if (eventObj.type !== 'extension_ui_request') {
      if (isBlockedNotification(eventObj)) {
        blocked = true
      }
      if (isTerminalNotification(eventObj)) {
        completed = true
        exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
        resolveCompletion()
        return
      }
    }

    // Handle extension_ui_request
    if (eventObj.type === 'extension_ui_request') {
      // State tracking runs regardless of clientStarted: bootstrap-time
      // notifications (e.g. survivor-branch merge failures) arrive before
      // the LLM session begins and must still trip the blocked/terminal gates.
      if (isBlockedNotification(eventObj)) {
        blocked = true
      }

      // Detect "Milestone X ready." for auto-mode chaining
      if (isMilestoneReadyNotification(eventObj)) {
        milestoneReady = true
      }

      if (isTerminalNotification(eventObj)) {
        completed = true
      }

      if (!clientStarted) {
        // Before the LLM session starts, only state tracking matters.
        // Resolve immediately on terminal; skip UI interaction handling.
        if (completed) {
          exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
          resolveCompletion()
        }
        return
      }

      // Answer injection: try to handle with pre-supplied answers before supervised/auto
      if (injector && !FIRE_AND_FORGET_METHODS.has(String(eventObj.method ?? ''))) {
        if (injector.tryHandle(eventObj, injectorStdinAdapter)) {
          if (completed) {
            exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
            resolveCompletion()
          }
          return
        }
      }

      const method = String(eventObj.method ?? '')
      const shouldSupervise = options.supervised && !supervisedFallback
        && !FIRE_AND_FORGET_METHODS.has(method)

      if (shouldSupervise) {
        // Interactive request in supervised mode — let orchestrator respond
        const eventId = String(eventObj.id ?? '')
        const timer = setTimeout(() => {
          pendingResponseTimers.delete(eventId)
          handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, client)
          process.stdout.write(JSON.stringify({ type: 'supervised_timeout', id: eventId, method }) + '\n')
        }, responseTimeout)
        pendingResponseTimers.set(eventId, timer)
      } else {
        handleExtensionUIRequest(eventObj as unknown as ExtensionUIRequest, client)
      }

      // If we detected a terminal notification, resolve after responding
      if (completed) {
        exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS
        resolveCompletion()
        return
      }
    }

    // Quick commands: resolve on first agent_end
    if (eventObj.type === 'agent_end' && (isQuickTask || isQuickCommand(options.command, options.commandArgs)) && !completed) {
      completed = true
      resolveCompletion()
      return
    }

    // Long-running commands: agent_end after tool execution — possible completion
    // The idle timer + terminal notification handle this case.
  })

  // Signal handling
  const signalHandler = () => {
    // Use writeSync on fd 2 to guarantee the Interrupted marker reaches
    // consumers before process.exit() truncates pending async writes.
    try {
      writeSync(2, '\n[headless] Interrupted, stopping child process...\n')
    } catch {
      // Fallback to async write if fd 2 is somehow unavailable.
      process.stderr.write('\n[headless] Interrupted, stopping child process...\n')
    }
    interrupted = true
    exitCode = EXIT_CANCELLED
    // Kill child process — don't await, just fire and exit.
    // The main flow may be awaiting a promise that resolves when the child dies,
    // which would race with this handler. Exit synchronously to ensure correct exit code.
    void client.stop().catch((error: unknown) => {
      process.stderr.write(`[headless] Warning: failed to stop child process: ${error instanceof Error ? error.message : String(error)}\n`)
    })
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (idleTimer) clearTimeout(idleTimer)
    // Preserve a terminal machine-readable result for both JSON output modes.
    emitStructuredResultSync()
    process.exit(exitCode)
  }
  // Use prependListener so our handler runs before pi-coding-agent's
  // LSP-client module-load SIGINT handler, which calls process.exit(0)
  // and would otherwise short-circuit our exit-code-11 contract.
  process.prependListener('SIGINT', signalHandler)
  process.prependListener('SIGTERM', signalHandler)
  // Emit a deterministic readiness marker so test harnesses can wait for
  // the SIGINT handler to be live before sending a signal. writeSync on
  // fd 2 avoids any pipe-buffering race between the marker and subsequent
  // signal delivery.
  try {
    writeSync(2, '[headless] signal-handlers-ready\n')
  } catch {
    process.stderr.write('[headless] signal-handlers-ready\n')
  }

  // Start the RPC session
  try {
    await client.start()
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to start RPC session: ${err instanceof Error ? err.message : String(err)}\n`)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    process.exit(1)
  }

  // v2 protocol negotiation — attempt init for structured completion events
  let v2Enabled = false
  try {
    await client.init({ clientId: 'gsd-headless' })
    v2Enabled = true
  } catch {
    process.stderr.write('[headless] Warning: v2 init failed, falling back to v1 string-matching\n')
  }

  clientStarted = true

  // --resume: resolve session ID and switch to it
  if (options.resumeSession) {
    const projectSessionsDir = getProjectSessionsDir(process.cwd())
    const sessions = await SessionManager.list(process.cwd(), projectSessionsDir)
    const result = resolveResumeSession(sessions, options.resumeSession)
    if (result.error) {
      process.stderr.write(`[headless] Error: ${result.error}\n`)
      await client.stop()
      if (timeoutTimer) clearTimeout(timeoutTimer)
      process.exit(1)
    }
    const matched = result.session!
    const switchResult = await client.switchSession(matched.path)
    if (switchResult.cancelled) {
      process.stderr.write(`[headless] Error: Session switch to '${matched.id}' was cancelled by an extension\n`)
      await client.stop()
      if (timeoutTimer) clearTimeout(timeoutTimer)
      process.exit(1)
    }
    process.stderr.write(`[headless] Resuming session ${matched.id}\n`)
  }

  // Build injector adapter — wraps client.sendUIResponse for AnswerInjector's writeToStdin interface
  injectorStdinAdapter = (data: string) => {
    try {
      const parsed = JSON.parse(data.trim())
      if (parsed.type === 'extension_ui_response' && parsed.id) {
        const { id, value, values, confirmed, cancelled } = parsed
        client.sendUIResponse(id, { value, values, confirmed, cancelled })
      }
    } catch {
      process.stderr.write('[headless] Warning: injector adapter received unparseable data\n')
    }
  }

  // Start supervised stdin reader for orchestrator commands
  if (options.supervised) {
    stopSupervisedReader = startSupervisedStdinReader(client, (id) => {
      const timer = pendingResponseTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        pendingResponseTimers.delete(id)
      }
    })
    // Ensure stdin is in flowing mode for JSONL reading
    process.stdin.resume()
  }

  // Detect child process crash (read-only exit event subscription — not stdin access)
  const internalProcess = Reflect.get(client as object, 'process') as ChildProcess | undefined
  if (internalProcess) {
    internalProcess.on('exit', (code: number | null) => {
      if (!completed) {
        if (code === 0 && timedOut) {
          // The overall --timeout fired and cleanup SIGTERMed the child; its
          // clean shutdown must not mask the incomplete run as success (#1967).
          process.stderr.write('[headless] Child exited cleanly (code 0) after timeout — run did not complete\n')
        } else if (code === 0) {
          process.stderr.write('[headless] Child exited cleanly (code 0) without terminal notification\n')
        } else {
          process.stderr.write(`[headless] Child process exited unexpectedly with code ${code ?? 'null'}\n`)
        }
        exitCode = classifyChildExitWithoutTerminal(code, timedOut)
        resolveCompletion()
      }
    })
  }

  const preRunMilestoneSnapshot = isNewMilestone && options.auto
    ? captureMilestoneExecutionSnapshot(process.cwd())
    : null

  // Send the command
  const command = buildHeadlessSlashCommand(options)
  if (!options.json) {
    process.stderr.write(`[headless] Running ${command}...\n`)
  }
  try {
    await client.prompt(command)
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to send prompt: ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = EXIT_ERROR
  }

  // Wait for completion
  if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
    await completionPromise
  }

  // Auto-mode chaining: if --auto and milestone creation succeeded, send /gsd auto.
  //
  // The chain decision is DB-authoritative. `milestoneReady` (regex on a notify
  // string) is only a fast path — it fires on just one of several planning
  // success branches, so "planning succeeded" frequently does not imply the
  // "ready" text was emitted. When the fast path misses, fall back to querying
  // the milestone readiness changed by this command and chain if it is executable
  // (issue #1295).
  const dbMilestoneReady = preRunMilestoneSnapshot
    ? isMilestoneExecutableInDb(process.cwd(), { changedSince: preRunMilestoneSnapshot })
    : false
  const shouldChainAuto =
    isNewMilestone && options.auto && !blocked && exitCode === EXIT_SUCCESS &&
    (milestoneReady || dbMilestoneReady)
  if (shouldChainAuto) {
    if (!options.json) {
      process.stderr.write('[headless] Milestone ready — chaining into auto-mode...\n')
    }

    // Reset completion state for the auto-mode phase.
    // Disable the overall timeout — auto-mode has its own internal supervisor.
    if (timeoutTimer) clearTimeout(timeoutTimer)
    completed = false
    milestoneReady = false
    blocked = false
    isMultiTurnCommand = true
    effectiveIdleTimeout = 0
    resetIdleTimer()
    const autoCompletionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })

    try {
      await client.prompt('/gsd auto')
    } catch (err) {
      process.stderr.write(`[headless] Error: Failed to start auto-mode: ${err instanceof Error ? err.message : String(err)}\n`)
      exitCode = EXIT_ERROR
    }

    if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
      await autoCompletionPromise
    }
  }

  // Cleanup
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (idleTimer) clearTimeout(idleTimer)
  pendingResponseTimers.forEach((timer) => clearTimeout(timer))
  pendingResponseTimers.clear()
  stopSupervisedReader?.()
  process.stdin.removeListener('close', onStdinClose)
  process.removeListener('SIGINT', signalHandler)
  process.removeListener('SIGTERM', signalHandler)

  await client.stop()

  if (isQuickTask) {
    if (!quickTaskMetadata || !quickTaskGitState) {
      if (exitCode !== EXIT_BLOCKED) exitCode = EXIT_ERROR
      process.stderr.write('[headless] Error: Quick task did not start; no task metadata was reported.\n')
    } else {
      const quickResult = collectQuickTaskResult(process.cwd(), quickTaskGitState, quickTaskMetadata)
      quickTaskDetails = quickResult.details
      if (!quickResult.ok) {
        if (exitCode !== EXIT_BLOCKED) exitCode = EXIT_ERROR
        process.stderr.write(`[headless] Error: ${quickResult.error}\n`)
      }
    }
  }

  // Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const status = classifyHeadlessFinalStatus({ blocked, exitCode, totalEvents, recentEvents })

  process.stderr.write(`[headless] Status: ${status}\n`)
  process.stderr.write(`[headless] Duration: ${duration}s\n`)
  process.stderr.write(`[headless] Events: ${totalEvents} total, ${toolCallCount} tool calls\n`)
  if (options.eventFilter) {
    process.stderr.write(`[headless] Event filter: ${[...options.eventFilter].join(', ')}\n`)
  }
  if (restartCount > 0) {
    process.stderr.write(`[headless] Restarts: ${restartCount}\n`)
  }

  // Answer injection stats
  if (injector) {
    const stats = injector.getStats()
    process.stderr.write(`[headless] Answers: ${stats.questionsAnswered} answered, ${stats.questionsDefaulted} defaulted, ${stats.secretsProvided} secrets\n`)
    for (const warning of injector.getUnusedWarnings()) {
      process.stderr.write(`${warning}\n`)
    }
  }

  // On failure, print last 5 events for diagnostics
  if (exitCode !== 0) {
    const lastFive = recentEvents.slice(-5)
    if (lastFive.length > 0) {
      process.stderr.write('[headless] Last events:\n')
      for (const e of lastFive) {
        process.stderr.write(`  ${e.type}${e.detail ? `: ${e.detail}` : ''}\n`)
      }
    }
  }

  // Emit structured JSON result in batch mode
  await emitStructuredResult()

  return { exitCode, interrupted, totalEvents, toolCallCount, recentEvents: [...recentEvents], status }
}
