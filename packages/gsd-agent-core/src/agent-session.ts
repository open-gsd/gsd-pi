/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import type {
	Agent,
	AgentAbortOrigin,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@gsd/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, TextContent } from "@gsd/pi-ai";
import type { BashResult } from "./bash-executor.js";
import type { CompactionResult } from "./compaction/index.js";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	ReplacedSessionContext,
	SessionStartEvent,
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
import type { BuildSystemPromptOptions } from "./system-prompt.js";
import type { BashOperations } from "@gsd/pi-coding-agent/core/tools/bash.js";
import {
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ExtensionBindings,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	type SessionStateChangeReason,
	type SessionStats,
	type ToolDefinitionEntry,
	parseSkillBlock,
} from "./session/agent-session-types.js";
import {
	beginTurnLatency,
	finishTurnLatency,
	formatTurnLatencyRecords,
	getTurnLatencyRecords,
	markFirstStreamActivity,
	markFirstVisibleTurnLatency,
	markTurnLatency,
	updateTurnLatencyModel,
	type BeginTurnLatencyOptions,
	type TurnLatencyRecord,
	type TurnLatencyStatus,
	type TurnLatencyVisibleKind,
} from "./turn-latency.js";
import type { AgentSessionHost } from "./session/agent-session-host.js";
import { AgentSessionEventsModule } from "./session/agent-session-events.js";
import { AgentSessionPromptModule } from "./session/agent-session-prompt.js";
import { AgentSessionModelModule } from "./session/agent-session-model.js";
import { AgentSessionCompactionModule } from "./session/agent-session-compaction.js";
import { AgentSessionNavigationModule } from "./session/agent-session-navigation.js";
import { AgentSessionExtensionsModule } from "./session/agent-session-extensions.js";
import { AgentSessionBashModule } from "./session/agent-session-bash.js";

export type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	ParsedSkillBlock,
	PromptOptions,
	SessionStateChangeReason,
	SessionStats,
} from "./session/agent-session-types.js";
export { parseSkillBlock } from "./session/agent-session-types.js";

