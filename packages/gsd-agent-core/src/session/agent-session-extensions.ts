import type { Agent, AgentTool, ThinkingLevel } from "@gsd/pi-agent-core";
import type { Model } from "@gsd/pi-ai";
import { resetApiProviders } from "@gsd/pi-ai";
import {
	ExtensionRunner,
	wrapRegisteredTools,
	type ReplacedSessionContext,
	type ToolDefinition,
	type ToolInfo,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
import { emitSessionShutdownEvent } from "@gsd/pi-coding-agent/core/extensions/runner.js";
import type { ResourceExtensionPaths, ResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import type { SlashCommandInfo } from "@gsd/pi-coding-agent/core/slash-commands.js";
import { createSyntheticSourceInfo } from "@gsd/pi-coding-agent/core/source-info.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { createAllToolDefinitions } from "@gsd/pi-coding-agent/core/tools/index.js";
import { createToolDefinitionFromAgentTool } from "@gsd/pi-coding-agent/core/tools/tool-definition-wrapper.js";
import { basename, dirname } from "node:path";
import type { ExtensionBindings, ToolDefinitionEntry } from "./agent-session-types.js";
import type { SessionStartEvent } from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { AgentSessionHost } from "./agent-session-host.js";

const extensionUiStreamBridgedAgents = new WeakSet<Agent>();

export class AgentSessionExtensionsModule {
	constructor(readonly host: AgentSessionHost) {}

	/** Forward ExtensionUIContext into provider stream options (claude-code-cli elicitation). */
	private ensureExtensionUiStreamBridge(): void {
		const agent = this.host.agent;
		if (extensionUiStreamBridgedAgents.has(agent)) return;

		const baseStreamFn = agent.streamFn;
		agent.streamFn = (model, context, options) =>
			baseStreamFn(model, context, {
				...options,
				extensionUIContext: this.host._extensionUIContext,
			} as typeof options);
		extensionUiStreamBridgedAgents.add(agent);
	}

	installAgentToolHooks(): void {
		this.host.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this.host._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.host.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this.host._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this.host._extensionUIContext = bindings.uiContext;
			this.ensureExtensionUiStreamBridge();
		}
		if (bindings.commandContextActions !== undefined) {
			this.host._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this.host._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this.host._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this.host._extensionErrorListener = bindings.onError;
		}

		this.applyExtensionBindings(this.host._extensionRunner);
		await this.host._extensionRunner.emit(this.host._sessionStartEvent);
		await this.extendResourcesFromExtensions(this.host._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this.host._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this.host._extensionRunner.emitResourcesDiscover(
			this.host._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this.host.resourceLoader.extendResources(extensionPaths);
		this.host._baseSystemPrompt = this.rebuildSystemPrompt(this.host.getActiveToolNames());
		this.host.agent.state.systemPrompt = this.host._baseSystemPrompt;
	}

	async emitSessionStartWithLegacySwitch(event: SessionStartEvent & { reason: "new" | "resume" }): Promise<void> {
		await this.host._extensionRunner.emit(event);
		await this.host._extensionRunner.emit({
			type: "session_switch",
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
		});
	}

	buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this.host._extensionUIContext);
		runner.bindCommandContext(this.host._extensionCommandContextActions);

		this.host._extensionErrorUnsubscriber?.();
		this.host._extensionErrorUnsubscriber = this.host._extensionErrorListener
			? runner.onError(this.host._extensionErrorListener)
			: undefined;
	}

	refreshCurrentModelFromRegistry(): void {
		const currentModel = this.host.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this.host.modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.host.agent.state.model = refreshedModel;
	}

	bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.host.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this.host.resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) =>
					this.host.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					}),
				sendUserMessage: (content, options) => {
					this.host.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.host.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.host.setSessionName(name);
				},
				getSessionName: () => {
					return this.host.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.host.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.host.getActiveToolNames(),
				getAllTools: () => this.host.getAllTools(),
				setActiveTools: (toolNames) => this.host.setActiveToolsByName(toolNames),
				refreshTools: () => this.refreshToolRegistry(),
				getCommands,
				setModel: async (model, options) => {
					if (!this.host.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.host.setModel(model, options);
					return true;
				},
				getThinkingLevel: () => this.host.thinkingLevel,
				setThinkingLevel: (level) => this.host.setThinkingLevel(level),
				retryLastTurn: () => {
					void this.host.agent.continue();
				},
				getVisibleSkills: () => this.host._visibleSkillNames,
				setVisibleSkills: (skillNames) => {
					this.host._visibleSkillNames = skillNames;
					this.refreshSystemPromptForVisibleSkills();
				},
				emitBeforeModelSelect: (event) => this.host._extensionRunner.emitBeforeModelSelect(event),
				emitAdjustToolSet: (event) => this.host._extensionRunner.emitAdjustToolSet(event),
				emitExtensionEvent: (event) => this.host._extensionRunner.emitExtensionEventDynamic(event),
			},
			{
				getModel: () => this.host.model,
				isIdle: () => !this.host.isStreaming,
				getSignal: () => this.host.agent.signal,
				abort: () => {
					if (this.host._extensionAbortHandler) {
						this.host._extensionAbortHandler();
						return;
					}
					void this.host.abort();
				},
				hasPendingMessages: () => this.host.pendingMessageCount > 0,
				shutdown: () => {
					this.host._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.host.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.host.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.host.systemPrompt,
				setCompactionThresholdOverride: (percent) => {
					this.host.settingsManager.setCompactionThresholdOverride(percent);
				},
			},
			{
				registerProvider: (name, config) => {
					this.host.modelRegistry.registerProvider(name, config);
					this.refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this.host.modelRegistry.unregisterProvider(name);
					this.refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this.host._toolRegistry.keys());
		const previousActiveToolNames = this.host.getActiveToolNames();
		const allowedToolNames = this.host._allowedToolNames;
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);

		const registeredTools = this.host._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this.host._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this.host._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this.host._toolDefinitions = definitionRegistry;
		this.host._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this.normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this.host._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this.normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this.host._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this.host._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this.host._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this.host._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this.host._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.host.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.host.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.host.settingsManager.getShellCommandPrefix();
		const shellPath = this.host.settingsManager.getShellPath();
		const baseToolDefinitions = this.host._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this.host._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this.host._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this.host._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this.host.resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this.host._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this.host._cwd,
			this.host.sessionManager,
			this.host.modelRegistry,
		);
		if (this.host._extensionRunnerRef) {
			this.host._extensionRunnerRef.current = this.host._extensionRunner;
		}
		this.bindExtensionCore(this.host._extensionRunner);
		this.applyExtensionBindings(this.host._extensionRunner);

		const defaultActiveToolNames = this.host._baseToolsOverride
			? Object.keys(this.host._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this.refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		const previousFlagValues = this.host._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this.host._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.host.settingsManager.reload();
		resetApiProviders();
		await this.host.resourceLoader.reload();
		this.buildRuntime({
			activeToolNames: this.host.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this.host._extensionUIContext ||
			this.host._extensionCommandContextActions ||
			this.host._extensionShutdownHandler ||
			this.host._extensionErrorListener;
		if (hasBindings) {
			await this.host._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this.host._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this.host._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this.host._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this.host.resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this.host.resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedContextFiles = this.host.resourceLoader.getAgentsFiles().agentsFiles;

		// Skills are discovered on-demand via read tool — no longer embedded
		// in the system prompt (~29KB saved per request). No skillFilter needed.
		this.host._baseSystemPromptOptions = {
			cwd: this.host._cwd,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this.host._baseSystemPromptOptions);
	}

	private refreshSystemPromptForVisibleSkills(): void {
		const toolNames = this.getActiveToolNames();
		this.host._baseSystemPrompt = this.rebuildSystemPrompt(toolNames);
		this.host.agent.state.systemPrompt = this.host._baseSystemPrompt;
	}

	getActiveToolNames(): string[] {
		return this.host.agent.state.tools.map((t) => t.name);
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this.host._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.host._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.host._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.host.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this.host._baseSystemPrompt = this.rebuildSystemPrompt(validToolNames);
		this.host.agent.state.systemPrompt = this.host._baseSystemPrompt;
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.host._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.host.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.host.sendUserMessage(content, options);
		return context;
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this.host._extensionRunner.hasHandlers(eventType);
	}

	get extensionRunner(): ExtensionRunner {
		return this.host._extensionRunner;
	}

	getRenderableToolDefinition(toolName: string): ToolDefinition | undefined {
		const normalized = toolName.toLowerCase();
		for (const { definition } of this.host._extensionRunner.getAllRegisteredTools()) {
			if (definition.name.toLowerCase() === normalized) {
				return definition;
			}
		}
		return undefined;
	}

	get resourceLoader(): ResourceLoader {
		return this.host.resourceLoader;
	}

}
