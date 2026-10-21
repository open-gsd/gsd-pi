import type {
  DefaultResourceLoader as DefaultResourceLoaderInstance,
  ModelRegistry as ModelRegistryInstance,
  PackageCommand,
  SettingsManager as SettingsManagerInstance,
} from '@gsd/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, sessionsDir, authFilePath } from './app-paths.js'
import { initResources, buildResourceLoader, bareResourceLoaderOptions, getNewerManagedResourceVersion } from './resource-loader.js'
import { ensureManagedTools } from './tool-bootstrap.js'
import { loadStoredEnvKeys } from './wizard.js'
import { migratePiCredentials } from './pi-migration.js'
import { shouldRunOnboarding, runOnboarding } from './onboarding.js'
import chalk from 'chalk'
import { checkForGsdBrowserUpdates, checkForUpdates } from './update-check.js'
import { shouldBypassManagedResourceMismatchGate } from './cli-policy.js'
import { shouldRedirectAutoToHeadless } from './cli-auto-routing.js'
import { resolvePrintModeExitCode } from './print-mode-exit.js'
import { printHelp, printSubcommandHelp } from './help-text.js'
import { applySecurityOverrides } from './security-overrides.js'
import { validateConfiguredModel } from './startup-model-validation.js'
import { migrateAnthropicDefaultToClaudeCode, migrateGeminiCliDefaultToAntigravity } from './provider-migrations.js'
import { applyModelOverride } from './cli-model-override.js'
import {
  buildHeadlessCommandArgs,
  parseCliArgs,
  runWebCliBranch,
  migrateLegacyFlatSessions,
} from './cli-web-branch.js'
import { stopWebMode } from './web-mode.js'
import { getProjectSessionsDir } from './project-sessions.js'
import { markStartup, printStartupTimings } from './startup-timings.js'
import { applyRtkProcessEnv, GSD_RTK_DISABLED_ENV, isTruthy } from './rtk-shared.js'
import {
  listInstalledExtensions,
  registerPackageExtensions,
  unregisterPackageExtensions,
} from './extension-registry.js'
import type { EnsureRtkResult } from './rtk.js'
import { registerInstalledExtensionPackage } from './extension-registry.js'

type PiCodingAgentModule = typeof import('@gsd/pi-coding-agent')
type AgentCoreModule = typeof import('@gsd/agent-core')
type InteractiveModeModule = typeof import('@gsd/agent-modes/modes/interactive/interactive-mode.js')
type PrintModeModule = typeof import('@gsd/agent-modes/modes/print-mode.js')
type RpcModeModule = typeof import('@gsd/agent-modes/modes/rpc/rpc-mode.js')

let piCodingAgentModulePromise: Promise<PiCodingAgentModule> | undefined
let agentCoreModulePromise: Promise<AgentCoreModule> | undefined
let interactiveModeModulePromise: Promise<InteractiveModeModule> | undefined
let printModeModulePromise: Promise<PrintModeModule> | undefined
let rpcModeModulePromise: Promise<RpcModeModule> | undefined

function loadPiCodingAgentModule(): Promise<PiCodingAgentModule> {
  return (piCodingAgentModulePromise ??= import('@gsd/pi-coding-agent'))
}

function loadAgentCoreModule(): Promise<AgentCoreModule> {
  return (agentCoreModulePromise ??= import('@gsd/agent-core'))
}

function loadInteractiveModeModule(): Promise<InteractiveModeModule> {
  return (interactiveModeModulePromise ??= import('@gsd/agent-modes/modes/interactive/interactive-mode.js'))
}

function loadPrintModeModule(): Promise<PrintModeModule> {
  return (printModeModulePromise ??= import('@gsd/agent-modes/modes/print-mode.js'))
}

function loadRpcModeModule(): Promise<RpcModeModule> {
  return (rpcModeModulePromise ??= import('@gsd/agent-modes/modes/rpc/rpc-mode.js'))
}

// ---------------------------------------------------------------------------
// V8 compile cache — Node 22+ can cache compiled bytecode across runs,
// eliminating repeated parse/compile overhead for unchanged modules.
// Must be set early so dynamic imports (extensions, lazy subcommands) benefit.
// ---------------------------------------------------------------------------
if (parseInt(process.versions.node) >= 22) {
  process.env.NODE_COMPILE_CACHE ??= join(agentDir, '.compile-cache')
}

