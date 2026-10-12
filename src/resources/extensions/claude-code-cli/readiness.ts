/**
 * Readiness check for the Claude Code CLI provider.
 *
 * Verifies the `claude` binary is installed, responsive, AND authenticated.
 *
 * The provider `isReady()` hook is synchronous and runs once per model from
 * the TUI and from auto mode, so nothing here may spawn a synchronous child
 * process: on Windows `claude --version` + `claude auth status` take seconds
 * and froze the UI for that long. The sync accessors only read a cache that
 * asynchronous probes refresh (see ../shared/cli-readiness.ts):
 *
 *  - Fresh cache (< 30 s): the cached answer.
 *  - Stale cache: the last known answer, immediately, plus one background
 *    re-probe that updates the cache for the next call.
 *  - Cold cache (process start, or after clearReadinessCache()): `false`,
 *    plus a background probe. Readiness gates request routing and persisted
 *    default-model migrations, so "unknown" must not be reported as "ready".
 *    The extension primes the cache at load, and code that must not act on a
 *    cold or stale answer awaits settleClaudeCodeReadiness() instead.
 *
 * Auth verification runs `claude auth status --json` and inspects the
 * `loggedIn` field, falling back to plain `claude auth status` and a text
 * heuristic when the JSON shape is unavailable (older Claude CLI builds).
 *
 * Set GSD_CLAUDE_DEBUG=1 to print the probe's binary selection and auth
 * outputs to stderr — useful when diagnosing platform-specific detection
 * failures (Issue #4997).
 */

import { createReadinessCache, READINESS_CHECK_INTERVAL_MS, runCliProbe } from "../shared/cli-readiness.js";

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
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", command, ...args] };
	}
	return { command, args };
}

function spawnClaude(command: string, args: string[], timeout: number): Promise<string> {
	const invocation = buildClaudeSpawnInvocation(command, args);
	return runCliProbe(invocation.command, invocation.args, timeout);
}

/**
 * Candidate executable names for the Claude Code CLI.
 *
 * Keep the explicit win32 ternary selector for regression coverage (Issue #4424):
 * Node's execFile must target `claude.cmd` directly on Windows.
 */
export function getClaudeCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "claude.cmd" : "claude";
}

const CLAUDE_COMMAND = getClaudeCommand();

/**
 * Windows installs vary: some environments expose `claude.cmd` (npm shim),
 * `claude.exe` (direct binary install), or a bare `claude` shim on PATH
 * (for example Git Bash wrappers). Try all three to avoid false "not
 * installed" results in readiness checks.
 */
export function getClaudeCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
	const command = getClaudeCommand(platform);
	return platform === "win32" ? [command, "claude.exe", "claude"] : [command];
}

const CLAUDE_COMMAND_CANDIDATES = getClaudeCommandCandidates();

