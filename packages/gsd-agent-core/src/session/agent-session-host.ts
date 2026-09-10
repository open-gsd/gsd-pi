import type {
	Agent,
	AgentAbortOrigin,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@gsd/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@gsd/pi-ai";
import type { BashResult } from "../bash-executor.js";
import type { CompactionResult } from "../compaction/index.js";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	InputSource,
	ReplacedSessionContext,
	ShutdownHandler,
	ToolDefinition,
	ToolInfo,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "@gsd/pi-coding-agent/core/messages.js";
import type { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import type { PromptTemplate } from "@gsd/pi-coding-agent/core/prompt-templates.js";
import type { ResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import type { BranchSummaryEntry, SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import type { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { BuildSystemPromptOptions } from "../system-prompt.js";
import type { BashOperations } from "@gsd/pi-coding-agent/core/tools/bash.js";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
	ToolDefinitionEntry,
} from "./agent-session-types.js";
import type { SessionStartEvent } from "@gsd/pi-coding-agent/core/extensions/index.js";
import type {
	BeginTurnLatencyOptions,
	TurnLatencyRecord,
	TurnLatencyStatus,
	TurnLatencyVisibleKind,
} from "../turn-latency.js";

/**
 * Internal surface shared by AgentSession submodule classes.
 * AgentSession implements this interface and passes `this` to module constructors.
 */
export interface AgentSessionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly resourceLoader: ResourceLoader;

	// Mutable session state accessed across modules
	_scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	_unsubscribeAgent: (() => void) | undefined;
	_eventListeners: AgentSessionEventListener[];
	_steeringMessages: string[];
	_followUpMessages: string[];
	_pendingNextTurnMessages: CustomMessage[];
	_compactionAbortController: AbortController | undefined;
	_autoCompactionAbortController: AbortController | undefined;
	_overflowRecoveryAttempted: boolean;
	_branchSummaryAbortController: AbortController | undefined;
	_retryAbortController: AbortController | undefined;
	_retryAttempt: number;
	_lastTurnCost: number;
	_bashAbortController: AbortController | undefined;
	_pendingBashMessages: BashExecutionMessage[];
	_extensionRunner: ExtensionRunner;
	_turnIndex: number;
	_customTools: ToolDefinition[];
	_baseToolDefinitions: Map<string, ToolDefinition>;
	_cwd: string;
	_extensionRunnerRef: { current?: ExtensionRunner } | undefined;
	_initialActiveToolNames: string[] | undefined;
	_allowedToolNames: Set<string> | undefined;
	_baseToolsOverride: Record<string, AgentTool> | undefined;
	_sessionStartEvent: SessionStartEvent;
	_extensionUIContext: ExtensionUIContext | undefined;
	_extensionCommandContextActions: ExtensionCommandContextActions | undefined;
	_extensionAbortHandler: (() => void) | undefined;
	_extensionShutdownHandler: ShutdownHandler | undefined;
	_extensionErrorListener: ExtensionErrorListener | undefined;
	_extensionErrorUnsubscriber: (() => void) | undefined;
	_visibleSkillNames: string[] | undefined;
	_toolRegistry: Map<string, AgentTool>;
	_toolDefinitions: Map<string, ToolDefinitionEntry>;
	_toolPromptSnippets: Map<string, string>;
	_toolPromptGuidelines: Map<string, string[]>;
	_baseSystemPrompt: string;
	_baseSystemPromptOptions: BuildSystemPromptOptions;
	_lastAssistantMessage: AssistantMessage | undefined;
	_activeTurnLatency: TurnLatencyRecord | undefined;

	// Read-only derived state
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly isStreaming: boolean;
	readonly systemPrompt: string;
	readonly state: AgentState;
	readonly messages: AgentMessage[];
	readonly steeringMode: "all" | "one-at-a-time";
	readonly followUpMode: "all" | "one-at-a-time";
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly sessionName: string | undefined;
	readonly promptTemplates: ReadonlyArray<PromptTemplate>;
	readonly isCompacting: boolean;
	readonly pendingMessageCount: number;

	// Cross-module internal API
	emit(event: AgentSessionEvent): void;
	emitQueueUpdate(): void;
	beginTurnLatency(options?: BeginTurnLatencyOptions): TurnLatencyRecord | undefined;
	markTurnLatency(phase: string, data?: Record<string, unknown>): void;
	markFirstStreamActivity(kind: string, data?: Record<string, unknown>): void;
	markFirstVisibleTurnLatency(kind: TurnLatencyVisibleKind, data?: Record<string, unknown>): void;
	finishTurnLatency(status: TurnLatencyStatus): void;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	isRetryableError(message: AssistantMessage): boolean;
	canPrepareRetry(message: AssistantMessage): boolean;
	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void>;
	handlePostAgentRun(): Promise<boolean>;
	flushPendingBashMessages(): void;
	checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck?: boolean): Promise<boolean>;
	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void>;
	findLastAssistantMessage(): AssistantMessage | undefined;
	setThinkingLevel(level: ThinkingLevel): void;
	getAvailableThinkingLevels(): ThinkingLevel[];
	clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel;
	supportsThinking(): boolean;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
	rebuildSystemPrompt(toolNames: string[]): string;
	refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
	}): void;
	buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void;
	installAgentToolHooks(): void;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
	compact(customInstructions?: string): Promise<CompactionResult>;
	abort(origin?: AgentAbortOrigin): Promise<void>;
	abortRetry(): void;
	setSessionName(name: string): void;
	emitSessionStartWithLegacySwitch(event: SessionStartEvent & { reason: "new" | "resume" }): Promise<void>;
	extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void>;
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; loginShell?: boolean },
	): Promise<BashResult>;
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
	getContextUsage(): ContextUsage | undefined;
	getToolDefinition(name: string): ToolDefinition | undefined;
	getAllTools(): ToolInfo[];
	createReplacedSessionContext(): ReplacedSessionContext;

	// Public methods modules delegate to
	setModel(model: Model<any>, options?: { persist?: boolean }): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
}
