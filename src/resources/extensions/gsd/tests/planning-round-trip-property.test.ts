// Project/App: gsd-pi
// File Purpose: Round-trip property test for .planning/ parity.
// import → render → import must produce a stable milestone/slice hierarchy.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  openDatabase,
  closeDatabase,
  getAllMilestones,
  getMilestoneSlices,
  getSliceTasks,
  clearEngineHierarchy,
} from "../gsd-db.ts";
import { parsePlanningDirectory } from "../migrate/parser.ts";
import { transformToGSD } from "../migrate/transformer.ts";
import { writeGSDDirectory } from "../migrate/writer.ts";
import { writePlanningDirectory } from "../migrate/planning-writer.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { invalidateStateCache } from "../state.ts";
import { writeCompatMarker } from "../compat/compat-marker.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "round-trip");
const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-prt-${randomUUID()}`));
  cpSync(join(FIXTURE_ROOT, name), base, { recursive: true });
  // The fixture only ships .planning/. The DB needs a .gsd/ dir to live in.
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}

interface Snapshot {
  ms: Array<{ id: string; title: string }>;
  slices: Array<{ mid: string; id: string; title: string }>;
  tasks: Array<{ mid: string; sid: string; id: string; title: string }>;
}

function snapshotHierarchy(): Snapshot {
  const ms = getAllMilestones().map((m) => ({ id: m.id, title: m.title }));
  const slices: Snapshot["slices"] = [];
  const tasks: Snapshot["tasks"] = [];
  for (const m of ms) {
    for (const s of getMilestoneSlices(m.id)) {
      slices.push({ mid: m.id, id: s.id, title: s.title });
      for (const t of getSliceTasks(m.id, s.id)) {
        tasks.push({ mid: m.id, sid: s.id, id: t.id, title: t.title });
      }
    }
  }
  return { ms, slices, tasks };
}

/**
 * Materialize a .planning/ tree into the gsd-pi DB:
 *   parse .planning/ → transform to GSD model → write .gsd/ → import to DB
 */
async function importPlanningToDb(base: string): Promise<void> {
  const parsed = await parsePlanningDirectory(join(base, ".planning"));
  const gsd = transformToGSD(parsed);
  await writeGSDDirectory(gsd, base);
  migrateHierarchyToDb(base);
  invalidateStateCache();
}

test(".planning/ round-trip: import → render → import produces stable milestone/slice ids", async () => {
  const base = copyFixture("planning-flat-phases");
  openDatabase(join(base, ".gsd", "gsd.db"));

  // Pass 1: import fixture .planning/ → DB
  await importPlanningToDb(base);
  const snap1 = snapshotHierarchy();
  assert.ok(snap1.ms.length > 0, "expected at least one milestone after first import");
  assert.ok(snap1.slices.length > 0, "expected at least one slice after first import");

  // Project DB → .planning/ (the new writer). Activate the marker first so the
  // projection hook in renderAllFromDb fires; but we call writePlanningDirectory
  // directly here to isolate the property under test.
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });
  await writePlanningDirectory(base, "flat-phases");
  assert.ok(existsSync(join(base, ".planning", "ROADMAP.md")), "projection should write ROADMAP.md");

  // Pass 2: clear DB, re-import the projected .planning/ → DB
  clearEngineHierarchy();
  await importPlanningToDb(base);
  const snap2 = snapshotHierarchy();

  // Property: hierarchy ids stable across the round-trip.
  assert.deepEqual(
    snap2.ms.map((m) => m.id),
    snap1.ms.map((m) => m.id),
    "milestone ids drifted across round-trip",
  );
  assert.deepEqual(
    snap2.slices.map((s) => `${s.mid}/${s.id}`),
    snap1.slices.map((s) => `${s.mid}/${s.id}`),
    "slice ids drifted across round-trip",
  );
});

test(".planning/ round-trip: re-projecting is idempotent (stable .planning/ content)", async () => {
  const base = copyFixture("planning-flat-phases");
  openDatabase(join(base, ".gsd", "gsd.db"));
  await importPlanningToDb(base);
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const snapshotPlanningFiles = (b: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) {
          out[p.replace(b + "/", "")] = readFileSyncNormalized(p);
        }
      }
    };
    walk(join(b, ".planning"));
    return out;
  };
  const readFileSyncNormalized = (p: string): string => {
    return readFileSync(p, "utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      // STATE.md carries a write-time timestamp that legitimately differs
      // between projections — strip it so idempotency is checked on content.
      .replace(/last_updated: ".*"/g, 'last_updated: "<ts>"');
  };

  await writePlanningDirectory(base, "flat-phases");
  const after1 = snapshotPlanningFiles(base);

  await writePlanningDirectory(base, "flat-phases");
  const after2 = snapshotPlanningFiles(base);

  assert.deepEqual(after2, after1, "re-projecting .planning/ changed content");
});