function exitIfManagedResourcesAreNewer(currentAgentDir: string): void {
  const currentVersion = process.env.GSD_VERSION || '0.0.0'
  const managedVersion = getNewerManagedResourceVersion(currentAgentDir, currentVersion)
  if (!managedVersion) {
    return
  }

  process.stderr.write(
    `[gsd] ${chalk.yellow('Version mismatch detected')}\n` +
    `[gsd] Synced resources are from ${chalk.bold(`v${managedVersion}`)}, but this \`gsd\` binary is ${chalk.dim(`v${currentVersion}`)}.\n` +
    `[gsd] Run ${chalk.bold('npm install -g @opengsd/gsd-pi@latest')} or ${chalk.bold('gsd upgrade')}, then try again.\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Shared helpers used by both the print and interactive code paths
// ---------------------------------------------------------------------------

/**
 * Print the non-interactive-mode error and exit. Called both from the early
 * TTY gate (before heavy init) and from the interactive-mode TTY gate right
 * before `InteractiveMode.run()`. The `includeWebHint` variant also lists
 * `--web` and `headless` as alternatives.
 */
function printNonTtyErrorAndExit(missing: string | undefined, includeWebHint: boolean): never {
  const suffix = missing ? ` but ${missing} not a TTY` : ''
  process.stderr.write(`[gsd] Error: Interactive mode requires a terminal (TTY)${suffix}.\n`)
  process.stderr.write('[gsd] Non-interactive alternatives:\n')
  process.stderr.write('[gsd]   gsd auto                       Auto-mode (pipeable, no TUI)\n')
  process.stderr.write('[gsd]   gsd --print "your message"     Single-shot prompt\n')
  if (includeWebHint) {
    process.stderr.write('[gsd]   gsd --web [path]               Browser-only web mode\n')
  }
  process.stderr.write('[gsd]   gsd --mode rpc                 JSON-RPC over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode mcp                 MCP server over stdin/stdout\n')
  process.stderr.write('[gsd]   gsd --mode text "message"      Text output mode\n')
  if (includeWebHint) {
    process.stderr.write('[gsd]   gsd headless                   Auto-mode without TUI\n')
  }
  process.exit(1)
}

/**
 * Print extension load/conflict errors from an extensions result. Downgrades
 * conflicts with built-in tools to warnings (#1347).
 */
function printExtensionErrors(errors: ReadonlyArray<{ error: string }>): void {
  for (const err of errors) {
    const isConflict = err.error.includes('supersedes') || err.error.includes('conflicts with')
    const prefix = isConflict ? 'Extension conflict' : 'Extension load error'
    process.stderr.write(`[gsd] ${prefix}: ${err.error}\n`)
  }
}

/**
 * Print extension load warnings (non-fatal, e.g. missing declared deps from
 * the topological sort). Complements printExtensionErrors — fatal errors go
 * there, advisory warnings go here.
 */
function printExtensionWarnings(warnings: ReadonlyArray<{ message: string }> | undefined): void {
  if (!warnings) return
  for (const w of warnings) {
    process.stderr.write(`[gsd] Extension warning: ${w.message}\n`)
  }
}

/**
 * Re-apply the validated model to the session when `createAgentSession()`
 * reports that it had to use a fallback. Prevents silently overriding the
 * persisted model of resumed conversations (#3534).
 */
async function reapplyValidatedModelOnFallback(
  session: { setModel(model: { provider: string; id: string }): unknown | Promise<unknown> },
  modelRegistry: ModelRegistryInstance,
  settingsManager: SettingsManagerInstance,
  fallbackMessage: string | undefined,
): Promise<void> {
  if (!fallbackMessage) return
  const validatedProvider = settingsManager.getDefaultProvider()
  const validatedModelId = settingsManager.getDefaultModel()
  if (!validatedProvider || !validatedModelId) return
  const correctModel = modelRegistry.getAvailable()
    .find((m) => m.provider === validatedProvider && m.id === validatedModelId)
  if (!correctModel) return
  try {
    await session.setModel(correctModel)
  } catch {
    // Provider not ready — leave session on its current model
  }
}

let cliFlags: ReturnType<typeof parseCliArgs>
try {
  cliFlags = parseCliArgs(process.argv)
} catch (err) {
  // `--help`/`-h` is a meta-request that must always resolve to help, even when
  // another argument is an unrecognized flag (e.g. `gsd --foo --help`). This
  // mirrors the includes()-based help handling below, which parseCliArgs would
  // otherwise pre-empt by throwing on the unknown flag first.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp(process.env.GSD_VERSION || '0.0.0')
    process.exit(0)
  }
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[gsd] Error: ${message}\n`)
  process.exit(1)
}
const isPrintMode = cliFlags.print || cliFlags.mode !== undefined

// `gsd [subcommand] --help` / `-h` — print help before any subcommand runs.
// loader.ts only catches --help/-h as the *first* arg; here we handle the
// case where it appears later (e.g. `gsd update --help`, `gsd --foo --help`).
// Prefer subcommand-specific help when the first positional is a known
// subcommand, otherwise fall back to general help.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  const helpSubcommand = cliFlags.messages[0]
  const version = process.env.GSD_VERSION || '0.0.0'
  if (!helpSubcommand || !printSubcommandHelp(helpSubcommand, version)) {
    printHelp(version)
  }
  process.exit(0)
}

