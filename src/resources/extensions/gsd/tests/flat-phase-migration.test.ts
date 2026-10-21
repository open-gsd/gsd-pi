// Project/App: gsd-pi
// File Purpose: Tests the one-time migration from nested to flat-phase layout.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  _setFlatPhaseMigrationBoundaryForTest,
  migrateToFlatPhase,
  needsFlatPhaseMigration,
  pruneStaleFlatPhaseBackups,
} from "../flat-phase-migration.ts";
import { openDatabase, closeDatabase, insertArtifact, insertMilestone, insertSlice, insertTask, getAllMilestones, getMilestoneSlices, getSliceTasks, _getAdapter } from "../gsd-db.ts";
import { writeCompatMarker } from "../compat/compat-marker.ts";
import { resolveMilestonePath } from "../paths.ts";

const tmpDirs: string[] = [];
const DIRECTORY_SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";
function makeTmp(options: { withTask?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-${randomUUID()}`));
  // Create legacy nested structure
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(
    options.withTask === false ? join(sliceDir, "tasks") : join(sliceDir, "tasks", "T01"),
    { recursive: true },
  );
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  if (options.withTask !== false) {
    insertTask({
      milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
      status: "pending", sequence: 1,
    });
  }
  tmpDirs.push(base);
  return base;
}

function makeAliasTmp(milestoneIds: string[]): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-alias-${randomUUID()}`));
  mkdirSync(
    join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"),
    { recursive: true },
  );
  openDatabase(join(base, ".gsd", "gsd.db"));
  for (const milestoneId of milestoneIds) {
    insertMilestone({ id: milestoneId, title: "Foundation", status: "active" });
    insertSlice({
      milestoneId,
      id: "S01",
      title: "Set up tooling",
      status: "pending",
      sequence: 1,
    });
    insertTask({
      milestoneId,
      sliceId: "S01",
      id: "T01",
      title: "Init repo",
      status: "pending",
      sequence: 1,
    });
  }
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  _setFlatPhaseMigrationBoundaryForTest(null);
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("milestone resolution follows the layout across migration", async () => {
  // Guards the invariant that a writer depends on: after the layout is rewritten
  // (milestones/ → phases/), resolveMilestonePath must point at the new dir. A
  // writer that resolves null here synthesizes a canonical name of its own, and
  // the projection ends up split across two phase directories for one milestone
  // — which is how S02's slice summary went missing and closeout stalled.
  const base = makeTmp();

  // Warm the cache against the legacy layout.
  const before = resolveMilestonePath(base, "M001");
  assert.ok(before?.includes("milestones"), `expected legacy dir, got ${before}`);

  await migrateToFlatPhase(base);

  const after = resolveMilestonePath(base, "M001");
  assert.ok(
    after?.includes("phases"),
    `after migration the milestone must resolve into phases/, got ${after}`,
  );
  assert.equal(existsSync(after!), true, "the resolved phase dir must exist on disk");
});

test("concurrent migrations in separate processes do not corrupt each other", async () => {
  // Headless runs the gsd extension in two processes (host + RPC child) and both
  // fire session_start. Before the cross-process lock, the second migration moved
  // milestones/ aside or cleared phases/ mid-render and the loser died on ENOENT.
  // Only a real child process exercises the lock — an in-process test cannot.
  const base = makeTmp();
  closeDatabase(); // children own the DB handle

  // Strip-types runs have no compiled .js sibling on disk, so hand the worker
  // the .ts entrypoints; compiled runs keep the .js URLs. The worker also needs
  // this run's loader hooks and type-stripping flag: spawn() ignores its
  // execArgv option (that is fork()-only), so the flags go in the args array.
  const loadableUrl = (specifier: string): string => {
    const filePath = fileURLToPath(new URL(specifier, import.meta.url));
    if (specifier.endsWith(".js") && !existsSync(filePath)) {
      const tsPath = filePath.replace(/\.js$/, ".ts");
      if (existsSync(tsPath)) return pathToFileURL(tsPath).href;
    }
    return new URL(specifier, import.meta.url).href;
  };
  const migrationUrl = loadableUrl("../flat-phase-migration.js");
  const dbUrl = loadableUrl("../gsd-db.js");
  const workerExecArgs: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (arg === "--experimental-strip-types" || arg.startsWith("--import")) {
      workerExecArgs.push(arg);
      if (arg === "--import") workerExecArgs.push(process.execArgv[++i]!);
    }
  }
  const worker = `
    const db = await import(${JSON.stringify(dbUrl)});
    const mig = await import(${JSON.stringify(migrationUrl)});
    db.openDatabase(${JSON.stringify(join(base, ".gsd", "gsd.db"))});
    try { await mig.migrateToFlatPhase(${JSON.stringify(base)}); }
    finally { if (db.isDbAvailable()) db.closeDatabase(); }
  `;

  const exits = await Promise.all(
    [0, 1].map(() => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [...workerExecArgs, "--input-type=module", "-e", worker], { stdio: "pipe" });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("exit", (code) => resolve(code === 0 ? 0 : (assert.fail(`migration worker failed: ${stderr}`), 1)));
    })),
  );

  assert.deepEqual(exits, [0, 0], "both concurrent migrations must succeed");
  assert.equal(needsFlatPhaseMigration(base), false, "migration must be complete after the race");
  assert.equal(existsSync(join(base, ".gsd", "phases")), true, "flat-phase layout must exist");
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "legacy layout must be gone");
});

