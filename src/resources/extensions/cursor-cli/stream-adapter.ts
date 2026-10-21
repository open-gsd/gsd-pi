import { spawn } from "node:child_process";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@gsd/pi-ai";
import { createAssistantMessageEventStream } from "@gsd/pi-ai";
import { buildCursorAgentSpawnInvocation } from "./readiness.js";

interface CursorAgentRunResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}

export type CursorAgentLineHandler = (line: string) => void;

export interface CursorAgentRunPlan {
	command: string;
	args: string[];
}

export interface CursorAgentStreamOptions extends SimpleStreamOptions {
	_cursorAgentRunnerForTest?: (
		plan: CursorAgentRunPlan,
		options: SimpleStreamOptions | undefined,
		onLine: CursorAgentLineHandler,
	) => Promise<CursorAgentRunResult>;
}

type ExternalToolResult = NonNullable<ToolCall["externalResult"]>;

type ParsedCursorAgentLine =
	| { type: "text"; text: string }
	| { type: "tool_call"; toolCall: ToolCall }
	| { type: "tool_result"; toolCallId: string; result: ExternalToolResult }
	| { type: "usage"; usage: Partial<AssistantMessage["usage"]> }
	| { type: "error"; message: string }
	| { type: "ignore" };

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textBlocks(content: (TextContent | { type: string })[]): string {
	return content
		.map((block) => block.type === "text" ? (block as TextContent).text : `[${block.type} omitted]`)
		.join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		const content = typeof message.content === "string" ? message.content : textBlocks(message.content);
		return `User:\n${content}`;
	}

	if (message.role === "assistant") {
		const text = message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return "[thinking omitted]";
				if (block.type === "toolCall") return `[tool call: ${block.name}]`;
				if (block.type === "serverToolUse") return `[server tool: ${block.name}]`;
				if (block.type === "webSearchResult") return "[web search result omitted]";
				return `[${(block as { type: string }).type} omitted]`;
			})
			.join("\n");
		return `Assistant:\n${text}`;
	}

	return `Tool result (${message.toolName}):\n${textBlocks(message.content)}`;
}

export function buildCursorPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt?.trim()) parts.push(`System instructions:\n${context.systemPrompt.trim()}`);
	if (context.messages.length > 0) parts.push(context.messages.map(messageToText).join("\n\n"));
	if (context.tools?.length) {
		const names = context.tools.map((tool) => tool.name);
		const bridged = names.filter((name) => isCursorBridgedGsdTool(name));
		parts.push(
			`The external Cursor agent may execute its own tools. ` +
			`GSD will not redispatch Cursor-owned internal tool events locally. ` +
			`GSD lifecycle tools bridged to the local host: ${bridged.join(", ") || "(none)"}. ` +
			(bridged.length > 0
				? `To invoke one, emit exactly one final envelope in this form: ` +
					`<gsd_tool_call>{"name":"gsd_task_complete","arguments":{...}}</gsd_tool_call>. ` +
					`Use a bridged tool name and its real arguments; GSD removes the envelope and executes it locally. `
				: "") +
			`Requested GSD tools: ${names.join(", ")}`,
		);
	}
	return parts.join("\n\n").trim();
}

export function buildCursorSpawnInvocation(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
): CursorAgentRunPlan {
	return buildCursorAgentSpawnInvocation(command, args, platform);
}

export function buildCursorAgentRunPlan(
	modelId: string,
	prompt: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): CursorAgentRunPlan {
	return buildCursorSpawnInvocation(
		process.env.CURSOR_AGENT_BIN?.trim() || "cursor-agent",
		["-p", prompt, "--output-format", "stream-json", "--model", modelId, "--workspace", cwd, "--trust"],
		platform,
	);
}

const CURSOR_BRIDGED_GSD_TOOLS = new Set([
	"gsd_task_complete",
	"gsd_complete_task",
	"gsd_task_recovery_resume",
]);

const GSD_TOOL_CALL_OPEN = "<gsd_tool_call>";
const GSD_TOOL_CALL_CLOSE = "</gsd_tool_call>";

function gsdToolBaseName(name: string): string {
	return name.replace(/^mcp__.+?__/, "");
}

export function isCursorBridgedGsdTool(name: string): boolean {
	const base = gsdToolBaseName(name);
	return CURSOR_BRIDGED_GSD_TOOLS.has(name) || CURSOR_BRIDGED_GSD_TOOLS.has(base);
}

