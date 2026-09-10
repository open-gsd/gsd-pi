/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	createAgentShimResult,
	createToolSearchShimResult,
	EventStream,
	isAgentToolName,
	isContextOverflow,
	isEmptyPathToolArguments,
	isToolSearchToolName,
	normalizeToolResultContent,
	parseStreamingJson,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@gsd/pi-ai";
import { resolveAgentTool } from "./resolve-agent-tool.js";
import {
	collectValidationErrorFields,
	decideSchemaOverloadBreaker,
	narrowedSchemaRetryInstruction,
} from "./schema-overload-convergence.js";
import { abortOriginFromSignal } from "./types.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Cap consecutive turns where every tool call fails preparation (schema / not-found). */
export const MAX_CONSECUTIVE_VALIDATION_FAILURES = 3;

/**
 * Cap continuations injected when the provider truncates output at the token
 * cap (stopReason "length"), so a provider that always truncates cannot spin
 * the loop (and its cost) forever.
 */
const MAX_LENGTH_CONTINUATIONS = 3;

/** Prompt injected after a length-truncated assistant turn so the model resumes. */
const LENGTH_CONTINUATION_PROMPT =
	"Your previous response was cut off at the output limit. Continue exactly where you left off.";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function createLengthStopMessage(
	sourceMessage: AssistantMessage,
	haltedBecause: string,
	contextOverflow = false,
): AssistantMessage {
	const overflowMarker = contextOverflow ? " [context_length_exceeded]" : "";
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `Agent stopped: provider returned stop_reason "length" and continuation was halted (${haltedBecause}).`,
			},
		],
		api: sourceMessage.api,
		provider: sourceMessage.provider,
		model: sourceMessage.model,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: `[length-halt]${overflowMarker} Provider stop_reason: length (${haltedBecause}; continuing was halted)`,
		timestamp: Date.now(),
	};
}

/**
 * Close a loop stream after `runAgentLoop*` threw outside the per-turn error
 * handling (e.g. context conversion, API key resolution, or a hook threw).
 * Without this the rejection is unhandled (fatal under Node's default) and
 * the stream never ends, hanging every consumer.
 *
 * Emits a final assistant message with stopReason "error" — the documented
 * error contract — then ends the stream with that message as the result.
 */
