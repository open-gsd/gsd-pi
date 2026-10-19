import { SessionManager } from "./session-manager.js";
import { createMcpServer } from "./server.js";
import { toMoonshotCompatibleInputSchema } from "./moonshot-tool-schema.js";
import { NATIVE_MCP_TOOL_CALL_ID } from "./workflow-tools.js";

export const GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES = [
	"gsd_execute",
	"gsd_status",
	"gsd_result",
	"gsd_cancel",
	"gsd_query",
	"gsd_resolve_blocker",
	"gsd_progress",
	"gsd_roadmap",
	"gsd_history",
	"gsd_doctor",
	"gsd_captures",
	"gsd_knowledge",
	"gsd_graph",
	"ask_user_questions",
] as const;

export interface GenericMcpToolDef {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
	): Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	}>;
}

interface RegisteredMcpTool {
	enabled?: boolean;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	handler?: (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>;
	callback?: (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<unknown>;
}

interface McpServerWithRegisteredTools {
	_registeredTools?: Record<string, RegisteredMcpTool>;
}

const ADAPTER_TOOL_NAME_SET = new Set<string>(GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
}

function normalizeContentBlock(block: unknown): { type: string; text?: string; data?: string; mimeType?: string } {
	if (!isRecord(block) || typeof block.type !== "string") {
		return { type: "text", text: asText(block) };
	}

	const normalized: { type: string; text?: string; data?: string; mimeType?: string } = { type: block.type };
	if (typeof block.text === "string") normalized.text = block.text;
	if (typeof block.data === "string") normalized.data = block.data;
	if (typeof block.mimeType === "string") normalized.mimeType = block.mimeType;
	return normalized;
}

function normalizeMcpToolResult(result: unknown): Awaited<ReturnType<GenericMcpToolDef["execute"]>> {
	if (!isRecord(result)) {
		return { content: [{ type: "text", text: asText(result) }] };
	}

	const content = Array.isArray(result.content)
		? result.content.map(normalizeContentBlock)
		: [{ type: "text", text: asText(result) }];
	const normalized: Awaited<ReturnType<GenericMcpToolDef["execute"]>> = { content };
	if (isRecord(result.structuredContent)) normalized.details = result.structuredContent;
	if (result.isError === true) normalized.isError = true;
	return normalized;
}

function registeredToolHandler(tool: RegisteredMcpTool) {
	return typeof tool.handler === "function" ? tool.handler : tool.callback;
}

export async function createWorkflowMcpAdapterToolDefs(
	sessionManager: SessionManager = new SessionManager(),
): Promise<GenericMcpToolDef[]> {
	const { server } = await createMcpServer(sessionManager, { includeWorkflowTools: false });
	const registeredTools = (server as unknown as McpServerWithRegisteredTools)._registeredTools ?? {};

	const tools: GenericMcpToolDef[] = [];
	for (const name of GSD_MODE_MCP_WORKFLOW_ADAPTER_TOOL_NAMES) {
		const registered = registeredTools[name];
		const handler = registered ? registeredToolHandler(registered) : undefined;
		if (!registered || registered.enabled === false || !handler) continue;

		tools.push({
			name,
			label: registered.title ?? name,
			description: registered.description ?? `GSD workflow adapter tool: ${name}`,
			parameters: toMoonshotCompatibleInputSchema(registered.inputSchema),
			execute: async (toolCallId, params, signal) => normalizeMcpToolResult(
				await handler(params, {
					requestId: toolCallId,
					[NATIVE_MCP_TOOL_CALL_ID]: toolCallId,
					...(signal ? { signal } : {}),
				}),
			),
		});
	}

	return tools.filter((tool) => ADAPTER_TOOL_NAME_SET.has(tool.name));
}
