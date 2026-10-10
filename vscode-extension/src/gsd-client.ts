// Project/App: gsd-pi
// File Purpose: VS Code extension RPC client for communicating with the GSD agent.

import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";
import type {
	BashResult,
	ModelInfo,
	RpcSessionState,
	RpcSlashCommand,
	ProjectProgress,
	ProjectSnapshot,
	SessionStats,
	ThinkingLevel,
} from "@opengsd/contracts" with { "resolution-mode": "import" };
import { buildGsdClientSpawnPlan } from "./gsd-client-spawn.js";

/**
 * Mirrors the RPC command/response protocol from the GSD agent.
 * Shared command and response payloads come from @opengsd/contracts.
 */
export type { BashResult, ModelInfo, ProjectProgress, ProjectSnapshot, SessionStats, ThinkingLevel };
export type SlashCommand = RpcSlashCommand;

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface AgentEvent {
	type: string;
	[key: string]: unknown;
}

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * Client that spawns `gsd --mode rpc` and communicates via JSON lines
 * over stdin/stdout. Emits VS Code events for streaming responses.
 */
export class GsdClient implements vscode.Disposable {
	private process: ChildProcess | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private requestId = 0;
	private buffer = "";
	private restartCount = 0;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private contextGeneration = 0;
	private contextTrusted = false;
	private restartTimestamps: number[] = [];
	private _autoRetryEnabled = false;

	private readonly _onEvent = new vscode.EventEmitter<AgentEvent>();
	readonly onEvent = this._onEvent.event;

	private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
	readonly onConnectionChange = this._onConnectionChange.event;

