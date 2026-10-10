// gsd-pi — Claude CLI binary detection for onboarding
// Lightweight check used at onboarding time (before extensions load).
// The full readiness check with caching lives in the claude-code-cli extension.
//
// The probes run on asynchronous child processes so the onboarding UI is
// never frozen while `claude --version` / `claude auth status` run (seconds
// on Windows, where each spawn goes through cmd.exe).
//
// Set GSD_CLAUDE_DEBUG=1 to log probe output to stderr. Useful when
// diagnosing platform-specific detection failures (Issue #4997).

import { keepEventLoopAlive, runCliProbe } from './resources/extensions/shared/cli-readiness.js'

/**
 * Spawn the Claude CLI without triggering Node's DEP0190.
 *
 * Passing `args` together with `shell: true` is deprecated in Node 22+
 * because the args are concatenated into the command string without
 * escaping. On Windows we still need a shell to resolve `.cmd` shims, so
 * we invoke `cmd /c <command> <args...>` explicitly. On POSIX we don't
 * need a shell at all.
 */
export function buildClaudeSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', command, ...args] }
  }
  return { command, args }
}

function spawnClaude(command: string, args: string[], timeout: number): Promise<string> {
  const invocation = buildClaudeSpawnInvocation(command, args)
  return runCliProbe(invocation.command, invocation.args, timeout)
}

/**
 * Platform-correct binary name for the Claude Code CLI.
 *
 * On Windows, npm-global binaries are installed as `.cmd` shims and
 * `execFile` does not auto-resolve the extension — calling bare
 * `claude` would fail with ENOENT even when the CLI is installed and
 * authenticated. Mirrors the `NPM_COMMAND` pattern in
 * `src/resources/extensions/gsd/pre-execution-checks.ts`.
 */
export function getClaudeCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'claude.cmd' : 'claude'
}

export const CLAUDE_COMMAND = getClaudeCommand()

/**
 * Ordered list of binary names to probe for the Claude Code CLI.
 *
 * Windows installs vary: npm-global installs produce a `claude.cmd` shim,
 * direct binary installs produce `claude.exe`, and Git Bash wrappers may
 * expose a bare `claude` shim. Try all three so no valid install is missed.
 */
export function getClaudeCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const command = getClaudeCommand(platform)
  return platform === 'win32' ? [command, 'claude.exe', 'claude'] : [command]
}

const CLAUDE_COMMAND_CANDIDATES: string[] = getClaudeCommandCandidates()

const VERSION_TIMEOUT_MS = 5_000
// Auth probe needs more headroom on Windows because the spawn goes through
// cmd.exe → claude.cmd → node → Claude CLI.
const AUTH_TIMEOUT_MS = 15_000

function debugLog(...parts: unknown[]): void {
  if (process.env.GSD_CLAUDE_DEBUG) {
    process.stderr.write(`[claude-cli-check] ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`)
  }
}

/**
 * Find the first candidate that responds to `--version`. Returns the
 * candidate name on success, null if none worked.
 *
 * On Windows with `shell: true`, a missing candidate surfaces as a
 * non-zero exit from cmd.exe rather than ENOENT — so we cannot rely on
 * the error code to decide "try next". Treat any failure as "try next"
 * for the version probe.
 */
async function findWorkingCommand(): Promise<string | null> {
  for (const command of CLAUDE_COMMAND_CANDIDATES) {
    try {
      await spawnClaude(command, ['--version'], VERSION_TIMEOUT_MS)
      debugLog('version probe ok via', command)
      return command
    } catch (error) {
      debugLog('version probe failed for', command, 'code=', (error as NodeJS.ErrnoException | undefined)?.code)
      continue
    }
  }
  return null
}

/**
 * Decide auth state from `claude auth status` output.
 *
 * Newer Claude CLI builds emit JSON with a `loggedIn` boolean. Older builds
 * emit free-form text. Prefer the structured signal; fall back to a text
 * heuristic. The text heuristic only covers English phrasing.
 */
export function parseAuthStatus(output: string): boolean | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: unknown }
      if (typeof parsed.loggedIn === 'boolean') {
        return parsed.loggedIn
      }
    } catch {
      // Fall through to text heuristic.
    }
  }

  const lower = trimmed.toLowerCase()
  if (/not logged in|no credentials|unauthenticated|not authenticated/.test(lower)) {
    return false
  }
  if (/logged in|authenticated|signed in|email|subscription/.test(lower)) {
    return true
  }
  return null
}

async function probeAuth(command: string): Promise<boolean | null> {
  // Try --json first (newer CLIs).
  try {
    const out = await spawnClaude(command, ['auth', 'status', '--json'], AUTH_TIMEOUT_MS)
    debugLog('auth status --json output:', out.slice(0, 200))
    const parsed = parseAuthStatus(out)
    if (parsed !== null) return parsed
  } catch (error) {
    debugLog('auth status --json threw:', (error as Error).message?.slice(0, 200))
  }

  // Fallback: plain `auth status` (older CLIs that don't accept --json).
  try {
    const out = await spawnClaude(command, ['auth', 'status'], AUTH_TIMEOUT_MS)
    debugLog('auth status output:', out.slice(0, 200))
    return parseAuthStatus(out)
  } catch (error) {
    debugLog('auth status threw:', (error as Error).message?.slice(0, 200))
    return null
  }
}

/**
 * Check if the `claude` binary is installed (regardless of auth state).
 */
export function isClaudeBinaryInstalled(): Promise<boolean> {
  return keepEventLoopAlive(findWorkingCommand().then((command) => command !== null))
}

/**
 * Check if the `claude` CLI is installed AND authenticated.
 */
export function isClaudeCliReady(): Promise<boolean> {
  return keepEventLoopAlive(
    (async () => {
      const command = await findWorkingCommand()
      if (!command) return false
      return (await probeAuth(command)) === true
    })(),
  )
}
