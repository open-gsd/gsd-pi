/**
 * Windows spawn for the Claude Code CLI that stops the CLI's whole process
 * tree (#3121).
 *
 * The Agent SDK stops the CLI with `process.kill("SIGTERM")` (on abort, at
 * process exit, and when the CLI is slow to exit after its stdin closes). On
 * Windows that ends the CLI alone. Its Bash-tool processes keep running with
 * their working directory in the milestone worktree and hold it open, so the
 * worktree cannot be removed or recreated until someone ends them.
 *
 * The SDK accepts a custom `spawnClaudeCodeProcess`. This one starts the CLI
 * the way the SDK's own spawn does, and routes every kill through
 * `terminateProcessTree`.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { terminateProcessTree } from "@gsd/pi-coding-agent";

/** Mirrors the SDK's `SpawnOptions` (sdk.d.ts). */
export interface ClaudeCodeSpawnOptions {
	command: string;
	args: string[];
	cwd?: string;
	env: { [envVar: string]: string | undefined };
	signal: AbortSignal;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** Mirrors the SDK's `SpawnedProcess` (sdk.d.ts). */
export interface ClaudeCodeSpawnedProcess {
	stdin: Writable;
	stdout: Readable;
	readonly killed: boolean;
	readonly exitCode: number | null;
	kill(signal: NodeJS.Signals): boolean;
	on(event: "exit", listener: ExitListener): void;
	on(event: "error", listener: ErrorListener): void;
	once(event: "exit", listener: ExitListener): void;
	once(event: "error", listener: ErrorListener): void;
	off(event: "exit", listener: ExitListener): void;
	off(event: "error", listener: ErrorListener): void;
}

export interface TreeTerminatingSpawnDeps {
	/** Receives CLI stderr, like the SDK's `stderr` option. */
	stderr?: (data: string) => void;
	spawn?: (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;
	terminate?: (child: ChildProcess, signal: NodeJS.Signals) => boolean;
}

export function createTreeTerminatingClaudeCodeSpawn(
	deps: TreeTerminatingSpawnDeps = {},
): (options: ClaudeCodeSpawnOptions) => ClaudeCodeSpawnedProcess {
	const spawn = deps.spawn ?? nodeSpawn;
	const terminate = deps.terminate ?? ((child: ChildProcess, signal: NodeJS.Signals) => terminateProcessTree(child, signal));
	return (options) => {
		const pipeStderr = Boolean(options.env.DEBUG_CLAUDE_AGENT_SDK) || deps.stderr !== undefined;
		// `signal` is deliberately not passed to spawn. Node's abort listener is
		// registered before the SDK's and would end the CLI alone; with the CLI
		// gone, nothing links its tool processes to it any more.
		const child = spawn(options.command, options.args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", pipeStderr ? "pipe" : "ignore"],
			env: options.env,
			windowsHide: true,
		});
		if (pipeStderr) {
			child.stderr?.on("data", (data: Buffer | string) => deps.stderr?.(data.toString()));
		}

		let killRequested = false;
		const kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
			if (child.exitCode !== null || child.signalCode !== null) return false;
			killRequested = true;
			return terminate(child, signal);
		};
		const onAbort = (): void => {
			kill("SIGTERM");
		};
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
		child.once("exit", () => options.signal.removeEventListener("abort", onAbort));

		return {
			stdin: child.stdin as Writable,
			stdout: child.stdout as Readable,
			get killed() {
				return killRequested || child.killed;
			},
			get exitCode() {
				return child.exitCode;
			},
			kill,
			on: child.on.bind(child),
			once: child.once.bind(child),
			off: child.off.bind(child),
		};
	};
}
