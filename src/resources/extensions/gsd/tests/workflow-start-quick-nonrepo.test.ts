// gsd-pi — Regression tests: /gsd start and /gsd quick must not crash outside a git repository (#2678)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { handleStart } from "../commands-workflow-templates.ts";
import { handleQuick } from "../quick.ts";
import { withCommandCwd } from "../commands/context.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";

/**
 * #2678: when basePath is not a git repository, the branch-creation fallback
 * re-ran `git.getCurrentBranch()` outside its try/catch — the same call that
 * just failed — so the command died with an uncaught "not a git repository"
 * error before writing STATE.json or dispatching the prompt. The handler must
 * instead dispatch the workflow on the current branch.
 */

function createMockPi() {
	const sent: Array<{ customType: string; content: string }> = [];
	return {
		sent,
		sendMessage(message: { customType: string; content: string }) {
			sent.push(message);
		},
	};
}

function createMockCtx() {
	const notifications: Array<{ message: string; level: string }> = [];
	return {
		notifications,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			custom: async () => {},
		},
	};
}

function createNonRepoProject(prefix: string): string {
	const base = mkdtempSync(join(tmpdir(), prefix));
	// .gsd/ initialized, but deliberately no .git/ — the reported setup.
	mkdirSync(join(base, ".gsd"), { recursive: true });
	return base;
}

function findWorkflowState(base: string): { branch: string } | null {
	const bugfixes = join(base, ".gsd", "workflows", "bugfixes");
	if (!existsSync(bugfixes)) return null;
	for (const dir of readdirSync(bugfixes)) {
		const statePath = join(bugfixes, dir, "STATE.json");
		if (existsSync(statePath)) {
			return JSON.parse(readFileSync(statePath, "utf-8")) as { branch: string };
		}
	}
	return null;
}

describe("workflow start/quick outside a git repository (#2678)", () => {
	test("/gsd start dispatches on the current branch instead of crashing", async () => {
		const base = createNonRepoProject("gsd-start-nonrepo-");
		try {
			const pi = createMockPi();
			const ctx = createMockCtx();

			await assert.doesNotReject(
				() => withCommandCwd(base, () => handleStart("bugfix fix the login bug", ctx as any, pi as any)),
				"handleStart must not throw outside a git repository",
			);

			assert.equal(pi.sent.length, 1, "workflow-start prompt is dispatched");
			assert.match(pi.sent[0].customType, /workflow/);

			const state = findWorkflowState(base);
			assert.ok(state, "STATE.json is written (command did not die before dispatch)");
			assert.equal(state.branch, "(detached)", "non-repo fallback records the (detached) branch");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("/gsd quick dispatches on the current branch instead of crashing", async () => {
		const base = createNonRepoProject("gsd-quick-nonrepo-");
		const origCwd = process.cwd();
		try {
			// handleQuick uses process.cwd() directly.
			process.chdir(base);
			const pi = createMockPi();
			const ctx = createMockCtx();

			await assert.doesNotReject(
				() => handleQuick("fix the login bug", ctx as any, pi as any),
				"handleQuick must not throw outside a git repository",
			);

			assert.equal(pi.sent.length, 1, "quick-task prompt is dispatched");
			assert.equal(pi.sent[0].customType, "gsd-quick-task");
			const branchNotice = ctx.notifications.find((n) => n.message.includes("Branch:"));
			assert.ok(branchNotice, "branch is reported");
			assert.match(branchNotice.message, /Branch: \(detached\)/);
		} finally {
			process.chdir(origCwd);
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("/gsd start with explicit branch isolation in a non-repo warns once and still dispatches", async (t) => {
		const base = createNonRepoProject("gsd-start-nonrepo-iso-");
		const home = mkdtempSync(join(tmpdir(), "gsd-start-nonrepo-home-"));
		const originalGsdHome = process.env.GSD_HOME;
		process.env.GSD_HOME = home;
		clearGSDPreferencesCache();
		t.after(() => {
			if (originalGsdHome === undefined) delete process.env.GSD_HOME;
			else process.env.GSD_HOME = originalGsdHome;
			clearGSDPreferencesCache();
			rmSync(base, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		});

		// User explicitly asked for branch isolation; the directory has no .git/.
		writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: branch\n---\n");
		clearGSDPreferencesCache();

		const pi = createMockPi();
		const ctx = createMockCtx();
		await assert.doesNotReject(
			() => withCommandCwd(base, () => handleStart("bugfix fix the login bug", ctx as any, pi as any)),
		);

		assert.equal(pi.sent.length, 1, "workflow-start prompt is dispatched anyway");
		const isoWarning = ctx.notifications.find((n) => /not a git repository/.test(n.message));
		assert.ok(isoWarning, "one warning explains why no branch was created");
		assert.equal(isoWarning.level, "warning");
		const state = findWorkflowState(base);
		assert.ok(state, "STATE.json is still written");
		assert.equal(state.branch, "(detached)");
	});

	test("/gsd start in a real repo with default isolation works on the current branch", async (t) => {
		const base = mkdtempSync(join(tmpdir(), "gsd-start-repo-"));
		const home = mkdtempSync(join(tmpdir(), "gsd-start-repo-home-"));
		const originalGsdHome = process.env.GSD_HOME;
		const origCwd = process.cwd();
		try {
			execSync("git init -b main", { cwd: base, stdio: "ignore" });
			execSync(`git config user.name "GSD Test"`, { cwd: base, stdio: "ignore" });
			execSync(`git config user.email "test@gsd.dev"`, { cwd: base, stdio: "ignore" });
			mkdirSync(join(base, ".gsd"), { recursive: true });
			writeFileSync(join(base, "README.md"), "init\n");
			execSync("git add -A", { cwd: base, stdio: "ignore" });
			execSync(`git commit -m "init"`, { cwd: base, stdio: "ignore" });

			process.env.GSD_HOME = home;
			clearGSDPreferencesCache();

			const pi = createMockPi();
			const ctx = createMockCtx();
			await assert.doesNotReject(
				() => withCommandCwd(base, () => handleStart("bugfix fix the login bug", ctx as any, pi as any)),
			);

			assert.equal(pi.sent.length, 1);
			// Default isolation is "none" — no branch may be created, no isolation
			// warning fired, and STATE.json records the actual current branch.
			const branches = execSync("git branch --list gsd/*", { cwd: base, encoding: "utf-8" }).trim();
			assert.equal(branches, "", "default isolation creates no workflow branch");
			assert.equal(
				ctx.notifications.find((n) => /not a git repository/.test(n.message)),
				undefined,
			);
			const state = findWorkflowState(base);
			assert.ok(state, "STATE.json is written");
			assert.equal(state.branch, "main");
		} finally {
			process.chdir(origCwd);
			if (originalGsdHome === undefined) delete process.env.GSD_HOME;
			else process.env.GSD_HOME = originalGsdHome;
			clearGSDPreferencesCache();
			rmSync(base, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
