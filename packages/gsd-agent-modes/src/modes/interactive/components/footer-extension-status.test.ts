// Project/App: gsd-pi
// File Purpose: Footer render contract for extension status keys (#2374).
//
// Pins the contract the gsd extension's turn-status module relies on: a
// "gsd-turn" entry in the extension status map renders in the footer without
// any TUI-package change (it flows through the generic secondary-status
// path). Structural fakes only — no real session.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";

import { FooterComponent } from "./footer.js";

initTheme("dark", false);

function stripAnsi(text: string): string {
	// biome-ignore lint: test-only ANSI scrubber
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeFooter(extensionStatuses: ReadonlyMap<string, string>): FooterComponent {
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => 1,
	};
	const session = {
		state: {},
		sessionManager: {
			getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
			getSessionName: () => undefined,
		},
		getContextUsage: () => null,
		modelRegistry: {
			isUsingOAuth: () => false,
			getProviderAuthMode: () => undefined,
		},
	};
	return new FooterComponent(
		session as unknown as ConstructorParameters<typeof FooterComponent>[0],
		footerData as unknown as ConstructorParameters<typeof FooterComponent>[1],
	);
}

describe("footer extension status rendering", () => {
	test("renders a gsd-turn secondary status without TUI changes", () => {
		const footer = makeFooter(new Map([["gsd-turn", "⏸ waiting on you · question"]]));
		const lines = footer.render(120);
		const rendered = lines.map(stripAnsi).join("\n");

		assert.match(rendered, /waiting on you · question/);
	});

	test("renders the turn-done flash", () => {
		const footer = makeFooter(new Map([["gsd-turn", "✅ turn done"]]));
		const lines = footer.render(120);
		const rendered = lines.map(stripAnsi).join("\n");

		assert.match(rendered, /turn done/);
	});

	test("no gsd-turn entry renders nothing turn-specific", () => {
		const footer = makeFooter(new Map());
		const lines = footer.render(120);
		const rendered = lines.map(stripAnsi).join("\n");

		assert.doesNotMatch(rendered, /waiting on you|turn done/);
	});

	test("coexists with a gsd-step primary status", () => {
		const footer = makeFooter(
			new Map([
				["gsd-step", "New Milestone · answer the questions above to plan"],
				["gsd-turn", "⏸ waiting on you · gate"],
			]),
		);
		const rendered = footer.render(160).map(stripAnsi).join("\n");

		assert.match(rendered, /answer the questions above to plan/);
		assert.match(rendered, /waiting on you · gate/);
	});

	test("renders the turn status at a narrow width (truncated, within budget)", () => {
		const footer = makeFooter(new Map([["gsd-turn", "⏸ waiting on you · question"]]));
		const lines = footer.render(60);
		const rendered = lines.map(stripAnsi).join("\n");

		// Layout truncates the secondary status to fit — the truncated prefix
		// still renders and no line exceeds the width.
		assert.match(rendered, /⏸ wait/);
		assert.ok(lines.every((line) => stripAnsi(line).length <= 60));

		const wide = footer.render(140).map(stripAnsi).join("\n");
		assert.match(wide, /waiting on you · question/);
	});
});
