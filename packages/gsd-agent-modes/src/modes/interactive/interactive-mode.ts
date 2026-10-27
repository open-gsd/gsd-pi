// Project/App: gsd-pi
// File Purpose: Interactive TUI mode and session UI rendering.
// gsd-pi - Interactive TUI mode for coding-agent sessions.
/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import type { ImageContent } from "@gsd/pi-ai";
import type { EditorComponent, MarkdownTheme, Spacer, Text } from "@gsd/pi-tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Loader,
	ProcessTerminal,
	setKeybindings,
	type Terminal as TuiTerminal,
	TUI,
} from "@gsd/pi-tui";
import { VERSION } from "@gsd/pi-coding-agent/config.js";
import { type AgentSession, type AgentSessionEvent, createInitialTranscriptState, type TranscriptState } from "@gsd/agent-core";
import type { ExtensionRunner } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { FooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { KeybindingsManager } from "@gsd/agent-core";
import { ensureTool } from "@gsd/pi-coding-agent/utils/tools-manager.js";
import { GsdStatusWidget } from "./components/gsd-status-widget.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { CustomEditor } from "./components/custom-editor.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { setRailAnimationEnabled } from "./components/transcript-design.js";
import { ContextualTips } from "@gsd/agent-core";
import { handleAgentEvent } from "./controllers/chat-controller.js";
import { createInteractiveModeUiState } from "./interactive-mode-ui-state.js";
import { applyAgentEventToTranscript } from "./tui-transcript-tracker.js";
import { setupEditorSubmitHandler as setupEditorSubmitHandlerController } from "./controllers/input-controller.js";
import {
	getEditorTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
} from "@gsd/pi-coding-agent/theme/theme.js";
import * as chatRender from "./interactive-chat-render.js";
import * as commandHandlers from "./interactive-command-handlers.js";
import * as extensionSystem from "./interactive-extension-system.js";
import * as inputRouter from "./interactive-input-router.js";
import * as keyHandlers from "./interactive-key-handlers.js";
import * as modeInit from "./interactive-mode-init.js";
import type { CompactionQueuedMessage } from "./interactive-notify-render.js";
import * as resourceDisplay from "./interactive-resource-display.js";
import * as selectors from "./interactive-selectors.js";
import { clearMarkdownThemeCache, getMarkdownThemeWithSettings as getMarkdownThemeWithSettingsModule } from "./interactive-theme-cache.js";
import * as uiMessaging from "./interactive-ui-messaging.js";
import { DEFAULT_TOOL_OUTPUT_EXPANDED } from "./interactive-mode-class-constants.js";

export type {
	AssistantReplaySegment,
	ExtensionNotifyType,
	ExtensionNotifyRenderResult,
	CompactionQueuedMessage,
} from "./interactive-notify-render.js";
export {
	buildAssistantReplaySegments,
	getToolExpansionStartupHint,
	shouldRenderExtensionNotifyInChat,
	renderExtensionNotifyInChat,
	renderBlockingErrorBanner,
} from "./interactive-notify-render.js";

export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Override the terminal implementation used by the TUI. */
	terminal?: TuiTerminal;
	/** When false, reuse the session's existing extension bindings instead of rebinding them for TUI mode. */
	bindExtensions?: boolean;
	/** Submit editor prompts directly to AgentSession instead of using the interactive prompt loop. */
	submitPromptsDirectly?: boolean;
	/** Control what happens when the user requests shutdown from the TUI. */
	shutdownBehavior?: "exit_process" | "stop_ui" | "ignore";
}

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private gsdStatusWidget: GsdStatusWidget;
	private gsdStatusExpanded: boolean | undefined = undefined;
	private gsdProgressState: import("@gsd/pi-coding-agent/core/extensions/extension-upstream-types.js").GsdProgressState | undefined;
	private gsdProgressDispose?: () => void;
	private statusContainer: Container;
	private pinnedMessageContainer: Container;
	private blockingErrorContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: CombinedAutocompleteProvider | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: Loader | undefined = undefined;
	private activityLoader: Loader | undefined = undefined;
	private pendingWorkingMessage: string | null | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private lastBlockingError: string | undefined = undefined;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupHeaderDismissed = false;

	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: import("@gsd/pi-ai").AssistantMessage | undefined = undefined;

	private pendingTools = new Map<string, ToolExecutionComponent>();
	// Live dispatch/terminal tracking for the status widgets. pendingTools
	// deliberately retains completed components for transcript reconstruction,
	// so its size is not an active-execution count (#2925).
	private activeToolInvocations = new Set<string>();
	private toolOutputExpanded = DEFAULT_TOOL_OUTPUT_EXPANDED;
	private pendingImages: ImageContent[] = [];
	private hideThinkingBlock = false;
	private skillCommands = new Map<string, string>();
	private unsubscribe?: () => void;
	private _branchChangeUnsub?: () => void;
	private _themeChangeUnsub?: () => void;
	private markdownThemeCache?: MarkdownTheme;
	private markdownThemeCacheIndent?: string;
	private isBashMode = false;
	private contextualTips = new ContextualTips();
	private bashComponent: BashExecutionComponent | undefined = undefined;
	private pendingBashComponents: BashExecutionComponent[] = [];
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];
	private shutdownRequested = false;
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();
	private stdinErrorHandler: ((err: Error) => void) | undefined = undefined;
	private extensionWidgetsAbove = new Map<string, import("@gsd/pi-tui").Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, import("@gsd/pi-tui").Component & { dispose?(): void }>();
	private readonly uiState = createInteractiveModeUiState();
	transcriptState: TranscriptState = createInitialTranscriptState();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;
	private customFooter: (import("@gsd/pi-tui").Component & { dispose?(): void }) | undefined = undefined;
	private headerContainer: Container;
	private builtInHeader: import("@gsd/pi-tui").Component | undefined = undefined;
	private customHeader: (import("@gsd/pi-tui").Component & { dispose?(): void }) | undefined = undefined;

	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	get streamingRenderState() {
		return this.uiState.streaming.streamingRenderState;
	}

	constructor(
		session: AgentSession,
		private options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		setRailAnimationEnabled(this.settingsManager.getToolRailAnimation());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.gsdStatusWidget = new GsdStatusWidget(() => ({
			override: this.settingsManager.getAdaptiveMode(),
			activeToolCount: this.activeToolInvocations.size,
			gsdPhase: this.gsdProgressState?.phase ?? this.pendingWorkingMessage ?? undefined,
			lastError: this.lastBlockingError,
			sessionName: this.sessionManager.getSessionName(),
			cwd: this.gsdProgressState?.path ?? process.cwd(),
			manuallyExpanded: this.gsdStatusExpanded,
			gsdProgress: this.gsdProgressState,
			isStreaming: this.session.isStreaming,
		}));
		this.statusContainer = new Container();
		this.pinnedMessageContainer = new Container();
		this.blockingErrorContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		// Install the user keybindings globally so pi-tui components (Editor, Input,
		// SelectList, ...) honor tui.* overrides from keybindings.json (#3028).
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as import("@gsd/pi-tui").Component);
		this.footerDataProvider = new FooterDataProvider(process.cwd());
		this.footer = new FooterComponent(session, this.footerDataProvider, () => ({
			override: this.settingsManager.getAdaptiveMode(),
			activeToolCount: this.activeToolInvocations.size,
			gsdPhase: this.gsdProgressState?.phase ?? this.pendingWorkingMessage ?? undefined,
			lastError: this.lastBlockingError,
			cwd: this.gsdProgressState?.path ?? process.cwd(),
			manuallyExpanded: this.gsdStatusExpanded,
			gsdProgress: this.gsdProgressState,
		}));
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.toolOutputExpanded = this.settingsManager.getToolsExpanded();
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private setupAutocomplete(): void {
		inputRouter.setupAutocomplete(this);
	}

	private installStdinErrorRecovery(): void {
		modeInit.installStdinErrorRecovery(this);
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.changelogMarkdown = modeInit.getChangelogForDisplay(this);
		await ensureTool("rg");

		this.ui.addChild(this.headerContainer);
		modeInit.mountStartupHeader(this);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.pinnedMessageContainer);
		this.ui.addChild(this.blockingErrorContainer);
		this.renderWidgets();
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		// Fullscreen (alternate screen) mode, slice-1 (#2946): opt-in via env.
		// Everything from the status line down (pinned zone, widgets, editor,
		// footer) stays fixed on screen; the header, chat transcript and pending
		// messages form the scrolling viewport above it.
		if (process.env.PI_TUI_FULLSCREEN === "1") {
			this.ui.setFullscreenPinBoundary(this.statusContainer);
			this.ui.setFullscreen(true);
		}

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		await this.initExtensions();
		this.renderInitialMessages();

		this.ui.start();
		this.ui.onOutputClosed = () => {
			if (this.isShuttingDown) return;
			void keyHandlers.shutdown(this);
		};
		this.installStdinErrorRecovery();
		this.isInitialized = true;

		modeInit.updateTerminalTitle(this);
		this.subscribeToAgent();

		this._themeChangeUnsub = onThemeChange(() => {
			this.clearMarkdownThemeCache();
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this._branchChangeUnsub = this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		await this.updateAvailableProviderCount();
	}

	async run(): Promise<void> {
		await this.init();

		modeInit.checkForNewVersion(this).then((newVersion) => {
			if (newVersion) {
				modeInit.showNewVersionNotification(this, newVersion);
			}
		});

		modeInit.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		while (true) {
			const userInput = await this.getUserInput();
			const images = this.pendingImages.length > 0 ? [...this.pendingImages] : undefined;
			this.pendingImages.length = 0;
			try {
				await this.session.prompt(userInput, { images });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	getMarkdownThemeWithSettings(): MarkdownTheme {
		return getMarkdownThemeWithSettingsModule(this);
	}

	private clearMarkdownThemeCache(): void {
		clearMarkdownThemeCache(this);
	}

	private setupEditorSubmitHandler(): void {
		setupEditorSubmitHandlerController(this as any);
	}

	private subscribeToAgent(): void {
		let eventQueue: Promise<void> = Promise.resolve();
		this.unsubscribe = this.session.subscribe((event) => {
			eventQueue = eventQueue.then(() => this.handleEvent(event)).catch(() => {});
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		this.transcriptState = applyAgentEventToTranscript(this.transcriptState, event);
		await handleAgentEvent(this as any, event);
	}

	clearEditor(): void {
		uiMessaging.clearEditor(this);
	}

	showError(errorMessage: string): void {
		uiMessaging.showError(this, errorMessage);
	}

	clearBlockingError(): void {
		uiMessaging.clearBlockingError(this);
	}

	showWarning(warningMessage: string): void {
		uiMessaging.showWarning(this, warningMessage);
	}

	showSuccess(successMessage: string): void {
		uiMessaging.showSuccess(this, successMessage);
	}

	showTip(message: string): void {
		uiMessaging.showTip(this, message);
	}

	getContextPercent(): number | undefined {
		return this.session.getContextUsage()?.percent ?? undefined;
	}

	renderInitialMessages(): void {
		chatRender.renderInitialMessages(this);
	}

	async getUserInput(): Promise<string> {
		return chatRender.getUserInput(this);
	}

	getExtensionUIContext() {
		return extensionSystem.createExtensionUIContext(this);
	}

	requestRender(force = false): void {
		if (!this.isInitialized) return;
		this.ui.requestRender(force);
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this._branchChangeUnsub?.();
		this._branchChangeUnsub = undefined;
		this._themeChangeUnsub?.();
		this._themeChangeUnsub = undefined;
		stopThemeWatcher();

		if (this.onInputCallback) {
			this.onInputCallback("");
			this.onInputCallback = undefined;
		}

		this.clearExtensionWidgets();
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}
		this.customFooter = undefined;
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}
		this.customHeader = undefined;
		this.autocompleteProvider = undefined;

		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.stdinErrorHandler) {
			process.stdin.removeListener("error", this.stdinErrorHandler);
			this.stdinErrorHandler = undefined;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	// Delegates (Phase E2 extracted modules)
	private formatDisplayPath(p: string): string { return resourceDisplay.formatDisplayPath(this, p); }
	private getShortPath(fullPath: string, source: string): string { return resourceDisplay.getShortPath(this, fullPath, source); }
	private showLoadedResources(options?: Parameters<typeof resourceDisplay.showLoadedResources>[1]): void { resourceDisplay.showLoadedResources(this, options); }

	private async initExtensions(): Promise<void> { return extensionSystem.initExtensions(this); }
	private getRegisteredToolDefinition(toolName: string) { return extensionSystem.getRegisteredToolDefinition(this, toolName); }
	private formatWebSearchResult(content: unknown): string { return extensionSystem.formatWebSearchResult(this, content); }
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void { extensionSystem.setupExtensionShortcuts(this, extensionRunner); }
	private setExtensionStatus(key: string, text: string | undefined): void { extensionSystem.setExtensionStatus(this, key, text); }
	private setGsdProgress(state: Parameters<typeof extensionSystem.setGsdProgress>[1], dispose?: () => void): void { extensionSystem.setGsdProgress(this, state, dispose); }
	private setExtensionWidget(key: string, content: Parameters<typeof extensionSystem.setExtensionWidget>[2], options?: Parameters<typeof extensionSystem.setExtensionWidget>[3]): void { extensionSystem.setExtensionWidget(this, key, content, options); }
	private clearExtensionWidgets(): void { extensionSystem.clearExtensionWidgets(this); }
	private resetExtensionUI(): void { extensionSystem.resetExtensionUI(this); }
	private renderWidgets(): void { extensionSystem.renderWidgets(this); }
	private setExtensionFooter(factory: Parameters<typeof extensionSystem.setExtensionFooter>[1]): void { extensionSystem.setExtensionFooter(this, factory); }
	private setExtensionHeader(factory: Parameters<typeof extensionSystem.setExtensionHeader>[1]): void { extensionSystem.setExtensionHeader(this, factory); }
	private addExtensionTerminalInputListener(handler: Parameters<typeof extensionSystem.addExtensionTerminalInputListener>[1]): () => void { return extensionSystem.addExtensionTerminalInputListener(this, handler); }
	private clearExtensionTerminalInputListeners(): void { extensionSystem.clearExtensionTerminalInputListeners(this); }
	private createExtensionUIContext() { return extensionSystem.createExtensionUIContext(this); }
	private showExtensionSelector(title: string, options: string[], opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<string | undefined> { return extensionSystem.showExtensionSelector(this, title, options, opts); }
	private hideExtensionSelector(): void { extensionSystem.hideExtensionSelector(this); }
	private showExtensionConfirm(title: string, message: string, opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<boolean> { return extensionSystem.showExtensionConfirm(this, title, message, opts); }
	private showExtensionInput(title: string, placeholder?: string, opts?: import("@gsd/pi-coding-agent/core/extensions/index.js").ExtensionUIDialogOptions): Promise<string | undefined> { return extensionSystem.showExtensionInput(this, title, placeholder, opts); }
	private hideExtensionInput(): void { extensionSystem.hideExtensionInput(this); }
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> { return extensionSystem.showExtensionEditor(this, title, prefill); }
	private hideExtensionEditor(): void { extensionSystem.hideExtensionEditor(this); }
	private setCustomEditorComponent(factory: Parameters<typeof extensionSystem.setCustomEditorComponent>[1]): void { extensionSystem.setCustomEditorComponent(this, factory); }
	private showExtensionNotify(message: string, type?: import("./interactive-notify-render.js").ExtensionNotifyType): void { extensionSystem.showExtensionNotify(this, message, type); }
	private showExtensionCustom<T>(factory: Parameters<typeof extensionSystem.showExtensionCustom<T>>[1], options?: Parameters<typeof extensionSystem.showExtensionCustom<T>>[2]): Promise<T> { return extensionSystem.showExtensionCustom(this, factory, options); }
	private showExtensionError(extensionPath: string, error: string, stack?: string): void { extensionSystem.showExtensionError(this, extensionPath, error, stack); }

	private setupKeyHandlers(): void { keyHandlers.setupKeyHandlers(this); }
	private handleClipboardImagePaste(): Promise<void> { return keyHandlers.handleClipboardImagePaste(this); }
	private handlePastedImagePath(filePath: string): void { keyHandlers.handlePastedImagePath(this, filePath); }
	private getSlashCommandContext() { return inputRouter.getSlashCommandContext(this); }
	private getAllQueuedMessages() { return inputRouter.getAllQueuedMessages(this); }
	private clearAllQueues() { return inputRouter.clearAllQueues(this); }
	private updatePendingMessagesDisplay(): void { inputRouter.updatePendingMessagesDisplay(this); }
	private restoreQueuedMessagesToEditor(options?: Parameters<typeof inputRouter.restoreQueuedMessagesToEditor>[1]): number { return inputRouter.restoreQueuedMessagesToEditor(this, options); }
	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void { inputRouter.queueCompactionMessage(this, text, mode); }
	private isExtensionCommand(text: string): boolean { return inputRouter.isExtensionCommand(this, text); }
	private isKnownSlashCommand(text: string): boolean { return inputRouter.isKnownSlashCommand(this, text); }
	private async flushCompactionQueue(options?: Parameters<typeof inputRouter.flushCompactionQueue>[1]): Promise<void> { return inputRouter.flushCompactionQueue(this, options); }
	private flushPendingBashComponents(): void { inputRouter.flushPendingBashComponents(this); }
	private updateTerminalTitle(): void { modeInit.updateTerminalTitle(this); }

	private getUserMessageText(message: import("@gsd/pi-ai").Message): string { return chatRender.getUserMessageText(this, message); }
	private showStatus(message: string, options?: { append?: boolean }): void { chatRender.showStatus(this, message, options); }
	private addMessageToChat(message: import("@gsd/pi-agent-core").AgentMessage, options?: { populateHistory?: boolean }): void { chatRender.addMessageToChat(this, message, options); }
	private trimChatHistory(): void { chatRender.trimChatHistory(this); }
	private renderSessionContext(sessionContext: import("@gsd/pi-coding-agent/core/session-manager.js").SessionContext, options?: Parameters<typeof chatRender.renderSessionContext>[2]): void { chatRender.renderSessionContext(this, sessionContext, options); }
	private rebuildChatFromMessages(): void { chatRender.rebuildChatFromMessages(this); }
	private populatePinnedFromMessages(messages: import("@gsd/pi-agent-core").AgentMessage[]): void { chatRender.populatePinnedFromMessages(this, messages); }

	private handleCtrlC(): void { keyHandlers.handleCtrlC(this); }
	private handleCtrlD(): void { keyHandlers.handleCtrlD(this); }
	private isShuttingDown = false;
	private async shutdown(): Promise<void> { return keyHandlers.shutdown(this); }
	private async checkShutdownRequested(): Promise<void> { return keyHandlers.checkShutdownRequested(this); }
	private handleCtrlZ(): void { keyHandlers.handleCtrlZ(this); }
	private async handleFollowUp(): Promise<void> { return keyHandlers.handleFollowUp(this); }
	private handleDequeue(): void { keyHandlers.handleDequeue(this); }
	private updateEditorBorderColor(): void { keyHandlers.updateEditorBorderColor(this); }
	private cycleThinkingLevel(): void { keyHandlers.cycleThinkingLevel(this); }
	private async cycleModel(direction: "forward" | "backward"): Promise<void> { return keyHandlers.cycleModel(this, direction); }
	private toggleToolOutputExpansion(): void { keyHandlers.toggleToolOutputExpansion(this); }
	private setToolsExpanded(expanded: boolean): void { keyHandlers.setToolsExpanded(this, expanded); }
	toggleGsdStatusWidget(): void {
		// Compute the effective expansion so the toggle always visually flips:
		// undefined = use widgetMode default, otherwise use the explicit value.
		const progress = this.gsdProgressState;
		const defaultExpanded = progress !== undefined && progress.widgetMode !== "min";
		const currentlyExpanded = this.gsdStatusExpanded !== undefined ? this.gsdStatusExpanded : defaultExpanded;
		this.gsdStatusExpanded = !currentlyExpanded;
		this.gsdStatusWidget.invalidate();
		this.footer.invalidate();
		this.ui.requestRender();
	}
	private setToolRailAnimation(enabled: boolean): void {
		this.settingsManager.setToolRailAnimation(enabled);
		setRailAnimationEnabled(enabled);
		for (const child of this.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) child.refreshRailAnimation();
		}
		this.ui.requestRender();
	}
	private toggleThinkingBlockVisibility(): void { keyHandlers.toggleThinkingBlockVisibility(this); }
	private openExternalEditor(): void { keyHandlers.openExternalEditor(this); }

	private showSelector(create: Parameters<typeof selectors.showSelector>[1]): void { selectors.showSelector(this, create); }
	private showSettingsSelector(): void { selectors.showSettingsSelector(this); }
	private async handleModelCommand(searchTerm?: string): Promise<void> { return selectors.handleModelCommand(this, searchTerm); }
	private async findExactModelMatch(searchTerm: string) { return selectors.findExactModelMatch(this, searchTerm); }
	private async getModelCandidates() { return selectors.getModelCandidates(this); }
	private async updateAvailableProviderCount(): Promise<void> { return selectors.updateAvailableProviderCount(this); }
	private showModelSelector(initialSearchInput?: string): void { selectors.showModelSelector(this, initialSearchInput); }
	private async showModelsSelector(): Promise<void> { return selectors.showModelsSelector(this); }
	private showUserMessageSelector(): void { selectors.showUserMessageSelector(this); }
	private showTreeSelector(initialSelectedId?: string): void { selectors.showTreeSelector(this, initialSelectedId); }
	private showSessionSelector(): void { selectors.showSessionSelector(this); }
	private async handleResumeSession(sessionPath: string): Promise<void> { return selectors.handleResumeSession(this, sessionPath); }
	private showProviderManager(): void { selectors.showProviderManager(this); }
	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> { return selectors.showOAuthSelector(this, mode); }
	private async showLoginDialog(providerId: string): Promise<void> { return selectors.showLoginDialog(this, providerId); }

	private async handleReloadCommand(): Promise<void> { return commandHandlers.handleReloadCommand(this); }
	private async handleClearCommand(): Promise<void> { return commandHandlers.handleClearCommand(this); }
	private handleDebugCommand(): void { commandHandlers.handleDebugCommand(this); }
	private handleDaxnuts(): void { commandHandlers.handleDaxnuts(this); }
	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void { commandHandlers.checkDaxnutsEasterEgg(this, model); }
	private async handleBashCommand(command: string, excludeFromContext?: boolean, displayCommand?: string, loginShell?: boolean): Promise<void> { return commandHandlers.handleBashCommand(this, command, excludeFromContext, displayCommand, loginShell); }
	private async executeCompaction(customInstructions?: string, isAuto?: boolean) { return commandHandlers.executeCompaction(this, customInstructions, isAuto); }
}
