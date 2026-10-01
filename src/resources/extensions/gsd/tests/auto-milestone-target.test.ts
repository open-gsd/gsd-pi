import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { handleAutoCommand, parseMilestoneTarget, parseModelFlag, parseWedgeAckArgs } from "../commands/handlers/auto.js";
import { isAutoActive } from "../auto.js";
import { normalizeRealPath } from "../paths.js";
import {
  COMPLETED_NO_ADVANCE_GUARD_ID,
  getOpenWedge,
  recordNonAdvancingOutcome,
  snapshotUnitTargetRows,
} from "../auto-liveness-backstop.js";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("parseMilestoneTarget", () => {
  it("extracts a simple milestone ID", () => {
    const result = parseMilestoneTarget("auto M016");
    assert.equal(result.milestoneId, "M016");
    assert.equal(result.rest, "auto");
  });

  it("extracts a milestone ID with unique suffix", () => {
    const result = parseMilestoneTarget("auto M001-a3b4c5 --verbose");
    assert.equal(result.milestoneId, "M001-a3b4c5");
    assert.equal(result.rest, "auto --verbose");
  });

  it("returns null when no milestone ID is present", () => {
    const result = parseMilestoneTarget("auto --verbose");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto --verbose");
  });

  it("extracts milestone ID with flags in any order", () => {
    const result = parseMilestoneTarget("auto --verbose M003 --debug");
    assert.equal(result.milestoneId, "M003");
    assert.equal(result.rest, "auto --verbose --debug");
  });

  it("returns null for plain 'auto'", () => {
    const result = parseMilestoneTarget("auto");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto");
  });

  it("extracts from 'next' command", () => {
    const result = parseMilestoneTarget("next M012");
    assert.equal(result.milestoneId, "M012");
    assert.equal(result.rest, "next");
  });

  it("handles milestone ID at the start of input", () => {
    const result = parseMilestoneTarget("M007");
    assert.equal(result.milestoneId, "M007");
    assert.equal(result.rest, "");
  });

  it("picks the first milestone ID when multiple appear", () => {
    // Edge case: user accidentally types two. First one wins.
    const result = parseMilestoneTarget("auto M001 M002");
    assert.equal(result.milestoneId, "M001");
    // M002 remains in rest since only the first match is removed
    assert.ok(result.rest.includes("M002"));
  });

  it("does not match bare numbers without M prefix", () => {
    const result = parseMilestoneTarget("auto 016");
    assert.equal(result.milestoneId, null);
  });
});

describe("auto preference diagnostics", () => {
  it("notifies preference diagnostics before launching auto-mode", () => {
    const source = readFileSync(join(__dirname, "..", "commands", "handlers", "auto.ts"), "utf-8");
    const autoBlockIndex = source.indexOf('if (trimmed === "auto" || trimmed.startsWith("auto "))');
    assert.ok(autoBlockIndex >= 0, "auto command block should exist");
    const nextBlockIndex = source.indexOf('if (trimmed === "stop")', autoBlockIndex);
    const autoBlock = source.slice(autoBlockIndex, nextBlockIndex);
    const notifyIndex = autoBlock.indexOf("notifyPreferenceDiagnostics");
    assert.ok(notifyIndex >= 0, "auto command should notify preference diagnostics");
    for (const match of autoBlock.matchAll(/startAutoDetached/g)) {
      assert.ok(
        notifyIndex < match.index!,
        "preference diagnostics should be notified before each auto-mode launch",
      );
    }
  });
});

describe("parseModelFlag", () => {
  it("extracts provider/model from --model", () => {
    const result = parseModelFlag("auto --model openrouter/openai/gpt-5.4");
    assert.equal(result.modelQuery, "openrouter/openai/gpt-5.4");
    assert.equal(result.rest, "auto");
  });

  it("extracts quoted model values", () => {
    const result = parseModelFlag('auto --model "openrouter/openai/gpt-5.4" --verbose');
    assert.equal(result.modelQuery, "openrouter/openai/gpt-5.4");
    assert.equal(result.rest, "auto --verbose");
  });

  it("returns null when --model is absent", () => {
    const result = parseModelFlag("auto --verbose M003");
    assert.equal(result.modelQuery, null);
    assert.equal(result.rest, "auto --verbose M003");
  });
});

