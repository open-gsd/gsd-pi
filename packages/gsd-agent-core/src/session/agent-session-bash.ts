import { type BashResult, executeBashWithOperations } from "../bash-executor.js";
import type { BashExecutionMessage } from "@gsd/pi-coding-agent/core/messages.js";
import { type BashOperations, createLocalBashOperations } from "@gsd/pi-coding-agent/core/tools/bash.js";
import type { AgentSessionHost } from "./agent-session-host.js";

export class AgentSessionBashModule {
	constructor(readonly host: AgentSessionHost) {}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; loginShell?: boolean },
	): Promise<BashResult> {
		this.host._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.host.settingsManager.getShellCommandPrefix();
		const shellPath = this.host.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.host.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this.host._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.host._bashAbortController = undefined;
		}
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.host.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.host._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.host.agent.state.messages.push(bashMessage);

			// Save to session
			this.host.sessionManager.appendMessage(bashMessage);
		}
	}

	abortBash(): void {
		this.host._bashAbortController?.abort();
	}

	get isBashRunning(): boolean {
		return this.host._bashAbortController !== undefined;
	}

	get hasPendingBashMessages(): boolean {
		return this.host._pendingBashMessages.length > 0;
	}

	flushPendingBashMessages(): void {
		if (this.host._pendingBashMessages.length === 0) return;

		for (const bashMessage of this.host._pendingBashMessages) {
			// Add to agent state
			this.host.agent.state.messages.push(bashMessage);

			// Save to session
			this.host.sessionManager.appendMessage(bashMessage);
		}

		this.host._pendingBashMessages = [];
	}

}
