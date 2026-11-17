// Project/App: gsd-pi
// File Purpose: Real integration test for the native attention overview (#2932). Builds a real
// temp SQLite database through the production engine and open-pause-blocker Domain Operation,
// then mounts the overlay through the production entry and proves read-only behavior.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabaseByWorkspace, _getAdapter } from "../db/engine.ts";
import { insertMilestone, setProjectRootBinding } from "../gsd-db.ts";
import { createWorkspace } from "../workspace.ts";
import { openPauseBlockerRow } from "../pause-blocker-domain-operation.ts";
import { createAttentionController, resolveAttentionDatabase, showAttentionOverlay } from "../attention-overview.ts";
import { registerShortcuts } from "../bootstrap/register-shortcuts.ts";
import { isAttentionCommand, isBlockerCommand } from "../commands/blocker-routing.ts";
import { isValidationBlockAllowedCommand } from "../validation-block-guard.ts";
import { isUnmergedMilestoneAllowedCommand } from "../unmerged-milestone-guard.ts";

const TS = "2026-11-15T10:00:00.000Z";

function sha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Real project database: production engine schema, one open consent blocker via the Domain Operation. */
function buildProjectWithOpenBlocker(): { root: string; db: string; blockerId: string } {
	const root = mkdtempSync(join(tmpdir(), "attention-int-"));
	mkdirSync(join(root, ".gsd"), { recursive: true });
	const ws = createWorkspace(root);
	assert.equal(openDatabaseByWorkspace(ws), true, "production engine opens the fixture");
	const db = _getAdapter()!;
	db.prepare("UPDATE project_authority SET revision = 1, updated_at = :ts WHERE singleton = 1").run({ ":ts": TS });
	// Bind the fixture to its own checkout through the production binder (the reader never adopts).
	setProjectRootBinding(realpathSync(root));
	db.prepare(`INSERT INTO workflow_operations (operation_id, project_id, operation_type, idempotency_key,
		expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
		actor_type, source_transport, request_hash, created_at)
		VALUES ('op1', (SELECT project_id FROM project_authority WHERE singleton = 1),
		'lifecycle.adopt', 'ik-op1', 0, 1, 0, 0, 'agent', 'internal', 'hash', :ts)`).run({ ":ts": TS });
	insertMilestone({ id: "M001", title: "Milestone", status: "active" });
	db.prepare(`INSERT INTO workflow_item_lifecycles (lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
		lifecycle_status, state_version, created_at, updated_at, last_operation_id, last_project_revision, last_authority_epoch)
		VALUES ('lc-m001', (SELECT project_id FROM project_authority WHERE singleton = 1),
		'milestone', 'M001', NULL, NULL, 'in_progress', 1, :ts, :ts, 'op1', 1, 0)`).run({ ":ts": TS });
	const opened = openPauseBlockerRow({
		lifecycleId: "lc-m001", blockerKind: "consent",
		description: "Confirm deploy target", requestedAction: "Reply yes or no", idempotencyKey: "ik-blk-1",
	});
	closeDatabase();
	return { root, db: ws.contract.projectDb, blockerId: opened.blockerId };
}