export class AgentSession implements AgentSessionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	_scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	_unsubscribeAgent: (() => void) | undefined;
	_eventListeners: AgentSessionEventListener[] = [];
	_steeringMessages: string[] = [];
	_followUpMessages: string[] = [];
	_pendingNextTurnMessages: CustomMessage[] = [];

	_compactionAbortController: AbortController | undefined = undefined;
	_autoCompactionAbortController: AbortController | undefined = undefined;
	_overflowRecoveryAttempted = false;
	_branchSummaryAbortController: AbortController | undefined = undefined;

	_retryAbortController: AbortController | undefined = undefined;
	_retryAttempt = 0;
	_lastTurnCost = 0;

	_bashAbortController: AbortController | undefined = undefined;
	_pendingBashMessages: BashExecutionMessage[] = [];

	_extensionRunner!: ExtensionRunner;
	_turnIndex = 0;

	_resourceLoader: ResourceLoader;
	_customTools: ToolDefinition[];
	_baseToolDefinitions: Map<string, ToolDefinition> = new Map();
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

	_modelRegistry: ModelRegistry;

	_toolRegistry: Map<string, AgentTool> = new Map();
	_toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	_toolPromptSnippets: Map<string, string> = new Map();
	_toolPromptGuidelines: Map<string, string[]> = new Map();

	_baseSystemPrompt = "";
	_baseSystemPromptOptions!: BuildSystemPromptOptions;
	_lastAssistantMessage: AssistantMessage | undefined = undefined;
	_activeTurnLatency: TurnLatencyRecord | undefined = undefined;

	private readonly _events = new AgentSessionEventsModule(this);
	private readonly _prompt = new AgentSessionPromptModule(this);
	private readonly _model = new AgentSessionModelModule(this);
	private readonly _compaction = new AgentSessionCompactionModule(this);
	private readonly _navigation = new AgentSessionNavigationModule(this);
	private readonly _extensions = new AgentSessionExtensionsModule(this);
	private readonly _bash = new AgentSessionBashModule(this);

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		this._unsubscribeAgent = this.agent.subscribe(this._events.handleAgentEvent);
		this._extensions.installAgentToolHooks();
		this._extensions.buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	get retryAttempt(): number {
		return this._retryAttempt;
	}

	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	beginTurnLatency(options: BeginTurnLatencyOptions = {}): TurnLatencyRecord | undefined {
		if (this._activeTurnLatency && this._activeTurnLatency.endedAtMs === undefined) {
			updateTurnLatencyModel(this._activeTurnLatency, options.model ?? this.model);
			if (options.trigger) {
				markTurnLatency(this._activeTurnLatency, "turn.trigger", { trigger: options.trigger });
			}
			return this._activeTurnLatency;
		}
		this._activeTurnLatency = beginTurnLatency({ ...options, model: options.model ?? this.model });
		return this._activeTurnLatency;
	}

	markTurnLatency(phase: string, data?: Record<string, unknown>): void {
		markTurnLatency(this._activeTurnLatency, phase, data);
	}

	markFirstStreamActivity(kind: string, data?: Record<string, unknown>): void {
		markFirstStreamActivity(this._activeTurnLatency, kind, data);
	}

	markFirstVisibleTurnLatency(kind: TurnLatencyVisibleKind, data?: Record<string, unknown>): void {
		markFirstVisibleTurnLatency(this._activeTurnLatency, kind, data);
	}

	finishTurnLatency(status: TurnLatencyStatus): void {
		finishTurnLatency(this._activeTurnLatency, status);
		this._activeTurnLatency = undefined;
	}

	getTurnLatencyRecords(): readonly TurnLatencyRecord[] {
		return getTurnLatencyRecords();
	}

	formatTurnLatencyRecords(): string {
		return formatTurnLatencyRecords();
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}

	// AgentSessionHost cross-module surface
	emit(event: AgentSessionEvent): void {
		this._events.emit(event);
	}

	emitQueueUpdate(): void {
		this._events.emitQueueUpdate();
	}

	disconnectFromAgent(): void {
		this._events.disconnectFromAgent();
	}

	reconnectToAgent(): void {
		this._events.reconnectToAgent();
	}

	isRetryableError(message: AssistantMessage): boolean {
		return this._prompt.isRetryableError(message);
	}

	canPrepareRetry(message: AssistantMessage): boolean {
		return this._prompt.canPrepareRetry(message);
	}

	runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		return this._prompt.runAgentPrompt(messages);
	}

	handlePostAgentRun(): Promise<boolean> {
		return this._prompt.handlePostAgentRun();
	}

	flushPendingBashMessages(): void {
		this._bash.flushPendingBashMessages();
	}

	checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck?: boolean): Promise<boolean> {
		return this._compaction.checkCompaction(assistantMessage, skipAbortedCheck);
	}

	getCompactionRequestAuth(model: Model<any>): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
		return this._model.getCompactionRequestAuth(model);
	}

	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey: string; headers?: Record<string, string> }> {
		return this._model.getRequiredRequestAuth(model);
	}

	emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		return this._model.emitModelSelect(nextModel, previousModel, source);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this._events.findLastAssistantMessage();
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this._model.setThinkingLevel(level);
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._model.getAvailableThinkingLevels();
	}

	clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this._model.clampThinkingLevel(level, availableLevels);
	}

	supportsThinking(): boolean {
		return this._model.supportsThinking();
	}

	getActiveToolNames(): string[] {
		return this._extensions.getActiveToolNames();
	}

	setActiveToolsByName(toolNames: string[]): void {
		this._extensions.setActiveToolsByName(toolNames);
	}

	rebuildSystemPrompt(toolNames: string[]): string {
		return this._extensions.rebuildSystemPrompt(toolNames);
	}

	refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this._extensions.refreshToolRegistry(options);
	}

	buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		this._extensions.buildRuntime(options);
	}

	installAgentToolHooks(): void {
		this._extensions.installAgentToolHooks();
	}

	emitSessionStartWithLegacySwitch(event: SessionStartEvent & { reason: "new" | "resume" }): Promise<void> {
		return this._extensions.emitSessionStartWithLegacySwitch(event);
	}

	extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		return this._extensions.extendResourcesFromExtensions(reason);
	}

	// Public API
	subscribe(listener: AgentSessionEventListener): () => void {
		return this._events.subscribe(listener);
	}

	dispose(): void {
		this._events.dispose();
	}

	getAllTools(): ToolInfo[] {
		return this._extensions.getAllTools();
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._extensions.getToolDefinition(name);
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._model.setScopedModels(scopedModels);
	}

	prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt.prompt(text, options);
	}

	steer(text: string, images?: ImageContent[]): Promise<void> {
		return this._prompt.steer(text, images);
	}

	followUp(text: string, images?: ImageContent[]): Promise<void> {
		return this._prompt.followUp(text, images);
	}

	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		return this._prompt.sendCustomMessage(message, options);
	}

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		return this._prompt.sendUserMessage(content, options);
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		return this._prompt.clearQueue();
	}

	getSteeringMessages(): readonly string[] {
		return this._prompt.getSteeringMessages();
	}

	getFollowUpMessages(): readonly string[] {
		return this._prompt.getFollowUpMessages();
	}

	abort(origin?: AgentAbortOrigin): Promise<void> {
		return this._prompt.abort(origin);
	}

	abortRetry(): void {
		this._prompt.abortRetry();
	}

	setModel(model: Model<any>, options?: { persist?: boolean }): Promise<void> {
		return this._model.setModel(model, options);
	}

	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		return this._model.cycleModel(direction);
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		return this._model.cycleThinkingLevel();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._prompt.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._prompt.setFollowUpMode(mode);
	}

	compact(customInstructions?: string): Promise<CompactionResult> {
		return this._compaction.compact(customInstructions);
	}

	abortCompaction(): void {
		this._compaction.abortCompaction();
	}

	abortBranchSummary(): void {
		this._compaction.abortBranchSummary();
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this._compaction.setAutoCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this._compaction.autoCompactionEnabled;
	}

	bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._extensions.bindExtensions(bindings);
	}

	reload(): Promise<void> {
		return this._extensions.reload();
	}

	get isRetrying(): boolean {
		return this._prompt.isRetrying;
	}

	get autoRetryEnabled(): boolean {
		return this._prompt.autoRetryEnabled;
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this._prompt.setAutoRetryEnabled(enabled);
	}

	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations; loginShell?: boolean },
	): Promise<BashResult> {
		return this._bash.executeBash(command, onChunk, options);
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bash.recordBashResult(command, result, options);
	}

	abortBash(): void {
		this._bash.abortBash();
	}

	get isBashRunning(): boolean {
		return this._bash.isBashRunning;
	}

	get hasPendingBashMessages(): boolean {
		return this._bash.hasPendingBashMessages;
	}

	setSessionName(name: string): void {
		this._navigation.setSessionName(name);
	}

	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		workspaceRoot?: string;
		abortSignal?: AbortSignal;
	}): Promise<boolean> {
		return this._navigation.newSession(options);
	}

	switchSession(sessionPath: string): Promise<boolean> {
		return this._navigation.switchSession(sessionPath);
	}

	fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		return this._navigation.fork(entryId);
	}

	getLastTurnCost(): number {
		return this._navigation.getLastTurnCost();
	}

	get editMode(): "standard" | "hashline" {
		return this._navigation.editMode;
	}

	setEditMode(mode: "standard" | "hashline"): void {
		this._navigation.setEditMode(mode);
	}

	navigateTree(
		targetId: string,
		options?: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		return this._navigation.navigateTree(targetId, options);
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this._navigation.getUserMessagesForForking();
	}

	getSessionStats(): SessionStats {
		return this._navigation.getSessionStats();
	}

	getContextUsage(): ContextUsage | undefined {
		return this._navigation.getContextUsage();
	}

	exportToHtml(outputPath?: string): Promise<string> {
		return this._navigation.exportToHtml(outputPath);
	}

	exportToJsonl(outputPath?: string): string {
		return this._navigation.exportToJsonl(outputPath);
	}

	getLastAssistantText(): string | undefined {
		return this._navigation.getLastAssistantText();
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		return this._extensions.createReplacedSessionContext();
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this._extensions.hasExtensionHandlers(eventType);
	}

	getRenderableToolDefinition(toolName: string): ToolDefinition | undefined {
		return this._extensions.getRenderableToolDefinition(toolName);
	}
}
