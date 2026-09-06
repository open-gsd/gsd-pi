// Project/App: gsd-pi
// File Purpose: Copilot Chat language model tools backed by the existing GSD RPC client.

import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";

interface EmptyToolInput {
	[key: string]: never;
}

function toJsonToolResult(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
	]);
}

function assertEmptyInput(input: unknown): void {
	if (input && typeof input === "object" && Object.keys(input).length > 0) {
		throw new Error("GSD project read tools do not accept input parameters. They use the active workspace project.");
	}
}

function readConfirmationMessages(title: string, detail: string): vscode.LanguageModelToolConfirmationMessages {
	return {
		title,
		message: new vscode.MarkdownString(`${detail}\n\nThe result is read-only, but it will be sent to the active chat/model context.`),
	};
}

export class ProjectProgressTool implements vscode.LanguageModelTool<EmptyToolInput> {
	constructor(private readonly client: GsdClient) {}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: "Reading GSD project progress",
			confirmationMessages: readConfirmationMessages(
				"Read GSD project progress",
				"Read the current GSD project progress from the active workspace.",
			),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		return toJsonToolResult(await this.client.getProjectProgress());
	}
}

export class ProjectSnapshotTool implements vscode.LanguageModelTool<EmptyToolInput> {
	constructor(private readonly client: GsdClient) {}

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: "Reading GSD project snapshot",
			confirmationMessages: readConfirmationMessages(
				"Read GSD project snapshot",
				"Read the bounded GSD project snapshot from the active workspace.",
			),
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<EmptyToolInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		return toJsonToolResult(await this.client.getProjectSnapshot());
	}
}

export function registerCopilotTools(context: vscode.ExtensionContext, client: GsdClient): void {
	context.subscriptions.push(
		vscode.lm.registerTool("gsd_project_progress", new ProjectProgressTool(client)),
		vscode.lm.registerTool("gsd_project_snapshot", new ProjectSnapshotTool(client)),
	);
}