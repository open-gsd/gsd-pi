// Project/App: gsd-pi
// File Purpose: Stops the GSD agent child together with every process it
// started (#3121).
//
// On Windows, `ChildProcess.kill()` ends only the process it is called on.
// The agent is launched through a command shim (`shell: true`), so that is
// cmd.exe: the agent itself, and the shell and tool processes it started,
// keep running with their working directory in the project and hold it open.
// The extension cannot load GSD's native process-tree listing, so the tree is
// ended with `taskkill /F /T` first, then the same kill call as before is
// made. On other platforms only that kill call runs. Same logic as
// `packages/rpc-client/src/process-tree.ts`.

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