test("mounted Inspect key reaches the existing read-only blocker route, only after explicit navigation", async () => {
	const { root, db, blockerId } = buildProjectWithOpenBlocker();
	const before = sha(db);
	const files = readdirSync(join(root, ".gsd")).sort();
	const notifications: Array<{ message: string; level: string }> = [];
	let mounts = 0;
	let closed = false;
	const ctx = { cwd: root, ui: {
		notify: (message: string, level: string) => notifications.push({ message, level }),
		custom: async (factory: Function) => {
			mounts++;
			const v = factory({}, {}, { matches: (data: string, action: string) =>
				(data === "\r" && action === "tui.select.confirm") || (data === "\u001b" && action === "tui.select.cancel") }, () => { closed = true; });
			v.handleInput("i");
			v.handleInput("\r");
			v.handleInput("\r");
			assert.equal(closed, false, "ordinary row open stays in details");
			assert.deepEqual(notifications, [], "opening sends nothing");
			v.handleInput("i");
			assert.equal(closed, true, "explicit Inspect leaves the overlay before displaying inspection");
			return true;
		},
	} };
	try {
		await showAttentionOverlay(ctx as never, root);
		assert.equal(mounts, 1, "no approval dialog or nested workflow UI");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.level, "info");
		assert.ok(notifications[0]!.message.includes(blockerId), "the actual blocker ID reaches existing route output");
		assert.equal(sha(db), before, "Inspect leaves database bytes unchanged");
		assert.deepEqual(readdirSync(join(root, ".gsd")).sort(), files, "no new state files");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const unavailable of ["database", "owner-context", "database-replaced"] as const) test(`mounted Inspect fails closed when ${unavailable} changes`, async () => {
	const { root, db } = buildProjectWithOpenBlocker();
	const notifications: string[] = [];
	let closed = false;
	const ctx = { cwd: root, ui: {
		notify: (message: string) => notifications.push(message),
		custom: async (factory: Function) => {
			const v = factory({}, {}, { matches: (data: string, action: string) => data === "\r" && action === "tui.select.confirm" }, () => { closed = true; });
			v.handleInput("\r");
			if (unavailable === "database") rmSync(db);
			else if (unavailable === "database-replaced") {
				renameSync(db, db + ".original");
				copyFileSync(db + ".original", db);
			} else ctx.cwd = tmpdir();
			v.handleInput("i");
			assert.equal(closed, false, "unavailable target preserves local details");
			return true;
		},
	} };
	try {
		await showAttentionOverlay(ctx as never, root);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!, /Inspect navigation is unavailable/);
		assert.ok(!notifications[0]!.includes('"projectId"'), "no other owner's inspection");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("routing: /gsd attention is metadata-only and never a blocker navigator", () => {
	assert.equal(isAttentionCommand("attention"), true);
	assert.equal(isAttentionCommand("attentions"), false);
	assert.equal(isBlockerCommand("attention"), false);
	assert.equal(isValidationBlockAllowedCommand("attention"), true);
	assert.equal(isUnmergedMilestoneAllowedCommand("attention"), true);
});

test("absent database fails closed: no database file is created and reads are unavailable", async () => {
	const root = mkdtempSync(join(tmpdir(), "attention-absent-"));
	try {
		assert.equal(resolveAttentionDatabase(root).ok, false);
		const controller = createAttentionController(root);
		await controller.open();
		assert.notEqual(controller.state().allClear, true);
		assert.equal(statSync(root).isDirectory(), true);
		assert.equal(readdirSync(root).includes(".gsd"), false, "no .gsd created by reading");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("real open blocker is listed read-only: database bytes unchanged, no state files added", async () => {
	const { root, db, blockerId } = buildProjectWithOpenBlocker();
	try {
		const before = sha(db);
		const filesBefore = readdirSync(join(root, ".gsd")).sort();

		const controller = createAttentionController(root);
		await controller.open();
		const state = controller.state();

		assert.equal(state.status, "ready");
		const item = state.items.find((i) => i.id === blockerId);
		assert.ok(item, `open blocker ${blockerId} is listed`);
		assert.equal(item!.namespace, "workflow");
		assert.equal(item!.classification, "consent");
		assert.equal(item!.destination.kind, "inspect-blocker", "verified workflow blocker is inspectable");
		assert.equal(state.allClear, false, "an open blocker is never all-clear");

		assert.equal(sha(db), before, "database bytes unchanged by reading");
		assert.deepEqual(readdirSync(join(root, ".gsd")).sort(), filesBefore);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("partial and unknown coverage is rendered explicitly and never all-clear", async () => {
	const { root } = buildProjectWithOpenBlocker();
	try {
		const controller = createAttentionController(root);
		await controller.open();
		const cov = controller.state().coverage;
		// The interaction namespace is read; pending RPC/dialog requests are not verifiable, so
		// the view never claims all-clear regardless of what the readers returned.
		assert.ok(cov.some((c) => c.namespace === "interaction"), "interaction namespace reported");
		assert.equal(controller.state().allClear, false, "not all-clear while any open item exists");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("mount: /gsd attention opens the overlay via the production entry with a real component", async () => {
	const { root, db, blockerId } = buildProjectWithOpenBlocker();
	try {
		const before = sha(db);
		const mounts: Array<{ overlay: boolean; component: unknown }> = [];
		const ctx = {
			ui: {
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: boolean) => void) => unknown, options: { overlay?: boolean }) => {
					const component = await factory({}, {}, { matches: () => false }, () => {});
					mounts.push({ overlay: options.overlay === true, component });
					return true;
				},
			},
		} as never;
		await showAttentionOverlay(ctx, root);
		assert.equal(mounts.length, 1, "exactly one native overlay mounted");
		assert.equal(mounts[0]!.overlay, true);
		const rendered = (mounts[0]!.component as { render(w: number): string[] }).render(100).join("\n");
		assert.ok(rendered.includes("Confirm deploy target"), "real open row rendered in the mounted component");
		assert.equal(sha(db), before, "mount is read-only");
		assert.ok(blockerId.length > 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no approve, retry, resolve, dismiss or recover control anywhere in the overview", async () => {
	const { root } = buildProjectWithOpenBlocker();
	try {
		const controller = createAttentionController(root);
		await controller.open();
		const text = JSON.stringify(controller.state()).toLowerCase();
		for (const forbidden of ["approve", "retry", "resolve", "dismiss", "recover"]) {
			assert.equal(text.includes(forbidden), false, `forbidden control: ${forbidden}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("keybinding: the registered attention shortcut mounts the same overlay on the real project", async () => {
	const { root, db } = buildProjectWithOpenBlocker();
	const originalCwd = process.cwd();
	try {
		const before = sha(db);
		const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
		const pi = { registerShortcut: (key: unknown, s: { handler: (ctx: unknown) => Promise<void> }) => { handlers.set(String(key), s.handler); } } as never;
		process.chdir(root);
		registerShortcuts(pi);
		const primary = handlers.get("ctrl+alt+a");
		const fallback = handlers.get("alt+a");
		assert.ok(primary, "ctrl+alt+a registered");
		assert.ok(fallback, "alt+a registered");
		let mounted = 0;
		let rendered = "";
		const ctx = {
			hasUI: true,
			ui: {
				custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: boolean) => void) => unknown) => {
					mounted++;
					const component = (await factory({}, {}, { matches: () => false }, () => {})) as { render(w: number): string[] };
					rendered = component.render(100).join("\n");
					return true;
				},
				notify: () => {},
			},
		};
		await primary!(ctx);
		await fallback!(ctx);
		assert.equal(mounted, 2, "both shortcuts mount the overlay");
		assert.ok(rendered.includes("Confirm deploy target"), "keybinding shows the same real open row");
		assert.equal(sha(db), before, "keybinding mount is read-only");
	} finally {
		process.chdir(originalCwd);
		rmSync(root, { recursive: true, force: true });
	}
});

test("full dispatcher: /gsd attention and malformed variants never heal Git or prepare a database", async () => {
	const { execFileSync } = await import("node:child_process");
	const { handleGSDCommand } = await import("../commands/dispatcher.ts");
	const { makeTempRepo, cleanup } = await import("./test-utils.ts");
	const repo = makeTempRepo("attention-dispatch-");
	const gitState = () => execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })
		+ execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" });
	const dbPath = join(repo, ".gsd", "gsd.db");
	const gitBefore = gitState();
	mkdirSync(join(repo, ".gsd"), { recursive: true });
	const filesBefore = readdirSync(join(repo, ".gsd")).sort();
	const notices: string[] = [];
	const ctx = {
		cwd: repo,
		hasUI: true,
		ui: { notify: (m: string) => { notices.push(m); }, setWidget: () => {}, setStatus: () => {}, custom: async () => true },
		sessionManager: { getSessionId: () => "s-attn" },
	} as never;
	try {
		for (const command of ["attention", "attention\tx", "attention extra args", "attention\ninvalid"]) {
			await handleGSDCommand(command, ctx, { sendMessage: () => {} } as never);
			assert.equal(existsSync(dbPath), false, `no database prepared by "${command}"`);
			assert.deepEqual(readdirSync(join(repo, ".gsd")).sort(), filesBefore, `no state files changed by "${command}"`);
			assert.equal(gitState(), gitBefore, `no Git healing or mutation by "${command}"`);
		}
		assert.ok(notices.some((m) => m.includes("Usage: /gsd attention")), "malformed arguments are reported, not executed");
	} finally {
		cleanup(repo);
	}
});

test("open auto-pause is shown in its own namespace with no workflow blocker row required", async () => {
	const { openAutoPause } = await import("../db/writers/auto-pauses.ts");
	const root = mkdtempSync(join(tmpdir(), "attention-pause-"));
	mkdirSync(join(root, ".gsd"), { recursive: true });
	const ws = createWorkspace(root);
	assert.equal(openDatabaseByWorkspace(ws), true);
	const db = _getAdapter()!;
	db.prepare("UPDATE project_authority SET revision = 1, updated_at = :ts WHERE singleton = 1").run({ ":ts": TS });
	setProjectRootBinding(realpathSync(root));
	openAutoPause({
		blockerKind: "user_request",
		pauseReason: "Operator asked to pause here",
		pausedAt: TS,
		stepMode: false,
	} as never);
	closeDatabase();
	try {
		const before = sha(ws.contract.projectDb);
		const controller = createAttentionController(root);
		await controller.open();
		const state = controller.state();
		const pause = state.items.find((i) => i.namespace === "auto-pause");
		assert.ok(pause, "open user_request pause is listed in auto-pause");
		assert.equal(pause!.classification, "unclassified", "an independent pause has no verified owner");
		assert.equal(pause!.owner, "unknown", "pause kind alone never assigns an owner");
		assert.equal(pause!.details.kind, "user_request", "pause keeps its own vocabulary in details");
		assert.equal(pause!.destination.kind, "details-only", "pause is never an inspect-blocker target");
		assert.equal(state.allClear, false, "an open pause is never all-clear");
		assert.equal(sha(ws.contract.projectDb), before, "reading a pause mutates nothing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
