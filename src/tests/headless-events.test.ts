/**
 * Tests for `--events` flag — JSONL event stream filtering.
 *
 * Validates argument parsing and the event filter logic used by
 * the headless orchestrator to reduce stdout noise for orchestrators.
 *
 * Uses extracted parsing logic (mirrors headless.ts) to avoid
 * transitive @gsd/native import that breaks in test environment.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ─── Extracted parsing logic (mirrors headless.ts) ─────────────────────────

interface HeadlessOptions {
  timeout: number
  json: boolean
  model?: string
  command: string
  commandArgs: string[]
  context?: string
  contextText?: string
  auto?: boolean
  verbose?: boolean
  maxRestarts?: number
  supervised?: boolean
  responseTimeout?: number
  answers?: string
  eventFilter?: Set<string>
}

function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const options: HeadlessOptions = {
    timeout: 300_000,
    json: false,
    command: 'auto',
    commandArgs: [],
  }

  const args = argv.slice(2)
  let positionalStarted = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'headless') continue

    if (!positionalStarted && arg.startsWith('--')) {
      if (arg === '--timeout' && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10)
      } else if (arg === '--json') {
        options.json = true
      } else if (arg === '--model' && i + 1 < args.length) {
        options.model = args[++i]
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
      } else if (arg === '--answers' && i + 1 < args.length) {
        options.answers = args[++i]
      } else if (arg === '--events' && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(','))
        options.json = true
      } else if (arg === '--supervised') {
        options.supervised = true
        options.json = true
      } else if (arg === '--response-timeout' && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10)
      }
    } else if (!positionalStarted) {
      positionalStarted = true
      options.command = arg
    } else {
      options.commandArgs.push(arg)
    }
  }

  return options
}

// ─── parseHeadlessArgs: --events flag ──────────────────────────────────────

test('--events parses comma-separated event types into a Set', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end,extension_ui_request', 'auto'])
  assert.ok(opts.eventFilter instanceof Set)
  assert.equal(opts.eventFilter!.size, 2)
  assert.ok(opts.eventFilter!.has('agent_end'))
  assert.ok(opts.eventFilter!.has('extension_ui_request'))
})

test('--events implies --json', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end', 'auto'])
  assert.equal(opts.json, true)
})

test('--events with single type', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', 'agent_end', 'auto'])
  assert.equal(opts.eventFilter!.size, 1)
  assert.ok(opts.eventFilter!.has('agent_end'))
})

test('no --events flag means no filter', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--json', 'auto'])
  assert.equal(opts.eventFilter, undefined)
})

test('--events with all common types', () => {
  const types = 'agent_start,agent_end,tool_execution_start,tool_execution_end,extension_ui_request'
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--events', types, 'auto'])
  assert.equal(opts.eventFilter!.size, 5)
})

test('--events combined with other flags', () => {
  const opts = parseHeadlessArgs(['node', 'gsd', 'headless', '--timeout', '60000', '--events', 'agent_end', '--verbose', 'next'])
  assert.equal(opts.timeout, 60000)
  assert.equal(opts.verbose, true)
  assert.equal(opts.command, 'next')
  assert.ok(opts.eventFilter!.has('agent_end'))
  assert.equal(opts.json, true)
})

// ─── Event filter matching logic ───────────────────────────────────────────

test('filter allows matching event types', () => {
  const filter = new Set(['agent_end', 'extension_ui_request'])
  assert.ok(filter.has('agent_end'))
  assert.ok(filter.has('extension_ui_request'))
  assert.ok(!filter.has('message_update'))
  assert.ok(!filter.has('tool_execution_start'))
})

test('no filter allows all event types (undefined check)', () => {
  const filter: Set<string> | undefined = undefined
  const shouldEmit = (type: string) => !filter || filter.has(type)
  assert.ok(shouldEmit('agent_end'))
  assert.ok(shouldEmit('message_update'))
  assert.ok(shouldEmit('tool_execution_start'))
})

test('empty filter blocks all events', () => {
  const filter = new Set<string>()
  const shouldEmit = (type: string) => !filter || filter.has(type)
  assert.ok(!shouldEmit('agent_end'))
  assert.ok(!shouldEmit('message_update'))
})

import {
  mapStatusToExitCode,
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  isBlockedNotification,
  isInteractiveHeadlessTool,
  isTerminalNotification,
  shouldArmHeadlessIdleTimeout,
  hasDeterministicNoWorkTail,
  classifyHeadlessFinalStatus,
  classifyChildExitWithoutTerminal,
  shouldRestartHeadlessRun,
} from '../headless-events.js'

function makeNotify(message: string): Record<string, unknown> {
  return { type: 'extension_ui_request', method: 'notify', message }
}

function makeCommandBlock(content: string): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      role: 'custom',
      customType: 'gsd-command-block',
      content,
    },
  }
}

// ─── mapStatusToExitCode ─────────────────────────────────────────────────

test('mapStatusToExitCode: "complete" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('complete'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "completed" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('completed'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "success" returns EXIT_SUCCESS', () => {
  assert.equal(mapStatusToExitCode('success'), EXIT_SUCCESS)
})

test('mapStatusToExitCode: "error" returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('error'), EXIT_ERROR)
})

test('mapStatusToExitCode: "timeout" returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('timeout'), EXIT_ERROR)
})

test('mapStatusToExitCode: "blocked" returns EXIT_BLOCKED', () => {
  assert.equal(mapStatusToExitCode('blocked'), EXIT_BLOCKED)
})

test('mapStatusToExitCode: "paused" returns EXIT_BLOCKED', () => {
  assert.equal(mapStatusToExitCode('paused'), EXIT_BLOCKED)
})

test('mapStatusToExitCode: "cancelled" returns EXIT_CANCELLED', () => {
  assert.equal(mapStatusToExitCode('cancelled'), EXIT_CANCELLED)
})

test('mapStatusToExitCode: unknown status returns EXIT_ERROR', () => {
  assert.equal(mapStatusToExitCode('unknown'), EXIT_ERROR)
})

test('isTerminalNotification: auto-mode pause notifications are terminal', () => {
  assert.equal(isTerminalNotification(makeNotify('Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.')), true)
})

test('isTerminalNotification: step-mode pause notifications are terminal', () => {
  assert.equal(isTerminalNotification(makeNotify('Step-mode paused (Escape). Type to interact, or /gsd next to resume.')), true)
})

test('isTerminalNotification: idempotent advance pause notifications are terminal', () => {
  assert.equal(isTerminalNotification(makeNotify('Auto-mode paused: idempotent advance: unit already active')), true)
})

test('isTerminalNotification: structured orchestrator terminal pause events are terminal', () => {
  assert.equal(isTerminalNotification({
    eventType: 'orchestrator-terminal',
    data: { source: 'auto-orchestrator', name: 'stop', reason: 'pause' },
  }), true)
})

test('isTerminalNotification: structured orchestrator advance-paused events are terminal', () => {
  assert.equal(isTerminalNotification({
    eventType: 'orchestrator-guard-block',
    data: { source: 'auto-orchestrator', name: 'advance-paused', reason: 'manual attention' },
  }), true)
})

test('isTerminalNotification: manual merge-resolution notifications are terminal', () => {
  assert.equal(isTerminalNotification(makeNotify('Survivor-branch finalization for M001 failed: merge conflict. Resolve manually and re-run /gsd auto.')), true)
})

test('isTerminalNotification: unmerged milestone command blocks are terminal', () => {
  assert.equal(
    isTerminalNotification(makeCommandBlock('/gsd auto cannot start new workflow work because M001 is complete but not merged.')),
    true,
  )
})

test('isTerminalNotification: validation-blocked command blocks are terminal', () => {
  assert.equal(
    isTerminalNotification(makeCommandBlock('/gsd auto cannot run because the active milestone is blocked by validation.')),
    true,
  )
})

test('isBlockedNotification: pause notifications require intervention in headless mode', () => {
  assert.equal(isBlockedNotification(makeNotify('Auto-mode paused (Escape). Type to interact, or /gsd auto to resume.')), true)
  assert.equal(isBlockedNotification(makeNotify('Auto-mode paused due to provider error: connection reset')), true)
})

test('isBlockedNotification: idempotent advance pause notifications are not blocked', () => {
  assert.equal(isBlockedNotification(makeNotify('Auto-mode paused: idempotent advance: unit already active')), false)
})

test('isBlockedNotification: structured orchestrator pause events require intervention', () => {
  assert.equal(isBlockedNotification({
    eventType: 'orchestrator-terminal',
    data: { source: 'auto-orchestrator', name: 'stop', reason: 'pause' },
  }), true)
  assert.equal(isBlockedNotification({
    eventType: 'orchestrator-guard-block',
    data: { source: 'auto-orchestrator', name: 'advance-paused', reason: 'manual attention' },
  }), true)
})

test('isBlockedNotification: manual merge-resolution notifications require intervention', () => {
  assert.equal(isBlockedNotification(makeNotify('Merge conflict on milestone M001: src/conflict.js. Resolve conflicts manually and run /gsd auto to resume.')), true)
  assert.equal(isBlockedNotification(makeNotify('Merge error on milestone M001: remote rejected push. Resolve and run /gsd auto to resume.')), true)
})

test('isBlockedNotification: blocking command blocks require intervention', () => {
  assert.equal(
    isBlockedNotification(makeCommandBlock('/gsd auto cannot start new workflow work because M001 is complete but not merged.')),
    true,
  )
  assert.equal(
    isBlockedNotification(makeCommandBlock('/gsd auto cannot run because the active milestone is blocked by validation.')),
    true,
  )
})

test('isBlockedNotification: avoids blocked text without blocked marker', () => {
  assert.equal(isBlockedNotification(makeNotify('The request was blocked by the firewall')), false)
})

test('un-showable menu notifications are terminal and blocked (#1294)', () => {
  // Verbatim shape from notifyCommandMenuUnavailable — the pre-planning menu route
  // that previously idled forever in headless auto/next.
  const menu = makeNotify('GSD — M002: Editorial HN menu could not be shown in this session.\nRun /gsd when ready.')
  assert.equal(isTerminalNotification(menu), true)
  assert.equal(isBlockedNotification(menu), true)

  // Picker-guidance shape from notifyPickerCommandNeedsInteractiveMenu.
  const picker = makeNotify('/gsd did not start: milestone menu needs an interactive session')
  assert.equal(isTerminalNotification(picker), true)
  assert.equal(isBlockedNotification(picker), true)
})

test('verdict notifications are terminal and rejected verdicts are blocked (#1373)', () => {
  const recorded = makeNotify('Verdict recorded: Milestone M001 verdict: needs-attention -> pass')
  assert.equal(isTerminalNotification(recorded), true)
  assert.equal(isBlockedNotification(recorded), false)

  const rejected = makeNotify('Verdict rejected: No milestone validation found for M001. Run /gsd auto to validate first, then retry /gsd verdict.')
  assert.equal(isTerminalNotification(rejected), true)
  assert.equal(isBlockedNotification(rejected), true)
})

test('isInteractiveHeadlessTool: ask_user_questions is interactive', () => {
  assert.equal(isInteractiveHeadlessTool('ask_user_questions'), true)
})

test('isInteractiveHeadlessTool: secure_env_collect is interactive', () => {
  assert.equal(isInteractiveHeadlessTool('secure_env_collect'), true)
})

test('isInteractiveHeadlessTool: MCP-scoped interactive tools are interactive', () => {
  assert.equal(isInteractiveHeadlessTool('mcp__custom-workflow__ask_user_questions'), true)
  assert.equal(isInteractiveHeadlessTool('mcp__custom-workflow__secure_env_collect'), true)
})

test('isInteractiveHeadlessTool: non-interactive tools stay false', () => {
  assert.equal(isInteractiveHeadlessTool('bash'), false)
  assert.equal(isInteractiveHeadlessTool(undefined), false)
})

test('shouldArmHeadlessIdleTimeout: arms after tool calls when no interactive tool is in flight', () => {
  assert.equal(shouldArmHeadlessIdleTimeout(1, 0), true)
  assert.equal(shouldArmHeadlessIdleTimeout(3, 0), true)
})

test('shouldArmHeadlessIdleTimeout: stays disarmed while interactive tools are in flight (#3714)', () => {
  assert.equal(shouldArmHeadlessIdleTimeout(1, 1), false)
  assert.equal(shouldArmHeadlessIdleTimeout(5, 2), false)
})

test('shouldArmHeadlessIdleTimeout: stays disarmed before any tool call has started', () => {
  assert.equal(shouldArmHeadlessIdleTimeout(0, 0), false)
  assert.equal(shouldArmHeadlessIdleTimeout(0, 1), false)
})

test('shouldArmHeadlessIdleTimeout: arms for quick commands even with zero tool calls', () => {
  // Quick commands (status/history/help/config) are handled entirely in the
  // extension layer — no LLM agent loop, no execution_complete, zero tool
  // calls. Without arming, the completion promise never resolves and the
  // process exits with a spurious "cancelled" (11).
  assert.equal(shouldArmHeadlessIdleTimeout(0, 0, true), true)
  // Tool calls still arm for non-quick commands (default isQuickCommand=false).
  assert.equal(shouldArmHeadlessIdleTimeout(1, 0, false), true)
  // Interactive tools in flight always disarm, even for quick commands.
  assert.equal(shouldArmHeadlessIdleTimeout(0, 1, true), false)
})

test('hasDeterministicNoWorkTail: detects select -> input -> notify(cancelled)', () => {
  const recentEvents = [
    { type: 'extension_ui_request', detail: 'select: choose milestone' },
    { type: 'extension_ui_request', detail: 'input: provide context' },
    { type: 'extension_ui_request', detail: 'notify: cancelled' },
  ]
  assert.equal(hasDeterministicNoWorkTail(recentEvents), true)
})

test('hasDeterministicNoWorkTail: returns false for non-cancelled notify', () => {
  const recentEvents = [
    { type: 'extension_ui_request', detail: 'select: choose milestone' },
    { type: 'extension_ui_request', detail: 'input: provide context' },
    { type: 'extension_ui_request', detail: 'notify: continuing' },
  ]
  assert.equal(hasDeterministicNoWorkTail(recentEvents), false)
})

test('classifyHeadlessFinalStatus: deterministic tail maps to no-work-deterministic', () => {
  const status = classifyHeadlessFinalStatus({
    blocked: false,
    exitCode: EXIT_ERROR,
    totalEvents: 11,
    recentEvents: [
      { type: 'extension_ui_request', detail: 'select: choose milestone' },
      { type: 'extension_ui_request', detail: 'input: provide context' },
      { type: 'extension_ui_request', detail: 'notify: cancelled' },
    ],
  })
  assert.equal(status, 'no-work-deterministic')
})

// ─── classifyChildExitWithoutTerminal (#1967) ────────────────────────────

test('classifyChildExitWithoutTerminal: clean child exit with no timeout is success', () => {
  assert.equal(classifyChildExitWithoutTerminal(0, false), EXIT_SUCCESS)
})

test('classifyChildExitWithoutTerminal: clean child exit after timeout keeps error exit code', () => {
  // The parent-initiated --timeout fired, cleanup SIGTERMed the child, and the
  // child shut down cleanly (code 0). That must NOT count as success (#1967).
  assert.equal(classifyChildExitWithoutTerminal(0, true), EXIT_ERROR)
})

test('classifyChildExitWithoutTerminal: non-zero child exit is error regardless of timeout', () => {
  assert.equal(classifyChildExitWithoutTerminal(1, false), EXIT_ERROR)
  assert.equal(classifyChildExitWithoutTerminal(1, true), EXIT_ERROR)
})

test('classifyChildExitWithoutTerminal: null child exit code is error', () => {
  assert.equal(classifyChildExitWithoutTerminal(null, false), EXIT_ERROR)
})

test('timed-out clean child exit classifies as timeout status (#1967)', () => {
  const exitCode = classifyChildExitWithoutTerminal(0, true)
  const status = classifyHeadlessFinalStatus({
    blocked: false,
    exitCode,
    totalEvents: 42,
    recentEvents: [],
  })
  assert.equal(status, 'timeout')
})

test('shouldRestartHeadlessRun: deterministic no-work tail is not restartable', () => {
  const shouldRestart = shouldRestartHeadlessRun({
    exitCode: EXIT_ERROR,
    interrupted: false,
    totalEvents: 11,
    toolCallCount: 0,
    recentEvents: [
      { type: 'extension_ui_request', detail: 'select: choose milestone' },
      { type: 'extension_ui_request', detail: 'input: provide context' },
      { type: 'extension_ui_request', detail: 'notify: cancelled' },
    ],
  })
  assert.equal(shouldRestart, false)
})

test('shouldRestartHeadlessRun: events present but no tool calls → not restartable', () => {
  // totalEvents > 0 but toolCallCount === 0: neither restart condition is met
  const shouldRestart = shouldRestartHeadlessRun({
    exitCode: EXIT_ERROR,
    interrupted: false,
    totalEvents: 6,
    toolCallCount: 0,
    recentEvents: [],
  })
  assert.equal(shouldRestart, false)
})

test('shouldRestartHeadlessRun: tool calls present but totalEvents <= 5 → not restartable', () => {
  // toolCallCount > 0 but totalEvents is not > 5: second restart condition fails
  const shouldRestart = shouldRestartHeadlessRun({
    exitCode: EXIT_ERROR,
    interrupted: false,
    totalEvents: 4,
    toolCallCount: 2,
    recentEvents: [],
  })
  assert.equal(shouldRestart, false)
})
