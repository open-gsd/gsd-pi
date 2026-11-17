// D012 SQL projection and snapshot-boundary regressions. All databases are disposable.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAttentionReader } from "@gsd/agent-modes";
import { buildAttentionView } from "../../../../../packages/gsd-agent-modes/src/modes/interactive/attention-model.ts";
import { inspectSqliteReadOnlySnapshot } from "../sqlite-readonly.ts";
import { createAttentionController } from "../attention-overview.ts";
import { closeDatabase, openDatabaseByWorkspace } from "../db/engine.ts";
import { setProjectRootBinding } from "../gsd-db.ts";
import { createWorkspace } from "../workspace.ts";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// Deliberately small SQL fixtures retain the production column names and execute the
// real SELECTs through the production read-only transaction. Invalid links exercise
// defensive reads, not producer mutations. The full-schema empty case is below.
function fixture(t: test.TestContext, change = "", omitAssociation = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-d012-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "fixture.db");
	const db = new DatabaseSync(path);
	try {
		db.exec(`
			CREATE TABLE project_authority (singleton INTEGER, project_id TEXT, project_root_realpath TEXT, revision INTEGER, authority_epoch INTEGER);
			CREATE TABLE workflow_blockers (blocker_id TEXT, project_id TEXT, lifecycle_id TEXT, blocker_kind TEXT, resolution_owner TEXT,
				blocker_status TEXT, description TEXT, requested_action TEXT, opened_project_revision INTEGER);
			CREATE TABLE workflow_item_lifecycles (lifecycle_id TEXT, project_id TEXT, item_kind TEXT, milestone_id TEXT, slice_id TEXT, task_id TEXT, lifecycle_status TEXT);
			CREATE TABLE auto_pauses (id INTEGER, scope TEXT, blocker_kind TEXT, pause_reason TEXT, paused_at TEXT, closed_at TEXT,
				milestone_id TEXT, unit_type TEXT, unit_id TEXT${omitAssociation ? "" : ", blocker_id TEXT"});
			CREATE TABLE workflow_open_questions (question_id TEXT, question_text TEXT, created_at TEXT, created_project_revision INTEGER, question_status TEXT);
			INSERT INTO workflow_blockers VALUES ('B-1', 'P1', 'L1', 'external_dependency', 'external', 'open', 'same prose', '', 1);
			INSERT INTO workflow_item_lifecycles VALUES ('L1', 'P1', 'task', 'M001', 'S01', 'T01', 'paused');
			INSERT INTO auto_pauses VALUES (1, 'scope1', 'external_dependency', 'same prose', '2026-11-15', NULL,
				'M001', 'execute-task', 'M001/S01/T01'${omitAssociation ? "" : ", 'B-1'"});
		`);
		db.prepare("INSERT INTO project_authority VALUES (1, 'P1', ?, 4, 1)").run(root);
		if (change) db.exec(change);
	} finally {
		db.close();
	}
	const before = sha(path);
	const reader = createAttentionReader({ databasePath: path, projectRoot: root, seam: {
		withReadOnlySnapshot: (file, inspect) => inspectSqliteReadOnlySnapshot(file, (connection) =>
			inspect((sql) => connection.prepare(sql).all() as Record<string, unknown>[])),
	} });
	return { reader, assertUnchanged: () => assert.equal(sha(path), before) };
}

for (const owner of ["external", "user"]) {
	test(`SQL: explicit current same-project link reads actual ${owner} owner, not a kind default`, async (t) => {
		const f = fixture(t, `UPDATE workflow_blockers SET resolution_owner = '${owner}'`);
		const snap = await f.reader.readSnapshot();
		assert.equal(snap.projectKey, "P1");
		const pause = buildAttentionView(snap.sources).items.find((i) => i.namespace === "auto-pause")!;
		assert.ok(pause, "pause retained");
		assert.equal(pause.owner, owner);
		assert.equal(pause.details.kind, "external_dependency");
		assert.equal(pause.destination.kind, "details-only");
		f.assertUnchanged();
	});
}

