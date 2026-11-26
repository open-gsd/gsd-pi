// Project/App: gsd-pi
// File Purpose: Extracted from interactive-mode.ts (Phase E2 seam remediation).

import type { AutocompleteItem, SlashCommand } from "@gsd/pi-tui";
import { CombinedAutocompleteProvider, fuzzyFilter } from "@gsd/pi-tui";
import type { Api, Model } from "@gsd/pi-ai";
import { BUILTIN_SLASH_COMMANDS } from "@gsd/pi-coding-agent/core/slash-commands.js";
import type { PromptTemplate } from "@gsd/pi-coding-agent/core/prompt-templates.js";
import type { RegisteredCommand } from "@gsd/pi-coding-agent/core/extensions/index.js";
import { getToolPath } from "@gsd/pi-coding-agent/utils/tools-manager.js";
import { providerDisplayName } from "./components/model-selector.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

export function setupAutocomplete(host: InteractiveModeDelegateHost): void {
	const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
	}));

	const modelCommand = slashCommands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const models =
				host.session.scopedModels.length > 0
					? host.session.scopedModels.map((s: { model: Model<Api> }) => s.model)
					: host.session.modelRegistry.getAvailable();

			if (models.length === 0) return null;

			const items = models.map((m: Model<Api>) => ({
				id: m.id,
				provider: m.provider,
				label: `${m.provider}/${m.id}`,
			}));

			type ModelItem = { id: string; provider: string; label: string };
			const filtered = fuzzyFilter(items, prefix, (item: ModelItem) => `${item.id} ${item.provider}`);

			if (filtered.length === 0) return null;

			return filtered.map((item: ModelItem) => ({
				value: item.label,
				label: item.id,
				description: providerDisplayName(item.provider),
			}));
		};
	}

	const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
	if (thinkingCommand) {
		thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const levels = [
				{ value: "off", label: "off", description: "Disable extended thinking" },
				{ value: "minimal", label: "minimal", description: "Minimal thinking budget" },
				{ value: "low", label: "low", description: "Low thinking budget" },
				{ value: "medium", label: "medium", description: "Medium thinking budget" },
				{ value: "high", label: "high", description: "High thinking budget" },
				{ value: "xhigh", label: "xhigh", description: "Maximum thinking budget" },
				{ value: "max", label: "max", description: "Maximum model-specific reasoning" },
			];
			const filtered = levels.filter((l) => l.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		};
	}

	const templateCommands: SlashCommand[] = host.session.promptTemplates.map((cmd: PromptTemplate) => ({
		name: cmd.name,
		description: cmd.description,
	}));

	const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
	const extensionCommands: SlashCommand[] = (
		host.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
	).map((cmd: RegisteredCommand) => ({
		name: cmd.name,
		description: cmd.description ?? "(extension command)",
		getArgumentCompletions: cmd.getArgumentCompletions,
	}));

	host.skillCommands.clear();
	const skillCommandList: SlashCommand[] = [];
	if (host.settingsManager.getEnableSkillCommands()) {
		for (const skill of host.session.resourceLoader.getSkills().skills) {
			const commandName = `skill:${skill.name}`;
			host.skillCommands.set(commandName, skill.filePath);
			skillCommandList.push({ name: commandName, description: skill.description });
		}
	}

	const fdPath = getToolPath("fd");

	host.autocompleteProvider = new CombinedAutocompleteProvider(
		[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
		process.cwd(),
		fdPath,
	);
	host.autocompleteProvider.setRespectGitignore?.(host.settingsManager.getRespectGitignoreInPicker());
	host.defaultEditor.setAutocompleteProvider(host.autocompleteProvider);
	if (host.editor !== host.defaultEditor) {
		host.editor.setAutocompleteProvider?.(host.autocompleteProvider);
	}
}
