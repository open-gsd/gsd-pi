/**
 * Tests that the quick-task closeout is wired to agent_end, not turn_end
 * (#2791), by firing the registered hooks against a real temporary git
 * repository.
 *
 * turn_end fires after every tool round inside one agent run, so a turn_end
 * wiring merged and deleted the quick branch mid-task for providers that
 * execute tools in the agent loop. agent_end brackets the whole run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";

type Registration = { event: string; handler: (event?: unknown, ctx?: unknown) => unknown };
type After = { after(fn: () => void): void };

const registrations: Registration[] = [];
registerHooks({
	on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
		registrations.push({ event, handler });
	},
} as any, []);

const agentEndHandlers = registrations.filter((r) => r.event === "agent_end");
const turnEndHandlers = registrations.filter((r) => r.event === "turn_end");

/** Synthetic agent_end payload; ctx.cwd points extension code at the repo. */
const AGENT_END_EVENT = { type: "agent_end", messages: [], willRetry: false };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Create a repo with a quick branch holding one commit and pending return state. */
function makeQuickTaskRepo(t: After): string {
	const repo = mkdtempSync(join(tmpdir(), "gsd-quick-cleanup-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));

	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test User"]);
	writeFileSync(join(repo, "README.md"), "base\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "chore: initial"]);
	git(repo, ["checkout", "-b", "quick/Q1-test"]);
	writeFileSync(join(repo, "quick.txt"), "quick work\n");
	git(repo, ["add", "quick.txt"]);
	git(repo, ["commit", "-m", "test: quick work"]);

	mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
	writeFileSync(join(repo, ".gsd", "runtime", "quick-return.json"), JSON.stringify({
		basePath: repo,
		originalBranch: "main",
		quickBranch: "quick/Q1-test",
		taskNum: 1,
		slug: "test",
		description: "test",
	}) + "\n");
	return repo;
}

/** Chdir into the repo for the rest of the test; restore before its teardown. */
function workIn(t: After, repo: string): void {
	const oldCwd = process.cwd();
	// Registered after the repo's rm hook, so the cwd is restored before the
	// directory is removed under either hook ordering.
	t.after(() => process.chdir(oldCwd));
	process.chdir(repo);
}

/** Run every registered handler for one event, then settle async work. */
async function fire(repo: string, event: string): Promise<void> {
	for (const { handler } of event === "agent_end" ? agentEndHandlers : turnEndHandlers) {
		try {
			if (event === "agent_end") {
				await handler(AGENT_END_EVENT, { cwd: repo });
			} else {
				await handler();
			}
		} catch {
			// Handlers other than the quick-closeout hook may require a richer
			// extension context than this synthetic one — not under test here.
		}
	}
	// Flush microtasks so async handler work (dynamic imports) settles.
	await new Promise((resolve) => setImmediate(resolve));
}

/** Simulate a mid-task tool round: edit + commit on the quick branch. */
function quickRound(repo: string, file: string, content: string): void {
	writeFileSync(join(repo, file), content);
	git(repo, ["add", file]);
	git(repo, ["commit", "-m", `test: ${file}`]);
}

describe("quick task agent_end cleanup (#2791)", () => {
	it("firing agent_end closes out the quick task: returns to main, deletes the branch, clears state", async (t) => {
		const repo = makeQuickTaskRepo(t);
		workIn(t, repo);
		await fire(repo, "agent_end");

		assert.equal(git(repo, ["branch", "--show-current"]), "main");
		assert.throws(() => git(repo, ["rev-parse", "--verify", "quick/Q1-test"]));
		assert.equal(existsSync(join(repo, ".gsd", "runtime", "quick-return.json")), false);
	});

	it("firing turn_end leaves pending quick-return state untouched", async (t) => {
		const repo = makeQuickTaskRepo(t);
		workIn(t, repo);
		await fire(repo, "turn_end");

		assert.equal(git(repo, ["branch", "--show-current"]), "quick/Q1-test");
		assert.equal(existsSync(join(repo, ".gsd", "runtime", "quick-return.json")), true);
	});

	it("keeps isolation across tool rounds and squash-merges all work at agent_end, idempotently", async (t) => {
		const repo = makeQuickTaskRepo(t);
		workIn(t, repo);

		// Round 1 lands work, then the tool round ends — the branch must
		// survive (#2791 regression: it was merged and deleted here).
		quickRound(repo, "one.txt", "round one\n");
		await fire(repo, "turn_end");
		assert.equal(git(repo, ["branch", "--show-current"]), "quick/Q1-test");
		assert.ok(existsSync(join(repo, ".gsd", "runtime", "quick-return.json")));

		// Round 2 likewise.
		quickRound(repo, "two.txt", "round two\n");
		await fire(repo, "turn_end");
		assert.equal(git(repo, ["branch", "--show-current"]), "quick/Q1-test");

		// The run completes: both rounds reach the squash commit on main.
		await fire(repo, "agent_end");
		assert.equal(git(repo, ["branch", "--show-current"]), "main");
		assert.throws(() => git(repo, ["rev-parse", "--verify", "quick/Q1-test"]));
		assert.equal(git(repo, ["log", "-1", "--format=%s"]), "quick(Q1): test");
		const merged = git(repo, ["show", "--name-only", "--format=", "HEAD"]);
		assert.ok(merged.includes("one.txt"), "round one must be in the squash commit");
		assert.ok(merged.includes("two.txt"), "round two must be in the squash commit");

		// A second agent_end (no pending state) is a safe no-op.
		const headBefore = git(repo, ["rev-parse", "HEAD"]);
		await fire(repo, "agent_end");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), headBefore);
		assert.equal(git(repo, ["branch", "--show-current"]), "main");
		assert.equal(existsSync(join(repo, ".gsd", "runtime", "quick-return.json")), false);
	});
});