// RTK bootstrap — runs once per process, memoized via a module-level promise
// so concurrent callers await the same initialization.
let rtkBootstrapPromise: Promise<void> | undefined
async function doRtkBootstrap(): Promise<void> {
  let rtkStatus: EnsureRtkResult | undefined
  let rtkDisabled = isTruthy(process.env[GSD_RTK_DISABLED_ENV])

  // RTK is opt-in via experimental.rtk preference. Default: disabled.
  // Honor GSD_RTK_DISABLED if already explicitly set in the environment
  // (env var takes precedence over preferences for manual override).
  if (!rtkDisabled) {
    const { loadEffectiveGSDPreferences } = await import('./resources/extensions/gsd/preferences.js')
    const prefs = loadEffectiveGSDPreferences()
    const rtkEnabled = prefs?.preferences.experimental?.rtk === true
    if (!rtkEnabled) {
      process.env[GSD_RTK_DISABLED_ENV] = '1'
      rtkDisabled = true
    }
  }
  markStartup('rtkPreferenceCheck')

  if (rtkDisabled) {
    applyRtkProcessEnv(process.env)
    rtkStatus = {
      enabled: false,
      supported: true,
      available: false,
      source: 'disabled',
      reason: `${GSD_RTK_DISABLED_ENV} is set`,
    }
  } else {
    const { bootstrapRtk } = await import('./rtk.js')
    rtkStatus = await bootstrapRtk()
  }
  markStartup('bootstrapRtk')
  if (!rtkStatus.available && rtkStatus.supported && rtkStatus.enabled && rtkStatus.reason) {
    process.stderr.write(`[gsd] Warning: RTK unavailable — continuing without shell-command compression (${rtkStatus.reason}).\n`)
  }
}
function ensureRtkBootstrap(): Promise<void> {
  if (!rtkBootstrapPromise) {
    markStartup('preRtkBootstrap')
    rtkBootstrapPromise = doRtkBootstrap()
  }
  return rtkBootstrapPromise
}