test("migrateToFlatPhase supports a top-level .gsd symlink", async () => {
  const base = makeTmp();
  closeDatabase();
  const externalRoot = mkdtempSync(join(tmpdir(), `gsd-mig-linked-${randomUUID()}`));
  tmpDirs.push(externalRoot);
  const externalGsd = join(externalRoot, "state");
  renameSync(join(base, ".gsd"), externalGsd);
  symlinkSync(externalGsd, join(base, ".gsd"), DIRECTORY_SYMLINK_TYPE);
  openDatabase(join(externalGsd, "gsd.db"));

  await migrateToFlatPhase(base);

  assert.equal(existsSync(join(externalGsd, "phases")), true, "migration writes through canonical .gsd state");
  assert.equal(existsSync(join(externalGsd, "milestones")), false, "canonical legacy layout is removed");
});

test("migrateToFlatPhase rejects a symlinked migration lock parent", async () => {
  const base = makeTmp();
  const outside = mkdtempSync(join(tmpdir(), `gsd-mig-outside-${randomUUID()}`));
  tmpDirs.push(outside);
  symlinkSync(outside, join(base, ".gsd", "migration"), DIRECTORY_SYMLINK_TYPE);

  await assert.rejects(
    migrateToFlatPhase(base),
    /unsupported symbolic link or non-directory/,
  );
  assert.deepEqual(readdirSync(outside), [], "migration lock must not create state outside .gsd");
});

test("migrateToFlatPhase rejects a symlinked migration lock target", async () => {
  const base = makeTmp();
  const outsideRoot = mkdtempSync(join(tmpdir(), `gsd-mig-outside-${randomUUID()}`));
  tmpDirs.push(outsideRoot);
  const outsideTarget = join(outsideRoot, "target");
  mkdirSync(outsideTarget);
  const migrationRoot = join(base, ".gsd", "migration");
  mkdirSync(migrationRoot);
  symlinkSync(
    outsideTarget,
    join(migrationRoot, "flat-phase-migration"),
    DIRECTORY_SYMLINK_TYPE,
  );

  await assert.rejects(
    migrateToFlatPhase(base),
    /unsupported symbolic link or non-directory/,
  );
  assert.equal(existsSync(`${outsideTarget}.lock`), false, "migration lock must not follow its target");
});

test("needsFlatPhaseMigration returns true when .gsd/milestones/ exists", () => {
  const base = makeTmp();
  assert.equal(needsFlatPhaseMigration(base), true);
});

test("needsFlatPhaseMigration returns false when no .gsd/milestones/", () => {
  const base = mkdtempSync(join(tmpdir(), `gsd-nomig-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  tmpDirs.push(base);
  assert.equal(needsFlatPhaseMigration(base), false);
});

test("needsFlatPhaseMigration ignores legacy anchor runtime scaffolding", () => {
  const base = mkdtempSync(join(tmpdir(), `gsd-anchor-nomig-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "anchors"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "anchors", "research-slice.json"),
    "{}",
    "utf-8",
  );
  tmpDirs.push(base);
  assert.equal(needsFlatPhaseMigration(base), false);
});

test("migrateToFlatPhase moves content from milestones/ to phases/", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should be removed");
});

