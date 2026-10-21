// Project/App: gsd-pi
// File Purpose: Round-trip property test — for any gsd-core .gsd/ fixture,
// import → render → import must produce a stable hierarchy snapshot, and
// re-rendering must produce stable markdown. Catches lossy-projection bugs
// that would otherwise silently destroy state across cross-tool round-trips.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "round-trip");

const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-rt-${randomUUID()}`));
  cpSync(join(FIXTURE_ROOT, name), base, { recursive: true });
  tmpDirs.push(base);
  return base;
}

interface HierarchySnapshot {
  milestones: Array<{ id: string; title: string; status: string }>;
  slices: Array<{ mid: string; id: string; title: string; status: string }>;
  tasks: Array<{ mid: string; sid: string; id: string; title: string; status: string }>;
}

function snapshotHierarchy(): HierarchySnapshot {
  const milestones = getAllMilestones().map((m) => ({ id: m.id, title: m.title, status: m.status }));
  const slices: HierarchySnapshot["slices"] = [];
  const tasks: HierarchySnapshot["tasks"] = [];
  for (const m of milestones) {
    for (const s of getMilestoneSlices(m.id)) {
      slices.push({ mid: m.id, id: s.id, title: s.title, status: s.status });
      for (const t of getSliceTasks(m.id, s.id)) {
        tasks.push({ mid: m.id, sid: s.id, id: t.id, title: t.title, status: t.status });
      }
    }
  }
  // Sort for stable comparison across DB row-order variations.
  const cmp = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  milestones.sort(cmp);
  slices.sort((a, b) => `${a.mid}/${a.id}`.localeCompare(`${b.mid}/${b.id}`));
  tasks.sort((a, b) => `${a.mid}/${a.sid}/${a.id}`.localeCompare(`${b.mid}/${b.sid}/${b.id}`));
  return { milestones, slices, tasks };
}

test("round-trip is stable: import → render → import produces the same hierarchy snapshot", async () => {
  // Only .gsd/-bearing fixtures — the .planning/ fixtures belong to the
  // planning round-trip suite (different layout, no .gsd/ to import from).
  const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURE_ROOT, d.name, ".gsd")))
    .map((d) => d.name);

  assert.ok(fixtures.length > 0, "expected at least one round-trip fixture");

  for (const name of fixtures) {
    const base = copyFixture(name);
    openDatabase(join(base, ".gsd", "gsd.db"));

    // Pass 1: import fixture markdown → DB
    migrateHierarchyToDb(base);
    invalidateStateCache();
    const snapshot1 = snapshotHierarchy();
    assert.ok(snapshot1.milestones.length > 0, `fixture ${name}: expected at least one milestone after import`);

    // Render DB → markdown (projection)
    const render1 = await renderAllFromDb(base);
    assert.deepEqual(render1.errors, [], `pass 1 render errors for ${name}: ${JSON.stringify(render1.errors)}`);

    // Pass 2: re-import the projected markdown → DB. migrateHierarchyToDb is
    // an idempotent upsert (INSERT OR IGNORE), so this simulates a second tool
    // opening the re-projected files and importing them.
    migrateHierarchyToDb(base);
    invalidateStateCache();
    const snapshot2 = snapshotHierarchy();

    // Property: hierarchy must be stable across the round-trip.
    assert.deepEqual(
      snapshot2,
      snapshot1,
      `round-trip drift for fixture ${name}: hierarchy changed across import → render → import`,
    );
  }
});

test("round-trip is idempotent: rendering twice produces stable markdown", async () => {
  const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURE_ROOT, d.name, ".gsd")))
    .map((d) => d.name);

  for (const name of fixtures) {
    const base = copyFixture(name);
    openDatabase(join(base, ".gsd", "gsd.db"));
    migrateHierarchyToDb(base);
    invalidateStateCache();
    await renderAllFromDb(base);

    // Snapshot all rendered markdown files (normalized: CRLF→LF, trailing
    // whitespace trimmed) so cosmetic differences don't false-positive.
    const snapshotFiles = (b: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".md")) {
            out[p.replace(b + "/", "")] = readFileSync(p, "utf-8").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
          }
        }
      };
      walk(join(b, ".gsd"));
      return out;
    };
    const after1 = snapshotFiles(base);

    // Render again
    await renderAllFromDb(base);
    const after2 = snapshotFiles(base);

    assert.deepEqual(after2, after1, `re-rendering changed markdown for fixture ${name}`);
  }
});