describe("parseWedgeAckArgs", () => {
  it("extracts the wedge id from 'wedge ack <id>'", () => {
    const result = parseWedgeAckArgs("wedge ack W-abc123");
    assert.equal(result.wedgeId, "W-abc123");
    assert.equal(result.usage, false);
  });

  it("is strict about the ack verb", () => {
    assert.equal(parseWedgeAckArgs("wedge acknowledge W-abc123").usage, true);
    assert.equal(parseWedgeAckArgs("wedge").usage, true);
    assert.equal(parseWedgeAckArgs("wedge ack").usage, true);
    assert.equal(parseWedgeAckArgs("wedge ack").wedgeId, null);
  });
});

describe("handleAutoCommand wedge ack (#2159)", () => {
  const notifications: Array<{ message: string; level: string }> = [];

  function makeCtx(base: string): ExtensionCommandContext {
    return {
      ui: {
        notify: (message: string, level?: string) => {
          notifications.push({ message, level: level ?? "info" });
        },
      },
      cwd: base,
    } as unknown as ExtensionCommandContext;
  }

  it("acknowledges a tripped one-shot wedge via the real command surface without entering auto-mode", async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-wedge-ack-handler-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const previousCwd = process.cwd();
    t.after(() => {
      process.chdir(previousCwd);
      try { closeDatabase(); } catch { /* Best-effort cleanup only. */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* Best-effort cleanup only. */ }
    });
    process.chdir(base);
    notifications.length = 0;

    openDatabase(join(base, ".gsd", "gsd.db"));
    const scope = normalizeRealPath(base) || base;
    const record = () => recordNonAdvancingOutcome({
      scopeId: scope,
      guardId: "finalize-break",
      unitType: "validate-milestone",
      unitId: "M001",
      inputPayload: "finalize-break: closeout refused terminally",
    });
    record();
    const tripped = record();
    assert.equal(tripped.tripped, true);
    if (!tripped.tripped) return;

    const pi = {} as ExtensionAPI;
    const handled = await handleAutoCommand(`wedge ack ${tripped.wedge.wedgeId}`, makeCtx(base), pi);

    assert.equal(handled, true, "the wedge verb should be handled");
    const ackNotices = notifications.filter((n) => n.message.includes("acknowledged"));
    assert.equal(ackNotices.length, 1, "the handler should confirm the acknowledgment");
    assert.equal(ackNotices[0]!.level, "info");
    const open = getOpenWedge(scope);
    assert.equal(open.ok, true);
    assert.equal(open.ok ? open.wedge : null, null, "the wedge record must be acknowledged");
    assert.equal(isAutoActive(), false, "acknowledging a wedge must not start auto-mode");
  });

  it("refuses with the guard reason when the wedge still blocks", async (t) => {
    const base = mkdtempSync(join(tmpdir(), "gsd-wedge-ack-blocked-"));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    const previousCwd = process.cwd();
    t.after(() => {
      process.chdir(previousCwd);
      try { closeDatabase(); } catch { /* Best-effort cleanup only. */ }
      try { rmSync(base, { recursive: true, force: true }); } catch { /* Best-effort cleanup only. */ }
    });
    process.chdir(base);
    notifications.length = 0;

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "T", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active", depends: [] });
    const scope = normalizeRealPath(base) || base;
    const atWedge = snapshotUnitTargetRows("complete-slice", "M001/S01");
    assert.equal(atWedge.ok, true);
    if (!atWedge.ok) return;
    const record = () => recordNonAdvancingOutcome({
      scopeId: scope,
      guardId: COMPLETED_NO_ADVANCE_GUARD_ID,
      unitType: "complete-slice",
      unitId: "M001/S01",
      inputPayload: atWedge.hash!,
    });
    record();
    const tripped = record();
    assert.equal(tripped.tripped, true);
    if (!tripped.tripped) return;

    const pi = {} as ExtensionAPI;
    const handled = await handleAutoCommand(`wedge ack ${tripped.wedge.wedgeId}`, makeCtx(base), pi);

    assert.equal(handled, true);
    const refusals = notifications.filter(
      (n) => n.level === "error" && n.message.includes("Cannot acknowledge wedge"),
    );
    assert.equal(refusals.length, 1, "a still-blocking wedge must be refused");
    const open = getOpenWedge(scope);
    assert.equal(open.ok, true);
    assert.equal(open.ok ? open.wedge?.wedgeId : null, tripped.wedge.wedgeId, "the wedge stays open");
    assert.equal(isAutoActive(), false);
  });
});