test("migrateToFlatPhase ignores unsupported .planning projection layout", async () => {
  const base = makeTmp();
  mkdirSync(join(base, ".planning", "milestones", "M001", "v1-phases"), { recursive: true });
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "legacy-milestone-dir", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "flat phase should render");
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "legacy milestones/ should be removed");
});

test("migrateToFlatPhase ignores and removes stale phase dirs from prior aborted runs", async () => {
  const base = makeTmp();
  const stalePhaseDir = join(base, ".gsd", "phases", "99-stale-aborted-run");
  mkdirSync(stalePhaseDir, { recursive: true });

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "current DB phase should render");
  assert.equal(existsSync(stalePhaseDir), false, "stale pre-existing phase dir should be removed");
});

test("migrateToFlatPhase moves the legacy tree through the managed boundary", async () => {
  const base = makeTmp();
  const milestonesPath = join(base, ".gsd", "milestones");
  const migratingPath = join(base, ".gsd", "milestones.migrating");

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "flat phase should render");
  assert.equal(existsSync(milestonesPath), false, "legacy milestones dir should be removed");
  assert.equal(existsSync(migratingPath), false, "staging dir should be removed after success");
});

test("migrateToFlatPhase creates a backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  assert.ok(existsSync(join(base, ".gsd-backups")), "backup should exist");
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.ok(backups.length >= 1, "at least one migrate-* backup dir should exist");
});

test("migrateToFlatPhase removes disposable phases snapshot after successful migration", async () => {
  const base = makeTmp();
  const reviewPath = join(base, ".gsd", "phases", "01-foundation", "PLAN-REVIEW.md");
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });
  writeFileSync(reviewPath, "# Plan Review\n\nHand-authored review.", "utf-8");

  await migrateToFlatPhase(base);

  const backupRoot = join(base, ".gsd-backups");
  const backups = readdirSync(backupRoot).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "one migrate backup should exist");
  assert.equal(
    existsSync(join(backupRoot, backups[0]!, "__phases")),
    false,
    "temporary phases/ recovery snapshot should be removed after success",
  );
});

test("failed migration restores pre-existing phases projection from backup", async () => {
  const base = makeTmp();
  const phasesPath = join(base, ".gsd", "phases");
  const reviewPath = join(phasesPath, "01-foundation", "PLAN-REVIEW.md");
  mkdirSync(join(phasesPath, "01-foundation"), { recursive: true });
  writeFileSync(reviewPath, "# Plan Review\n\nHand-authored review.", "utf-8");

  let interruptedClear = false;
  _setFlatPhaseMigrationBoundaryForTest((stage, target) => {
    if (stage === "after-remove" && target === phasesPath && !interruptedClear) {
      interruptedClear = true;
      throw new Error("simulated interruption after projection clear");
    }
  });

  await assert.rejects(migrateToFlatPhase(base), /simulated interruption/);

  assert.equal(interruptedClear, true, "test should interrupt after clearing the projection");
  assert.equal(
    readFileSync(reviewPath, "utf-8"),
    "# Plan Review\n\nHand-authored review.",
    "rollback should restore the pre-existing phases/ files",
  );
  const backupRoot = join(base, ".gsd-backups");
  const leaked = existsSync(backupRoot)
    ? readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"))
    : [];
  assert.equal(leaked.length, 0, "rollback should still clean the backup it created");
});

test("failed migration rolls back without leaking a .gsd-backups/migrate-* dir", async () => {
  const base = makeTmp();
  const milestonesPath = join(base, ".gsd", "milestones");
  const phasesPath = join(base, ".gsd", "phases");

  // Fail the pre-render clear of phases/ to drive the rollback path, which by
  // this point has already created the .gsd-backups/migrate-<ts>/ backup.
  _setFlatPhaseMigrationBoundaryForTest((stage, target) => {
    if (stage === "before-remove" && target === phasesPath) {
      throw Object.assign(new Error("simulated locked phases/"), { code: "EPERM" });
    }
  });

  await assert.rejects(migrateToFlatPhase(base), /simulated locked/);

  assert.ok(existsSync(milestonesPath), "legacy milestones/ should be restored on rollback");
  const backupRoot = join(base, ".gsd-backups");
  const leaked = existsSync(backupRoot)
    ? readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"))
    : [];
  assert.equal(leaked.length, 0, "rollback must delete the migrate-* backup it created");
});

