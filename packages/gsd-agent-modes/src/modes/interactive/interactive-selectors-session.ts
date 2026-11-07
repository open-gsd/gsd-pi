// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import { Loader, Spacer } from "@gsd/pi-tui";
import type { Component } from "@gsd/pi-tui";
import type { Model } from "@gsd/pi-ai";
import { resolveModelScope } from "@gsd/pi-coding-agent/core/model-resolver.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { getAvailableThemes, setRegisteredThemes, setTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { ProviderManagerComponent } from "./components/provider-manager.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import {
  findExactModelMatch as findExactModelMatchController,
  getModelCandidates as getModelCandidatesController,
  handleModelCommand as handleModelCommandController,
  updateAvailableProviderCount as updateAvailableProviderCountController,
} from "./controllers/model-controller.js";
import { handleLoginProviderSelection } from "./interactive-selectors-auth.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

export function showUserMessageSelector(host: InteractiveModeDelegateHost): void {
		const userMessages = host.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			host.showStatus("No messages to fork from");
			return;
		}

		host.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await host.session.fork(entryId);
					if (result.cancelled) {
						// Extension cancelled the fork
						done();
						host.ui.requestRender();
						return;
					}

					host.chatContainer.clear();
					host.renderInitialMessages();
					host.editor.setText(result.selectedText);
					done();
					host.showStatus("Branched to new session");
				},
				() => {
					done();
					host.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

export function showTreeSelector(host: InteractiveModeDelegateHost, initialSelectedId?: string): void {
		const tree = host.sessionManager.getTree();
		const realLeafId = host.sessionManager.getLeafId();
		const initialFilterMode = host.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			host.showStatus("No entries in session");
			return;
		}

		host.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				host.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						host.showStatus("Already at host point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!host.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await host.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								host.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await host.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = host.defaultEditor.onEscape;

					if (wantsSummary) {
						host.defaultEditor.onEscape = () => {
							host.session.abortBranchSummary();
						};
						host.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							host.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${appKey(host.keybindings, "interrupt")} to cancel)`,
						);
						host.statusContainer.addChild(summaryLoader);
						host.ui.requestRender();
					}

					try {
						const result = await host.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							host.showStatus("Branch summarization cancelled");
							host.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							host.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						host.chatContainer.clear();
						host.renderInitialMessages();
						if (result.editorText && !host.editor.getText().trim()) {
							host.editor.setText(result.editorText);
						}
						host.showStatus("Navigated to selected point");
					} catch (error) {
						host.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							host.statusContainer.clear();
						}
						host.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					host.ui.requestRender();
				},
				(entryId, label) => {
					host.sessionManager.appendLabelChange(entryId, label);
					host.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

export function showSessionSelector(host: InteractiveModeDelegateHost): void {
		host.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(host.sessionManager.getCwd(), host.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await host.handleResumeSession(sessionPath);
				},
				() => {
					done();
					host.ui.requestRender();
				},
				() => {
					void host.shutdown();
				},
				() => host.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: host.keybindings,
				},

				host.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

export async function handleResumeSession(host: InteractiveModeDelegateHost, sessionPath: string): Promise<void> {
		// Stop loading animation
		if (host.loadingAnimation) {
			host.loadingAnimation.stop();
			host.loadingAnimation = undefined;
		}
		host.statusContainer.clear();

		// Clear UI state
		host.pendingMessagesContainer.clear();
		host.compactionQueuedMessages = [];
		host.streamingComponent = undefined;
		host.streamingMessage = undefined;
		host.pendingTools.clear();
		host.clearBlockingError();

		// Switch session via AgentSession (emits extension session events)
		await host.session.switchSession(sessionPath);

		// Clear and re-render the chat
		host.chatContainer.clear();
		host.renderInitialMessages();

		if (host.session.sessionManager.wasInterrupted()) {
			host.showStatus("Resumed session (previous session ended unexpectedly — last action may be incomplete)");
		} else {
			host.showStatus("Resumed session");
		}
	}

export function showProviderManager(host: InteractiveModeDelegateHost): void {
		host.showSelector((done) => {
			const component = new ProviderManagerComponent(
				host.ui,
				host.session.modelRegistry.authStorage,
				host.session.modelRegistry,
				() => {
					done();
					host.ui.requestRender();
				},
				async (provider: string) => {
					host.showStatus(`Discovering models for ${provider}...`);
					try {
						const results = await host.session.modelRegistry.discoverModels([provider]);
						const result = results[0];
						if (result?.error) {
							host.showError(`Discovery failed: ${result.error}`);
						} else {
							host.showStatus(`Discovered ${result?.models.length ?? 0} models from ${provider}`);
						}
					} catch (error) {
						host.showError(error instanceof Error ? error.message : String(error));
					}
					done();
					host.ui.requestRender();
				},
				async (provider: string) => {
					done();
					await handleLoginProviderSelection(host, provider);
				},
			);
			return { component, focus: component };
		});
	}