export function isGsdToolName(name: string): boolean {
	const base = gsdToolBaseName(name);
	return base.startsWith("gsd_") || name.startsWith("gsd_");
}

export function unsupportedCursorGsdToolError(name: string): string {
	return `tool unsupported under cursor-agent: ${name}`;
}

function invalidCursorGsdToolEnvelopeError(detail: string): Error {
	return new Error(`invalid cursor-agent GSD lifecycle envelope: ${detail}`);
}

function longestToolEnvelopePrefixSuffix(value: string): number {
	for (let length = Math.min(value.length, GSD_TOOL_CALL_OPEN.length - 1); length > 0; length--) {
		if (GSD_TOOL_CALL_OPEN.startsWith(value.slice(-length))) return length;
	}
	return 0;
}

function emitCompleteLines(chunk: string, pending: { value: string }, onLine: CursorAgentLineHandler): void {
	pending.value += chunk;
	const lines = pending.value.split(/\r?\n/);
	pending.value = lines.pop() ?? "";
	for (const line of lines) onLine(line);
}

function flushPendingLine(pending: { value: string }, onLine: CursorAgentLineHandler): void {
	if (!pending.value) return;
	onLine(pending.value);
	pending.value = "";
}

function runCursorAgent(
	plan: CursorAgentRunPlan,
	options: SimpleStreamOptions | undefined,
	onLine: CursorAgentLineHandler,
): Promise<CursorAgentRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(plan.command, plan.args, {
			cwd: options?.cwd || process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		const pendingStdout = { value: "" };

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			options?.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			settle(() => reject(new Error("Request was aborted")));
		};

		if (options?.signal?.aborted) {
			onAbort();
			return;
		}
		options?.signal?.addEventListener("abort", onAbort);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			try {
				emitCompleteLines(chunk, pendingStdout, onLine);
			} catch (error) {
				child.kill("SIGTERM");
				settle(() => reject(error));
			}
		});
		child.stderr?.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code, signal) => settle(() => {
			try {
				flushPendingLine(pendingStdout, onLine);
			} catch (error) {
				reject(error);
				return;
			}
			resolve({ stdout, stderr, code, signal });
		}));
	});
}

function stringValue(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => stringValue(objectValue(item)?.text, objectValue(item)?.content, item))
			.filter((item): item is string => Boolean(item))
			.join("\n");
	}
	const obj = objectValue(value);
	if (!obj) return "";
	return stringValue(obj.text, obj.content, obj.message, obj.result) ?? "";
}

function mapUsage(raw: Record<string, unknown>): Partial<AssistantMessage["usage"]> {
	const input = Number(raw.input_tokens ?? raw.input ?? raw.prompt_tokens ?? 0);
	const output = Number(raw.output_tokens ?? raw.output ?? raw.completion_tokens ?? 0);
	const cacheRead = Number(raw.cache_read_input_tokens ?? raw.cacheRead ?? 0);
	const cacheWrite = Number(raw.cache_creation_input_tokens ?? raw.cacheWrite ?? 0);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
	};
}

function normalizeToolArguments(input: unknown): Record<string, unknown> {
	return objectValue(input) ?? { input };
}

function normalizeToolResult(raw: Record<string, unknown>): ExternalToolResult {
	const text = extractText(raw.content ?? raw.result ?? raw.output);
	return {
		content: text ? [{ type: "text", text }] : [],
		isError: Boolean(raw.is_error ?? raw.isError ?? raw.error),
	};
}

