/**
 * Stop the agent child process together with every process it started.
 *
 * On Windows, `ChildProcess.kill()` ends only the agent process. Shell and
 * tool processes it started keep running with their working directory in the
 * project or milestone worktree and hold it open (#3121). This package has no
 * dependencies, so it cannot use the native process-tree listing that the
 * rest of GSD uses (`terminateProcessTree` in `@gsd/pi-coding-agent`); it ends
 * the tree with `taskkill /F /T` first, then makes the same kill call as
 * before. On other platforms only that kill call runs.
 */

import { ChildProcess, spawnSync } from "node:child_process";

export interface StopChildProcessTreeOptions {
	platform?: NodeJS.Platform;
	/** Ends `pid` and its descendants. Defaults to `taskkill /F /T /PID <pid>`. */
	killTree?: (pid: number) => void;
}

const TASKKILL_TIMEOUT_MS = 10_000;

function taskkillTree(pid: number): void {
	spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
		stdio: "ignore",
		windowsHide: true,
		timeout: TASKKILL_TIMEOUT_MS,
	});
}

export function stopChildProcessTree(
	child: ChildProcess,
	signal: NodeJS.Signals,
	options: StopChildProcessTreeOptions = {},
): boolean {
	const platform = options.platform ?? process.platform;
	// Only a live, real child: an exited child's PID may belong to another
	// process, and test doubles carry made-up PIDs.
	if (
		platform === "win32"
		&& child instanceof ChildProcess
		&& typeof child.pid === "number"
		&& child.pid > 0
		&& child.exitCode === null
		&& child.signalCode === null
	) {
		try {
			(options.killTree ?? taskkillTree)(child.pid);
		} catch {
			// Fall through to the direct kill below.
		}
	}
	return child.kill(signal);
}