// `gsd update` / `gsd upgrade` — update to the latest version via npm.
// MUST run before exitIfManagedResourcesAreNewer(): when the bundled resource
// manifest is from a newer version than the running binary, every other
// command is blocked — only self-upgrade commands should bypass the gate so the user can
// actually upgrade out of the broken state. See shouldBypassManagedResourceMismatchGate.
if (shouldBypassManagedResourceMismatchGate(cliFlags.messages[0])) {
  const { runUpdate } = await import('./update-cmd.js')
  await runUpdate({ target: cliFlags.messages[1], extraArgs: cliFlags.messages.slice(2) })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Hermes integration subcommand — `gsd hermes install`
// ---------------------------------------------------------------------------
if (cliFlags.messages[0] === 'hermes') {
  const { runHermesIntegrationCommand } = await import('./hermes-integration-install.js')
  const exitCode = await runHermesIntegrationCommand(process.argv)
  process.exit(exitCode)
}

// ---------------------------------------------------------------------------
// Graph subcommand — `gsd graph build|status|query|diff`
// ---------------------------------------------------------------------------
if (cliFlags.messages[0] === 'graph') {
  const sub = cliFlags.messages[1]
  const { buildGraph, writeGraph, graphStatus, graphQuery, graphDiff, resolveGsdRoot } = await import('@opengsd/mcp-server')

  const projectDir = process.cwd()
  const gsdRoot = resolveGsdRoot(projectDir)

  // Projection-write version gating (T003 spike, write side): `graph build`
  // bypasses the DB, so it must consult the schema stamp and refuse to write
  // into a newer project; read-only subcommands warn loudly but keep their
  // read-only semantics. A missing DB keeps current behavior, and the version
  // knowledge stays in the extension (the mcp-server graph code is untouched).
  const { openExistingWorkflowDatabase } = await import('./resources/extensions/gsd/db-workspace.js')
  const dbOpen = openExistingWorkflowDatabase(projectDir)
  const schemaTooNewMessage = !dbOpen.ok && dbOpen.reason === 'schema-too-new' ? dbOpen.error.message : null

  if (!sub || sub === 'build') {
    if (schemaTooNewMessage !== null) {
      process.stderr.write(`[gsd] graph build failed: ${schemaTooNewMessage}\n`)
      process.exit(1)
    }
    try {
      const graph = await buildGraph(projectDir)
      await writeGraph(gsdRoot, graph)
      process.stdout.write(`Graph built: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`)
    } catch (err) {
      process.stderr.write(`[gsd] graph build failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  } else if (sub === 'status') {
    if (schemaTooNewMessage !== null) {
      process.stderr.write(`[gsd] Warning: ${schemaTooNewMessage}\n`)
    }
    try {
      const result = await graphStatus(projectDir)
      if (!result.exists) {
        process.stdout.write('Graph: not built yet. Run: gsd graph build\n')
      } else {
        process.stdout.write(`Graph status:\n`)
        process.stdout.write(`  exists:    ${result.exists}\n`)
        process.stdout.write(`  nodes:     ${result.nodeCount}\n`)
        process.stdout.write(`  edges:     ${result.edgeCount}\n`)
        process.stdout.write(`  stale:     ${result.stale}\n`)
        process.stdout.write(`  ageHours:  ${result.ageHours !== undefined ? result.ageHours.toFixed(2) : 'n/a'}\n`)
        process.stdout.write(`  lastBuild: ${result.lastBuild ?? 'n/a'}\n`)
      }
    } catch (err) {
      process.stderr.write(`[gsd] graph status failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  } else if (sub === 'query') {
    const term = cliFlags.messages[2]
    if (!term) {
      process.stderr.write('Usage: gsd graph query <term>\n')
      process.exit(1)
    }
    if (schemaTooNewMessage !== null) {
      process.stderr.write(`[gsd] Warning: ${schemaTooNewMessage}\n`)
    }
    try {
      const result = await graphQuery(projectDir, term)
      if (result.nodes.length === 0) {
        process.stdout.write(`No nodes found for term: "${term}"\n`)
      } else {
        process.stdout.write(`Query results for "${term}" (${result.nodes.length} nodes, ${result.edges.length} edges):\n`)
        for (const node of result.nodes) {
          process.stdout.write(`  [${node.type}] ${node.label} (${node.confidence})\n`)
        }
      }
    } catch (err) {
      process.stderr.write(`[gsd] graph query failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  } else if (sub === 'diff') {
    if (schemaTooNewMessage !== null) {
      process.stderr.write(`[gsd] Warning: ${schemaTooNewMessage}\n`)
    }
    try {
      const result = await graphDiff(projectDir)
      process.stdout.write(`Graph diff:\n`)
      process.stdout.write(`  nodes added:    ${result.nodes.added.length}\n`)
      process.stdout.write(`  nodes removed:  ${result.nodes.removed.length}\n`)
      process.stdout.write(`  nodes changed:  ${result.nodes.changed.length}\n`)
      process.stdout.write(`  edges added:    ${result.edges.added.length}\n`)
      process.stdout.write(`  edges removed:  ${result.edges.removed.length}\n`)
    } catch (err) {
      process.stderr.write(`[gsd] graph diff failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  } else {
    process.stderr.write(`Unknown graph command: ${sub}\n`)
    process.stderr.write('Commands: build, status, query <term>, diff\n')
    process.exit(1)
  }
  process.exit(0)
}

exitIfManagedResourcesAreNewer(agentDir)

// Early TTY check — must come before heavy initialization to avoid dangling
// handles that prevent process.exit() from completing promptly.
// Subcommands exempt from the early non-TTY guard.
// They are allowed past this gate and must enforce any command-specific TTY
// requirements themselves (for example, `sessions` can be interactive).
// Keep this list in sync with implemented CLI subcommands: if a legitimate
// command is missing here, non-TTY invocation will fail early with a TTY error.
const subcommandsExemptFromEarlyTtyCheck = new Set([
  'auto',
  'config',
  'graph',
  'headless',
  'hermes',
  'read',
  'quick',
  'install',
  'list',
  'remove',
  'sessions',
  'update',
  'upgrade',
  'web',
  'worktree',
  'wt',
])
const isSubcommandExemptFromEarlyTtyCheck = subcommandsExemptFromEarlyTtyCheck.has(cliFlags.messages[0] ?? '')
if (!process.stdin.isTTY && !isPrintMode && !isSubcommandExemptFromEarlyTtyCheck && !cliFlags.listModels && !cliFlags.web) {
  printNonTtyErrorAndExit(undefined, false)
}

const packageCommandNames: ReadonlySet<PackageCommand> = new Set(['install', 'remove', 'list'])
if (packageCommandNames.has(cliFlags.messages[0] as PackageCommand)) {
  const piCodingAgent = await loadPiCodingAgentModule()
  const parsedPackageCommand = piCodingAgent.parsePackageCommand(process.argv.slice(2), packageCommandNames)
  const { runPackageCommand } = piCodingAgent
  const packageCommand = await runPackageCommand({
    appName: 'gsd',
    args: process.argv.slice(2),
    cwd: process.cwd(),
    agentDir,
    stdout: process.stdout,
    stderr: process.stderr,
    allowedCommands: packageCommandNames,
    extensionRegistry: {
      list: () => listInstalledExtensions(process.cwd()).map((entry) => ({
        id: entry.id,
        enabled: entry.enabled,
        scope: entry.source,
        version: entry.version,
        installedFrom: entry.installedFrom,
      })),
      register: ({ source, scope, cwd, extensions }) => {
        registerPackageExtensions(source, scope, cwd, extensions)
      },
      unregister: ({ source, scope, cwd }) => {
        unregisterPackageExtensions(source, scope, cwd)
      },
    },
  })
  if (packageCommand.exitCode === 0 && parsedPackageCommand?.command === 'install' && parsedPackageCommand.source) {
    const settingsManager = piCodingAgent.SettingsManager.create(process.cwd(), agentDir)
    const packageManager = new piCodingAgent.DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager })
    const scope = parsedPackageCommand.local ? 'project' : 'user'
    const installedPath = packageManager.getInstalledPath(parsedPackageCommand.source, scope)
    if (installedPath) {
      registerInstalledExtensionPackage(installedPath, parsedPackageCommand.source, scope)
    }
  }
  if (packageCommand.handled) {
    process.exit(packageCommand.exitCode)
  }
}

// `gsd config` — replay the setup wizard and exit
if (cliFlags.messages[0] === 'config') {
  const { AuthStorage } = await loadPiCodingAgentModule()
  const authStorage = AuthStorage.create(authFilePath)
  loadStoredEnvKeys(authStorage)
  await runOnboarding(authStorage)
  process.exit(0)
}

// `gsd web stop [path|all]` — stop web server before anything else
if (cliFlags.messages[0] === 'web' && cliFlags.messages[1] === 'stop') {
  const webBranch = await runWebCliBranch(cliFlags, {
    stopWebMode,
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir,
  })
  if (webBranch.handled) {
    process.exit(webBranch.exitCode)
  }
}

// `gsd --web [path]` or `gsd web [start] [path]` — launch browser-only web mode
if (cliFlags.web || (cliFlags.messages[0] === 'web' && cliFlags.messages[1] !== 'stop')) {
  await ensureRtkBootstrap()
  const webBranch = await runWebCliBranch(cliFlags, {
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir,
  })
  if (webBranch.handled) {
    process.exit(webBranch.exitCode)
  }
}


// `gsd sessions` — list past sessions and pick one to resume
if (cliFlags.messages[0] === 'sessions') {
  const { SessionManager } = await loadPiCodingAgentModule()
  const cwd = process.cwd()
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  const projectSessionsDir = join(sessionsDir, safePath)

  process.stderr.write(chalk.dim(`Loading sessions for ${cwd}...\n`))
  const sessions = await SessionManager.list(cwd, projectSessionsDir)

  if (sessions.length === 0) {
    process.stderr.write(chalk.yellow('No sessions found for this directory.\n'))
    process.exit(0)
  }

  process.stderr.write(chalk.bold(`\n  Sessions (${sessions.length}):\n\n`))

  const maxShow = 20
  const toShow = sessions.slice(0, maxShow)
  for (let i = 0; i < toShow.length; i++) {
    const s = toShow[i]
    const date = s.modified.toLocaleString()
    const msgs = s.messageCount
    const name = s.name ? ` ${chalk.cyan(s.name)}` : ''
    const preview = s.firstMessage
      ? s.firstMessage.replace(/\n/g, ' ').substring(0, 80)
      : chalk.dim('(empty)')
    const num = String(i + 1).padStart(3)
    process.stderr.write(`  ${chalk.bold(num)}. ${chalk.green(date)} ${chalk.dim(`(${msgs} msgs)`)}${name}\n`)
    process.stderr.write(`       ${chalk.dim(preview)}\n\n`)
  }

  if (sessions.length > maxShow) {
    process.stderr.write(chalk.dim(`  ... and ${sessions.length - maxShow} more\n\n`))
  }

  // Interactive selection
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.bold('  Enter session number to resume (or q to quit): '), resolve)
  })
  rl.close()

  // Clean up stdin state left by readline.createInterface().
  // Without this, downstream TUI initialization gets corrupted listeners and exhibits
  // duplicate terminal I/O. Match the pattern used after onboarding cleanup.
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.setRawMode) process.stdin.setRawMode(false)
  process.stdin.pause()

  const choice = parseInt(answer, 10)
  if (isNaN(choice) || choice < 1 || choice > toShow.length) {
    process.stderr.write(chalk.dim('Cancelled.\n'))
    process.exit(0)
  }

  const selected = toShow[choice - 1]
  process.stderr.write(chalk.green(`\nResuming session from ${selected.modified.toLocaleString()}...\n\n`))

  // Mark for the interactive session below to open this specific session
  cliFlags.continue = true
  cliFlags._selectedSessionPath = selected.path
}

