/**
 * Unit tests for GSD Captures — database store, CAPTURES.md render, and worktree path resolution.
 *
 * - appendCapture / markCaptureResolved / markCaptureExecuted each run one Domain Operation
 * - loadAllCaptures / loadPendingCaptures read only the database
 * - CAPTURES.md is a render: a section the database does not hold is not read
 * - doctor --fix imports those sections
 * - gsd_capture_resolve and gsd_capture_complete are the agent write path
 * - resolveCapturesPath handles worktree paths
 * - parseTriageOutput handles valid, malformed, and partial JSON
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyExpectedArtifact } from "../artifact-verification.ts";
import {
  appendCapture,
  loadAllCaptures,
  loadPendingCaptures,
  loadActionableCaptures,
  loadStopCaptures,
  hasPendingCaptures,
  markCaptureResolved,
  markCaptureExecuted,
  resolveCapturesPath,
  parseTriageOutput,
} from "../captures.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { _getAdapter, closeDatabase, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { executeCaptureComplete, executeCaptureResolve } from "../tools/capture-tools.ts";
import { piExecutionInvocation } from "../execution-invocation.ts";
import { drainLogs } from "../workflow-logger.ts";

/** A temp project whose database is open. The database is closed after each test. */
function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(dir, ".gsd", "gsd.db")), true);
  return dir;
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  invalidateStateCache();
  drainLogs();
});

function operations(type: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = :type",
  ).get({ ":type": type });
  return Number(row?.["count"]);
}

// A file an older release wrote: captures lived only in CAPTURES.md.
const LEGACY_CAPTURES = [
  "# Captures",
  "",
  "### CAP-legacy01",
  "**Text:** stop the run",
  "**Captured:** 2026-03-13T09:00:00.000Z",
  "**Status:** resolved",
  "**Classification:** stop",
  "**Resolution:** halt",
  "**Rationale:** user directive",
  "**Resolved:** 2026-03-13T09:05:00.000Z",
  "**Milestone:** M001",
  "",
  "### CAP-legacy02",
  "**Text:** silenced by an executor",
  "**Captured:** 2026-03-14T10:00:00.000Z",
  "**Status:** resolved",
  "",
  "### CAP-legacy03",
  "**Text:** already done",
  "**Captured:** 2026-03-15T10:00:00.000Z",
  "**Status:** resolved",
  "**Classification:** note",
  "**Resolution:** acknowledged",
  "**Rationale:** informational",
  "**Resolved:** 2026-03-15T10:05:00.000Z",
  "**Executed:** 2026-03-15T10:06:00.000Z",
  "",
].join("\n");

async function captureIssues(
  base: string,
  options: { repair?: boolean; importFileOverrides?: boolean },
  fixesApplied: string[] = [],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, fixesApplied, options);
  return issues.filter((issue) => issue.code === "capture_file_entry_unimported");
}

// ─── Database authority ───────────────────────────────────────────────────────

test("captures: each write is one Domain Operation and the readers work with CAPTURES.md deleted", (t) => {
  const tmp = makeTempDir("cap-db");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "stop now");
  markCaptureResolved(tmp, id, "stop", "halt", "user directive", "M001");

  assert.equal(operations("capture.register"), 1);
  assert.equal(operations("capture.resolve"), 1);

  rmSync(join(tmp, ".gsd", "CAPTURES.md"));

  assert.deepEqual(loadStopCaptures(tmp).map((capture) => capture.id), [id]);
  markCaptureExecuted(tmp, id);
  assert.equal(operations("capture.execute"), 1);
  assert.deepEqual(loadStopCaptures(tmp), []);
  assert.match(readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8"), /\*\*Executed:\*\* /, "the render is written again from the database");
});