test("failed migration restores arbitrary legacy artifact bytes", async () => {
  const base = makeTmp();
  const binaryPath = join(base, ".gsd", "milestones", "M001", "evidence.bin");
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]);
  writeFileSync(binaryPath, binary);
  const phasesPath = join(base, ".gsd", "phases");

  _setFlatPhaseMigrationBoundaryForTest((stage, target) => {
    if (stage === "before-remove" && target === phasesPath) {
      throw new Error("simulated binary rollback");
    }
  });

  await assert.rejects(migrateToFlatPhase(base), /simulated binary rollback/);
  assert.deepEqual(readFileSync(binaryPath), binary);
});

test("resumed migration removes disposable phases snapshot after success", async () => {
  const base = makeTmp();
  const milestonesPath = join(base, ".gsd", "milestones");
  const migratingPath = join(base, ".gsd", "milestones.migrating");
  const reviewPath = join(base, ".gsd", "phases", "01-foundation", "PLAN-REVIEW.md");
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });
  writeFileSync(reviewPath, "# Plan Review\n\nResume recovery copy.", "utf-8");
  renameSync(milestonesPath, migratingPath);

  await migrateToFlatPhase(base);

  assert.equal(existsSync(migratingPath), false, "resume staging dir should be removed after success");
  const backupRoot = join(base, ".gsd-backups");
  const backups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "resumed migration should create one retained migrate backup");
  assert.equal(
    existsSync(join(backupRoot, backups[0]!, "__phases")),
    false,
    "temporary phases/ recovery snapshot should be removed after resumed success",
  );
  assert.equal(
    existsSync(join(migratingPath, "__phases")),
    false,
    "resume should not store the phases snapshot inside the disposable migrating tree",
  );
});

test("migrateToFlatPhase preserves milestone/slice/task counts in DB", async () => {
  const base = makeTmp();
  const msBefore = getAllMilestones().length;
  const slicesBefore = getMilestoneSlices("M001").length;
  const tasksBefore = getSliceTasks("M001", "S01").length;
  await migrateToFlatPhase(base);
  assert.equal(getAllMilestones().length, msBefore);
  assert.equal(getMilestoneSlices("M001").length, slicesBefore);
  assert.equal(getSliceTasks("M001", "S01").length, tasksBefore);
});

test("migrateToFlatPhase prunes legacy milestones artifact rows after flat render", async () => {
  const base = makeTmp();
  insertArtifact({
    path: "milestones/M001/M001-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# M001: Foundation\n",
  });
  insertArtifact({
    path: "milestones/M001/slices/S01/S01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# Plan\n",
  });
  insertArtifact({
    path: "milestones/M001/slices/S01/tasks/T01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# Task Plan\n",
  });

  await migrateToFlatPhase(base);

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.equal(
    rows.some((row) => row.path.startsWith("milestones/")),
    false,
    "legacy milestones/ artifact rows should be pruned after successful flat migration",
  );
  assert.ok(
    rows.some((row) => row.path.startsWith("phases/")),
    "flat-phase render should leave replacement projection rows in the artifacts table",
  );
});

test("migrateToFlatPhase prunes stale flat-phase artifact rows that renderAll intentionally skips", async () => {
  const base = makeTmp();
  insertArtifact({
    path: "phases/01-foundation/T01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# Legacy standalone task plan\n",
  });
  insertArtifact({
    path: "phases/01-foundation/01-01-RESEARCH.md",
    artifact_type: "RESEARCH",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "",
  });

  await migrateToFlatPhase(base);

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.equal(
    rows.some((row) => row.path === "phases/01-foundation/T01-PLAN.md"),
    false,
    "standalone task PLAN rows should be pruned when the flat renderer does not recreate the file",
  );
  assert.equal(
    rows.some((row) => row.path === "phases/01-foundation/01-01-RESEARCH.md"),
    false,
    "empty-content artifact rows should be pruned when the flat renderer skips the file",
  );
});

test("migrateToFlatPhase is idempotent (second run is a no-op)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  // Second run should not throw and should not create a second backup
  await migrateToFlatPhase(base);
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "should only have one backup");
});