const unknownCases: [string, string][] = [
	["unlinked", "UPDATE auto_pauses SET blocker_id = NULL"],
	["dangling despite matching prose/kind/time", "UPDATE auto_pauses SET blocker_id = 'missing'"],
	["kind mismatch", "UPDATE workflow_blockers SET blocker_kind = 'consent'"],
	["cross-project blocker", "UPDATE workflow_blockers SET project_id = 'OTHER'"],
	["cross-project lifecycle", "UPDATE workflow_item_lifecycles SET project_id = 'OTHER'"],
	["resolved blocker", "UPDATE workflow_blockers SET blocker_status = 'resolved'"],
	["dismissed blocker", "UPDATE workflow_blockers SET blocker_status = 'dismissed'"],
	["completed lifecycle", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'completed'"],
	["cancelled lifecycle", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'cancelled'"],
	["missing lifecycle", "DELETE FROM workflow_item_lifecycles"],
	["unsupported owner", "UPDATE workflow_blockers SET resolution_owner = 'agent'"],
	["unsupported unit type", "UPDATE auto_pauses SET unit_type = 'something-new'"],
	["unit identity mismatch", "UPDATE auto_pauses SET unit_id = 'M001/S01/T02'"],
	["milestone mismatch", "UPDATE auto_pauses SET milestone_id = 'M002'"],
	["ambiguous link", "INSERT INTO auto_pauses SELECT 2, 'scope2', blocker_kind, pause_reason, paused_at, closed_at, milestone_id, unit_type, unit_id, blocker_id FROM auto_pauses"],
	["ambiguous lifecycle", "INSERT INTO workflow_item_lifecycles SELECT * FROM workflow_item_lifecycles"],
	["ambiguous partly noncurrent lifecycle", "INSERT INTO workflow_item_lifecycles SELECT lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id, 'completed' FROM workflow_item_lifecycles"],
	["ambiguous partly mismatched blocker", "INSERT INTO workflow_blockers SELECT blocker_id, 'OTHER', lifecycle_id, blocker_kind, resolution_owner, blocker_status, description, requested_action, opened_project_revision FROM workflow_blockers"],
	["blocker-accepted lifecycle", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'blocker-accepted'"],
	["unsupported lifecycle state", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'future-state'"],
	["independent machine_fixable", "UPDATE auto_pauses SET blocker_kind = 'machine_fixable', blocker_id = NULL"],
	["independent user_request", "UPDATE auto_pauses SET blocker_kind = 'user_request', blocker_id = NULL"],
];
for (const [name, change] of unknownCases) {
	test(`SQL: ${name} retains pause and known kind, but ownership stays unknown`, async (t) => {
		const f = fixture(t, change);
		const snap = await f.reader.readSnapshot();
		const source = snap.sources.find((s) => s.namespace === "auto-pause")!;
		assert.equal(source.status, "available");
		const pauses = buildAttentionView(snap.sources).items.filter((i) => i.namespace === "auto-pause");
		assert.ok(pauses.length > 0);
		for (const pause of pauses) {
			assert.equal(pause.owner, "unknown");
			assert.equal(pause.details.kind, name.startsWith("independent ") ? name.slice(12) : "external_dependency");
			assert.equal(pause.destination.kind, "details-only");
		}
		f.assertUnchanged();
	});
}

test("SQL: a pause-only kind cannot acquire ownership through an unsupported blocker link", async (t) => {
	const f = fixture(t, "UPDATE workflow_blockers SET blocker_kind = 'machine_fixable'; UPDATE auto_pauses SET blocker_kind = 'machine_fixable'");
	const snap = await f.reader.readSnapshot();
	const pause = buildAttentionView(snap.sources).items.find((i) => i.namespace === "auto-pause")!;
	assert.equal(pause.owner, "unknown");
	assert.equal(pause.details.kind, "machine_fixable");
	assert.equal(pause.destination.kind, "details-only");
	f.assertUnchanged();
});

for (const [name, change] of [
	["milestone", "UPDATE workflow_item_lifecycles SET item_kind = 'milestone', slice_id = NULL, task_id = NULL; UPDATE auto_pauses SET unit_type = 'plan-milestone', unit_id = 'M001'"],
	["slice", "UPDATE workflow_item_lifecycles SET item_kind = 'slice', task_id = NULL; UPDATE auto_pauses SET unit_type = 'plan-slice', unit_id = 'M001/S01'"],
	["prefixed task", "UPDATE workflow_item_lifecycles SET task_id = 'S01-T01'; UPDATE auto_pauses SET unit_id = 'M001/S01/S01-T01'"],
	["ready", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'ready'"],
	["in progress", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'in_progress'"],
	["pending", "UPDATE workflow_item_lifecycles SET lifecycle_status = 'pending'"],
]) {
	test(`SQL: verified ${name} association retains its actual owner`, async (t) => {
		const f = fixture(t, change);
		const snap = await f.reader.readSnapshot();
		const pause = buildAttentionView(snap.sources).items.find((i) => i.namespace === "auto-pause")!;
		assert.equal(pause.owner, "external");
		assert.equal(pause.destination.kind, "details-only");
		f.assertUnchanged();
	});
}

test("SQL: absent optional link column keeps independent pause unknown, without migration", async (t) => {
	const f = fixture(t, "", true);
	const snap = await f.reader.readSnapshot();
	const pause = buildAttentionView(snap.sources).items.find((i) => i.namespace === "auto-pause")!;
	assert.equal(pause.owner, "unknown");
	assert.equal(pause.details.kind, "external_dependency");
	f.assertUnchanged();
});

test("SQL: absent optional lifecycle support retains the pause with unknown ownership", async (t) => {
	const f = fixture(t, "DROP TABLE workflow_item_lifecycles");
	const snap = await f.reader.readSnapshot();
	assert.equal(snap.projectKey, "P1");
	const pause = buildAttentionView(snap.sources).items.find((i) => i.namespace === "auto-pause")!;
	assert.equal(pause.owner, "unknown");
	f.assertUnchanged();
});

test("SQL: a missing question table isolates failure within the same verified snapshot", async (t) => {
	const f = fixture(t, "DROP TABLE workflow_open_questions");
	const snap = await f.reader.readSnapshot();
	assert.equal(snap.projectKey, "P1");
	for (const s of snap.sources) assert.equal(s.status, s.namespace === "interaction" ? "unavailable" : "available");
	assert.deepEqual(buildAttentionView(snap.sources).items.map((i) => i.namespace).sort(), ["auto-pause", "workflow"]);
	assert.equal(buildAttentionView(snap.sources).allClear, false);
	f.assertUnchanged();
});

test("bound empty production schema cannot claim complete live native-prompt coverage", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-d012-full-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".gsd"));
	const workspace = createWorkspace(root);
	try {
		assert.equal(openDatabaseByWorkspace(workspace), true);
		setProjectRootBinding(root);
	} finally {
		closeDatabase();
	}
	const before = sha(workspace.contract.projectDb);
	const controller = createAttentionController(root);
	await controller.open();
	const s = controller.state();
	assert.equal(s.status, "ready");
	assert.equal(s.items.length, 0);
	assert.equal(s.allClear, false);
	const interaction = s.coverage.find((c) => c.namespace === "interaction")!;
	assert.equal(interaction.status, "available");
	assert.equal(interaction.completeness, "partial");
	assert.match(interaction.reason!, /native.*prompt/i);
	assert.equal(sha(workspace.contract.projectDb), before);
});