test("captures: an edit to CAPTURES.md does not change capture state", (t) => {
  const tmp = makeTempDir("cap-edit");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "add a pause button");
  const path = join(tmp, ".gsd", "CAPTURES.md");
  // What an agent or a user could write by hand: resolve the capture as a stop directive.
  writeFileSync(path, readFileSync(path, "utf-8").replace(
    "**Status:** pending",
    "**Status:** resolved\n**Classification:** stop\n**Resolution:** halt\n**Rationale:** edited\n**Resolved:** 2026-03-13T09:05:00.000Z",
  ));

  assert.deepEqual(loadStopCaptures(tmp), []);
  assert.deepEqual(loadPendingCaptures(tmp).map((capture) => capture.id), [id]);
});

test("captures: a CAPTURES.md section the database does not hold is not read, and the render keeps it", (t) => {
  const tmp = makeTempDir("cap-legacy");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, ".gsd", "CAPTURES.md");
  writeFileSync(path, LEGACY_CAPTURES);

  assert.deepEqual(loadAllCaptures(tmp), []);
  assert.deepEqual(loadStopCaptures(tmp), []);
  assert.equal(hasPendingCaptures(tmp), false);

  const id = appendCapture(tmp, "new thought");

  assert.deepEqual(loadAllCaptures(tmp).map((capture) => capture.id), [id]);
  const rendered = readFileSync(path, "utf-8");
  assert.ok(rendered.includes(`### ${id}`));
  assert.match(rendered, /### CAP-legacy01\n\*\*Text:\*\* stop the run/, "the render keeps the section for doctor");
  assert.equal(operations("capture.import"), 0);
});

test("captures: doctor reports un-imported CAPTURES.md sections and imports them only on the operator's --fix", async (t) => {
  const tmp = makeTempDir("cap-doctor");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, ".gsd", "CAPTURES.md"), LEGACY_CAPTURES);

  let issues = await captureIssues(tmp, {});
  assert.deepEqual(issues.map((issue) => [issue.severity, issue.fixable]), [
    ["warning", true], ["warning", true], ["warning", true],
  ]);
  assert.match(issues[0]!.message, /CAP-legacy01 \("stop the run", resolved\)/);

  // A repair run the operator did not ask for imports nothing.
  issues = await captureIssues(tmp, { repair: true });
  assert.equal(issues.length, 3);
  assert.equal(operations("capture.import"), 0);

  const fixes: string[] = [];
  issues = await captureIssues(tmp, { repair: true, importFileOverrides: true }, fixes);
  assert.deepEqual(issues, []);
  assert.equal(operations("capture.import"), 1);
  assert.match(fixes.join("\n"), /imported 3 capture\(s\) from CAPTURES\.md: CAP-legacy01, CAP-legacy02, CAP-legacy03/);

  const [stop, silenced, done] = loadAllCaptures(tmp);
  assert.deepEqual(
    [stop!.id, stop!.status, stop!.classification, stop!.resolvedInMilestone, stop!.timestamp, stop!.executed],
    ["CAP-legacy01", "resolved", "stop", "M001", "2026-03-13T09:00:00.000Z", undefined],
  );
  assert.deepEqual(loadStopCaptures(tmp).map((capture) => capture.id), ["CAP-legacy01"]);
  assert.equal(silenced!.status, "pending", "a section resolved with no classification was not triaged");
  assert.deepEqual([done!.executed, done!.executedAt], [true, "2026-03-15T10:06:00.000Z"]);

  assert.deepEqual(await captureIssues(tmp, {}), [], "nothing is left to import");
});

// ─── Capture tools ────────────────────────────────────────────────────────────

