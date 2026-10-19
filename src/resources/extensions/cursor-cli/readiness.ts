/**
 * Readiness check for the Cursor Agent CLI provider.
 *
 * Nothing here spawns a synchronous child process: the sync accessors read a
 * cache that asynchronous probes refresh (see ../shared/cli-readiness.ts).
 * A stale cache returns the last known answer and re-probes in the
 * background; a cold cache returns `false` (unknown is never reported as
 * ready) and is primed at extension load. Code that must not act on a cold
 * or stale answer awaits settleCursorAgentReadiness().
 */

import {
	createReadinessCache,
	keepEventLoopAlive,
	READINESS_CHECK_INTERVAL_MS,
	runCliProbe,
} from "../shared/cli-readiness.js";

const VERSION_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 10_000;
const LIST_MODELS_TIMEOUT_MS = 15_000;

export function getCursorAgentCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "cursor-agent.cmd" : "cursor-agent";
}

export function getCursorAgentCommandCandidates(platform: NodeJS.Platform = process.platform): string[] {
	const command = getCursorAgentCommand(platform);
	return platform === "win32" ? [command, "cursor-agent.exe", "cursor-agent"] : [command];
}

export function buildCursorAgentSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", command, ...args] };
	}
	return { command, args };
}

function debugLog(...parts: unknown[]): void {
	if (process.env.GSD_CURSOR_DEBUG) {
		process.stderr.write(`[cursor-readiness] ${parts.map((part) => String(part)).join(" ")}\n`);
	}
}

function spawnCursorAgent(command: string, args: string[], timeout: number): Promise<string> {
	const invocation = buildCursorAgentSpawnInvocation(command, args);
	return runCliProbe(invocation.command, invocation.args, timeout);
}

async function findWorkingCommand(): Promise<string | null> {
	for (const command of getCursorAgentCommandCandidates()) {
		try {
			await spawnCursorAgent(command, ["--version"], VERSION_TIMEOUT_MS);
			debugLog("version probe ok via", command);
			return command;
		} catch (error) {
			debugLog("version probe failed for", command, (error as Error).message?.slice(0, 200));
		}
	}
	return null;
}

export function parseCursorAgentStatus(output: string): boolean | null {
	const trimmed = output.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			for (const key of ["authenticated", "loggedIn", "logged_in", "isAuthenticated"]) {
				if (typeof parsed[key] === "boolean") return parsed[key];
			}
		} catch {
			// Fall through to text heuristics.
		}
	}

	const lower = trimmed.toLowerCase();
	if (/not authenticated|not logged in|no credentials|logged out|unauthenticated/.test(lower)) return false;
	if (/authenticated|logged in|signed in|cursor account|subscription/.test(lower)) return true;
	return null;
}

export function isCursorAgentApiKeyValue(value: string | undefined): boolean {
	const trimmed = value?.trim();
	return Boolean(trimmed && trimmed !== "cli");
}

function hasCursorApiKey(): boolean {
	return isCursorAgentApiKeyValue(process.env.CURSOR_API_KEY);
}

async function probeAuth(command: string): Promise<boolean | null> {
	if (hasCursorApiKey()) return true;

	try {
		const out = await spawnCursorAgent(command, ["status"], STATUS_TIMEOUT_MS);
		debugLog("status output", out.slice(0, 200));
		return parseCursorAgentStatus(out);
	} catch (error) {
		debugLog("status failed", (error as Error).message?.slice(0, 200));
	}

	return null;
}

/** One fresh asynchronous probe that bypasses (and does not touch) the cache. */
export function probeCursorAgentReadyUncached(): Promise<boolean> {
	return keepEventLoopAlive(
		(async () => {
			const command = await findWorkingCommand();
			if (!command) return false;
			return (await probeAuth(command)) === true;
		})(),
	);
}

interface CursorAgentReadiness {
	binaryPresent: boolean;
	authed: boolean;
}

async function probeReadiness(previous: CursorAgentReadiness | null): Promise<CursorAgentReadiness> {
	const command = await findWorkingCommand();
	if (!command) {
		return { binaryPresent: false, authed: false };
	}

	const authed = await probeAuth(command);
	if (authed === null) {
		// Soft-fail: keep a previously known auth state, otherwise not authed.
		return { binaryPresent: true, authed: previous?.authed ?? false };
	}
	return { binaryPresent: true, authed };
}

const readinessCache = createReadinessCache<CursorAgentReadiness>({
	probe: probeReadiness,
	intervalMs: READINESS_CHECK_INTERVAL_MS,
});

/** Cached answer; false while the cache is cold. Never blocks. */
export function isCursorAgentBinaryPresent(): boolean {
	return readinessCache.peek()?.binaryPresent ?? false;
}

/** Cached answer; false while the cache is cold. Never blocks. */
export function isCursorAgentReady(): boolean {
	const readiness = readinessCache.peek();
	return (readiness?.binaryPresent ?? false) && (readiness?.authed ?? false);
}

/** Readiness from a probe no older than the cache window. */
export async function settleCursorAgentReadiness(): Promise<boolean> {
	const readiness = await readinessCache.settle();
	return readiness.binaryPresent && readiness.authed;
}

/** Binary presence from a probe no older than the cache window. */
export async function settleCursorAgentBinaryPresent(): Promise<boolean> {
	return (await readinessCache.settle()).binaryPresent;
}

/** Start the first probe in the background. Called at extension load. */
export function primeCursorAgentReadiness(): void {
	readinessCache.peek();
}

export function clearCursorAgentReadinessCache(): void {
	readinessCache.clear();
}

export async function readCursorAgentListModels(): Promise<string | null> {
	const command = await findWorkingCommand();
	if (!command) return null;
	try {
		return await spawnCursorAgent(command, ["--list-models"], LIST_MODELS_TIMEOUT_MS);
	} catch (error) {
		debugLog("list-models failed", (error as Error).message?.slice(0, 200));
		return null;
	}
}