	private readonly _onError = new vscode.EventEmitter<string>();
	readonly onError = this._onError.event;

	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly binaryPath: string,
		private readonly cwd: string,
	) {
		this.disposables.push(this._onEvent, this._onConnectionChange, this._onError);
	}

	get isConnected(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	get projectRoot(): string {
		return this.cwd;
	}

	/** Local fences only: no wire version, provenance or project identity is inferred. */
	get projectContextGeneration(): number {
		return this.contextGeneration;
	}

	get isProjectContextTrusted(): boolean {
		return this.contextTrusted && this.isConnected;
	}

	get autoRetryEnabled(): boolean {
		return this._autoRetryEnabled;
	}

	/**
	 * Spawn the GSD agent in RPC mode.
	 */
	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		clearTimeout(this.restartTimer);
		const generation = this.invalidateProjectContext();
		const spawnPlan = buildGsdClientSpawnPlan(this.binaryPath, this.cwd);
		const proc = spawn(spawnPlan.command, spawnPlan.args, spawnPlan.options);
		this.process = proc;

		this.buffer = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			if (this.process !== proc) return;
			this.buffer += chunk.toString("utf8");
			this.drainBuffer(proc);
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			if (this.process !== proc) return;
			const text = chunk.toString("utf8").trim();
			if (text) {
				this._onError.fire(text);
			}
		});

		let startupSettled = false;
		const startupResult = new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				proc.off("spawn", handleSpawn);
				proc.off("error", handleStartupError);
			};
			const handleSpawn = () => {
				if (startupSettled) return;
				startupSettled = true;
				cleanup();
				if (this.process !== proc) {
					reject(new Error("GSD startup context changed. Restart the agent and retry."));
					return;
				}
				this.contextTrusted = this.contextGeneration === generation;
				this._onConnectionChange.fire(true);
				this.restartCount = 0;
				resolve();
			};
			const handleStartupError = (err: NodeJS.ErrnoException) => {
				if (startupSettled) return;
				startupSettled = true;
				cleanup();
				if (this.process !== proc) {
					reject(new Error("GSD startup context changed. Restart the agent and retry."));
					return;
				}
				this.process = null;
				this.invalidateProjectContext();
				this.rejectAllPending("GSD startup failed. Restart the agent and retry.");
				const hint = err.code === "ENOENT"
					? ` Make sure GSD is installed ("npm install -g @opengsd/gsd-pi") and set "gsd.binaryPath" to the absolute path if it is not on PATH.`
					: "";
				const message = `Failed to start GSD process: ${err.message}.${hint}`;
				this._onError.fire(message);
				reject(new Error(message));
			};

			proc.once("spawn", handleSpawn);
			proc.once("error", handleStartupError);
		});

		proc.on("error", (err: NodeJS.ErrnoException) => {
			if (!startupSettled || this.process !== proc) return;
			this.process = null;
			this.invalidateProjectContext();
			this.rejectAllPending("GSD process failed. Restart the agent and retry.");
			this._onConnectionChange.fire(false);
			const hint = err.code === "ENOENT"
				? ` Make sure GSD is installed ("npm install -g @opengsd/gsd-pi") and set "gsd.binaryPath" to the absolute path if it is not on PATH.`
				: "";
			this._onError.fire(`GSD process error: ${err.message}.${hint}`);
		});

		proc.on("exit", (code, signal) => {
			if (this.process !== proc) return;
			this.process = null;
			const exitGeneration = this.invalidateProjectContext();
			this.rejectAllPending(`GSD process exited (code=${code}, signal=${signal})`);
			this._onConnectionChange.fire(false);

			if (code !== 0 && signal !== "SIGTERM") {
				const now = Date.now();
				this.restartTimestamps.push(now);
				// Keep only timestamps within the last 60 seconds
				this.restartTimestamps = this.restartTimestamps.filter(t => now - t < 60_000);

				if (this.restartTimestamps.length > 3) {
					// Too many crashes within 60s — stop retrying
					this._onError.fire(
						`GSD process crashed ${this.restartTimestamps.length} times within 60s. Not restarting. Use "GSD: Start Agent" to retry manually.`,
					);
				} else if (this.restartCount < 3) {
					this.restartCount++;
					this.restartTimer = setTimeout(() => {
						if (this.contextGeneration !== exitGeneration || this.process) return;
						void this.start().catch(() => this._onError.fire("GSD restart failed. Start the agent and retry."));
					}, 1000 * this.restartCount);
				}
			}
		});

		await startupResult;
	}

	/**
	 * Stop the GSD agent process.
	 */
	async stop(): Promise<void> {
		clearTimeout(this.restartTimer);
		this.invalidateProjectContext();
		const proc = this.process;
		this.process = null;
		this.rejectAllPending("GSD client stopped. Restart the agent and retry.");
		this._onConnectionChange.fire(false);
		if (!proc) return;
		proc.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 2000);
			proc.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Send a prompt message to the agent.
	 * Returns once the command is acknowledged; streaming events follow via onEvent.
	 */
	async sendPrompt(message: string): Promise<void> {
		const response = await this.send({ type: "prompt", message });
		this.assertSuccess(response);
	}

	/**
	 * Interrupt the agent with a steering message while it is streaming.
	 */
	async steer(message: string): Promise<void> {
		const response = await this.send({ type: "steer", message });
		this.assertSuccess(response);
	}

	/**
	 * Send a follow-up message after the agent has completed.
	 */
	async followUp(message: string): Promise<void> {
		const response = await this.send({ type: "follow_up", message });
		this.assertSuccess(response);
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		const response = await this.send({ type: "abort" });
		this.assertSuccess(response);
	}

	// =========================================================================
	// State
	// =========================================================================

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		this.assertSuccess(response);
		return response.data as RpcSessionState;
	}

	// =========================================================================
	// Model
	// =========================================================================

	/**
	 * Set the active model.
	 */
	async setModel(provider: string, modelId: string): Promise<void> {
		const response = await this.send({ type: "set_model", provider, modelId });
		this.assertSuccess(response);
	}

	/**
	 * Get available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		this.assertSuccess(response);
		return (response.data as { models: ModelInfo[] }).models;
	}

	/**
	 * Cycle through available models.
	 */
	async cycleModel(): Promise<{ model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null> {
		const response = await this.send({ type: "cycle_model" });
		this.assertSuccess(response);
		return response.data as { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	}

	// =========================================================================
	// Thinking
	// =========================================================================

	/**
	 * Set the thinking level explicitly.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const response = await this.send({ type: "set_thinking_level", level });
		this.assertSuccess(response);
	}

	/**
	 * Cycle through thinking levels (off -> low -> medium -> high -> off).
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		this.assertSuccess(response);
		return response.data as { level: ThinkingLevel } | null;
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the conversation context.
	 */
	async compact(customInstructions?: string): Promise<unknown> {
		const cmd: Record<string, unknown> = { type: "compact" };
		if (customInstructions) {
			cmd.customInstructions = customInstructions;
		}
		const response = await this.send(cmd);
		this.assertSuccess(response);
		return response.data;
	}

	/**
	 * Enable or disable automatic compaction.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		const response = await this.send({ type: "set_auto_compaction", enabled });
		this.assertSuccess(response);
	}

	// =========================================================================
	// Retry
	// =========================================================================

	/**
	 * Enable or disable automatic retry on failure.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		const response = await this.send({ type: "set_auto_retry", enabled });
		this.assertSuccess(response);
		this._autoRetryEnabled = enabled;
	}

	/**
	 * Abort a pending retry.
	 */
	async abortRetry(): Promise<void> {
		const response = await this.send({ type: "abort_retry" });
		this.assertSuccess(response);
	}

	// =========================================================================
	// Bash
	// =========================================================================

	/**
	 * Execute a bash command via the agent.
	 */
	async runBash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		this.assertSuccess(response);
		return response.data as BashResult;
	}

	/**
	 * Abort a running bash command.
	 */
	async abortBash(): Promise<void> {
		const response = await this.send({ type: "abort_bash" });
		this.assertSuccess(response);
	}

	// =========================================================================
	// Session
	// =========================================================================

	/**
	 * Start a new session.
	 */
	async newSession(): Promise<void> {
		const response = await this.mutateSession({ type: "new_session" });
		this.assertSuccess(response);
		this._autoRetryEnabled = false;
	}

	/**
	 * Get session statistics (token counts, cost, etc.).
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		this.assertSuccess(response);
		return response.data as SessionStats;
	}

	async getProjectProgress(): Promise<ProjectProgress | null> {
		return this.readProjectContext<ProjectProgress>("get_project_progress");
	}

	async getProjectSnapshot(): Promise<ProjectSnapshot | null> {
		return this.readProjectContext<ProjectSnapshot>("get_project_snapshot");
	}

	/**
	 * Export the conversation as HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const cmd: Record<string, unknown> = { type: "export_html" };
		if (outputPath) {
			cmd.outputPath = outputPath;
		}
		const response = await this.send(cmd);
		this.assertSuccess(response);
		return response.data as { path: string };
	}

	/**
	 * Switch to a different session file.
	 */
	async switchSession(sessionPath: string): Promise<void> {
		const response = await this.mutateSession({ type: "switch_session", sessionPath });
		this.assertSuccess(response);
	}

	/**
	 * Set the display name for the current session.
	 */
	async setSessionName(name: string): Promise<void> {
		const response = await this.send({ type: "set_session_name", name });
		this.assertSuccess(response);
	}

	/**
	 * Get all conversation messages.
	 */
	async getMessages(): Promise<unknown[]> {
		const response = await this.send({ type: "get_messages" });
		this.assertSuccess(response);
		return (response.data as { messages: unknown[] }).messages;
	}

	/**
	 * Get the text of the last assistant response.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		this.assertSuccess(response);
		return (response.data as { text: string | null }).text;
	}

	/**
	 * List available slash commands.
	 */
	async getCommands(): Promise<SlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		this.assertSuccess(response);
		return (response.data as { commands: SlashCommand[] }).commands;
	}

	// =========================================================================
	// Fork
	// =========================================================================

	/**
	 * Get messages that can be used as fork points.
	 */
	async getForkMessages(): Promise<{ entryId: string; text: string }[]> {
		const response = await this.send({ type: "get_fork_messages" });
		this.assertSuccess(response);
		return (response.data as { messages: { entryId: string; text: string }[] }).messages;
	}

	/**
	 * Fork the session at the given entry point.
	 */
	async forkSession(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.mutateSession({ type: "fork", entryId });
		this.assertSuccess(response);
		return response.data as { text: string; cancelled: boolean };
	}

	// =========================================================================
	// Queue Modes
	// =========================================================================

	/**
	 * Set steering queue mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		const response = await this.send({ type: "set_steering_mode", mode });
		this.assertSuccess(response);
	}

	/**
	 * Set follow-up queue mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		const response = await this.send({ type: "set_follow_up_mode", mode });
		this.assertSuccess(response);
	}

	dispose(): void {
		this.stop();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	// -- Private helpers ------------------------------------------------------

	private invalidateProjectContext(): number {
		this.contextTrusted = false;
		return ++this.contextGeneration;
	}

	private async mutateSession(command: Record<string, unknown>): Promise<RpcResponse> {
		const priorTrust = this.isProjectContextTrusted;
		const proc = this.process;
		const generation = this.invalidateProjectContext();
		const response = await this.send(command);
		// Only explicit cancellation proves the previous session stayed selected. A successful
		// arbitrary switch has no independently verified root; even new/fork cannot upgrade trust.
		if (this.process === proc && this.contextGeneration === generation && this.isConnected
			&& response.command === command.type && response.success === true && !("error" in response) && !("isError" in response)
			&& response.data !== null && typeof response.data === "object" && !Array.isArray(response.data)
			&& (response.data as { cancelled?: unknown }).cancelled === true) {
			this.contextTrusted = priorTrust;
		}
		return response;
	}

	private async readProjectContext<T>(command: string): Promise<T | null> {
		const generation = this.contextGeneration;
		try {
			const response = await this.send({ type: command });
			if (!this.isConnected || this.contextGeneration !== generation || response.command !== command
				|| response.success !== true || "error" in response || "isError" in response) throw new Error();
			return response.data as T | null;
		} catch {
			// Runtime exceptions and rejected envelopes may contain project text or paths.
			throw new Error("GSD project read failed or its context changed. Restart the agent and retry; update the runtime and extension if the problem persists.");
		}
	}

	private drainBuffer(proc: ChildProcess): void {
		while (this.process === proc) {
			const newlineIdx = this.buffer.indexOf("\n");
			if (newlineIdx === -1) {
				break;
			}
			let line = this.buffer.slice(0, newlineIdx);
			this.buffer = this.buffer.slice(newlineIdx + 1);

			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			if (!line) {
				continue;
			}
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line);
		} catch {
			return; // ignore non-JSON lines
		}

		if (data === null || typeof data !== "object" || Array.isArray(data)) return;

		// Response to a pending request
		if (data.type === "response" && typeof data.id === "string" && this.pendingRequests.has(data.id)) {
			const pending = this.pendingRequests.get(data.id)!;
			this.pendingRequests.delete(data.id);
			clearTimeout(pending.timer);
			pending.resolve(data as unknown as RpcResponse);
			return;
		}

		// Extension UI request — agent needs user input
		if (data.type === "extension_ui_request" && typeof data.id === "string") {
			void this.handleUIRequest(data, this.process, this.contextGeneration);
			return;
		}

		// Streaming event
		this._onEvent.fire(data as AgentEvent);
	}

	private async handleUIRequest(request: Record<string, unknown>, proc: ChildProcess | null, generation: number): Promise<void> {
		// A prompt can outlive its process or session. Never send its answer to a replacement.
		const sendResponse = (data: Record<string, unknown>) => {
			if (proc && this.process === proc && this.contextGeneration === generation) this.sendRaw(data);
		};
		const id = request.id as string;
		const method = request.method as string;

		try {
			switch (method) {
				case "select": {
					const options = (request.options as string[]) ?? [];
					const title = String(request.title ?? "Select");
					const allowMultiple = request.allowMultiple === true;

					if (allowMultiple) {
						const picked = await vscode.window.showQuickPick(options, {
							title,
							canPickMany: true,
						});
						if (picked) {
							sendResponse({ type: "extension_ui_response", id, values: picked });
						} else {
							sendResponse({ type: "extension_ui_response", id, cancelled: true });
						}
					} else {
						const picked = await vscode.window.showQuickPick(options, { title });
						if (picked) {
							sendResponse({ type: "extension_ui_response", id, value: picked });
						} else {
							sendResponse({ type: "extension_ui_response", id, cancelled: true });
						}
					}
					break;
				}

				case "confirm": {
					const title = String(request.title ?? "Confirm");
					const message = String(request.message ?? "");
					const result = await vscode.window.showInformationMessage(
						`${title}: ${message}`,
						{ modal: true },
						"Yes",
						"No",
					);
					sendResponse({ type: "extension_ui_response", id, confirmed: result === "Yes" });
					break;
				}

				case "input": {
					const title = String(request.title ?? "Input");
					const placeholder = String(request.placeholder ?? "");
					const value = await vscode.window.showInputBox({ title, placeHolder: placeholder });
					if (value !== undefined) {
						sendResponse({ type: "extension_ui_response", id, value });
					} else {
						sendResponse({ type: "extension_ui_response", id, cancelled: true });
					}
					break;
				}

				case "notify": {
					const message = String(request.message ?? "");
					const notifyType = String(request.notifyType ?? "info");
					if (notifyType === "error") {
						vscode.window.showErrorMessage(`GSD: ${message}`);
					} else if (notifyType === "warning") {
						vscode.window.showWarningMessage(`GSD: ${message}`);
					} else {
						vscode.window.showInformationMessage(`GSD: ${message}`);
					}
					// Notify doesn't need a response
					break;
				}

				default:
					// Unknown method — cancel to unblock the agent
					sendResponse({ type: "extension_ui_response", id, cancelled: true });
					break;
			}
		} catch {
			// On error, cancel to unblock
			sendResponse({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	private sendRaw(data: Record<string, unknown>): void {
		if (this.process?.stdin) {
			this.process.stdin.write(JSON.stringify(data) + "\n");
		}
	}

	private send(command: Record<string, unknown>): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			return Promise.reject(new Error("GSD client not started"));
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id };

		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 30_000);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.process!.stdin!.write(JSON.stringify(fullCommand) + "\n");
		});
	}

	private assertSuccess(response: RpcResponse): void {
		if (!response.success) {
			throw new Error(response.error ?? "Unknown RPC error");
		}
	}

	private rejectAllPending(reason: string): void {
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pendingRequests.clear();
	}
}
