// Project/App: gsd-pi
// File Purpose: Regression tests for the interactive terminal footer renderer.

import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
	FooterComponent,
	formatCwdForFooter,
} from "../../packages/gsd-agent-modes/src/modes/interactive/components/footer.ts";
import { initTheme } from "../../packages/pi-coding-agent/src/theme/theme.ts";

initTheme("dark", false);

test("formatCwdForFooter abbreviates home paths only", () => {
	assert.equal(formatCwdForFooter("/home/user2", "/home/user"), "/home/user2");
	assert.equal(formatCwdForFooter("/home/user", "/home/user"), "~");
	assert.equal(formatCwdForFooter("/home/user/project", "/home/user"), "~/project");
});

test("FooterComponent renders workspace in center when GSD strip is hidden", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
				getSessionName: () => "feature-session",
			},
			getContextUsage: () => ({ percent: 12.5, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map([["one", "ready"], ["two", "synced"]]),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	assert.equal(lines.length, 1);
	assert.match(lines[0], /main/);
	assert.match(lines[0], /test-model/);
	assert.match(lines[0], /13%/);
	assert.match(lines[0], /feature-session/);
	assert.match(lines[0], /\/tmp\/gsd-pi/);
	assert.match(lines[0], /ready synced/);
	assert.match(lines[0], /● GSD/);
	assert.doesNotMatch(lines[0], /╭/);
});

test("FooterComponent shows (auto) hint when autoCompactEnabled is true", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 20, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);
	footer.setAutoCompactEnabled(true);
	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));
	assert.match(lines[0], /\(auto\)/);
});

test("FooterComponent hides (auto) hint when autoCompactEnabled is false", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 20, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);
	footer.setAutoCompactEnabled(false);
	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));
	assert.doesNotMatch(lines[0], /\(auto\)/);
});

test("FooterComponent shows in-context tokens, not cumulative session usage", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1_000_000 },
			},
			sessionManager: {
				getUsageTotals: () => ({
					input: 4_000,
					output: 1_700,
					cacheRead: 50_000,
					cacheWrite: 0,
					cost: 0,
				}),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 97, contextWindow: 1_000_000, tokens: 970_000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	assert.match(lines[0], /97%/);
	assert.match(lines[0], /970k\/1\.0M/);
	assert.doesNotMatch(lines[0], /5\.7k\/1\.0M/);
});

test("FooterComponent promotes gsd-step to center when GSD strip is visible", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				getUsageTotals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 40, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () =>
				new Map([
					["gsd-fast", "fast: priority"],
					["gsd-step", "Executing Task · follow progress above"],
					["ollama", "Ollama"],
				]),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "auto",
			activeToolCount: 1,
			gsdPhase: "Executing T03",
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: true,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	assert.match(lines[0], /Executing Task/);
	assert.match(lines[0], /Ollama/);
	assert.match(lines[0], /fast: priority/);
	assert.doesNotMatch(lines[0], /● GSD/);
});

test("FooterComponent renders the session cost including subagent usage", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				// Parent + reconciled child-session usage (#2821).
				getUsageTotals: () => ({ input: 500, output: 300, cacheRead: 100, cacheWrite: 0, cost: 21.14 }),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	assert.match(lines[0], /\$21\.14/);
	assert.doesNotMatch(lines[0], /\$21\.14\*/);
});

test("FooterComponent keeps the subscription * marker on the combined session cost", () => {
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1000 },
			},
			sessionManager: {
				getUsageTotals: () => ({ input: 500, output: 300, cacheRead: 100, cacheWrite: 0, cost: 21.14 }),
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => true,
				getProviderAuthMode: () => "oauth",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	assert.match(lines[0], /\$21\.14\*/);
});

test("FooterComponent combines subagent cost without distorting the parent cache percentage", () => {
	const parentTotals = { input: 500, output: 300, cacheRead: 4500, cacheWrite: 0, cost: 16.93 };
	const combinedTotals = { input: 500 + 9000, output: 300, cacheRead: 4500 + 100, cacheWrite: 0, cost: 21.14 };
	const footer = new FooterComponent(
		{
			state: {
				model: { id: "test-model", provider: "test", contextWindow: 1_000_000 },
			},
			sessionManager: {
				getUsageTotals: (options?: { includeExternalUsage?: boolean }) =>
					options?.includeExternalUsage ? combinedTotals : parentTotals,
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 10, contextWindow: 1_000_000, tokens: 100_000 }),
			getLastTurnCost: () => 0,
			modelRegistry: {
				isUsingOAuth: () => false,
				getProviderAuthMode: () => "apiKey",
			},
		} as any,
		{
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		} as any,
		() => ({
			override: "chat",
			activeToolCount: 0,
			cwd: "/tmp/gsd-pi",
			manuallyExpanded: false,
		}),
	);

	const lines = footer.render(160).map((line) => stripVTControlCharacters(line));

	// Cost is parent + children.
	assert.match(lines[0], /\$21\.14/);
	// Cache percentage stays a parent-conversation property (4500/5000 = 90%),
	// not the child-diluted 4500/13600.
	assert.match(lines[0], /90%↺/);
});
