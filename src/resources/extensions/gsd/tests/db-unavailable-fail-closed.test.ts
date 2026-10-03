// Project/App: gsd-pi
// File Purpose: Behavior gates for ADR-046 "fail closed when the DB is unavailable".

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerDbTools } from "../bootstrap/db-tools.ts";
import { handleStatus } from "../commands/handlers/core.ts";
import { withCommandCwd } from "../commands/context.ts";
import { closeDatabase, insertAuditEvent, setTaskBlockerDiscovered } from "../gsd-db.ts";
import { inlineDecisionsFromDb, inlineProjectFromDb, inlineRequirementsFromDb } from "../auto-prompts.ts";
import { buildTurnTimeline } from "../uok/timeline.ts";
import { clearReservedMilestoneIds } from "../milestone-ids.ts";
import { UokGateRunner } from "../uok/gate-runner.ts";
import { _resetLogs, drainLogs, setStderrLoggingEnabled } from "../workflow-logger.ts";

type RegisteredPiTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { cwd: string },
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

function generateIdTool(): RegisteredPiTool {
  const tools: RegisteredPiTool[] = [];
  registerDbTools({ registerTool: (tool: RegisteredPiTool) => tools.push(tool) } as never);
  const tool = tools.find((t) => t.name === "gsd_milestone_generate_id");
  assert.ok(tool, "gsd_milestone_generate_id is registered");
  return tool;
}

/** A project whose gsd.db exists but cannot be opened (not a SQLite file). */
function makeProjectWithUnopenableDb(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-db-unavailable-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n", "utf-8");
  writeFileSync(join(base, ".gsd", "gsd.db"), "this is not a sqlite database\n".repeat(64), "utf-8");
  return base;
}

describe("DB unavailable: fail closed", () => {
  let base: string;

  beforeEach(() => {
    closeDatabase();
    clearReservedMilestoneIds();
    base = makeProjectWithUnopenableDb();
  });

  afterEach(() => {
    closeDatabase();
    clearReservedMilestoneIds();
    rmSync(base, { recursive: true, force: true });
  });

  test("gsd_milestone_generate_id returns an error and creates no milestone", async () => {
    const result = await generateIdTool().execute("call-1", {}, undefined, undefined, { cwd: base });

    assert.match(result.content[0]!.text, /^Error generating milestone ID: workflow DB is unavailable/);
    assert.equal(result.details.error, "workflow DB is unavailable");
    assert.deepEqual(readdirSync(join(base, ".gsd", "milestones")), ["M001"], "no milestone dir is created");
  });

  test("/gsd status reports the open failure, not 'no milestones'", async () => {
    const notes: Array<{ message: string; level: string }> = [];
    const ctx = { ui: { notify: (message: string, level: string) => notes.push({ message, level }) } };

    await withCommandCwd(base, () => handleStatus(ctx as never));

    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.level, "error");
    assert.match(notes[0]!.message, /^Cannot read GSD status: ensureDbOpen failed/);
    assert.doesNotMatch(notes[0]!.message, /No GSD milestones found/);
  });

  test("store writers throw instead of silently doing nothing", () => {
    assert.throws(() => setTaskBlockerDiscovered("M001", "S01", "T01", true), /No database open/);
    assert.throws(
      () => insertAuditEvent({
        eventId: "evt-1",
        traceId: "trace-1",
        category: "orchestration",
        type: "test",
        ts: new Date().toISOString(),
        payload: {},
      }),
      /No database open/,
    );
  });

  test("gate runner returns the gate result and logs an error instead of silently skipping its record", async (t) => {
    const previousStderr = setStderrLoggingEnabled(false);
    t.after(() => {
      setStderrLoggingEnabled(previousStderr);
      _resetLogs();
    });
    _resetLogs();
    const runner = new UokGateRunner();
    runner.register({ id: "g1", type: "policy", execute: async () => ({ outcome: "pass" }) });

    const result = await runner.run("g1", { basePath: base, traceId: "trace-g1", turnId: "turn-g1" });

    assert.equal(result.outcome, "pass");
    assert.ok(
      drainLogs().some((entry) =>
        entry.severity === "error" && entry.message === "gate g1 result not recorded: workflow DB is unavailable"),
      "the unrecorded gate result is logged as an error",
    );
  });

  test("prompt builders give an explicit unavailable block, never the markdown file", async () => {
    writeFileSync(join(base, ".gsd", "DECISIONS.md"), "# Decisions\n\nFILE DECISION D001\n", "utf-8");
    writeFileSync(join(base, ".gsd", "REQUIREMENTS.md"), "# Requirements\n\nFILE REQUIREMENT R001\n", "utf-8");
    writeFileSync(join(base, ".gsd", "PROJECT.md"), "# Project\n\nFILE PROJECT BODY\n", "utf-8");

    const blocks = [
      await inlineDecisionsFromDb(base, "M001"),
      await inlineRequirementsFromDb(base, "M001"),
      await inlineProjectFromDb(base),
    ];

    for (const block of blocks) {
      assert.match(String(block), /unavailable: workflow DB is unavailable/);
      assert.doesNotMatch(String(block), /FILE (DECISION|REQUIREMENT|PROJECT)/);
    }
  });

  test("turn timeline refuses to read the JSONL projection", () => {
    mkdirSync(join(base, ".gsd", "audit"), { recursive: true });
    writeFileSync(join(base, ".gsd", "audit", "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "x" }) + "\n");

    assert.throws(() => buildTurnTimeline(base), /Cannot build turn timeline: workflow DB is unavailable/);
    assert.ok(existsSync(join(base, ".gsd", "gsd.db")), "the unopenable DB file is left in place");
  });
});