// `gsd read` — JSON read seam for integrations (Hermes 6c)
if (cliFlags.messages[0] === 'read') {
  const { runReadCli } = await import('./read-cli.js')
  process.exit(await runReadCli(process.argv))
}

// `gsd headless` — run auto-mode without TUI
if (cliFlags.messages[0] === 'headless') {
  await ensureRtkBootstrap()
  // Sync bundled resources before headless runs (#3471). Without this,
  // headless-query loads from src/resources/ while auto/interactive load
  // from ~/.gsd/agent/extensions/ — different extension copies diverge.
  initResources(agentDir)
  const { runHeadless, parseHeadlessArgs } = await import('./headless.js')
  await runHeadless(parseHeadlessArgs(process.argv))
  // runHeadless is expected to terminate the process. If it returns, fail loud
  // instead of silently reporting success.
  process.exit(process.exitCode ?? 1)
}

// `gsd quick <task>` — first-class non-interactive shorthand for
// `gsd headless quick <task>`. Always route through headless, even when a TTY
// is attached, so task arguments can never fall through to the empty composer.
if (cliFlags.messages[0] === 'quick') {
  initResources(agentDir)
  await runHeadlessCommand(buildHeadlessCommandArgs(cliFlags))
}

/**
 * Run a headless command by invoking the headless entrypoint with a synthetic
 * argv. Shared by CLI shorthands so they use the same bootstrap and dynamic
 * import path as `gsd headless`.
 */
async function runHeadlessCommand(headlessArgs: string[]): Promise<never> {
  await ensureRtkBootstrap()
  const { runHeadless, parseHeadlessArgs } = await import('./headless.js')
  const argv = [process.argv[0], process.argv[1], 'headless', ...headlessArgs]
  await runHeadless(parseHeadlessArgs(argv))
  // runHeadless should not return; preserve any explicit exitCode and default
  // to failure if control reaches here.
  process.exit(process.exitCode ?? 1)
}

function flushPendingProviderRegistrations(resourceLoader: DefaultResourceLoaderInstance, modelRegistry: ModelRegistryInstance): void {
  const { runtime } = resourceLoader.getExtensions()
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    modelRegistry.registerProvider(name, config)
  }
  runtime.pendingProviderRegistrations = []
}

