import { ChildProcess } from "node:child_process";
import { listDescendants as nativeListDescendants } from "@gsd/native";

/** The part of a child-process handle that {@link terminateProcessTree} uses. */
export interface TerminableChild {
	readonly pid?: number;
	readonly exitCode: number | null;
	readonly signalCode?: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TerminateProcessTreeOptions {
	/** Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Descendant PIDs of `pid`, parents before children. Defaults to the native engine. */
	listDescendants?: (pid: number) => number[];
	/** Ends one descendant. Defaults to `process.kill(pid, "SIGKILL")`. */
	killDescendant?: (pid: number) => void;
	/**
	 * Treat a handle target as a real child process even when it is not a
	 * `ChildProcess` instance. Only for tests that drive the Windows path with
	 * a fake handle.
	 */
	trustHandle?: boolean;
}

// Processes started while the first pass runs are caught by one more pass.
const DESCENDANT_SWEEPS = 2;

/**
 * Stop a process that GSD started, together with every process it started.
 *
 * On macOS and Linux this is exactly `child.kill(signal)` or
 * `process.kill(pid, signal)`: the target's own signal handling (or its
 * process group) takes its children down, as before.
 *
 * On Windows those calls end only the target (TerminateProcess). Anything it
 * started, such as an agent's shell tool running a script, keeps running with
 * its working directory inside the project or milestone worktree, and holds
 * that directory open until someone ends it (#3121). Here the descendants are
 * listed before the target is killed, the same kill call is made, and then
 * each descendant is ended.
 *
 * The target kill is the same call as before on every platform, so its return
 * value and any error it throws (for a PID target) reach the caller unchanged.
 *
 * Descendants of a handle target are only walked while it is a live
 * `ChildProcess`: once it has exited its PID may belong to another process.
 */
export function terminateProcessTree(
	target: TerminableChild | number,
	signal: NodeJS.Signals = "SIGTERM",
	options: TerminateProcessTreeOptions = {},
): boolean {
	const platform = options.platform ?? process.platform;
	const killTarget = (): boolean => {
		if (typeof target === "number") {
			process.kill(target, signal);
			return true;
		}
		return target.kill(signal);
	};
	if (platform !== "win32") return killTarget();

	const rootPid = windowsTreeRoot(target, options.trustHandle === true);
	if (rootPid === undefined) return killTarget();

	const list = options.listDescendants ?? nativeListDescendants;
	const killDescendant = options.killDescendant ?? ((pid: number) => {
		process.kill(pid, "SIGKILL");
	});
	const ended = new Set<number>([rootPid, process.pid]);
	const endDescendants = (pids: number[]): void => {
		for (const pid of pids) {
			if (ended.has(pid)) continue;
			ended.add(pid);
			try {
				killDescendant(pid);
			} catch {
				// Already gone, or not ours to end.
			}
		}
	};

	const before = safeList(list, rootPid);
	const result = killTarget();
	endDescendants(before);
	for (let sweep = 1; sweep < DESCENDANT_SWEEPS; sweep++) {
		const late = safeList(list, rootPid).filter((pid) => !ended.has(pid));
		if (late.length === 0) break;
		endDescendants(late);
	}
	return result;
}

function windowsTreeRoot(target: TerminableChild | number, trustHandle: boolean): number | undefined {
	if (typeof target === "number") {
		return Number.isInteger(target) && target > 0 && target !== process.pid ? target : undefined;
	}
	if (!trustHandle && !(target instanceof ChildProcess)) return undefined;
	if (target.exitCode !== null || (target.signalCode ?? null) !== null) return undefined;
	const pid = target.pid;
	return typeof pid === "number" && pid > 0 && pid !== process.pid ? pid : undefined;
}

function safeList(list: (pid: number) => number[], pid: number): number[] {
	try {
		return list(pid);
	} catch {
		// Native engine unavailable on this platform build: fall back to the
		// target-only kill rather than failing the stop.
		return [];
	}
}