test("re-fired migration reuses the existing backup instead of leaking a new migrate-* dir (#1292)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  const backupRoot = join(base, ".gsd-backups");
  const firstBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.equal(firstBackups.length, 1, "first migration snapshots exactly one backup");

  // Simulate the re-fire: the legacy .gsd/milestones/ layout reappears (e.g. a
  // marker-key mismatch re-imports the whole tree). The DB rows still exist, so
  // the migration gate proceeds again — it must not snapshot a second backup.
  const resurrectedContext = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-CONTEXT.md");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  writeFileSync(resurrectedContext, "# Resurrected context\n", "utf-8");
  assert.equal(needsFlatPhaseMigration(base), true, "reappeared legacy layout re-triggers migration");

  await migrateToFlatPhase(base);

  const afterBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.deepEqual(afterBackups, firstBackups, "re-fire must not leak a second migrate-* backup");
  assert.equal(
    readFileSync(join(backupRoot, firstBackups[0]!, "M001", "slices", "S01", "S01-CONTEXT.md"), "utf-8"),
    "# Resurrected context\n",
    "the retained backup must archive the current legacy tree",
  );
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "legacy milestones/ removed again");
});

test("rollback after a re-fired migration preserves the reused migrate-* backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  const backupRoot = join(base, ".gsd-backups");
  const firstBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.equal(firstBackups.length, 1, "first migration snapshots exactly one backup");

  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  const milestonesPath = join(base, ".gsd", "milestones");
  const phasesPath = join(base, ".gsd", "phases");

  _setFlatPhaseMigrationBoundaryForTest((stage, target) => {
    if (stage === "before-remove" && target === phasesPath) {
      throw Object.assign(new Error("simulated locked phases/"), { code: "EPERM" });
    }
  });

  await assert.rejects(migrateToFlatPhase(base), /simulated locked/);

  const afterBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.deepEqual(afterBackups, firstBackups, "rollback must preserve the reused backup");
  assert.ok(existsSync(milestonesPath), "legacy milestones/ should be restored on rollback");
});

test("migration ignores an empty/partial leftover backup and writes a complete one (#1292)", async () => {
  const base = makeTmp();

  // Simulate a prior first-time backup that crashed mid-cpSync: an empty
  // migrate-<ts>/ leftover with no milestones/ content. It is the newest entry,
  // so mtime-based selection would reuse it as the rollback copy if content were
  // not validated — silently retaining a recovery copy missing the legacy tree.
  const backupRoot = join(base, ".gsd-backups");
  const emptyLeftover = join(backupRoot, "migrate-crashed");
  mkdirSync(emptyLeftover, { recursive: true });

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "flat phase should render");
  // The empty leftover must not have been reused; a fresh, content-bearing
  // backup that actually captured the legacy milestones/ tree must be created.
  const contentBackups = readdirSync(backupRoot)
    .filter((d) => d.startsWith("migrate-"))
    .filter((d) => existsSync(join(backupRoot, d, "M001")));
  assert.ok(
    contentBackups.length >= 1,
    "a complete backup containing the legacy milestones/ tree must be created, not the empty leftover",
  );
});

test("migrateToFlatPhase archives resurrected projections for known DB identities", async () => {
  const base = makeTmp({ withTask: false });
  const legacySliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(legacySliceDir, "S01-CONTEXT.md"), "# Final Slice Context\n\nPrior discussion.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-RESEARCH.md"), "# Slice Research\n\nPrior research.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-CONTINUE.md"), "# Continue\n\nCompacted marker.", "utf-8");
  writeFileSync(
    join(legacySliceDir, "S01-PLAN.md"),
    "# BLOCKER - auto-mode recovery failed\n\nUnit `plan-slice` failed to produce this artifact.",
    "utf-8",
  );

  await migrateToFlatPhase(base);

  assert.equal(existsSync(join(base, ".gsd", "phases", "01-foundation")), true);
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
  const backup = readdirSync(join(base, ".gsd-backups"))
    .map((entry) => join(base, ".gsd-backups", entry))
    .find((candidate) => existsSync(join(candidate, "M001", "slices", "S01", "S01-CONTEXT.md")));
  assert.ok(backup, "the stale projection must remain available in the migration backup");
  assert.equal(
    readFileSync(join(backup, "M001", "slices", "S01", "S01-CONTEXT.md"), "utf-8"),
    "# Final Slice Context\n\nPrior discussion.",
  );
});

