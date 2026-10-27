// gsd-pi + packages/gsd-agent-modes/src/modes/interactive/interactive-mode-keybindings.test.ts - InteractiveMode keybindings wiring regression coverage (#3028).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveMode } from "./interactive-mode.js";
import { type AgentSession, type KeybindingsManager } from "@gsd/agent-core";
import { getKeybindings } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

initTheme("dark", false);

function createStubSession(): AgentSession {
	return {
		settingsManager: {
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
			getToolRailAnimation: () => false,
			getEditorPaddingX: () => 1,
			getAutocompleteMaxVisible: () => 5,
			getToolsExpanded: () => false,
			getHideThinkingBlock: () => false,
			getTheme: () => "dark",
			getAdaptiveMode: () => undefined,
		},
		sessionManager: { getSessionName: () => "keybindings-test-session" },
		resourceLoader: { getThemes: () => ({ themes: [] }) },
		autoCompactionEnabled: false,
		isStreaming: false,
	} as unknown as AgentSession;
}

describe("InteractiveMode keybindings wiring", () => {
	it("installs the user keybindings manager globally so Editor reads tui.input overrides", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "gsd-keybindings-test-"));
		// Same override the issue reproduces with: submit on shift+enter, newline on enter.
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "tui.input.submit": "shift+enter", "tui.input.newLine": "enter" }));

		const previousAgentDir = process.env.GSD_CODING_AGENT_DIR;
		process.env.GSD_CODING_AGENT_DIR = agentDir;

		let mode: InteractiveMode | undefined;
		try {
			mode = new InteractiveMode(createStubSession());

			const installed = getKeybindings();
			const userManager = (mode as unknown as { keybindings: KeybindingsManager }).keybindings;

			// The global manager must be the InteractiveMode manager instance.
			assert.equal(installed, userManager);
			// Its resolved tui.input bindings must reflect keybindings.json, not the pi-tui defaults.
			assert.deepEqual(installed.getKeys("tui.input.submit"), ["shift+enter"]);
			assert.deepEqual(installed.getKeys("tui.input.newLine"), ["enter"]);
		} finally {
			mode?.stop();
			if (previousAgentDir === undefined) {
				delete process.env.GSD_CODING_AGENT_DIR;
			} else {
				process.env.GSD_CODING_AGENT_DIR = previousAgentDir;
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
