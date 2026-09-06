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
	if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
		throw new Error("GSD project read tools do not accept input parameters. They use the active workspace project.");
	}
}

function assertSingleWorkspaceRoot(): void {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length !== 1) {
		throw new Error("GSD project read tools require exactly one workspace folder. Open the target project in its own VS Code window.");
	}
}

async function awaitWithCancellation<T>(operation: Promise<T>, token: vscode.CancellationToken): Promise<T> {
	if (token.isCancellationRequested) {
		throw new Error("GSD project read was cancelled.");
	}

	return await new Promise<T>((resolve, reject) => {
		const cancellation = token.onCancellationRequested(() => reject(new Error("GSD project read was cancelled.")));
		operation.then(resolve, reject).finally(() => cancellation.dispose());
	});
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
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		assertSingleWorkspaceRoot();
		if (!this.client.isConnected) {
			throw new Error("GSD agent is not connected. Start the GSD agent, then retry the project progress read.");
		}
		return toJsonToolResult(await awaitWithCancellation(this.client.getProjectProgress(), token));
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
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		assertEmptyInput(options.input);
		assertSingleWorkspaceRoot();
		if (!this.client.isConnected) {
			throw new Error("GSD agent is not connected. Start the GSD agent, then retry the project snapshot read.");
		}
		return toJsonToolResult(await awaitWithCancellation(this.client.getProjectSnapshot(), token));
	}
}

export function registerCopilotTools(context: vscode.ExtensionContext, client: GsdClient): void {
	context.subscriptions.push(
		vscode.lm.registerTool("gsd_project_progress", new ProjectProgressTool(client)),
		vscode.lm.registerTool("gsd_project_snapshot", new ProjectSnapshotTool(client)),
	);
}