test("migrateToFlatPhase still rejects legacy projections with unknown identities", async () => {
  const base = makeTmp();
  const unknownDir = join(base, ".gsd", "milestones", "M999");
  mkdirSync(unknownDir, { recursive: true });
  writeFileSync(join(unknownDir, "M999-CONTEXT.md"), "# Unknown Milestone\n", "utf-8");

  await assert.rejects(
    () => migrateToFlatPhase(base),
    /Recommended: run `\/gsd recover`/,
  );

  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
  assert.equal(existsSync(join(unknownDir, "M999-CONTEXT.md")), true);
});

test("migrateToFlatPhase rejects structurally unknown slice identities", async () => {
  const base = makeTmp();
  const unknownSlice = join(base, ".gsd", "milestones", "M001", "slices", "S99");
  mkdirSync(unknownSlice, { recursive: true });
  writeFileSync(join(unknownSlice, "S99-CONTEXT.md"), "# Unknown Slice\n", "utf-8");

  await assert.rejects(() => migrateToFlatPhase(base), /Recommended: run `\/gsd recover`/);

  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
  assert.equal(existsSync(join(unknownSlice, "S99-CONTEXT.md")), true);
});

test("migrateToFlatPhase rejects content-bearing unparseable milestone directories", async () => {
  const base = makeTmp();
  const unknownMilestone = join(base, ".gsd", "milestones", "unparseable-milestone");
  mkdirSync(unknownMilestone, { recursive: true });
  writeFileSync(join(unknownMilestone, "CONTEXT.md"), "# Unknown Milestone\n", "utf-8");

  await assert.rejects(() => migrateToFlatPhase(base), /Recommended: run `\/gsd recover`/);

  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
  assert.equal(existsSync(join(unknownMilestone, "CONTEXT.md")), true);
});

test("migrateToFlatPhase aligns a bare legacy milestone with one suffixed DB identity", async () => {
  const base = makeAliasTmp(["M001-abc123"]);

  await migrateToFlatPhase(base);

  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
  assert.ok(resolveMilestonePath(base, "M001-abc123"));
});

test("migrateToFlatPhase aligns a padded legacy milestone with one numeric DB identity", async () => {
  const base = makeAliasTmp(["1"]);

  await migrateToFlatPhase(base);

  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
  assert.ok(resolveMilestonePath(base, "1"));
});

test("migrateToFlatPhase aligns a legacy milestone with a zero-padded numeric DB identity", async () => {
  const base = makeAliasTmp(["001"]);

  await migrateToFlatPhase(base);

  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
  assert.ok(resolveMilestonePath(base, "001"));
});

test("migrateToFlatPhase rejects ambiguous numeric milestone aliases", async () => {
  const base = makeAliasTmp(["1", "001"]);

  await assert.rejects(() => migrateToFlatPhase(base), /Recommended: run `\/gsd recover`/);

  assert.equal(existsSync(join(base, ".gsd", "milestones", "M001")), true);
  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
});

test("migrateToFlatPhase rejects ambiguous bare milestone aliases", async () => {
  const base = makeAliasTmp(["M001-abc123", "M001-def456"]);

  await assert.rejects(() => migrateToFlatPhase(base), /Recommended: run `\/gsd recover`/);

  assert.equal(existsSync(join(base, ".gsd", "milestones", "M001")), true);
  assert.equal(existsSync(join(base, ".gsd", "phases")), false);
});

test("pruneStaleFlatPhaseBackups removes migrate-* dirs older than retention window", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  const backupRoot = join(base, ".gsd-backups");
  assert.ok(existsSync(backupRoot), "backup should exist immediately after migration");

  const staleDir = join(backupRoot, "migrate-stale");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "marker.txt"), "old backup\n", "utf-8");
  const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(staleDir, staleDate, staleDate);

  const removed = pruneStaleFlatPhaseBackups(base);
  assert.equal(removed, 1, "stale migrate-* dir should be pruned");
  assert.equal(existsSync(staleDir), false, "stale backup dir should be gone");
  assert.ok(existsSync(backupRoot), "fresh migration backup should remain");
});

test("pruneStaleFlatPhaseBackups is a no-op while flat-phase migration is still needed", () => {
  const base = makeTmp();
  const backupRoot = join(base, ".gsd-backups", "migrate-stale");
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, "marker.txt"), "old backup\n", "utf-8");
  const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(backupRoot, staleDate, staleDate);

  assert.equal(pruneStaleFlatPhaseBackups(base), 0, "must not prune while migration is pending");
  assert.ok(existsSync(backupRoot), "backup must remain until migration completes");
});