function endLoopStreamWithError(
	stream: ReturnType<typeof createAgentStream>,
	config: AgentLoopConfig,
	err: unknown,
): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `Agent loop failed: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: err instanceof Error ? err.message : String(err),
		timestamp: Date.now(),
	};
	stream.push({ type: "message_start", message });
	stream.push({ type: "message_end", message });
	stream.end([message]);
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	)
		.then((messages) => {
			stream.end(messages);
		})
		.catch((err) => {
			endLoopStreamWithError(stream, config, err);
		});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	)
		.then((messages) => {
			stream.end(messages);
		})
		.catch((err) => {
			endLoopStreamWithError(stream, config, err);
		});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	let consecutiveAllToolErrorTurns = 0;
	let lengthContinuations = 0;
	let previousValidationFields: string[] = [];
	let narrowedSchemaRetryGranted = false;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				const abortOrigin =
					abortOriginFromSignal(signal) ?? (message.stopReason === "error" ? "error" : undefined);
				await emit({ type: "agent_end", messages: newMessages, ...(abortOrigin ? { abortOrigin } : {}) });
				return;
			}

			// The provider cut the output at the token cap: the turn is incomplete
			// (text orphaned mid-sentence, possibly mid-tool-call). Either continue
			// the output (bounded by MAX_LENGTH_CONTINUATIONS) or surface a terminal
			// error instead of presenting the truncation as a clean stop.
			let continueAfterTruncation = false;
			let lengthHaltReason: string | undefined;
			let lengthHaltIsContextOverflow = false;
			if (message.stopReason === "length") {
				// Only a pure truncation is continuable. A zero-output length stop is
				// silent context overflow (pi-ai isContextOverflow case 3), and a length
				// stop carrying an errorMessage is a provider failure — continuing
				// either would re-feed an unusable context and halt with a misreported
				// cap message.
				const isOutputTruncation = !message.errorMessage && message.usage.output > 0;
				if (!isOutputTruncation) {
					lengthHaltIsContextOverflow = isContextOverflow(message, config.model.contextWindow);
					if (message.errorMessage) {
						lengthHaltReason = `provider error: ${message.errorMessage}`;
					} else if (lengthHaltIsContextOverflow) {
						lengthHaltReason = "no output was generated (context overflow, not output truncation)";
					} else {
						lengthHaltReason = "no output was generated";
					}
				} else if (lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
					continueAfterTruncation = true;
				} else {
					lengthHaltReason = `continuation cap (${MAX_LENGTH_CONTINUATIONS}) exhausted`;
				}
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			let toolBatchTerminated = false;
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				toolBatchTerminated = executedToolBatch.terminate;
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				const hasPreparationErrors = executedToolBatch.preparationErrorCount > 0;
				const allToolsFailedPreparation =
					toolResults.length > 0 &&
					executedToolBatch.preparationErrorCount === toolResults.length;
				if (allToolsFailedPreparation) {
					consecutiveAllToolErrorTurns++;
				} else if (!hasPreparationErrors) {
					consecutiveAllToolErrorTurns = 0;
					previousValidationFields = [];
					narrowedSchemaRetryGranted = false;
				}

				const currentValidationFields = collectValidationErrorFields(
					toolResults.map(toolResultText),
				);
				const overload = decideSchemaOverloadBreaker({
					consecutive: consecutiveAllToolErrorTurns,
					cap: MAX_CONSECUTIVE_VALIDATION_FAILURES,
					previousFields: previousValidationFields,
					currentFields: currentValidationFields,
					narrowedRetryGranted: narrowedSchemaRetryGranted,
				});
				if (allToolsFailedPreparation) {
					previousValidationFields = currentValidationFields;
				}

				if (overload.grantNarrowedRetry && lengthHaltReason === undefined) {
					narrowedSchemaRetryGranted = true;
					consecutiveAllToolErrorTurns = MAX_CONSECUTIVE_VALIDATION_FAILURES - 1;
					const retryMessage: AgentMessage = {
						role: "user",
						content: [{ type: "text", text: narrowedSchemaRetryInstruction(currentValidationFields) }],
						timestamp: Date.now(),
					};
					currentContext.messages.push(retryMessage);
					newMessages.push(retryMessage);
					await emit({ type: "message_start", message: retryMessage });
					await emit({ type: "message_end", message: retryMessage });
				} else if (overload.trip && lengthHaltReason === undefined) {
					// A length stop after repeated preparation errors is surfaced by the
					// schema breaker—loud, not silent—so no continuation is injected here.
					const stopMessage: AssistantMessage = {
						role: "assistant",
						content: [
							{
								type: "text",
								text: `Agent stopped: ${consecutiveAllToolErrorTurns} consecutive turns with all tool calls failing. This usually means the model is repeatedly sending arguments that do not match the tool schema.`,
							},
						],
						api: config.model.api,
						provider: config.model.provider,
						model: config.model.id,
						usage: ZERO_USAGE,
						stopReason: "error",
						errorMessage: "Schema overload: consecutive tool validation failures exceeded cap",
						timestamp: Date.now(),
					};
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "message_start", message: stopMessage });
					await emit({ type: "message_end", message: stopMessage });
					newMessages.push(stopMessage);
					currentContext.messages.push(stopMessage);
					await emit({ type: "turn_end", message: stopMessage, toolResults: [] });
					await emit({ type: "agent_end", messages: newMessages, abortOrigin: abortOriginFromSignal(signal) ?? "error" });
					return;
				}
			}

			if (continueAfterTruncation && toolBatchTerminated) {
				continueAfterTruncation = false;
				lengthHaltReason = "tool termination requested";
			}

			await emit({ type: "turn_end", message, toolResults });
			if (lengthHaltReason !== undefined) {
				const stopMessage = createLengthStopMessage(message, lengthHaltReason, lengthHaltIsContextOverflow);
				await emit({ type: "message_start", message: stopMessage });
				await emit({ type: "message_end", message: stopMessage });
				newMessages.push(stopMessage);
				currentContext.messages.push(stopMessage);
				await emit({ type: "turn_end", message: stopMessage, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages, abortOrigin: abortOriginFromSignal(signal) ?? "error" });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (continueAfterTruncation) {
				lengthContinuations++;
				// Injected after the tool results so providers that require toolResult
				// messages to directly follow the assistant toolCall message accept the
				// context on the next stream call.
				const continuationMessage: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: LENGTH_CONTINUATION_PROMPT }],
					timestamp: Date.now(),
				};
				currentContext.messages.push(continuationMessage);
				newMessages.push(continuationMessage);
				await emit({ type: "message_start", message: continuationMessage });
				await emit({ type: "message_end", message: continuationMessage });
				if (toolCalls.length === 0) {
					hasMoreToolCalls = true;
				}
			}

			const shouldStopAfterTurn = await config.shouldStopAfterTurn?.({
				message,
				toolResults,
				context: currentContext,
				newMessages,
			});
			if (shouldStopAfterTurn) {
				if (continueAfterTruncation) {
					const stopMessage = createLengthStopMessage(message, "stop hook halted the continuation");
					await emit({ type: "message_start", message: stopMessage });
					await emit({ type: "message_end", message: stopMessage });
					newMessages.push(stopMessage);
					currentContext.messages.push(stopMessage);
					await emit({ type: "turn_end", message: stopMessage, toolResults: [] });
				}
				await emit({ type: "agent_end", messages: newMessages, abortOrigin: abortOriginFromSignal(signal) ?? "programmatic" });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	const abortOrigin = abortOriginFromSignal(signal);
	await emit({ type: "agent_end", messages: newMessages, ...(abortOrigin ? { abortOrigin } : {}) });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		const stop = startLatencyTimer(config, "agent_loop.context_transform");
		messages = await config.transformContext(messages, signal);
		stop({ inputMessages: context.messages.length, outputMessages: messages.length });
	} else {
		markLatency(config, "agent_loop.context_transform.skipped", { inputMessages: context.messages.length });
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const stopConvert = startLatencyTimer(config, "agent_loop.convert_to_llm");
	const llmMessages = await config.convertToLlm(messages);
	stopConvert({ inputMessages: messages.length, outputMessages: llmMessages.length });

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const stopApiKey = startLatencyTimer(config, "agent_loop.api_key");
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	stopApiKey({ provider: config.model.provider, resolved: !!resolvedApiKey });

	const stopStreamCreate = startLatencyTimer(config, "agent_loop.stream_create");
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	stopStreamCreate({
		provider: config.model.provider,
		model: config.model.id,
		contextMessages: llmMessages.length,
		tools: llmContext.tools?.length ?? 0,
	});

	let partialMessage: AssistantMessage | null = null;
	let providerPartialMessage: AssistantMessage | null = null;
	const partialToolCallJson = new Map<number, string>();
	let addedPartial = false;
	let sawStreamActivity = false;

	for await (const event of response) {
		if (!sawStreamActivity) {
			sawStreamActivity = true;
			markLatency(config, "agent_loop.first_stream_activity", { eventType: event.type });
		}
		let shouldEmitUpdate = false;
		switch (event.type) {
			case "start":
				markLatency(config, "agent_loop.assistant_start", {
					provider: event.partial.provider,
					model: event.partial.model,
				});
				providerPartialMessage = event.partial;
				partialMessage = {
					...event.partial,
					content: event.partial.content.map((block) => ({ ...block })),
				};
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: partialMessage });
				break;

			case "text_start":
				if (partialMessage) {
					partialMessage.content[event.contentIndex] = { type: "text", text: "" };
				}
				shouldEmitUpdate = true;
				break;

			case "text_delta":
				if (partialMessage) {
					const block = partialMessage.content[event.contentIndex];
					if (block?.type === "text") block.text += event.delta;
				}
				shouldEmitUpdate = true;
				break;

			case "text_end":
				if (partialMessage) {
					const block = partialMessage.content[event.contentIndex];
					if (block?.type === "text") block.text = event.content;
				}
				shouldEmitUpdate = true;
				break;

			case "thinking_start":
				if (partialMessage) {
					partialMessage.content[event.contentIndex] = { type: "thinking", thinking: "" };
				}
				shouldEmitUpdate = true;
				break;

			case "thinking_delta":
				if (partialMessage) {
					const block = partialMessage.content[event.contentIndex];
					if (block?.type === "thinking") block.thinking += event.delta;
				}
				shouldEmitUpdate = true;
				break;

			case "thinking_end":
				if (partialMessage) {
					const block = partialMessage.content[event.contentIndex];
					if (block?.type === "thinking") block.thinking = event.content;
				}
				shouldEmitUpdate = true;
				break;

			case "toolcall_start":
				if (partialMessage) {
					const streamedBlock = providerPartialMessage?.content[event.contentIndex];
					partialMessage.content[event.contentIndex] =
						streamedBlock?.type === "toolCall"
							? { ...streamedBlock, arguments: {} }
							: { type: "toolCall", id: "", name: "", arguments: {} };
					partialToolCallJson.set(event.contentIndex, "");
				}
				shouldEmitUpdate = true;
				break;

			case "toolcall_delta":
				if (partialMessage) {
					const block = partialMessage.content[event.contentIndex];
					if (block?.type === "toolCall") {
						const json = (partialToolCallJson.get(event.contentIndex) ?? "") + event.delta;
						partialToolCallJson.set(event.contentIndex, json);
						block.arguments = parseStreamingJson(json);
					}
				}
				shouldEmitUpdate = true;
				break;

			case "toolcall_end":
				if (partialMessage) {
					partialMessage.content[event.contentIndex] = { ...event.toolCall };
					partialToolCallJson.delete(event.contentIndex);
				}
				shouldEmitUpdate = true;
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}

		if (shouldEmitUpdate && partialMessage) {
			context.messages[context.messages.length - 1] = partialMessage;
			await emit({
				type: "message_update",
				assistantMessageEvent: event,
				message: { ...partialMessage },
			});
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

function markLatency(config: AgentLoopConfig, phase: string, data?: Record<string, unknown>): void {
	config.latencyMark?.(phase, data);
}

function startLatencyTimer(
	config: AgentLoopConfig,
	phase: string,
): (data?: Record<string, unknown>) => void {
	const start = performance.now();
	markLatency(config, `${phase}.start`);
	return (data?: Record<string, unknown>) => {
		markLatency(config, `${phase}.end`, {
			elapsedMs: Math.round((performance.now() - start) * 100) / 100,
			...(data ?? {}),
		});
	};
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	preparationErrorCount: number;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	let preparationErrorCount = 0;

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			if (preparation.isError && preparation.countsTowardValidationFailure !== false) {
				preparationErrorCount++;
			}
			finalized = {
				toolCall,
				result: normalizeAgentToolResult(preparation.result),
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
		preparationErrorCount,
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	let preparationErrorCount = 0;

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			if (preparation.isError && preparation.countsTowardValidationFailure !== false) {
				preparationErrorCount++;
			}
			const finalized = {
				toolCall,
				result: normalizeAgentToolResult(preparation.result),
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
		preparationErrorCount,
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	countsTowardValidationFailure?: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const externalResult = toolCall.externalResult;
	if (externalResult) {
		return {
			kind: "immediate",
			result: {
				content: normalizeToolResultContent(externalResult.content),
				details: externalResult.details ?? {},
				// The provider (claude-code-cli) already executed this tool inside its
				// own agentic session and emitted ONE final assistant message carrying
				// both the tool blocks and the post-tool text. There is no follow-up
				// LLM work for the agent-loop to do, so terminate the batch. Without
				// this, shouldTerminateToolBatch() returns false → hasMoreToolCalls
				// stays true → the loop makes a redundant streamAssistantResponse call,
				// emitting a second message_start that the TUI renders as a duplicate
				// assistant bubble / stacked `╭─ GSD ─` header (issue #654).
				terminate: true,
			},
			isError: externalResult.isError ?? false,
		};
	}

	const tool = resolveAgentTool(currentContext.tools, toolCall.name);
	if (!tool) {
		if (isToolSearchToolName(toolCall.name)) {
			return {
				kind: "immediate",
				result: createToolSearchShimResult(toolCall.arguments, {
					activeToolNames: currentContext.tools?.map((tool) => tool.name),
				}),
				isError: false,
			};
		}
		if (isAgentToolName(toolCall.name)) {
			return {
				kind: "immediate",
				result: createAgentShimResult(toolCall.arguments),
				isError: false,
			};
		}
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	if (isEmptyPathToolArguments(tool.name, toolCall.arguments)) {
		return {
			kind: "immediate",
			result: {
				content: [{ type: "text", text: "Skipped tool call with no file path." }],
				details: {},
			},
			isError: false,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const reason = beforeResult.reason || "Tool execution was blocked";
				return {
					kind: "immediate",
					result: createErrorToolResult(reason, beforeResult.displayReason),
					isError: true,
					countsTowardValidationFailure: false,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const execution = prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// A cooperative tool returns promptly when its signal aborts. A hung or
		// signal-deaf tool (a deadlocked MCP server, a D-state child the tool never
		// reaps) would otherwise leave `execution` pending forever — blocking the
		// whole tool batch, so no tool_execution_end is ever emitted and the UI card
		// stays "running" indefinitely (a real CPU drain downstream). Race the
		// execution against abort: once aborted, stop awaiting the tool and finalize
		// it as aborted. The tool's own promise keeps running in the background, but
		// the turn completes and every tool_execution_start gets a paired _end.
		let outcome: ExecutedToolCallOutcome;
		if (signal) {
			outcome = await raceToolExecutionAgainstAbort(execution, signal);
		} else {
			const result = await execution;
			outcome = { result, isError: result?.isError ?? false };
		}
		await Promise.all(updateEvents);
		return outcome;
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * Await a tool's execution unless `signal` aborts first. On abort, resolve with a
 * synthetic aborted result instead of blocking on a tool that ignores the signal.
 * Only abort short-circuits the wait — there is no general timeout, so legitimately
 * long-running cooperative tools are unaffected.
 */
async function raceToolExecutionAgainstAbort(
	execution: Promise<AgentToolResult<any>>,
	signal: AbortSignal,
): Promise<ExecutedToolCallOutcome> {
	if (signal.aborted) {
		return { result: createErrorToolResult("Operation aborted"), isError: true };
	}
	// If abort wins the race, `execution` is abandoned but still pending; swallow any
	// later settlement so a background rejection does not surface as an unhandled
	// rejection after the turn has moved on.
	const guardedExecution = execution.then(
		(result) => ({ result, isError: result?.isError ?? false }) satisfies ExecutedToolCallOutcome,
		(error) => ({
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		}),
	);
	let onAbort: (() => void) | undefined;
	const abortPromise = new Promise<ExecutedToolCallOutcome>((resolve) => {
		onAbort = () => resolve({ result: createErrorToolResult("Operation aborted"), isError: true });
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([guardedExecution, abortPromise]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = normalizeAgentToolResult(executed.result);
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = normalizeAgentToolResult({
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				});
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function toolResultText(result: ToolResultMessage): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function createErrorToolResult(message: string, displayReason?: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: displayReason ? { displayReason } : {},
	};
}

function normalizeAgentToolResult(result: Partial<AgentToolResult<any>> | undefined): AgentToolResult<any> {
	return {
		content: normalizeToolResultContent(result?.content),
		details: result?.details,
		isError: result?.isError,
		terminate: result?.terminate,
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