/** Providers like Ollama register on session_start; probe them for --list-models. */
async function probeDeferredProvidersForListModels(modelRegistry: ModelRegistryInstance): Promise<void> {
  try {
    const { probeAndRegister } = await import('./resources/extensions/ollama/index.js')
    const pi = {
      registerProvider(name: string, config: Parameters<ModelRegistryInstance['registerProvider']>[1]) {
        modelRegistry.registerProvider(name, config)
      },
      unregisterProvider(name: string) {
        modelRegistry.unregisterProvider(name)
      },
    }
    await probeAndRegister(pi as Parameters<typeof probeAndRegister>[0])
  } catch {
    // Non-fatal — local Ollama is optional.
  }
}

// `gsd auto [args...]` with piped stdin/stdout — shorthand for
// `gsd headless auto [args...]` (#2732). Keep terminal TTY launches in the
// interactive path so Warp/iTerm/Terminal retain foreground ownership.
if (shouldRedirectAutoToHeadless(cliFlags.messages[0], process.stdin.isTTY, process.stdout.isTTY)) {
  await runHeadlessCommand(buildHeadlessCommandArgs(cliFlags))
}

// ---------------------------------------------------------------------------
// Worktree subcommand — `gsd worktree <list|merge|clean|remove>`
// ---------------------------------------------------------------------------
if (
  !isPrintMode &&
  cliFlags.listModels === undefined &&
  (cliFlags.messages[0] === 'worktree' || cliFlags.messages[0] === 'wt')
) {
  const { handleList, handleMerge, handleClean, handleRemove } = await import('./worktree-cli.js')
  const sub = cliFlags.messages[1]
  const subArgs = cliFlags.messages.slice(2)

  if (!sub || sub === 'list') {
    await handleList(process.cwd())
  } else if (sub === 'merge') {
    await handleMerge(process.cwd(), subArgs)
  } else if (sub === 'clean') {
    await handleClean(process.cwd())
  } else if (sub === 'remove' || sub === 'rm') {
    await handleRemove(process.cwd(), subArgs)
  } else {
    process.stderr.write(`Unknown worktree command: ${sub}\n`)
    process.stderr.write('Commands: list, merge [name], clean, remove <name>\n')
  }
  process.exit(0)
}

const {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  SessionManager,
} = await loadPiCodingAgentModule()
const { createAgentSession } = await loadAgentCoreModule()
markStartup('loadPiCodingAgent')

// Pi's tool bootstrap can mis-detect already-installed fd/rg on some systems
// because spawnSync(..., ["--version"]) returns EPERM despite a zero exit code.
// Provision local managed binaries first so Pi sees them without probing PATH.
ensureManagedTools(join(agentDir, 'bin'))
markStartup('ensureManagedTools')

const authStorage = AuthStorage.create(authFilePath)
markStartup('AuthStorage.create')
loadStoredEnvKeys(authStorage)
migratePiCredentials(authStorage)

// Resolve models.json path
const { resolveModelsJsonPath } = await import('./models-resolver.js')
const modelsJsonPath = resolveModelsJsonPath()

const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath)
markStartup('ModelRegistry')
const settingsManager = SettingsManager.create(process.cwd(), agentDir)
applySecurityOverrides(settingsManager)
markStartup('SettingsManager.create')
const { configureHttpDispatcher } = await import('@gsd/pi-coding-agent/core/http-dispatcher.js')
configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())
markStartup('configureHttpDispatcher')

// Run onboarding wizard on first launch (no LLM provider configured)
if (!isPrintMode && shouldRunOnboarding(authStorage, settingsManager.getDefaultProvider())) {
  await runOnboarding(authStorage)

  // Clean up stdin state left by @clack/prompts.
  // readline.emitKeypressEvents() adds a permanent data listener and
  // readline.createInterface() may leave stdin paused. Remove stale
  // listeners and pause stdin so the TUI can start with a clean slate.
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('keypress')
  if (process.stdin.setRawMode) process.stdin.setRawMode(false)
  process.stdin.pause()
}

// Update check — non-blocking banner check; interactive prompt deferred to avoid
// blocking startup. The passive checkForUpdates() prints a banner if an update is
// available (using cached data or a background fetch) without blocking the TUI.
if (!isPrintMode) {
  checkForUpdates().catch(() => {})
  checkForGsdBrowserUpdates().catch(() => {})
}

// Warn if terminal is too narrow for readable output
if (!isPrintMode && process.stdout.columns && process.stdout.columns < 40) {
  process.stderr.write(
    chalk.yellow(`[gsd] Terminal width is ${process.stdout.columns} columns (minimum recommended: 40). Output may be unreadable.\n`),
  )
}

// --list-models: load extensions so that extension-registered providers (e.g.
// pi-claude-cli) appear in the listing, then flush their pending registrations
// into the model registry before printing.
if (cliFlags.listModels !== undefined) {
  exitIfManagedResourcesAreNewer(agentDir)
  initResources(agentDir)
  const { prepareModelRegistryForListing } = await import('@gsd/agent-modes/cli/prepare-model-registry.js')
  const { listModels } = await import('@gsd/agent-modes/cli/list-models.js')
  await prepareModelRegistryForListing(modelRegistry, {
    agentDir,
    cwd: process.cwd(),
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
    afterLoad: async (registry) => {
      await probeDeferredProvidersForListModels(registry)
      try {
        const { resolveDisabledModelProvidersFromPreferences } = await import('./resources/extensions/gsd/preferences.js')
        registry.setDisabledModelProviders(resolveDisabledModelProvidersFromPreferences())
      } catch {
        // Non-fatal: list all ready providers when preferences cannot be loaded.
      }
    },
  })
  const searchPattern = typeof cliFlags.listModels === 'string' ? cliFlags.listModels : undefined
  await listModels(modelRegistry, { searchPattern })
  process.exit(0)
}