export function parseCursorAgentLine(line: string): ParsedCursorAgentLine {
	const trimmed = line.trim();
	if (!trimmed) return { type: "ignore" };

	let event: Record<string, unknown>;
	try {
		event = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return { type: "text", text: trimmed };
	}

	const type = stringValue(event.type, event.event) ?? "";
	if (type === "error") {
		return { type: "error", message: stringValue(event.message, event.error) ?? "cursor_agent_error" };
	}

	// cursor-agent echoes the composed prompt back as a `user` event and streams
	// reasoning as top-level `thinking` events; neither is assistant text, but both
	// carry text reachable by the generic fallback below.
	// Thinking is dropped rather than re-emitted as `thinking_*` events: this adapter pins all
	// text to contentIndex 0, so emitting reasoning as its own content block would require
	// reworking the content-index state machine. Dropping keeps assistant text correct today.
	if (type === "user" || type === "thinking") return { type: "ignore" };
	const message = objectValue(event.message);
	const role = stringValue(message?.role);
	if (role && role !== "assistant") return { type: "ignore" };

	if (type === "tool_call") {
		if (event.call_id || event.subtype || event.tool_call) return { type: "ignore" };

		const id = stringValue(event.id, event.tool_call_id) ?? `cursor_tool_${Date.now()}`;
		const name = stringValue(event.name, event.tool_name) ?? "cursor_tool";
		return {
			type: "tool_call",
			toolCall: { type: "toolCall", id, name, arguments: normalizeToolArguments(event.input ?? event.arguments) },
		};
	}

	if (type === "tool_result") {
		return {
			type: "tool_result",
			toolCallId: stringValue(event.tool_call_id, event.id) ?? "",
			result: normalizeToolResult(event),
		};
	}

	if (type === "result") {
		const usage = objectValue(event.usage);
		return usage ? { type: "usage", usage: mapUsage(usage) } : { type: "ignore" };
	}

	const text = extractText(event.delta ?? event.text ?? event.content ?? message?.content ?? event.message);
	if (text) return { type: "text", text };

	const usage = objectValue(event.usage);
	if (usage) return { type: "usage", usage: mapUsage(usage) };

	return { type: "ignore" };
}

function createUsage(partial?: Partial<AssistantMessage["usage"]>): AssistantMessage["usage"] {
	const input = partial?.input ?? 0;
	const output = partial?.output ?? 0;
	const cacheRead = partial?.cacheRead ?? 0;
	const cacheWrite = partial?.cacheWrite ?? 0;
	return {
		...ZERO_USAGE,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheWrite,
		cost: { ...ZERO_USAGE.cost },
	};
}

function buildAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	usage?: Partial<AssistantMessage["usage"]>,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(usage),
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function emitDone(stream: AssistantMessageEventStream, message: AssistantMessage, text: string): void {
	stream.push({ type: "start", partial: { ...message, content: [] } });
	if (text) {
		stream.push({ type: "text_start", contentIndex: 0 });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text });
		stream.push({ type: "text_end", contentIndex: 0, content: text });
	}
	message.content.forEach((block, index) => {
		if (block.type !== "toolCall") return;
		stream.push({ type: "toolcall_start", contentIndex: index });
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block });
	});
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
}

function emitError(stream: AssistantMessageEventStream, model: Model<Api>, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const output = buildAssistantMessage(model, [], undefined, "error", message);
	stream.push({ type: "error", reason: "error", error: output });
	stream.end(output);
}

