import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.js";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.js";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.js";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.js";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.js";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.js";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.js";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.js";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
