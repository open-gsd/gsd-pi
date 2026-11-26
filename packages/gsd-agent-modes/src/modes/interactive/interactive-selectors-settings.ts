// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).
// @ts-nocheck

import { Loader, Spacer } from "@gsd/pi-tui";
import type { Component } from "@gsd/pi-tui";
import type { Model, OAuthProviderId } from "@gsd/pi-ai";
import { getAuthPath } from "@gsd/pi-coding-agent/config.js";
import { resolveModelScope } from "@gsd/pi-coding-agent/core/model-resolver.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { getAvailableThemes, setRegisteredThemes, setTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
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
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";


import { Loader, Spacer } from "@gsd/pi-tui";
import type { Component } from "@gsd/pi-tui";
import type { Model, OAuthProviderId } from "@gsd/pi-ai";
import { getAuthPath } from "@gsd/pi-coding-agent/config.js";
import { resolveModelScope } from "@gsd/pi-coding-agent/core/model-resolver.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { getAvailableThemes, setRegisteredThemes, setTheme, theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { appKey } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
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
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

export function showSelector(host: InteractiveModeDelegateHost, create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			host.editorContainer.clear();
			host.editorContainer.addChild(host.editor);
			host.ui.setFocus(host.editor);
		};
		const { component, focus } = create(done);
		host.editorContainer.clear();
		host.editorContainer.addChild(component);
		host.ui.setFocus(focus);
		host.ui.requestRender();
	}

export function showSettingsSelector(host: InteractiveModeDelegateHost): void {
		host.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: host.session.autoCompactionEnabled,
					showImages: host.settingsManager.getShowImages(),
					autoResizeImages: host.settingsManager.getImageAutoResize(),
					blockImages: host.settingsManager.getBlockImages(),
					enableSkillCommands: host.settingsManager.getEnableSkillCommands(),
					steeringMode: host.session.steeringMode,
					followUpMode: host.session.followUpMode,
					transport: host.settingsManager.getTransport(),
					thinkingLevel: host.session.thinkingLevel,
					availableThinkingLevels: host.session.getAvailableThinkingLevels(),
					currentTheme: host.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: host.hideThinkingBlock,
					toolsExpanded: host.toolOutputExpanded,
					toolRailAnimation: host.settingsManager.getToolRailAnimation(),
					collapseChangelog: host.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: host.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: host.settingsManager.getTreeFilterMode(),
					showHardwareCursor: host.settingsManager.getShowHardwareCursor(),
					editorPaddingX: host.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: host.settingsManager.getAutocompleteMaxVisible(),
					respectGitignoreInPicker: host.settingsManager.getRespectGitignoreInPicker(),
					quietStartup: host.settingsManager.getQuietStartup(),
					clearOnShrink: host.settingsManager.getClearOnShrink(),
					timestampFormat: host.settingsManager.getTimestampFormat(),
					adaptiveMode: host.settingsManager.getAdaptiveMode(),
				},
				{
					onAutoCompactChange: (enabled) => {
						host.session.setAutoCompactionEnabled(enabled);
						host.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						host.settingsManager.setShowImages(enabled);
						for (const child of host.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						host.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						host.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						host.settingsManager.setEnableSkillCommands(enabled);
						host.setupAutocomplete();
					},
					onSteeringModeChange: (mode) => {
						host.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						host.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						host.settingsManager.setTransport(transport);
						host.session.agent.transport = transport;
					},
					onThinkingLevelChange: (level) => {
						host.session.setThinkingLevel(level);
						host.footer.invalidate();
						host.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						host.settingsManager.setTheme(themeName);
						host.clearMarkdownThemeCache();
						host.ui.invalidate();
						if (!result.success) {
							host.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							host.clearMarkdownThemeCache();
							host.ui.invalidate();
							host.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						host.hideThinkingBlock = hidden;
						host.settingsManager.setHideThinkingBlock(hidden);
						for (const child of host.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						host.chatContainer.clear();
						host.rebuildChatFromMessages();
					},
					onToolsExpandedChange: (expanded) => {
						host.settingsManager.setToolsExpanded(expanded);
						host.setToolsExpanded(expanded);
					},
					onToolRailAnimationChange: (enabled) => {
						host.setToolRailAnimation(enabled);
					},
					onCollapseChangelogChange: (collapsed) => {
						host.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						host.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						host.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						host.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						host.settingsManager.setShowHardwareCursor(enabled);
						host.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						host.settingsManager.setEditorPaddingX(padding);
						host.defaultEditor.setPaddingX(padding);
						if (host.editor !== host.defaultEditor && host.editor.setPaddingX !== undefined) {
							host.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						host.settingsManager.setAutocompleteMaxVisible(maxVisible);
						host.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (host.editor !== host.defaultEditor && host.editor.setAutocompleteMaxVisible !== undefined) {
							host.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						host.settingsManager.setClearOnShrink(enabled);
						host.ui.setClearOnShrink(enabled);
					},
					onRespectGitignoreInPickerChange: (enabled) => {
						host.settingsManager.setRespectGitignoreInPicker(enabled);
						host.autocompleteProvider?.setRespectGitignore?.(enabled);
					},
					onTimestampFormatChange: (format) => {
						host.settingsManager.setTimestampFormat(format);
					},
					onAdaptiveModeChange: (mode) => {
						host.settingsManager.setAdaptiveMode(mode);
						host.ui.requestRender();
					},
					onCancel: () => {
						done();
						host.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

export async function handleModelCommand(host: InteractiveModeDelegateHost, searchTerm?: string): Promise<void> {
		await handleModelCommandController(host, searchTerm);
	}

export async function findExactModelMatch(host: InteractiveModeDelegateHost, searchTerm: string): Promise<Model<any> | undefined> {
		return findExactModelMatchController(host, searchTerm);
	}

export async function getModelCandidates(host: InteractiveModeDelegateHost): Promise<Model<any>[]> {
		return getModelCandidatesController(host);
	}

	/** Update the footer's available provider count from current model candidates */
export async function updateAvailableProviderCount(host: InteractiveModeDelegateHost): Promise<void> {
		await updateAvailableProviderCountController(host);
	}

export function showModelSelector(host: InteractiveModeDelegateHost, initialSearchInput?: string): void {
		host.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				host.ui,
				host.session.model,
				host.settingsManager,
				host.session.modelRegistry,
				host.session.scopedModels,
				async (model) => {
					try {
						await host.session.setModel(model);
						host.footer.invalidate();
						host.updateEditorBorderColor();
						done();
						host.showStatus(`Model: ${model.id}`);
						host.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						host.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					host.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

export async function showModelsSelector(host: InteractiveModeDelegateHost): Promise<void> {
		// Get all available models
		host.session.modelRegistry.refresh();
		const allModels = host.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			host.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = host.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = host.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, host.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), host.session.modelRegistry);
				host.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				host.session.setScopedModels([]);
			}
			await host.updateAvailableProviderCount();
			host.ui.requestRender();
		};

		host.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						host.settingsManager.setEnabledModels(newPatterns);
						host.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						host.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}