test("captures: gsd_capture_resolve classifies one capture and stamps the active milestone", async (t) => {
  const tmp = makeTempDir("cap-tool-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  insertMilestone({ id: "M001", title: "Captures", status: "active" });
  invalidateStateCache();
  const id = appendCapture(tmp, "fix the typo in the footer");

  const result = await executeCaptureResolve(
    { captureId: id, classification: "quick-task", resolution: "fix inline", rationale: "small" },
    tmp,
    piExecutionInvocation("gsd_capture_resolve", "call-1"),
  );

  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const [capture] = loadAllCaptures(tmp);
  assert.deepEqual(
    [capture!.status, capture!.classification, capture!.resolution, capture!.resolvedInMilestone, capture!.executed],
    ["resolved", "quick-task", "fix inline", "M001", undefined],
  );
  assert.equal(hasPendingCaptures(tmp), false);
  assert.equal(verifyExpectedArtifact("triage-captures", "M001/S01/triage", tmp), true);

  const unknown = await executeCaptureResolve(
    { captureId: "CAP-missing", classification: "note", resolution: "x", rationale: "y" },
    tmp,
    piExecutionInvocation("gsd_capture_resolve", "call-2"),
  );
  assert.equal(unknown.isError, true);
  assert.equal(operations("capture.resolve"), 1, "an unknown capture writes nothing");
});

test("captures: a quick-task that does nothing is not recorded as executed", async (t) => {
  const tmp = makeTempDir("cap-tool-complete");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const id = appendCapture(tmp, "fix the typo in the footer");
  markCaptureResolved(tmp, id, "quick-task", "fix inline", "small", "M001");
  const noteId = appendCapture(tmp, "remember this");
  markCaptureResolved(tmp, noteId, "note", "acknowledged", "informational");

  // The quick-task unit ran and its agent recorded nothing: no evidence.
  assert.equal(loadAllCaptures(tmp)[0]!.executed, undefined);
  assert.equal(verifyExpectedArtifact("quick-task", `M001/${id}`, tmp), false);
  assert.deepEqual(loadActionableCaptures(tmp, "M001").map((capture) => capture.id), [id], "the capture stays queued");

  const notQuickTask = await executeCaptureComplete(
    { captureId: noteId, outcome: "done" },
    tmp,
    piExecutionInvocation("gsd_capture_complete", "call-0"),
  );
  assert.equal(notQuickTask.isError, true);

  const result = await executeCaptureComplete(
    { captureId: id, outcome: "Fixed the footer typo in src/footer.ts" },
    tmp,
    piExecutionInvocation("gsd_capture_complete", "call-1"),
  );

  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(loadAllCaptures(tmp)[0]!.executed, true);
  assert.equal(verifyExpectedArtifact("quick-task", `M001/${id}`, tmp), true);
  assert.deepEqual(loadActionableCaptures(tmp, "M001"), []);

  const again = await executeCaptureComplete(
    { captureId: id, outcome: "Fixed the footer typo in src/footer.ts" },
    tmp,
    piExecutionInvocation("gsd_capture_complete", "call-1"),
  );
  assert.notEqual(again.isError, true);
  assert.equal(operations("capture.execute"), 1, "a retry of the call writes no second operation");
});

// ─── appendCapture ────────────────────────────────────────────────────────────

test("captures: appendCapture creates CAPTURES.md on first call", (t) => {
  const tmp = makeTempDir("cap-create");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "first thought");
  assert.ok(id.startsWith("CAP-"), "ID should start with CAP-");
  assert.ok(
    existsSync(join(tmp, ".gsd", "CAPTURES.md")),
    "CAPTURES.md should exist",
  );
  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes("# Captures"), "should have header");
  assert.ok(content.includes(`### ${id}`), "should have entry heading");
  assert.ok(
    content.includes("**Text:** first thought"),
    "should have text field",
  );
  assert.ok(
    content.includes("**Status:** pending"),
    "should have pending status",
  );
});

test("captures: appendCapture appends to existing file", (t) => {
  const tmp = makeTempDir("cap-append");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "thought one");
  const id2 = appendCapture(tmp, "thought two");
  assert.notStrictEqual(id1, id2, "IDs should be unique");

  const content = readFileSync(join(tmp, ".gsd", "CAPTURES.md"), "utf-8");
  assert.ok(content.includes(`### ${id1}`), "should have first entry");
  assert.ok(content.includes(`### ${id2}`), "should have second entry");
  assert.ok(
    content.includes("**Text:** thought one"),
    "should have first text",
  );
  assert.ok(
    content.includes("**Text:** thought two"),
    "should have second text",
  );
});

// ─── loadAllCaptures / loadPendingCaptures ────────────────────────────────────

