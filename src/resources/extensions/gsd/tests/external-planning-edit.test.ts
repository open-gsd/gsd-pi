// Project/App: gsd-pi
// File Purpose: Tests for the external-planning-edit drift handler.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { externalPlanningEditHandler } from "../state-reconciliation/drift/external-planning-edit.ts";
import { reconcileBeforeDispatch } from "../state-reconciliation.ts";
import { writeCompatMarker, readCompatMarker } from "../compat/compat-marker.ts";
import type { DriftContext } from "../state-reconciliation/types.ts";
import type { GSDState } from "../types.ts";

const tmpDirs: string[] = [];
function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-pedit-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  mkdirSync(join(base, ".planning"), { recursive: true });
  tmpDirs.push(base);
  return base;
}
const stubState = { phase: "idle" } as unknown as GSDState;
function ctx(base: string): DriftContext {
  return { basePath: base, state: stubState };
}
afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("detect returns no drift when planning inactive and dir is empty", async () => {
  const base = makeTmpBase();
  // .planning/ exists (created by makeTmpBase) but has no ROADMAP.md → no
  // layout signal → detectPlanningLayout returns null → stays inactive.
  const drift = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);

  const { readCompatMarker } = await import("../compat/compat-marker.ts");
  const marker = readCompatMarker(base);
  assert.equal(marker.planning?.active, false, "should not activate without a recognisable layout");
});

test("detect reports inactive modeled planning without activating compatibility", async () => {
  const base = makeTmpBase();
  writeFileSync(
    join(base, ".planning", "ROADMAP.md"),
    "# Roadmap\n\n## Phases\n\n- [ ] 01 — Foundation\n",
    "utf-8",
  );
  // No compat marker written → planning.active = false by default.

  const drift = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.projectionPath, "ROADMAP.md");
  assert.equal(drift[0]?.passthrough, false);
  const blocker = await externalPlanningEditHandler.blocker?.(drift[0]!, ctx(base));
  assert.match(blocker ?? "", /database is authoritative/i);
  assert.match(blocker ?? "", /Preview\/Application/);

  // Marker must NOT have been written by detect().
  const { readCompatMarker } = await import("../compat/compat-marker.ts");
  const marker = readCompatMarker(base);
  assert.equal(marker.planning?.active, false, "detect() must not activate the marker");
});

test("detect returns drift when planning projection sha mismatches", async () => {
  const base = makeTmpBase();
  const rel = "ROADMAP.md";
  writeFileSync(join(base, ".planning", rel), "# edited by gsd-core\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: { [rel]: { sha: "stale000000000000", entities: ["M001"] } },
      passthrough: {},
    },
    piVersion: "1.4.0",
  });

  const drift = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.kind, "external-planning-edit");
  assert.equal(drift[0]!.projectionPath, rel);
  assert.equal(drift[0]!.passthrough, false);
});

test("detect flags passthrough files separately with passthrough=true", async () => {
  const base = makeTmpBase();
  const rel = "codebase/STACK.md";
  mkdirSync(join(base, ".planning", "codebase"), { recursive: true });
  writeFileSync(join(base, ".planning", rel), "# new stack content\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: { [rel]: { sha: "old0000000000000", entities: [] } },
    },
    piVersion: "1.4.0",
  });

  const drift = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.passthrough, true);
});

test("detect returns no drift when sha matches", async () => {
  const base = makeTmpBase();
  const rel = "ROADMAP.md";
  const content = "# unchanged\n";
  writeFileSync(join(base, ".planning", rel), content, "utf-8");
  const { computeProjectionSha } = await import("../compat/compat-marker.ts");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: { [rel]: { sha: computeProjectionSha(content), entities: ["M001"] } },
      passthrough: {},
    },
    piVersion: "1.4.0",
  });

  const drift = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift.length, 0);
});

test("repair refreshes passthrough marker sha (idempotent on second detect)", async () => {
  const base = makeTmpBase();
  const rel = "codebase/STACK.md";
  mkdirSync(join(base, ".planning", "codebase"), { recursive: true });
  writeFileSync(join(base, ".planning", rel), "# new stack content\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: {},
      passthrough: { [rel]: { sha: "old0000000000000", entities: [] } },
    },
    piVersion: "1.4.0",
  });

  const drift1 = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift1.length, 1);
  const contentBefore = readFileSync(join(base, ".planning", rel));
  await externalPlanningEditHandler.repair(drift1[0]!, ctx(base));

  const drift2 = await externalPlanningEditHandler.detect(stubState, ctx(base));
  assert.equal(drift2.length, 0);
  assert.deepEqual(readFileSync(join(base, ".planning", rel)), contentBefore);
});

test("reconcileBeforeDispatch dryRun=true does not write compat marker (planning)", async () => {
  // /gsd sync --dry-run must leave planning compatibility state untouched.
  const base = makeTmpBase();
  writeFileSync(
    join(base, ".planning", "ROADMAP.md"),
    "# Roadmap\n\n## Phases\n\n- [ ] 01 — Foundation\n",
    "utf-8",
  );
  // Capture the marker state before the dry-run reconcile.
  const markerBefore = readCompatMarker(base);

  const result = await reconcileBeforeDispatch(base, {
    dryRun: true,
    registry: [externalPlanningEditHandler],
    invalidateStateCache: () => {},
    deriveState: async () => stubState as unknown as import("../types.ts").GSDState,
  });
  assert.match(result.blockers.join("\n"), /Preview\/Application/);
  assert.equal(result.repaired.length, 0);

  // Marker must be identical to before: no planning activation, no SHA seeding.
  const markerAfter = readCompatMarker(base);
  assert.equal(
    markerAfter.planning?.active,
    markerBefore.planning?.active,
    "dryRun reconcile must not activate planning",
  );
  assert.deepEqual(
    markerAfter.planning?.projections,
    markerBefore.planning?.projections,
    "dryRun reconcile must not write planning projections",
  );
});
