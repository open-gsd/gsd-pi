// Project/App: gsd-pi
// File Purpose: Copilot Chat language model tools backed by the existing GSD RPC client.

import * as vscode from "vscode";
import type { GsdClient } from "./gsd-client.js";
import {
	assertActiveWorkspaceRoot, assertEmptyToolInput, awaitWithCancellation,
	assertCanonicalProjectProgress, assertCanonicalProjectSnapshot,
} from "./copilot-tools-guards.js";

interface EmptyToolInput {
	[key: string]: never;
}

function toJsonToolResult(value: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2)),
	]);
}

async function readForChat(
	client: GsdClient,
	input: unknown,
	token: vscode.CancellationToken,
	operation: () => Promise<unknown>,
	assertPayload: (value: unknown) => void,
): Promise<vscode.LanguageModelToolResult> {
	assertEmptyToolInput(input);
	const root = client.projectRoot;
	assertWorkspaceRootMatchesClient(root);
	const generation = client.projectContextGeneration;
	if (!client.isConnected || !client.isProjectContextTrusted) {
		throw new Error("GSD project context is not connected or trusted. Restart the GSD agent for this workspace, then retry.");
	}
	let value: unknown;
	try {
		value = await awaitWithCancellation(operation, token);
	} catch {
		if (token.isCancellationRequested) throw new Error("GSD project read was cancelled.");
		throw new Error("GSD project read failed. Restart the agent and retry; update the runtime and extension if the problem persists.");
	}
	// The awaited read can cross a workspace change, reconnect, or session mutation.
	if (token.isCancellationRequested) throw new Error("GSD project read was cancelled.");
	assertWorkspaceRootMatchesClient(client.projectRoot);
	if (client.projectRoot !== root || !client.isConnected || !client.isProjectContextTrusted
		|| client.projectContextGeneration !== generation) {
		throw new Error("GSD project context changed during the read. Restart the agent for this workspace, then retry.");
	}
	assertPayload(value);
	return toJsonToolResult(value);
}

function assertWorkspaceRootMatchesClient(projectRoot: string): void {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	assertActiveWorkspaceRoot(projectRoot, workspaceFolders.map((folder) => folder.uri.fsPath));
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
		return readForChat(this.client, options.input, token,
			() => this.client.getProjectProgress(), assertCanonicalProjectProgress);
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
		return readForChat(this.client, options.input, token,
			() => this.client.getProjectSnapshot(), assertCanonicalProjectSnapshot);
	}
}

export function registerCopilotTools(context: vscode.ExtensionContext, client: GsdClient): void {
	if (typeof vscode.lm.registerTool !== "function") {
		return;
	}
	context.subscriptions.push(
		vscode.lm.registerTool("gsd_project_progress", new ProjectProgressTool(client)),
		vscode.lm.registerTool("gsd_project_snapshot", new ProjectSnapshotTool(client)),
	);
}