test("captures: loadAllCaptures parses entries correctly", (t) => {
  const tmp = makeTempDir("cap-load");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "alpha");
  appendCapture(tmp, "beta");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "should have 2 entries");
  assert.strictEqual(all[0].text, "alpha");
  assert.strictEqual(all[1].text, "beta");
  assert.strictEqual(all[0].status, "pending");
  assert.strictEqual(all[1].status, "pending");
});

test("captures: loadAllCaptures returns empty array when nothing is captured", (t) => {
  const tmp = makeTempDir("cap-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 0);
});

test("captures: loadPendingCaptures filters resolved entries", (t) => {
  const tmp = makeTempDir("cap-pending");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");

  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");

  const pending = loadPendingCaptures(tmp);
  assert.strictEqual(pending.length, 1, "should have 1 pending");
  assert.strictEqual(pending[0].text, "pending two");
});

test("captures: loadAllCaptures preserves resolved entries", (t) => {
  const tmp = makeTempDir("cap-all-resolved");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "pending one");
  appendCapture(tmp, "pending two");

  markCaptureResolved(tmp, id1, "note", "acknowledged", "just a note");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 2, "all should still have 2");
  assert.strictEqual(all[0].status, "resolved");
  assert.strictEqual(all[1].status, "pending");
});

// ─── hasPendingCaptures ───────────────────────────────────────────────────────

test("captures: hasPendingCaptures returns false when no file", (t) => {
  const tmp = makeTempDir("cap-has-nofile");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  assert.strictEqual(hasPendingCaptures(tmp), false);
});

test("captures: hasPendingCaptures returns true with pending entries", (t) => {
  const tmp = makeTempDir("cap-has-true");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "something");
  assert.strictEqual(hasPendingCaptures(tmp), true);
});

test("captures: hasPendingCaptures returns false when all resolved", (t) => {
  const tmp = makeTempDir("cap-has-false");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "will resolve");
  markCaptureResolved(tmp, id, "note", "done", "resolved it");
  assert.strictEqual(hasPendingCaptures(tmp), false);
});

// ─── markCaptureResolved ──────────────────────────────────────────────────────

test("captures: markCaptureResolved updates entry in place", (t) => {
  const tmp = makeTempDir("cap-resolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "keep pending");
  const id2 = appendCapture(tmp, "will resolve");
  appendCapture(tmp, "also pending");

  markCaptureResolved(tmp, id2, "quick-task", "executed inline", "small fix");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 3, "should still have 3 entries");

  const resolved = all.find((c) => c.id === id2)!;
  assert.strictEqual(resolved.status, "resolved");
  assert.strictEqual(resolved.classification, "quick-task");
  assert.strictEqual(resolved.resolution, "executed inline");
  assert.strictEqual(resolved.rationale, "small fix");
  assert.ok(resolved.resolvedAt, "should have resolved timestamp");

  // Others should be unaffected
  const kept = all.find((c) => c.id === id1)!;
  assert.strictEqual(kept.status, "pending");
  assert.strictEqual(kept.classification, undefined);
});

// ─── resolveCapturesPath ──────────────────────────────────────────────────────

test("captures: resolveCapturesPath returns .gsd/CAPTURES.md for normal path", () => {
  const base = join(tmpdir(), "cap-test-project");
  const result = resolveCapturesPath(base);
  assert.ok(result.endsWith(join(".gsd", "CAPTURES.md")));
  assert.ok(result.startsWith(base));
});

test("captures: resolveCapturesPath resolves worktree path to project root", () => {
  const base = join(tmpdir(), "cap-test-project");
  const worktreePath = join(base, ".gsd", "worktrees", "M004");
  const result = resolveCapturesPath(worktreePath);
  assert.ok(
    result.endsWith(join(".gsd", "CAPTURES.md")),
    `should end with .gsd/CAPTURES.md, got: ${result}`,
  );
  // Should resolve to project root, not worktree root
  assert.ok(
    !result.includes("worktrees"),
    `should not contain worktrees, got: ${result}`,
  );
  assert.ok(
    result.startsWith(base),
    `should start with ${base}, got: ${result}`,
  );
});

