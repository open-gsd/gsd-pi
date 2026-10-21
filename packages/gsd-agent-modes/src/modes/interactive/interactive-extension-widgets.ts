// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import { Container, Spacer, Text, type Component, type TUI } from "@gsd/pi-tui";
import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { setupExtensionShortcuts } from "./interactive-extension-tools.js";
export { getRegisteredToolDefinition, formatWebSearchResult } from "./interactive-extension-tools.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { setRegisteredThemes, setTheme, Theme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import type { ExtensionNotifyType } from "./interactive-notify-render.js";
import { renderBlockingErrorBanner, renderExtensionNotifyInChat } from "./interactive-notify-render.js";
import { createExtensionUIContext as buildExtensionUIContext } from "./controllers/extension-ui-controller.js";
import { MAX_WIDGET_LINES } from "./interactive-mode-class-constants.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";
import { getEditorTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { EditorComponent, EditorTheme, KeybindingsManager, OverlayHandle, OverlayOptions } from "@gsd/pi-tui";

export async function initExtensions(host: InteractiveModeDelegateHost): Promise<void> {
		if (host.options.bindExtensions !== false) {
			const uiContext = host.createExtensionUIContext();
			await host.session.bindExtensions({
				uiContext,
				commandContextActions: {
					waitForIdle: () => host.session.agent.waitForIdle(),
					newSession: async (options) => {
						if (host.loadingAnimation) {
							host.loadingAnimation.stop();
							host.loadingAnimation = undefined;
						}
						host.statusContainer.clear();

						// Delegate to AgentSession (handles setup + agent state sync)
						const success = await host.session.newSession(options);
						if (!success) {
							return { cancelled: true };
						}

						// Clear UI state
						host.chatContainer.clear();
						host.pendingMessagesContainer.clear();
						host.compactionQueuedMessages = [];
						host.streamingComponent = undefined;
						host.streamingMessage = undefined;
						host.pendingTools.clear();
						host.clearBlockingError();

						// Render any messages added via setup, or show empty session
						host.renderInitialMessages();
						host.ui.requestRender();

						return { cancelled: false };
					},
					fork: async (entryId) => {
						const result = await host.session.fork(entryId);
						if (result.cancelled) {
							return { cancelled: true };
						}

						host.chatContainer.clear();
						host.renderInitialMessages();
						host.editor.setText(result.selectedText);
						host.showStatus("Forked to new session");

						return { cancelled: false };
					},
					navigateTree: async (targetId, options) => {
						const result = await host.session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						if (result.cancelled) {
							return { cancelled: true };
						}

						host.chatContainer.clear();
						host.renderInitialMessages();
						if (result.editorText && !host.editor.getText().trim()) {
							host.editor.setText(result.editorText);
						}
						host.showStatus("Navigated to selected point");

						return { cancelled: false };
					},
					switchSession: async (sessionPath) => {
						await host.handleResumeSession(sessionPath);
						return { cancelled: false };
					},
					reload: async () => {
						await host.handleReloadCommand();
					},
				},
				shutdownHandler: () => {
					host.shutdownRequested = true;
					if (!host.session.isStreaming) {
						void host.shutdown();
					}
				},
				onError: (error) => {
					host.showExtensionError(error.extensionPath, error.error, error.stack);
				},
			});
		}

		setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
		host.setupAutocomplete();

		const extensionRunner = host.session.extensionRunner;
		if (!extensionRunner) {
			host.showLoadedResources({ extensionPaths: [], force: false });
			return;
		}

		setupExtensionShortcuts(host, extensionRunner);
		host.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
	}

export function setExtensionStatus(host: InteractiveModeDelegateHost, key: string, text: string | undefined): void {
		host.footerDataProvider.setExtensionStatus(key, text);
		host.footer.invalidate();
		host.ui.requestRender();
	}

export function setGsdProgress(
	host: InteractiveModeDelegateHost,
	state: import("@gsd/pi-coding-agent/core/extensions/extension-upstream-types.js").GsdProgressState | undefined,
	dispose?: () => void,
): void {
	if (dispose !== undefined) {
		const prev = host.gsdProgressDispose;
		host.gsdProgressDispose = dispose;
		// Reset user's manual expansion for the new unit so widgetMode drives
		// the initial state again (the user can re-collapse via ctrl+shift+d).
		host.gsdStatusExpanded = undefined;
		prev?.();
	} else if (state === undefined) {
		const prev = host.gsdProgressDispose;
		host.gsdProgressDispose = undefined;
		prev?.();
	}
	host.gsdProgressState = state;
	host.ui.requestRender();
}

	/**
	 * Set an extension widget (string array or custom component).
	 */
export function setExtensionWidget(host: InteractiveModeDelegateHost, key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(host.extensionWidgetsAbove);
		removeExisting(host.extensionWidgetsBelow);

		if (content === undefined) {
			renderWidgets(host, );
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(host.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? host.extensionWidgetsBelow : host.extensionWidgetsAbove;
		targetMap.set(key, component);
		renderWidgets(host, );
		// Step-complete / handoff widgets replace the live progress panel and can
		// shrink the layout after pinned streaming output is torn down. Force a
		// full viewport realign so the transcript stays visible.
		if (key === "gsd-outcome" && content !== undefined) {
			host.ui.requestRender(true);
		}
	}

export function clearExtensionWidgets(host: InteractiveModeDelegateHost): void {
		for (const widget of host.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of host.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		host.extensionWidgetsAbove.clear();
		host.extensionWidgetsBelow.clear();
		renderWidgets(host, );
	}

export function resetExtensionUI(host: InteractiveModeDelegateHost): void {
		if (host.extensionSelector) {
			hideExtensionSelector(host, );
		}
		if (host.extensionInput) {
			hideExtensionInput(host, );
		}
		if (host.extensionEditor) {
			hideExtensionEditor(host, );
		}
		host.ui.hideOverlay();
		host.clearExtensionTerminalInputListeners();
		host.setExtensionFooter(undefined);
		host.setExtensionHeader(undefined);
		clearExtensionWidgets(host, );
		const prevGsdDispose = host.gsdProgressDispose;
		host.gsdProgressDispose = undefined;
		host.gsdProgressState = undefined;
		prevGsdDispose?.();
		host.footerDataProvider.clearExtensionStatuses();
		host.footer.invalidate();
		host.setCustomEditorComponent(undefined);
		host.defaultEditor.onExtensionShortcut = undefined;
		host.updateTerminalTitle();
		if (host.loadingAnimation) {
			host.loadingAnimation.setMessage(
				`${host.defaultWorkingMessage} (${appKey(host.keybindings, "interrupt")} to interrupt)`,
			);
		}
	}

	/**
	 * Render all extension widgets to the widget container.
	 */
export function renderWidgets(host: InteractiveModeDelegateHost): void {
		if (!host.widgetContainerAbove || !host.widgetContainerBelow) return;

		// widgetContainerAbove: spacer collapses when pinned content is visible
		// so there's no extra blank line between pinned output and the editor border.
		// Use detachChildren() (not clear()) — the extensionWidgetsAbove map owns
		// disposal; clear() would dispose every mounted widget on every re-render.
		host.widgetContainerAbove.detachChildren();
		const pinned = host.pinnedMessageContainer;
		host.widgetContainerAbove.addChild({
			render: () => pinned.children.length > 0 ? [] : [""],
			invalidate: () => {},
		});
		if (host.gsdStatusWidget) {
			host.widgetContainerAbove.addChild(host.gsdStatusWidget);
		}
		for (const component of host.extensionWidgetsAbove.values()) {
			host.widgetContainerAbove.addChild(component);
		}

		renderWidgetContainer(host, host.widgetContainerBelow, host.extensionWidgetsBelow, false, false);
		host.ui.requestRender();
	}

export function renderWidgetContainer(host: InteractiveModeDelegateHost, 
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		// Detach without disposing — the widgets map owns lifecycle; disposing
		// here would kill refresh timers and subscriptions on every re-render.
		container.detachChildren();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
export function setExtensionFooter(host: InteractiveModeDelegateHost, factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (host.customFooter?.dispose) {
			host.customFooter.dispose();
		}

		// Remove current footer from UI
		if (host.customFooter) {
			host.ui.removeChild(host.customFooter);
		} else {
			host.ui.removeChild(host.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			host.customFooter = factory(host.ui, theme, host.footerDataProvider);
			host.ui.addChild(host.customFooter);
		} else {
			// Restore built-in footer
			host.customFooter = undefined;
			host.ui.addChild(host.footer);
		}

		host.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
export function setExtensionHeader(host: InteractiveModeDelegateHost, factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!host.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (host.customHeader?.dispose) {
			host.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = host.customHeader || host.builtInHeader;
		const index = host.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			host.customHeader = factory(host.ui, theme);
			if (index !== -1) {
				host.headerContainer.children[index] = host.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				host.headerContainer.children.unshift(host.customHeader);
			}
		} else {
			// Restore built-in header
			host.customHeader = undefined;
			if (index !== -1) {
				host.headerContainer.children[index] = host.builtInHeader;
			}
		}

		host.ui.requestRender();
	}

export function addExtensionTerminalInputListener(
	host: InteractiveModeDelegateHost,
	handler: (data: string) => { consume?: boolean; data?: string } | undefined,
): () => void {
		const unsubscribe = host.ui.addInputListener(handler);
		host.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			host.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

export function clearExtensionTerminalInputListeners(host: InteractiveModeDelegateHost): void {
		for (const unsubscribe of host.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		host.extensionTerminalInputUnsubscribers.clear();
	}
