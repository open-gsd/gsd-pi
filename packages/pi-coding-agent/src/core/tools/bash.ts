import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@gsd/pi-agent-core";
import { Container, Text, truncateToWidth } from "@gsd/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../tool-ui/keybinding-hints.js";
import { truncateToVisualLines } from "../tool-ui/visual-truncate.js";
import { theme } from "../../theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	HARD_DEADLINE_MS,
	killProcessTree,
	SIGKILL_GRACE_MS,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getDisplayReason, getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.js";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	// Issue #3095: the model-facing unit is MILLISECONDS, matching the sibling
	// GSD exec tools (gsd_exec / gsd_uat_exec `timeout_ms`) that share this
	// surface. The old seconds-based bare `timeout` made ms values transfer
	// silently and arm ~55-hour deadlines. The executor contract
	// (BashOperations.exec) stays SECONDS so existing implementers are not
	// broken — execute() below owns the single ms→s normalization.
	timeout_ms: Type.Optional(
		Type.Number({
			description:
				"Timeout in milliseconds (optional, no default timeout). 30000 = 30 seconds. Unit is milliseconds, NOT seconds.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			/** Deadline in SECONDS. The bash tool normalizes its ms schema value to seconds exactly once, here (issue #3095). */
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: {
	shellPath?: string;
	loginShell?: boolean;
	/**
	 * Grace (ms) handed to killProcessTree between SIGTERM and SIGKILL.
	 * Defaults to SIGKILL_GRACE_MS. Exposed primarily as a test seam.
	 */
	killGraceMs?: number;
	/**
	 * Delay (ms) AFTER a kill is initiated before the hard deadline force-resolves
	 * the awaiting exec. Defaults to SIGKILL_GRACE_MS + HARD_DEADLINE_MS so it only
	 * fires once SIGKILL has had its grace window. Exposed primarily as a test seam.
	 */
	forceResolveDelayMs?: number;
}): BashOperations {
	const killGraceMs = options?.killGraceMs ?? SIGKILL_GRACE_MS;
	const forceResolveDelayMs = options?.forceResolveDelayMs ?? SIGKILL_GRACE_MS + HARD_DEADLINE_MS;
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			// Hard deadline: a true D-state (uninterruptible-sleep) child never emits
			// `exit`/`close`, so waitForChildProcess(child) would hang forever even after
			// SIGKILL. killProcessTree can send the signals but cannot force-resolve
			// the awaiting caller — the deadline MUST live here, in the caller. It is only
			// ARMED once a kill has been initiated (timeout or abort), and fires
			// `forceResolveDelayMs` later so SIGKILL has had its full grace window first.
			let deadlineHandle: NodeJS.Timeout | undefined;
			let resolveDeadline: ((value: { forceKilled: true }) => void) | undefined;
			const hardDeadlinePromise = new Promise<{ forceKilled: true }>((resolve) => {
				resolveDeadline = resolve;
			});
			const armHardDeadline = () => {
				if (deadlineHandle) return; // already armed by a prior kill
				deadlineHandle = setTimeout(() => {
					resolveDeadline?.({ forceKilled: true });
				}, forceResolveDelayMs);
				if (typeof deadlineHandle === "object" && "unref" in deadlineHandle) deadlineHandle.unref();
			};
			const initiateKill = () => {
				if (child.pid) killProcessTree(child.pid, { graceMs: killGraceMs });
				armHardDeadline();
			};
			const onAbort = () => {
				initiateKill();
			};

			try {
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						initiateKill();
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Race the real termination against the hard deadline. Promise.race ensures
				// the deadline and the real `close` cannot double-resolve the caller.
				const exitPromise = waitForChildProcess(child).then((code) => ({ forceKilled: false as const, code }));
				const raceResult = await Promise.race([exitPromise, hardDeadlinePromise]);
				if (raceResult.forceKilled) {
					// Child never closed (D-state symptom). Stop tracking and force-resolve
					// the awaiting caller with a distinct marker the bash tool renders sanely.
					if (child.pid) untrackDetachedChildPid(child.pid);
					throw new Error("force-killed");
				}
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode: raceResult.code };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (deadlineHandle) clearTimeout(deadlineHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Issue #3095: render the schema's `timeout_ms` value in human form. The raw
 * ms value must never be echoed with an `s` suffix (a 200000ms deadline once
 * rendered as the absurd "(timeout 200000s)"). Sub-second deadlines stay in
 * ms; everything above renders as (possibly fractional) seconds.
 */
function formatTimeoutSuffix(timeoutMs: number | undefined): string {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return "";
	if (timeoutMs < 1000) return theme.fg("muted", ` (timeout ${timeoutMs}ms)`);
	const secs = timeoutMs / 1000;
	const secsText = Number.isInteger(secs) ? String(secs) : secs.toFixed(1);
	return theme.fg("muted", ` (timeout ${secsText}s)`);
}

function formatBashCall(args: { command?: string; timeout_ms?: number } | undefined): string {
	const command = str(args?.command);
	const timeoutSuffix = formatTimeoutSuffix(args?.timeout_ms);
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails & { displayReason?: string };
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getDisplayReason(result.details) ?? getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command. Returns stdout/stderr, truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Full output saved to temp file when truncated.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout_ms }: { command: string; timeout_ms?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			// Issue #3095 — the single ms→s normalization boundary. The schema speaks
			// MILLISECONDS (matching gsd_exec/gsd_uat_exec's `timeout_ms` on the same
			// surface); BashOperations.exec speaks SECONDS and its implementers (local
			// shell, SSH/sandbox examples) keep that contract unchanged. Fractional
			// seconds preserve sub-second deadlines exactly. A legacy seconds-shaped
			// `timeout` argument no longer exists in the schema, so it is ignored
			// rather than silently mis-scaled.
			const timeoutSecs =
				typeof timeout_ms === "number" && Number.isFinite(timeout_ms) && timeout_ms > 0
					? timeout_ms / 1000
					: undefined;
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: timeoutSecs,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					if (err instanceof Error && err.message === "force-killed") {
						// Hard-deadline force-resolve: the child never closed even after SIGKILL
						// (D-state symptom). Surface a distinct marker so an operator/agent can
						// tell this apart from a clean SIGTERM exit. Partial output is preserved.
						const suffix =
							timeoutSecs !== undefined
								? `Command timed out after ${timeoutSecs} seconds (force-killed)`
								: "Command force-killed";
						throw new Error(appendStatus(text, suffix));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
