/**
 * Unit tests for stop/backtrack capture classifications and milestone regression (#3487).
 *
 * Tests:
 * - "stop" and "backtrack" are valid classification types
 * - loadStopCaptures returns unexecuted stop+backtrack captures
 * - an executor edit of CAPTURES.md does not silence a capture
 * - the stop guard reads only the database and writes no BACKTRACK-TRIGGER.md
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isClosedStatus } from "../status-guards.ts";
import {
  appendCapture,
  loadAllCaptures,
  loadStopCaptures,
  markCaptureResolved,
  hasPendingCaptures,
} from "../captures.ts";
import { runGuards } from "../auto/phases.ts";
import type { IterationContext } from "../auto/types.ts";
import { _getAdapter, closeDatabase, isDbAvailable, openDatabase } from "../gsd-db.ts";

/** A temp project with an open in-memory database. The database is closed after each test. */
function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  assert.equal(openDatabase(":memory:"), true);
  return dir;
}

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
});

// ─── Classification Types ─────────────────────────────────────────────────────

test("stop is a valid classification", () => {
  const tmp = makeTempDir("stop-class");
  const id = appendCapture(tmp, "stop running immediately");
  markCaptureResolved(tmp, id, "stop", "Halt auto-mode", "User said stop", "M005");
  const all = loadAllCaptures(tmp);
  const cap = all.find(c => c.id === id);
  assert.equal(cap?.classification, "stop");
  rmSync(tmp, { recursive: true, force: true });
});

test("backtrack is a valid classification", () => {
  const tmp = makeTempDir("bt-class");
  const id = appendCapture(tmp, "restart from M003");
  markCaptureResolved(tmp, id, "backtrack", "Backtrack to M003", "User wants to restart", "M005");
  const all = loadAllCaptures(tmp);
  const cap = all.find(c => c.id === id);
  assert.equal(cap?.classification, "backtrack");
  rmSync(tmp, { recursive: true, force: true });
});

// ─── loadStopCaptures ─────────────────────────────────────────────────────────

test("loadStopCaptures returns unexecuted stop and backtrack captures", () => {
  const tmp = makeTempDir("load-stop");
  const stopId = appendCapture(tmp, "halt execution");
  const btId = appendCapture(tmp, "go back to M003");
  const noteId = appendCapture(tmp, "just a note");
  markCaptureResolved(tmp, stopId, "stop", "Halt", "User stop", "M005");
  markCaptureResolved(tmp, btId, "backtrack", "Backtrack to M003", "User backtrack", "M005");
  markCaptureResolved(tmp, noteId, "note", "Info only", "Not actionable", "M005");

  const stops = loadStopCaptures(tmp);
  assert.equal(stops.length, 2);
  assert.ok(stops.some(c => c.classification === "stop"));
  assert.ok(stops.some(c => c.classification === "backtrack"));
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Executor edits of CAPTURES.md ────────────────────────────────────────────

test("an executor that writes Status: resolved to CAPTURES.md does not silence the capture", () => {
  const tmp = makeTempDir("silence-exec");
  appendCapture(tmp, "stop everything");

  const capPath = join(tmp, ".gsd", "CAPTURES.md");
  writeFileSync(
    capPath,
    readFileSync(capPath, "utf-8").replace("**Status:** pending", "**Status:** resolved"),
    "utf-8",
  );

  assert.equal(hasPendingCaptures(tmp), true, "the capture is still pending for triage");
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Stop guard (runGuards) ───────────────────────────────────────────────────

function guardContext(basePath: string): { ic: IterationContext; pauses: number[] } {
  const pauses: number[] = [];
  const ic = {
    ctx: { ui: { notify: () => {} } },
    pi: {},
    s: { basePath, originalBasePath: basePath },
    deps: {
      pauseAuto: async () => { pauses.push(1); },
      sendDesktopNotification: () => {},
      getManifestStatus: async () => null,
    },
    prefs: undefined,
  } as unknown as IterationContext;
  return { ic, pauses };
}

test("stop guard: a stop capture pauses auto with CAPTURES.md deleted", async () => {
  const tmp = makeTempDir("guard-stop");
  const id = appendCapture(tmp, "halt execution");
  markCaptureResolved(tmp, id, "stop", "Halt", "User stop", "M005");
  rmSync(join(tmp, ".gsd", "CAPTURES.md"));
  const { ic, pauses } = guardContext(tmp);

  const result = await runGuards(ic, "M005");

  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "user-stop"]);
  assert.equal(pauses.length, 1);
  assert.equal(loadAllCaptures(tmp)[0]!.executed, true);
  assert.equal((await runGuards(ic, "M005")).action, "next", "the executed directive does not pause again");
  rmSync(tmp, { recursive: true, force: true });
});

test("stop guard: an edited CAPTURES.md does not pause", async () => {
  const tmp = makeTempDir("guard-edit");
  appendCapture(tmp, "add a pause button");
  const capPath = join(tmp, ".gsd", "CAPTURES.md");
  const stopFields = "**Status:** resolved\n**Classification:** stop\n**Resolution:** halt\n**Rationale:** edited\n**Resolved:** 2026-03-13T09:05:00.000Z";
  writeFileSync(capPath, [
    readFileSync(capPath, "utf-8").replace("**Status:** pending", stopFields),
    "### CAP-byhand01",
    "**Text:** stop",
    "**Captured:** 2026-03-13T09:00:00.000Z",
    stopFields,
    "",
  ].join("\n"), "utf-8");
  const { ic, pauses } = guardContext(tmp);

  const result = await runGuards(ic, "M005");

  assert.equal(result.action, "next");
  assert.equal(pauses.length, 0);
  rmSync(tmp, { recursive: true, force: true });
});

test("stop guard: a backtrack capture pauses and is recorded as executed, with no trigger file", async () => {
  const tmp = makeTempDir("guard-backtrack");
  const id = appendCapture(tmp, "M005 missed auth, go back");
  markCaptureResolved(tmp, id, "backtrack", "Backtrack to M003", "User backtrack", "M005");
  const { ic, pauses } = guardContext(tmp);

  const result = await runGuards(ic, "M005");

  assert.deepEqual([result.action, result.action === "break" && result.reason], ["break", "user-backtrack"]);
  assert.equal(pauses.length, 1);
  const executed = _getAdapter()!.prepare(
    "SELECT payload_json FROM workflow_domain_events WHERE event_type = 'capture.executed' AND entity_id = :id",
  ).get({ ":id": id });
  assert.deepEqual(JSON.parse(String(executed?.["payload_json"])), { captureId: id });
  assert.equal(existsSync(join(tmp, ".gsd", "BACKTRACK-TRIGGER.md")), false);
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Slice Skip Status (#3477) ──────────────────────────────────────────────

test("isClosedStatus treats 'skipped' as closed", () => {
  assert.equal(isClosedStatus("skipped"), true);
  assert.equal(isClosedStatus("complete"), true);
  assert.equal(isClosedStatus("done"), true);
  assert.equal(isClosedStatus("pending"), false);
  assert.equal(isClosedStatus("active"), false);
});