// Keep the version probe snappy — `claude --version` is a quick path.
const VERSION_TIMEOUT_MS = 5_000;
// Auth status can be much slower on Windows because the spawn goes through
// cmd.exe → claude.cmd → node → Claude CLI. 15s leaves headroom on cold spawns
// without making startup feel hung when the CLI is genuinely missing.
const AUTH_TIMEOUT_MS = 15_000;

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CLAUDE_DEBUG) {
		process.stderr.write(`[claude-readiness] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
	}
}

/**
 * Find the first candidate that responds to `--version`. Returns the
 * candidate name on success, null if none worked.
 *
 * On Windows with `cmd /c`, a missing candidate surfaces as a
 * non-zero exit from cmd.exe rather than ENOENT — so we cannot rely on
 * the error code to decide "try next". Treat any failure as "try next"
 * for the version probe; the only thing that matters for binary
 * detection is whether *some* candidate produces a `claude --version`
 * line.
 */
async function findWorkingCommand(): Promise<string | null> {
	for (const command of CLAUDE_COMMAND_CANDIDATES) {
		try {
			await spawnClaude(command, ["--version"], VERSION_TIMEOUT_MS);
			debugLog("version probe ok via", command);
			return command;
		} catch (error) {
			debugLog("version probe failed for", command, "code=", (error as NodeJS.ErrnoException | undefined)?.code);
			continue;
		}
	}
	return null;
}

/**
 * Decide auth state from `claude auth status` output.
 *
 * Newer Claude CLI builds emit JSON by default with a `loggedIn` boolean.
 * Older builds emit free-form text. We prefer the structured signal and fall
 * back to a text heuristic. Note: the text heuristic only covers English
 * phrasing — the JSON path is the durable signal.
 */
export function parseAuthStatus(output: string): boolean | null {
	const trimmed = output.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { loggedIn?: unknown };
			if (typeof parsed.loggedIn === "boolean") {
				return parsed.loggedIn;
			}
		} catch {
			// Fall through to text heuristic.
		}
	}

	const lower = trimmed.toLowerCase();
	if (/not logged in|no credentials|unauthenticated|not authenticated/.test(lower)) {
		return false;
	}
	if (/logged in|authenticated|signed in|email|subscription/.test(lower)) {
		return true;
	}
	return null;
}

async function probeAuth(command: string): Promise<boolean | null> {
	// Try --json first (newer CLIs).
	try {
		const out = await spawnClaude(command, ["auth", "status", "--json"], AUTH_TIMEOUT_MS);
		debugLog("auth status --json output:", out.slice(0, 200));
		const parsed = parseAuthStatus(out);
		if (parsed !== null) return parsed;
	} catch (error) {
		debugLog("auth status --json threw:", (error as Error).message?.slice(0, 200));
	}

	// Fallback: plain `auth status` (older CLIs that don't accept --json).
	try {
		const out = await spawnClaude(command, ["auth", "status"], AUTH_TIMEOUT_MS);
		debugLog("auth status output:", out.slice(0, 200));
		return parseAuthStatus(out);
	} catch (error) {
		debugLog("auth status threw:", (error as Error).message?.slice(0, 200));
		return null;
	}
}

interface ClaudeReadiness {
	binaryPresent: boolean;
	authed: boolean;
}

/**
 * One full asynchronous probe: binary detection, then auth.
 * Preserves a known auth state across soft-fail auth probes.
 */
async function probeReadiness(previous: ClaudeReadiness | null): Promise<ClaudeReadiness> {
	const command = await findWorkingCommand();
	if (!command) {
		return { binaryPresent: false, authed: false };
	}

	const authed = await probeAuth(command);
	if (authed === null) {
		// Couldn't determine auth state from CLI output. Don't clobber a
		// previously known-good cache; otherwise default to false so we don't
		// silently route requests to an unauthenticated CLI.
		return { binaryPresent: true, authed: previous?.authed ?? false };
	}
	return { binaryPresent: true, authed };
}

const readinessCache = createReadinessCache<ClaudeReadiness>({
	probe: probeReadiness,
	intervalMs: READINESS_CHECK_INTERVAL_MS,
});

/**
 * Whether the `claude` binary is installed (regardless of auth state).
 * Cached answer; false while the cache is cold.
 */
export function isClaudeBinaryPresent(): boolean {
	return readinessCache.peek()?.binaryPresent ?? false;
}

/**
 * Whether the `claude` CLI is authenticated with a valid session.
 * Returns false if the binary is not installed. Cached answer; false while
 * the cache is cold.
 */
export function isClaudeCodeAuthed(): boolean {
	const readiness = readinessCache.peek();
	return (readiness?.binaryPresent ?? false) && (readiness?.authed ?? false);
}

/**
 * Full readiness check: binary installed AND authenticated.
 * This is the gating function used by the provider registration. It never
 * blocks: it returns the cached answer (false while cold) and lets a
 * background probe refresh a stale cache.
 */
export function isClaudeCodeReady(): boolean {
	return isClaudeCodeAuthed();
}

/**
 * Readiness from a probe no older than the cache window. Awaits the
 * in-flight (or a new) probe when the cache is cold or stale; never blocks
 * the event loop.
 */
export async function settleClaudeCodeReadiness(): Promise<boolean> {
	const readiness = await readinessCache.settle();
	return readiness.binaryPresent && readiness.authed;
}

/**
 * Start the first probe in the background so the cache usually has an answer
 * by the time something asks. Called at extension load.
 */
export function primeClaudeCodeReadiness(): void {
	readinessCache.peek();
}

/**
 * Force-clear the cached readiness state.
 * Useful after the user completes auth setup so the next check is fresh.
 */
export function clearReadinessCache(): void {
	readinessCache.clear();
}
