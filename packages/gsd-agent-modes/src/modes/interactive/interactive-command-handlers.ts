// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import * as fs from "node:fs";
import * as path from "node:path";
import type { CompactionResult } from "@gsd/agent-core/compaction/index.js";
import { createCompactionSummaryMessage } from "@gsd/pi-coding-agent/core/messages.js";
import type { TruncationResult } from "@gsd/pi-coding-agent/core/tools/truncate.js";
import { getDebugLogPath } from "@gsd/pi-coding-agent/config.js";
import { Loader, Spacer, Text, visibleWidth, type Component } from "@gsd/pi-tui";
import { setRegisteredThemes, setTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

export async function handleReloadCommand(host: InteractiveModeDelegateHost): Promise<void> {
		if (host.session.isStreaming) {
			host.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (host.session.isCompacting) {
			host.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		host.resetExtensionUI();

		const loader = new BorderedLoader(host.ui, theme, "Reloading extensions, skills, prompts, themes...", {
			cancellable: false,
		});
		const previousEditor = host.editor;
		host.editorContainer.clear();
		host.editorContainer.addChild(loader);
		host.ui.setFocus(loader);
		host.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			host.editorContainer.clear();
			host.editorContainer.addChild(editor);
			host.ui.setFocus(editor);
			host.ui.requestRender();
		};

		try {
			await host.session.reload();
			setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
			host.hideThinkingBlock = host.settingsManager.getHideThinkingBlock();
			const themeName = host.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			host.clearMarkdownThemeCache();
			if (!themeResult.success) {
				host.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = host.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = host.settingsManager.getAutocompleteMaxVisible();
			host.defaultEditor.setPaddingX(editorPaddingX);
			host.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (host.editor !== host.defaultEditor) {
				host.editor.setPaddingX?.(editorPaddingX);
				host.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			host.ui.setShowHardwareCursor(host.settingsManager.getShowHardwareCursor());
			host.ui.setClearOnShrink(host.settingsManager.getClearOnShrink());
			host.setupAutocomplete();
			const runner = host.session.extensionRunner;
			if (runner) {
				host.setupExtensionShortcuts(runner);
			}
			host.rebuildChatFromMessages();
			dismissLoader(host.editor as Component);
			host.showLoadedResources({
				extensionPaths: runner?.getExtensionPaths() ?? [],
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = host.session.modelRegistry.getError();
			if (modelsJsonError) {
				host.showError(`models.json error: ${modelsJsonError}`);
			}
			host.showStatus("Reloaded extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			host.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

export async function handleClearCommand(host: InteractiveModeDelegateHost): Promise<void> {
		// Stop loading animation
		if (host.loadingAnimation) {
			host.loadingAnimation.stop();
			host.loadingAnimation = undefined;
		}
		host.statusContainer.clear();

		// New session via session (emits extension session events)
		await host.session.newSession();

		// Clear UI state
		host.headerContainer.clear();
		host.chatContainer.clear();
		host.pendingMessagesContainer.clear();
		host.compactionQueuedMessages = [];
		host.streamingComponent = undefined;
		host.streamingMessage = undefined;
		host.pendingTools.clear();
		host.pendingImages.length = 0;
		host.clearBlockingError();

		// Reset contextual tips for the new session
		host.contextualTips.reset();

		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
		host.ui.requestRender();
	}

export function handleDebugCommand(host: InteractiveModeDelegateHost): void {
	const width = host.ui.terminal.columns;
	const height = host.ui.terminal.rows;
	const allLines = host.ui.render(width);
	const turnLatency = typeof host.session.formatTurnLatencyRecords === "function"
		? host.session.formatTurnLatencyRecords()
		: "TUI turn latency records unavailable.";

	const debugLogPath = getDebugLogPath();
	const debugData = [
		`Debug output at ${new Date().toISOString()}`,
		`Terminal: ${width}x${height}`,
		`Total lines: ${allLines.length}`,
		"",
		"=== TUI turn latency ===",
		turnLatency,
		"",
		"=== All rendered lines with visible widths ===",
		...allLines.map((line, idx) => {
			const vw = visibleWidth(line);
			const escaped = JSON.stringify(line);
			return `[${idx}] (w=${vw}) ${escaped}`;
		}),
		"",
		"=== Agent messages (JSONL) ===",
		...host.session.messages.map((msg) => JSON.stringify(msg)),
		"",
	].join("\n");

	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.writeFileSync(debugLogPath, debugData);

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
	);
	host.ui.requestRender();
}

export function handleDaxnuts(host: InteractiveModeDelegateHost): void {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new DaxnutsComponent(host.ui));
		host.ui.requestRender();
	}

export function checkDaxnutsEasterEgg(host: InteractiveModeDelegateHost, model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			host.handleDaxnuts();
		}
	}

export async function handleBashCommand(host: InteractiveModeDelegateHost, command: string, excludeFromContext = false, displayCommand?: string, loginShell?: boolean): Promise<void> {
		const extensionRunner = host.session.extensionRunner;
		const label = displayCommand || command;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd: process.cwd(),
				})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			host.bashComponent = new BashExecutionComponent(label, host.ui, excludeFromContext);
			if (host.session.isStreaming) {
				host.pendingMessagesContainer.addChild(host.bashComponent);
				host.pendingBashComponents.push(host.bashComponent);
			} else {
				host.chatContainer.addChild(host.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				host.bashComponent.appendOutput(result.output);
			}
			host.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			host.session.recordBashResult(command, result, { excludeFromContext });
			host.bashComponent = undefined;
			host.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = host.session.isStreaming;
		host.bashComponent = new BashExecutionComponent(label, host.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			host.pendingMessagesContainer.addChild(host.bashComponent);
			host.pendingBashComponents.push(host.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			host.chatContainer.addChild(host.bashComponent);
		}
		host.ui.requestRender();

		try {
			const result = await host.session.executeBash(
				command,
				(chunk) => {
					if (host.bashComponent) {
						host.bashComponent.appendOutput(chunk);
						host.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations, loginShell },
			);

			if (host.bashComponent) {
				host.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (host.bashComponent) {
				host.bashComponent.setComplete(undefined, false);
			}
			host.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		host.bashComponent = undefined;
		host.ui.requestRender();
	}

export async function executeCompaction(host: InteractiveModeDelegateHost, customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
		// Stop loading animation
		if (host.loadingAnimation) {
			host.loadingAnimation.stop();
			host.loadingAnimation = undefined;
		}
		host.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = host.defaultEditor.onEscape;
		host.defaultEditor.onEscape = () => {
			host.session.abortCompaction();
		};

		// Show compacting status
		host.chatContainer.addChild(new Spacer(1));
		const cancelHint = `(${appKey(host.keybindings, "interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			host.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		host.statusContainer.addChild(compactingLoader);
		host.ui.requestRender();

		let result: CompactionResult | undefined;

		try {
			result = await host.session.compact(customInstructions);

			// Rebuild UI
			host.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			host.addMessageToChat(msg);

			host.footer.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				host.showError("Compaction cancelled");
			} else {
				host.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			host.statusContainer.clear();
			host.defaultEditor.onEscape = originalOnEscape;
		}
		void host.flushCompactionQueue({ willRetry: false });
		return result;
	}