export function streamViaCursorAgent(
	model: Model<Api>,
	context: Context,
	options?: CursorAgentStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	queueMicrotask(async () => {
		try {
			const cwd = options?.cwd || process.cwd();
			const prompt = buildCursorPrompt(context);
			const plan = buildCursorAgentRunPlan(model.id, prompt, cwd);
			const runForTest = options?._cursorAgentRunnerForTest;
			let text = "";
			let usage: Partial<AssistantMessage["usage"]> | undefined;
			let streamStarted = false;
			let textStarted = false;
			const toolCalls = new Map<string, ToolCall>();
			const content: AssistantMessage["content"] = [];
			let envelopeBuffer = "";
			let readingEnvelope = false;

			const partialMessage = (): AssistantMessage => {
				const partialContent: AssistantMessage["content"] = text ? [{ type: "text", text }, ...content] : [...content];
				return buildAssistantMessage(model, partialContent, usage);
			};
			const ensureStart = () => {
				if (streamStarted) return;
				streamStarted = true;
				stream.push({ type: "start", partial: partialMessage() });
			};
			const emitText = (value: string) => {
				if (!value) return;
				ensureStart();
				if (!textStarted) {
					textStarted = true;
					stream.push({ type: "text_start", contentIndex: 0 });
				}
				text += value;
				stream.push({ type: "text_delta", contentIndex: 0, delta: value });
			};
			const acceptToolCall = (toolCall: ToolCall): void => {
				if (isGsdToolName(toolCall.name) && !isCursorBridgedGsdTool(toolCall.name)) {
					throw new Error(unsupportedCursorGsdToolError(toolCall.name));
				}
				ensureStart();
				toolCalls.set(toolCall.id, toolCall);
				content.push(toolCall);
				const index = text ? content.length : content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex: index });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall });
			};
			const acceptEnvelope = (payload: string): void => {
				let parsed: Record<string, unknown>;
				try {
					const value = objectValue(JSON.parse(payload));
					if (!value) throw invalidCursorGsdToolEnvelopeError("payload must be a JSON object");
					parsed = value;
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("invalid cursor-agent")) throw error;
					throw invalidCursorGsdToolEnvelopeError(error instanceof Error ? error.message : String(error));
				}
				const requestedName = stringValue(parsed.name);
				if (!requestedName) throw invalidCursorGsdToolEnvelopeError("missing tool name");
				const name = gsdToolBaseName(requestedName);
				if (!isCursorBridgedGsdTool(name)) throw new Error(unsupportedCursorGsdToolError(requestedName));
				const args = objectValue(parsed.arguments ?? parsed.input);
				if (!args) throw invalidCursorGsdToolEnvelopeError(`missing arguments for ${name}`);
				acceptToolCall({
					type: "toolCall",
					id: `cursor_gsd_${Date.now()}_${content.length}`,
					name,
					arguments: args,
				});
			};
			const acceptText = (value: string, flush = false): void => {
				envelopeBuffer += value;
				for (;;) {
					if (readingEnvelope) {
						const closeIndex = envelopeBuffer.indexOf(GSD_TOOL_CALL_CLOSE);
						if (closeIndex < 0) {
							if (flush) throw invalidCursorGsdToolEnvelopeError(`missing ${GSD_TOOL_CALL_CLOSE}`);
							return;
						}
						acceptEnvelope(envelopeBuffer.slice(0, closeIndex));
						envelopeBuffer = envelopeBuffer.slice(closeIndex + GSD_TOOL_CALL_CLOSE.length);
						readingEnvelope = false;
						continue;
					}

					const openIndex = envelopeBuffer.indexOf(GSD_TOOL_CALL_OPEN);
					if (openIndex >= 0) {
						emitText(envelopeBuffer.slice(0, openIndex));
						envelopeBuffer = envelopeBuffer.slice(openIndex + GSD_TOOL_CALL_OPEN.length);
						readingEnvelope = true;
						continue;
					}

					const heldSuffixLength = flush ? 0 : longestToolEnvelopePrefixSuffix(envelopeBuffer);
					const visibleLength = envelopeBuffer.length - heldSuffixLength;
					emitText(envelopeBuffer.slice(0, visibleLength));
					envelopeBuffer = envelopeBuffer.slice(visibleLength);
					return;
				}
			};
			const handleLine = (line: string): void => {
				const parsed = parseCursorAgentLine(line);
				if (parsed.type === "ignore") return;
				if (parsed.type === "error") throw new Error(parsed.message);
				if (parsed.type === "text") {
					acceptText(parsed.text);
					return;
				}
				if (parsed.type === "usage") {
					usage = { ...(usage ?? {}), ...parsed.usage };
					return;
				}
				if (parsed.type === "tool_call") {
					acceptToolCall(parsed.toolCall);
					return;
				}
				if (parsed.type === "tool_result") {
					const toolCall = toolCalls.get(parsed.toolCallId);
					if (toolCall && isCursorBridgedGsdTool(toolCall.name)) return;
					if (toolCall) toolCall.externalResult = parsed.result;
				}
			};

			const result = runForTest
				? await runForTest(plan, options, handleLine)
				: await runCursorAgent(plan, options, handleLine);

			if (runForTest) {
				for (const line of result.stdout.split(/\r?\n/)) handleLine(line);
			}

			if (result.code !== 0) {
				throw new Error((result.stderr || result.stdout || `cursor-agent exited with code ${result.code}`).trim());
			}
			acceptText("", true);

			const finalContent: AssistantMessage["content"] = text ? [{ type: "text", text }, ...content] : content;
			const finalMessage = buildAssistantMessage(model, finalContent, usage);
			if (!streamStarted) {
				emitDone(stream, finalMessage, text);
				return;
			}
			if (textStarted) stream.push({ type: "text_end", contentIndex: 0, content: text });
			stream.push({ type: "done", reason: "stop", message: finalMessage });
			stream.end(finalMessage);
		} catch (error) {
			emitError(stream, model, error);
		}
	});

	return stream;
}