// ─── parseTriageOutput ────────────────────────────────────────────────────────

test("triage: parseTriageOutput handles valid JSON array", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-abc123",
      classification: "quick-task",
      rationale: "Small fix",
      affectedFiles: ["src/foo.ts"],
    },
    {
      captureId: "CAP-def456",
      classification: "defer",
      rationale: "Future work",
      targetSlice: "S03",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].captureId, "CAP-abc123");
  assert.strictEqual(results[0].classification, "quick-task");
  assert.deepStrictEqual(results[0].affectedFiles, ["src/foo.ts"]);
  assert.strictEqual(results[1].classification, "defer");
  assert.strictEqual(results[1].targetSlice, "S03");
});

test("triage: parseTriageOutput handles fenced code block", () => {
  const input = `Here are my classifications:

\`\`\`json
[
  {
    "captureId": "CAP-aaa",
    "classification": "note",
    "rationale": "Just informational"
  }
]
\`\`\`

That's my analysis.`;

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-aaa");
  assert.strictEqual(results[0].classification, "note");
});

test("triage: parseTriageOutput handles JSON with leading/trailing prose", () => {
  const input = `I've analyzed the captures. Here are my results:
[{"captureId": "CAP-bbb", "classification": "inject", "rationale": "Needs a new task"}]
Let me know if you need changes.`;

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].classification, "inject");
});

test("triage: parseTriageOutput returns empty array on malformed JSON", () => {
  const results = parseTriageOutput("this is not json at all");
  assert.strictEqual(results.length, 0);
});

test("triage: parseTriageOutput returns empty array on empty input", () => {
  assert.strictEqual(parseTriageOutput("").length, 0);
  assert.strictEqual(parseTriageOutput("  ").length, 0);
});

test("triage: parseTriageOutput filters invalid entries from partial results", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-good",
      classification: "note",
      rationale: "Valid entry",
    },
    {
      captureId: "CAP-bad",
      classification: "invalid-type",
      rationale: "Bad classification",
    },
    {
      // Missing required fields
      captureId: "CAP-incomplete",
    },
    {
      captureId: "CAP-also-good",
      classification: "replan",
      rationale: "Needs restructuring",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 2, "should keep only valid entries");
  assert.strictEqual(results[0].captureId, "CAP-good");
  assert.strictEqual(results[1].captureId, "CAP-also-good");
});

test("triage: parseTriageOutput wraps single object in array", () => {
  const input = JSON.stringify({
    captureId: "CAP-single",
    classification: "quick-task",
    rationale: "Just one",
  });

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].captureId, "CAP-single");
});

test("triage: parseTriageOutput handles all five classification types", () => {
  const types = [
    "quick-task",
    "inject",
    "defer",
    "replan",
    "note",
  ] as const;

  const input = JSON.stringify(
    types.map((t, i) => ({
      captureId: `CAP-${i}`,
      classification: t,
      rationale: `Type: ${t}`,
    })),
  );

  const results = parseTriageOutput(input);
  assert.strictEqual(results.length, 5);
  for (let i = 0; i < types.length; i++) {
    assert.strictEqual(results[i].classification, types[i]);
  }
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

test("captures: appendCapture handles special characters in text", (t) => {
  const tmp = makeTempDir("cap-special");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, 'text with "quotes" and **bold** and `code`');
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.ok(all[0].text.includes('"quotes"'), "should preserve quotes");
  assert.ok(all[0].text.includes("**bold**"), "should preserve bold");
});

test("captures: markCaptureResolved fails loud for an unknown ID and writes nothing", (t) => {
  const tmp = makeTempDir("cap-noop");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  appendCapture(tmp, "real capture");
  assert.throws(
    () => markCaptureResolved(tmp, "CAP-nonexistent", "note", "test", "test"),
    /capture CAP-nonexistent is not in the GSD database/,
  );
  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].status, "pending", "original should be unchanged");
  assert.equal(operations("capture.resolve"), 0);
});