// GSD always uses quiet startup — the gsd extension renders its own branded header
if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true)
}

// Collapse changelog by default — avoid wall of text on updates
if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true)
}
markStartup('startupSettings')

// ---------------------------------------------------------------------------
// Print / subagent mode — single-shot execution, no TTY required
// ---------------------------------------------------------------------------
if (isPrintMode) {
  await ensureRtkBootstrap()
  const sessionManager = cliFlags.noSession
    ? SessionManager.inMemory()
    : cliFlags.session
      ? SessionManager.open(cliFlags.session, cliFlags.sessionDir)
      : SessionManager.create(process.cwd(), cliFlags.sessionDir)

  // Read --append-system-prompt file content (subagent writes agent system prompts to temp files)
  let appendSystemPrompt: string | undefined
  if (cliFlags.appendSystemPrompt) {
    try {
      appendSystemPrompt = readFileSync(cliFlags.appendSystemPrompt, 'utf-8')
    } catch {
      // If it's not a file path, treat it as literal text
      appendSystemPrompt = cliFlags.appendSystemPrompt
    }
  }

  exitIfManagedResourcesAreNewer(agentDir)
  initResources(agentDir)
  markStartup('initResources')
  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    cwd: process.cwd(),
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
    appendSystemPrompt: appendSystemPrompt ? [appendSystemPrompt] : undefined,
    // --bare (forwarded by headless/MCP to this RPC child): minimal context.
    ...bareResourceLoaderOptions(cliFlags.bare),
  })
  await resourceLoader.reload()
  markStartup('resourceLoader.reload')
  flushPendingProviderRegistrations(resourceLoader, modelRegistry)
  migrateAnthropicDefaultToClaudeCode({
    authStorage,
    isClaudeCodeReady: () => modelRegistry.isProviderRequestReady('claude-code'),
    settingsManager,
    modelRegistry,
  })
  migrateGeminiCliDefaultToAntigravity({
    authStorage,
    isAntigravityReady: () => modelRegistry.isProviderRequestReady('google-antigravity'),
    settingsManager,
    modelRegistry,
  })

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
  })
  markStartup('createAgentSession')

  // Validate configured model AFTER extensions have registered their models (#2626).
  // Before this, extension-provided models (e.g. claude-code/*) were not yet in the
  // registry, causing the user's valid choice to be silently overwritten.
  validateConfiguredModel(modelRegistry, settingsManager)
  await reapplyValidatedModelOnFallback(session, modelRegistry, settingsManager, modelFallbackMessage)
  printExtensionErrors(extensionsResult.errors)
  printExtensionWarnings(extensionsResult.warnings)

  applyModelOverride(session, modelRegistry, cliFlags.model)
  if (cliFlags.thinking) session.setThinkingLevel(cliFlags.thinking)

  const mode = cliFlags.mode || 'text'

  if (mode === 'rpc') {
    const { runRpcMode } = await loadRpcModeModule()
    printStartupTimings()
    await runRpcMode(session)
    process.exit(0)
  }

  if (mode === 'mcp') {
    printStartupTimings()
    const { startMcpServer } = await import('./mcp-server.js')
    const { buildMcpModeTools } = await import('./mcp-mode-tools.js')

    // Activate every registered tool before starting the MCP transport.
    // `session.agent.state.tools` is the *active* subset, not the full
    // registry — if we expose only the active set, extension-registered
    // tools (gsd workflow, browser-tools, mac-tools, search-the-web, …)
    // are invisible to MCP clients. Flipping the active set to every
    // known tool name makes `state.tools` mirror the full registry for
    // this MCP session, which is what an external client expects.
    const allToolNames = session.getAllTools().map((t) => t.name)
    session.setActiveToolsByName(allToolNames)
    const tools = await buildMcpModeTools(session.agent.state.tools ?? [])

    await startMcpServer({
      tools,
      version: process.env.GSD_VERSION || '0.0.0',
    })
    // MCP server runs until the transport closes; keep alive
    await new Promise(() => {})
  }

  const { runPrintMode } = await loadPrintModeModule()
  printStartupTimings()
  await runPrintMode(session, {
    mode: mode as 'text' | 'json',
    messages: cliFlags.messages,
  })
  // Honor any exit code a slash command or extension handler set during the
  // turn (e.g. a machine-readable verdict for headless orchestrators); default
  // to 0 when none was set.
  process.exit(resolvePrintModeExitCode(process.exitCode))
}

// ---------------------------------------------------------------------------
// Worktree flag (-w) — create/resume a worktree for the interactive session
// ---------------------------------------------------------------------------
if (cliFlags.worktree) {
  const { handleWorktreeFlag } = await import('./worktree-cli.js')
  await handleWorktreeFlag(cliFlags.worktree)
}

// ---------------------------------------------------------------------------
// Active worktree banner — remind user of unmerged worktrees on normal launch
// ---------------------------------------------------------------------------
if (!cliFlags.worktree && !isPrintMode) {
  try {
    const { showWorktreeStatusBanner } = await import('./worktree-status-banner.js')
    showWorktreeStatusBanner(process.cwd())
  } catch { /* non-fatal */ }
}
markStartup('worktreeStatusBanner')

// ---------------------------------------------------------------------------
// Interactive mode — normal TTY session
// ---------------------------------------------------------------------------

await ensureRtkBootstrap()

// Per-directory session storage — same encoding as the upstream SDK so that
// /resume only shows sessions from the current working directory.
const cwd = process.cwd()
const projectSessionsDir = getProjectSessionsDir(cwd)

// Migrate legacy flat sessions: before per-directory scoping, all .jsonl session
// files lived directly in ~/.gsd/sessions/. Move them into the correct per-cwd
// subdirectory so /resume can find them.
migrateLegacyFlatSessions(sessionsDir, projectSessionsDir)

const sessionManager = cliFlags._selectedSessionPath
  ? SessionManager.open(cliFlags._selectedSessionPath, projectSessionsDir)
  : cliFlags.session
    ? SessionManager.open(cliFlags.session, cliFlags.sessionDir)
    : cliFlags.continue
      ? SessionManager.continueRecent(cwd, projectSessionsDir)
      : SessionManager.create(cwd, cliFlags.sessionDir ?? projectSessionsDir)

exitIfManagedResourcesAreNewer(agentDir)
initResources(agentDir)
markStartup('initResources')

// Overlap resource loading with session manager setup — both are independent.
// resourceLoader.reload() is the most expensive step (jiti compilation), so
// starting it early shaves ~50-200ms off interactive startup.
const resourceLoader = await buildResourceLoader(agentDir, {
  additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
  bare: cliFlags.bare,
})
const resourceLoadPromise = resourceLoader.reload()

// While resources load, let session manager finish any async I/O it needs.
// Then await the resource promise before creating the agent session.
await resourceLoadPromise
markStartup('resourceLoader.reload')
flushPendingProviderRegistrations(resourceLoader, modelRegistry)
migrateAnthropicDefaultToClaudeCode({
  authStorage,
  isClaudeCodeReady: () => modelRegistry.isProviderRequestReady('claude-code'),
  settingsManager,
  modelRegistry,
})
migrateGeminiCliDefaultToAntigravity({
  authStorage,
  isAntigravityReady: () => modelRegistry.isProviderRequestReady('google-antigravity'),
  settingsManager,
  modelRegistry,
})
markStartup('providerMigrations')

const { session, extensionsResult, modelFallbackMessage: interactiveFallbackMsg } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
})
markStartup('createAgentSession')

// Validate configured model AFTER extensions have registered their models (#2626).
// Before this, extension-provided models (e.g. claude-code/*) were not yet in the
// registry, causing the user's valid choice to be silently overwritten.
validateConfiguredModel(modelRegistry, settingsManager)
await reapplyValidatedModelOnFallback(session, modelRegistry, settingsManager, interactiveFallbackMsg)
printExtensionErrors(extensionsResult.errors)
printExtensionWarnings(extensionsResult.warnings)

applyModelOverride(session, modelRegistry, cliFlags.model)
if (cliFlags.thinking) session.setThinkingLevel(cliFlags.thinking)

// Restore scoped models from settings on startup.
// The upstream InteractiveMode reads enabledModels from settings when /scoped-models is opened,
// but doesn't apply them to the session at startup — so Ctrl+P cycles all models instead of
// just the saved selection until the user re-runs /scoped-models.
const enabledModelPatterns = settingsManager.getEnabledModels()
if (enabledModelPatterns && enabledModelPatterns.length > 0) {
  const availableModels = modelRegistry.getAvailable()
  const scopedModels: Array<{ model: (typeof availableModels)[number] }> = []
  const seen = new Set<string>()

  for (const pattern of enabledModelPatterns) {
    // Patterns are "provider/modelId" exact strings saved by /scoped-models
    const slashIdx = pattern.indexOf('/')
    if (slashIdx !== -1) {
      const provider = pattern.substring(0, slashIdx)
      const modelId = pattern.substring(slashIdx + 1)
      const model = availableModels.find((m) => m.provider === provider && m.id === modelId)
      if (model) {
        const key = `${model.provider}/${model.id}`
        if (!seen.has(key)) {
          seen.add(key)
          scopedModels.push({ model })
        }
      }
    } else {
      // Fallback: match by model id alone
      const model = availableModels.find((m) => m.id === pattern)
      if (model) {
        const key = `${model.provider}/${model.id}`
        if (!seen.has(key)) {
          seen.add(key)
          scopedModels.push({ model })
        }
      }
    }
  }

  // Only apply if we resolved some models and it's a genuine subset
  if (scopedModels.length > 0 && scopedModels.length < availableModels.length) {
    session.setScopedModels(scopedModels)
  }
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const missing = !process.stdin.isTTY && !process.stdout.isTTY
    ? 'stdin and stdout are'
    : !process.stdin.isTTY
      ? 'stdin is'
      : 'stdout is'
  printNonTtyErrorAndExit(missing, true)
}

const { InteractiveMode } = await loadInteractiveModeModule()
const interactiveMode = new InteractiveMode(session)
markStartup('InteractiveMode')
printStartupTimings()
await interactiveMode.run()