test("captures: re-resolving a capture overwrites previous resolution", (t) => {
  const tmp = makeTempDir("cap-reresolve");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "will re-resolve");
  markCaptureResolved(tmp, id, "note", "first resolution", "first rationale");
  markCaptureResolved(tmp, id, "inject", "second resolution", "second rationale");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].classification, "inject", "should have updated classification");
  assert.strictEqual(all[0].resolution, "second resolution");
  assert.strictEqual(all[0].rationale, "second rationale");
});

test("triage: parseTriageOutput preserves affectedFiles and targetSlice", () => {
  const input = JSON.stringify([
    {
      captureId: "CAP-files",
      classification: "quick-task",
      rationale: "Has files",
      affectedFiles: ["src/a.ts", "src/b.ts"],
    },
    {
      captureId: "CAP-target",
      classification: "defer",
      rationale: "Has target",
      targetSlice: "S04",
    },
  ]);

  const results = parseTriageOutput(input);
  assert.deepStrictEqual(results[0].affectedFiles, ["src/a.ts", "src/b.ts"]);
  assert.strictEqual(results[0].targetSlice, undefined);
  assert.strictEqual(results[1].targetSlice, "S04");
  assert.strictEqual(results[1].affectedFiles, undefined);
});

// ─── Stale Quick-Task Captures (#2872) ────────────────────────────────────────

test("captures: markCaptureResolved stores milestone ID when provided", (t) => {
  const tmp = makeTempDir("cap-milestone");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id = appendCapture(tmp, "fix dialog width");
  markCaptureResolved(tmp, id, "quick-task", "widen the dialog", "small fix", "M003");

  const all = loadAllCaptures(tmp);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].resolvedInMilestone, "M003", "should store milestone ID");
});

test("captures: loadActionableCaptures excludes captures resolved in prior milestones", (t) => {
  const tmp = makeTempDir("cap-stale-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Capture resolved in M003 (prior milestone)
  const id1 = appendCapture(tmp, "dialog too narrow");
  markCaptureResolved(tmp, id1, "quick-task", "widen it", "small fix", "M003");

  // Capture resolved in M004 (current milestone)
  const id2 = appendCapture(tmp, "button misaligned");
  markCaptureResolved(tmp, id2, "quick-task", "fix alignment", "css fix", "M004");

  // Capture resolved without milestone context (legacy)
  const id3 = appendCapture(tmp, "typo in label");
  markCaptureResolved(tmp, id3, "quick-task", "fix typo", "trivial");

  // When loading for M004, only M004 and no-milestone captures should be returned
  const actionable = loadActionableCaptures(tmp, "M004");
  const ids = actionable.map(c => c.id);

  assert.ok(!ids.includes(id1), "should exclude capture resolved in M003");
  assert.ok(ids.includes(id2), "should include capture resolved in M004");
  assert.ok(ids.includes(id3), "should include capture with no milestone (legacy)");
});

test("captures: loadActionableCaptures without milestone returns all actionable", (t) => {
  const tmp = makeTempDir("cap-no-milestone-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "issue one");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M003");

  const id2 = appendCapture(tmp, "issue two");
  markCaptureResolved(tmp, id2, "inject", "inject it", "needed", "M004");

  // Without milestone filter, all actionable captures are returned (backward compat)
  const actionable = loadActionableCaptures(tmp);
  assert.strictEqual(actionable.length, 2, "should return all actionable without filter");
});

test("captures: loadActionableCaptures excludes already-executed captures", (t) => {
  const tmp = makeTempDir("cap-executed-filter");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const id1 = appendCapture(tmp, "already done");
  markCaptureResolved(tmp, id1, "quick-task", "fix it", "small", "M004");
  markCaptureExecuted(tmp, id1);

  const id2 = appendCapture(tmp, "still pending");
  markCaptureResolved(tmp, id2, "quick-task", "fix it too", "small", "M004");

  const actionable = loadActionableCaptures(tmp, "M004");
  assert.strictEqual(actionable.length, 1, "should exclude executed capture");
  assert.strictEqual(actionable[0].id, id2);
});
