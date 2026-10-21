import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  _getAdapter,
  closeDatabase,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
  isDbAvailable,
  openDatabase,
  _setStartupSchemaDetectionForTest,
} from "../gsd-db.ts";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { filterDoctorIssues } from "../doctor-format.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import { runGSDDoctor } from "../doctor.ts";
import { MEMORIES_FTS_REBUILT_KEY } from "../db-memory-fts-schema.ts";
import { getProjectGSDPreferencesPath } from "../preferences.ts";
import { appendEvent } from "../workflow-events.ts";
import { renderPlanFromDb, renderRoadmapFromDb } from "../markdown-renderer.ts";
import { openWorkflowDatabase } from "../db-workspace.ts";

afterEach(() => {
  _setStartupSchemaDetectionForTest(null);
  closeDatabase();
});

test("filterDoctorIssues keeps project and environment issues in scoped reports", () => {
  const issues = [
    { severity: "error", code: "env_dependencies", scope: "project", unitId: "environment", message: "node_modules missing", fixable: false },
    { severity: "warning", code: "db_unavailable", scope: "project", unitId: "project", message: "DB unavailable", fixable: false },
    { severity: "warning", code: "state_file_missing", scope: "slice", unitId: "M016/S01", message: "slice warning", fixable: false },
  ] as const;

  const filtered = filterDoctorIssues([...issues], { scope: "M016", includeWarnings: true });
  assert.deepEqual(
    filtered.map((issue) => issue.unitId),
    ["environment", "project", "M016/S01"],
  );
});

test("doctor preference diagnostics report diagnostic.scope (#1764)", async (t) => {
  const originalGsdHome = process.env.GSD_HOME;
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-pref-scope-"));
  const home = mkdtempSync(join(tmpdir(), "gsd-doctor-pref-home-"));
  t.after(() => {
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(base, ".gsd"), { recursive: true });
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "PREFERENCES.md"), "---\nversion: 3\n---\n", "utf-8");
  const projectPreferencesPath = getProjectGSDPreferencesPath(base);
  mkdirSync(dirname(projectPreferencesPath), { recursive: true });
  writeFileSync(projectPreferencesPath, "---\nversion: 3\n---\n", "utf-8");

  const report = await runGSDDoctor(base, { fix: false });
  const issuesByFile = new Map(
    report.issues
      .filter((item) => item.code === "invalid_preferences")
      .map((item) => [item.file, item]),
  );
  assert.equal(issuesByFile.get(join(home, "PREFERENCES.md"))?.scope, "global");
  assert.equal(issuesByFile.get(projectPreferencesPath)?.scope, "project");
});

test("filterDoctorIssues keeps invalid_preferences issues regardless of preferences file scope", () => {
  // Both global and project preference diagnostics should survive scope filtering.
  // doctor.ts uses unitId: "project" for all invalid_preferences issues so they
  // pass through the scope filter the same way other project-level issues do.
  const issues = [
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "project", message: "global PREFERENCES.md parse error", fixable: false },
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "project", message: "project PREFERENCES.md parse error", fixable: false },
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "global", message: "stale unitId — should be filtered out", fixable: false },
  ] as const;

  const filtered = filterDoctorIssues([...issues], { scope: "M016", includeWarnings: true });
  assert.deepEqual(
    filtered.map((issue) => issue.message),
    ["global PREFERENCES.md parse error", "project PREFERENCES.md parse error"],
    "invalid_preferences issues with unitId: project survive scope filtering; unitId: global is dropped",
  );
});

test("checkEngineHealth reports db_unavailable when gsd.db exists but the DB is closed", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-unavailable-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "gsd.db"), "");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const dbIssue = issues.find((issue) => issue.code === "db_unavailable");
  assert.ok(dbIssue, "doctor should surface degraded DB mode when a DB file exists");
  assert.equal(dbIssue.unitId, "project");
  assert.equal(dbIssue.file, ".gsd/gsd.db");
});

test("checkEngineHealth reports a busy workflow DB as fixable db_locked", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-locked-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
  closeDatabase();
  _setStartupSchemaDetectionForTest(() => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 });
  });
  assert.equal(openWorkflowDatabase(base).ok, false);
  _setStartupSchemaDetectionForTest(null);

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const locked = issues.find((issue) => issue.code === "db_locked");
  assert.ok(locked);
  assert.equal(locked.severity, "error");
  assert.equal(locked.fixable, process.platform !== "win32");
  assert.equal(issues.some((issue) => issue.code === "db_unavailable"), false);
});

test("checkEngineHealth repair signals proven holders and reopens the database", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-lock-repair-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  assert.equal(openDatabase(join(gsdDir, "gsd.db")), true);
  closeDatabase();
  _setStartupSchemaDetectionForTest(() => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errcode: 5 });
  });
  assert.equal(openWorkflowDatabase(base).ok, false);
  _setStartupSchemaDetectionForTest(null);

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, {
    repairDbLock: true,
    lockRecovery: {
      inspectHolders: () => [],
      terminateHolders: async () => ({ signaled: [777], terminated: [777], remaining: [] }),
      reopen: (path) => openWorkflowDatabase(path),
    },
  });

  assert.equal(isDbAvailable(), true);
  assert.equal(issues.some((issue) => issue.code === "db_locked"), false);
  assert.deepEqual(fixes, ["released workflow database lock held by dormant PID(s): 777"]);
});

test("checkEngineHealth reports memories_fts without the rebuild marker", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-memory-fts-marker-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  const adapter = _getAdapter()!;
  const fts = adapter.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
  if (!fts) return;

  adapter.prepare(
    "DELETE FROM runtime_kv WHERE scope = 'global' AND scope_id = '' AND key = :key",
  ).run({ ":key": MEMORIES_FTS_REBUILT_KEY });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const ftsIssue = issues.find((issue) => issue.code === "memories_fts_rebuild_missing");
  assert.ok(ftsIssue, "doctor should surface a potentially desynced memory FTS index");
  assert.equal(ftsIssue.severity, "warning");
  assert.equal(ftsIssue.unitId, "project");
  assert.equal(ftsIssue.file, ".gsd/gsd.db");
  assert.equal(ftsIssue.fixable, false);
});

test("checkEngineHealth does not advertise orphaned Tasks as automatically fixable", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-orphaned-task-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  const adapter = _getAdapter()!;
  adapter.exec("PRAGMA foreign_keys = OFF");
  adapter.prepare(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status, sequence)
    VALUES ('M001', 'S99', 'T01', 'Orphaned Task', 'pending', 1)
  `).run();
  adapter.exec("PRAGMA foreign_keys = ON");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const orphan = issues.find((issue) => issue.code === "db_orphaned_task");
  assert.ok(orphan);
  assert.equal(orphan.fixable, false);
});

test("checkEngineHealth reports checkbox divergence against DB status", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-checkbox-drift-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete", sequence: 1 });

  const roadmap = await renderRoadmapFromDb(base, "M001");
  if ("skipped" in roadmap) assert.fail("planned milestone should render a roadmap");
  const plan = await renderPlanFromDb(base, "M001", "S01");

  writeFileSync(roadmap.roadmapPath, readFileSync(roadmap.roadmapPath, "utf-8").replace("- [ ] **S01:", "- [x] **S01:"), "utf-8");
  writeFileSync(plan.planPath, readFileSync(plan.planPath, "utf-8").replace("- [x] **T01**:", "- [ ] **T01**:"), "utf-8");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const divergences = issues.filter((issue) => issue.code === "checkbox_db_status_divergence");
  assert.deepEqual(
    divergences.map((issue) => issue.unitId).sort(),
    ["M001/S01", "M001/S01/T01"],
  );
});

test("checkEngineHealth keeps PLAN checkbox divergence after stale projection flush", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-checkbox-plan-drift-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete", sequence: 1 });

  const roadmap = await renderRoadmapFromDb(base, "M001");
  if ("skipped" in roadmap) assert.fail("planned milestone should render a roadmap");
  const plan = await renderPlanFromDb(base, "M001", "S01");

  writeFileSync(roadmap.roadmapPath, readFileSync(roadmap.roadmapPath, "utf-8").replace("- [ ] **S01:", "- [x] **S01:"), "utf-8");
  writeFileSync(plan.planPath, readFileSync(plan.planPath, "utf-8").replace("- [x] **T01**:", "- [ ] **T01**:"), "utf-8");
  appendEvent(base, {
    cmd: "complete-task",
    params: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    ts: "2999-01-01T00:00:00.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes);

  const divergences = issues.filter((issue) => issue.code === "checkbox_db_status_divergence");
  assert.deepEqual(
    divergences.map((issue) => issue.unitId),
    ["M001/S01/T01"],
    "stale ROADMAP divergence is cleared after re-render, but stale PLAN task divergence remains",
  );
  assert.ok(fixes.includes("re-rendered stale projections for M001"));
  assert.match(readFileSync(plan.planPath, "utf-8"), /- \[ \] \*\*T01\*\*:/);
});

test("checkEngineHealth retains ROADMAP divergence when projection repair remains stale", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-roadmap-repair-stale-"));
  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    id: "S01",
    milestoneId: "M001",
    title: "Slice",
    status: "pending",
    risk: "low",
    depends: [],
    sequence: 1,
  });
  const roadmap = await renderRoadmapFromDb(base, "M001");
  if ("skipped" in roadmap) assert.fail("planned milestone should render a roadmap");
  writeFileSync(
    roadmap.roadmapPath,
    readFileSync(roadmap.roadmapPath, "utf-8").replace("- [ ] **S01:", "- [x] **S01:"),
    "utf-8",
  );
  appendEvent(base, {
    cmd: "complete-slice",
    params: { milestoneId: "M001", sliceId: "S01" },
    ts: "2999-01-01T00:00:00.000Z",
    actor: "agent",
  });

  const roadmapDir = dirname(roadmap.roadmapPath);
  chmodSync(roadmapDir, 0o555);
  t.after(() => {
    chmodSync(roadmapDir, 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes);

  assert.deepEqual(
    issues.filter((issue) => issue.code === "checkbox_db_status_divergence").map((issue) => issue.unitId),
    ["M001/S01"],
  );
  assert.equal(fixes.includes("re-rendered stale projections for M001"), false);
});

test("checkEngineHealth ignores stale suffixed flat-phase duplicate when bare milestone exists", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-checkbox-flat-duplicate-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M003", title: "M003-vaz73w: New milestone M003-vaz73w", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  for (const taskId of ["T01", "T02", "T03"]) {
    insertTask({ id: taskId, milestoneId: "M003", sliceId: "S01", title: taskId, status: "complete", sequence: Number(taskId.slice(1)) });
  }

  insertMilestone({ id: "M003-vaz73w", title: "New milestone M003-vaz73w", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003-vaz73w", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  for (const taskId of ["T01", "T02", "T03"]) {
    insertTask({ id: taskId, milestoneId: "M003-vaz73w", sliceId: "S01", title: taskId, status: "complete", sequence: Number(taskId.slice(1)) });
  }

  const canonicalPlan = await renderPlanFromDb(base, "M003", "S01");
  const staleDir = join(gsdDir, "phases", "03-vaz73w-new-milestone-m003-vaz73w");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(
    join(staleDir, "03-01-PLAN.md"),
    canonicalPlan.content.replace("- [x] **T03**:", "- [ ] **T03**:"),
    "utf-8",
  );

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.deepEqual(
    issues.filter((issue) => issue.code === "checkbox_db_status_divergence").map((issue) => issue.unitId),
    [],
    "stale suffixed duplicate phase projection must not compete with the bare milestone projection",
  );
});

test("checkEngineHealth reads task checkboxes from the canonical milestone worktree", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-checkbox-worktree-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M003", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M003", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T03", milestoneId: "M003", sliceId: "S01", title: "Task", status: "complete", sequence: 1 });

  const plan = await renderPlanFromDb(base, "M003", "S01");
  const checkedPlan = readFileSync(plan.planPath, "utf-8");
  writeFileSync(plan.planPath, checkedPlan.replace("- [x] **T03**:", "- [ ] **T03**:"), "utf-8");

  const worktree = join(base, ".gsd-worktrees", "M003");
  const worktreePlan = join(worktree, ".gsd", "phases", "03-milestone", "03-01-PLAN.md");
  mkdirSync(join(worktree, ".gsd", "phases", "03-milestone"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M003")}\n`);
  writeFileSync(worktreePlan, checkedPlan, "utf-8");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.deepEqual(
    issues.filter((issue) => issue.code === "checkbox_db_status_divergence").map((issue) => issue.unitId),
    [],
    "the stale project-root PLAN must not compete with the live milestone worktree projection",
  );
});

test("checkEngineHealth reads task checkboxes from the <tasks> block, not a stray line above it", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-task-section-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete", sequence: 1 });

  const roadmap = await renderRoadmapFromDb(base, "M001");
  if ("skipped" in roadmap) assert.fail("planned milestone should render a roadmap");
  const plan = await renderPlanFromDb(base, "M001", "S01");

  // Flip the authoritative <tasks> checkbox so it disagrees with the DB
  // (DB: complete, markdown: unchecked = real drift), then inject a *checked*
  // decoy line for the same task above the <tasks> block. The old whole-file
  // regex matched the decoy first and hid the real drift; parsePlan reads the
  // authoritative <tasks> block and still reports it. No events are appended,
  // so the projection-drift re-render never runs and the crafted file stands.
  const rendered = readFileSync(plan.planPath, "utf-8")
    .replace("- [x] **T01**:", "- [ ] **T01**:")
    .replace("<tasks>\n", "- [x] **T01**: stale duplicate above the tasks block\n\n<tasks>\n");
  writeFileSync(plan.planPath, rendered, "utf-8");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const divergences = issues.filter((issue) => issue.code === "checkbox_db_status_divergence");
  assert.deepEqual(
    divergences.map((issue) => issue.unitId),
    ["M001/S01/T01"],
    "task drift must be read from the authoritative <tasks> block, not a stray checkbox above it",
  );
});

test("checkEngineHealth reads canonical reopen events from worktree bases", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-reopen-worktree-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const worktree = join(gsdDir, "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Reopened", status: "active" });
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("worker-1", "localhost", 1, "2026-01-01T00:00:00.000Z", "test", "2026-01-01T00:00:00.000Z", "stopped", base);
  db.prepare(
    `INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "trace-1",
    "worker-1",
    1,
    "M001",
    "complete-milestone",
    "M001",
    "completed",
    1,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z",
  );
  appendEvent(base, {
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2026-01-01T00:00:02.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  await checkEngineHealth(worktree, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "completed_milestone_reopened"),
    false,
    "canonical reopen event should exempt the reopened milestone from doctor drift errors",
  );
});

test("checkEngineHealth treats explicit reopen as authoritative when dispatch timestamps are missing", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-reopen-no-dispatch-time-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Reopened", status: "active" });
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("worker-1", "localhost", 1, "2026-01-01T00:00:00.000Z", "test", "2026-01-01T00:00:00.000Z", "stopped", base);
  db.prepare(
    `INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("trace-1", "worker-1", 1, "M001", "complete-milestone", "M001", "completed", 1, "", "");
  appendEvent(base, {
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2026-01-01T00:00:02.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "completed_milestone_reopened"),
    false,
    "explicit reopen should exempt reopened milestone even when completion dispatch timestamps are absent",
  );
});

test("checkEngineHealth reports artifact rows whose files are missing on disk", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-missing-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const worktree = join(gsdDir, "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");
  writeFileSync(join(worktree, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: "milestones/M001/M001-CONTEXT.md",
    artifact_type: "CONTEXT",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# Context\n",
  });
  insertArtifact({
    path: "milestones/M001/M001-MISSING.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# Missing\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(worktree, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === "milestones/M001/M001-CONTEXT.md"),
    false,
    "worktree-local artifacts should resolve through the projection root",
  );
  const missing = issues.find((issue) => issue.code === "artifact_file_missing" && issue.file === "milestones/M001/M001-MISSING.md");
  assert.ok(missing, "missing artifact rows should be reported");
  assert.equal(missing.unitId, "M001");
  assert.equal(missing.fixable, false);
});

test("checkEngineHealth resolves artifact rows through the canonical milestone worktree", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-artifact-worktree-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const artifactPath = "phases/03-milestone/03-01-PLAN.md";
  const worktree = join(base, ".gsd-worktrees", "M003");
  mkdirSync(gsdDir, { recursive: true });
  mkdirSync(join(worktree, ".gsd", "phases", "03-milestone"), { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M003")}\n`);
  writeFileSync(join(worktree, ".gsd", artifactPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: artifactPath,
    artifact_type: "PLAN",
    milestone_id: "M003",
    slice_id: "S01",
    task_id: null,
    full_content: "# Plan\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === artifactPath),
    false,
    "worktree-local artifact rows must not be reported missing from the project root",
  );
});

test("checkEngineHealth resolves escaped .gsd artifact rows against the project .gsd directory", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-escaped-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const artifactPath = "phases/01-m001/01-01-ASSESSMENT.md";
  mkdirSync(join(gsdDir, "phases", "01-m001"), { recursive: true });
  writeFileSync(join(gsdDir, artifactPath), "# Assessment\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: `../../../Documents/Projects/project/.gsd/${artifactPath}`,
    artifact_type: "ASSESSMENT",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# Assessment\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing"),
    false,
    "escaped .gsd paths should resolve to the project .gsd artifact",
  );
});

test("checkEngineHealth reports escaped missing artifact rows with .gsd-relative paths", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-escaped-missing-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: "../../../Documents/Projects/project/.gsd/phases/01-m001/01-01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# Plan\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const issue = issues.find((candidate) => candidate.code === "artifact_file_missing");
  assert.ok(issue, "missing escaped artifact row should still be reported");
  assert.equal(issue.file, "phases/01-m001/01-01-PLAN.md");
  assert.doesNotMatch(issue.message, /\.\.\//);
});

test("checkEngineHealth repair prunes stale phases artifact rows with present milestones files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-stale-phase-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const stalePath = "phases/01-m001/01-01-PLAN.md";
  const replacementPath = "milestones/M001/slices/S01/S01-PLAN.md";
  mkdirSync(join(gsdDir, "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# stale plan\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath),
    false,
    "repair should not report stale rows it pruned",
  );
  assert.ok(fixes.includes(`pruned stale flat-phase artifact row ${stalePath}`));

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), []);
});

test("checkEngineHealth repair prunes stale phases artifact rows with renamed flat-phase files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-renamed-flat-phase-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const stalePath = "phases/01-new-milestone-m001/01-01-PLAN.md";
  const replacementPath = "phases/01-lokably-brand-foundation-and-welcome-pag/01-01-PLAN.md";
  mkdirSync(join(gsdDir, "phases", "01-lokably-brand-foundation-and-welcome-pag"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# stale plan\n",
  });

  const beforeIssues: any[] = [];
  await checkEngineHealth(base, beforeIssues, []);

  const beforeIssue = beforeIssues.find((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath);
  assert.ok(beforeIssue, "stale renamed phases row should be reported when repair is off");
  assert.equal(beforeIssue.fixable, true, "renamed phases rows with a flat replacement should be fixable");

  const repairIssues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, repairIssues, fixes, { repair: true });

  assert.equal(
    repairIssues.some((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath),
    false,
    "repair should not report stale rows it pruned",
  );
  assert.ok(fixes.includes(`pruned stale flat-phase artifact row ${stalePath}`));

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), []);
});

test("checkEngineHealth repair keeps phases rows whose own file is still present", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-keep-present-phase-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const livePath = "phases/01-m001/01-01-PLAN.md";
  const replacementPath = "milestones/M001/slices/S01/S01-PLAN.md";
  // Both the active phases/ file AND a legacy milestones/ copy exist on disk.
  // The row is "fixable" (a milestones replacement is present), but its own
  // file is present too — repair must not drop the live row.
  mkdirSync(join(gsdDir, "phases", "01-m001"), { recursive: true });
  writeFileSync(join(gsdDir, livePath), "# Plan\n", "utf-8");
  mkdirSync(join(gsdDir, "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: livePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# plan\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    fixes.some((fix) => fix.includes(livePath)),
    false,
    "repair must not prune a row whose own file is present on disk",
  );
  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === livePath),
    false,
    "a present artifact must not be reported missing",
  );

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), [livePath]);
});

test("checkEngineHealth repair prunes stale phases task rows against tasks/<T>-<TYPE>.md replacements", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-stale-task-phase-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const stalePath = "phases/01-m001/01-01-T01-SUMMARY.md";
  // Canonical legacy task layout has no per-task subdirectory: the SUMMARY lives
  // at tasks/<T>-<TYPE>.md, not tasks/<T>/<T>-<TYPE>.md. If the expected-path
  // builder adds an extra tasks/<T>/ segment, task-scoped stale rows never match
  // their on-disk replacement and leak unpruned.
  const replacementPath = "milestones/M001/slices/S01/tasks/T01-SUMMARY.md";
  mkdirSync(join(gsdDir, "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Summary\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# stale summary\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath),
    false,
    "task-scoped stale rows should prune against the tasks/<T>-<TYPE>.md replacement",
  );
  assert.ok(fixes.includes(`pruned stale flat-phase artifact row ${stalePath}`));

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), []);
});

test("checkEngineHealth repair prunes stale phases rows stored as escaped ../ paths", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-escaped-phase-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  // Leaked row: the DB stores an escaped, absolute-ish path rather than a clean
  // `phases/…` value. The prune must gate on the .gsd-relative path so the row
  // this repair targets is not skipped just because the raw value starts with `../`.
  const stalePath = "../../../Documents/Projects/project/.gsd/phases/01-m001/01-01-PLAN.md";
  const replacementPath = "milestones/M001/slices/S01/S01-PLAN.md";
  mkdirSync(join(gsdDir, "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# stale plan\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing"),
    false,
    "escaped phases rows should prune against the milestones replacement, not be reported missing",
  );
  assert.ok(
    fixes.some((fix) => fix.startsWith("pruned stale flat-phase artifact row") && fix.includes("phases/01-m001/01-01-PLAN.md")),
    "repair should record a prune for the escaped stale phases row",
  );

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), [], "escaped stale phases row should be deleted from the DB");
});

test("checkEngineHealth marks escaped phases rows fixable when a milestones replacement exists", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-escaped-phase-fixable-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const replacementPath = "milestones/M001/slices/S01/S01-PLAN.md";
  mkdirSync(join(gsdDir, "milestones", "M001", "slices", "S01"), { recursive: true });
  writeFileSync(join(gsdDir, replacementPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: "../../../Documents/Projects/project/.gsd/phases/01-m001/01-01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# stale plan\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const issue = issues.find((candidate) => candidate.code === "artifact_file_missing");
  assert.ok(issue, "escaped stale row should still be reported when repair is off");
  assert.equal(issue.file, "phases/01-m001/01-01-PLAN.md");
  assert.equal(issue.fixable, true, "escaped phases rows with a milestones replacement must be marked fixable");
});

test("checkEngineHealth resolves legacy milestones rows through flat-phase files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-flat-fallback-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const flatPath = "phases/01-foundation/01-01-PLAN.md";
  const legacyPath = "milestones/M001/slices/S01/S01-PLAN.md";
  mkdirSync(join(gsdDir, "phases", "01-foundation"), { recursive: true });
  writeFileSync(join(gsdDir, flatPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: legacyPath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# legacy plan row\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === legacyPath),
    false,
    "legacy milestones rows should not be reported missing when the flat-phase file exists",
  );
});

test("checkEngineHealth repair prunes stale milestones rows with present flat-phase files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-stale-legacy-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const flatPath = "phases/01-foundation/01-01-PLAN.md";
  const stalePath = "milestones/M001/slices/S01/S01-PLAN.md";
  mkdirSync(join(gsdDir, "phases", "01-foundation"), { recursive: true });
  writeFileSync(join(gsdDir, flatPath), "# Plan\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# stale plan row\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath),
    false,
    "repair should not report stale legacy rows it pruned",
  );
  assert.ok(fixes.includes(`pruned stale legacy artifact row ${stalePath}`));

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), []);
});

test("checkEngineHealth marks stale milestones task rows without flat files fixable", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-fixable-stale-legacy-task-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const stalePath = "milestones/M001/slices/S01/tasks/T01-PLAN.md";
  mkdirSync(join(gsdDir, "phases", "01-foundation"), { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# stale task plan row\n",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const issue = issues.find((candidate) => candidate.code === "artifact_file_missing" && candidate.file === stalePath);
  assert.ok(issue, "missing stale legacy task row should still be reported when repair is off");
  assert.equal(issue.fixable, true, "stale legacy task rows without flat files should be fixable");
});

test("checkEngineHealth repair prunes stale milestones task rows without flat files", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-prune-stale-legacy-task-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const stalePath = "milestones/M001/slices/S01/tasks/T01-PLAN.md";
  mkdirSync(join(gsdDir, "phases", "01-foundation"), { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: stalePath,
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# stale task plan row\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === stalePath),
    false,
    "repair should prune stale legacy task rows that have no flat file representation",
  );
  assert.ok(fixes.includes(`pruned stale legacy artifact row ${stalePath}`));

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.deepEqual(rows.map((row) => row.path), []);
});

function taskSummary(id: string, verificationResult = "passed"): string {
  return [
    "---",
    `id: ${id}`,
    "parent: S01",
    "milestone: M001",
    "key_files:",
    "  - src/example.ts",
    "key_decisions:",
    "  - Keep recovery conservative",
    "duration: 5m",
    `verification_result: ${verificationResult}`,
    "completed_at: 2026-01-01T00:00:00.000Z",
    "blocker_discovered: false",
    "---",
    "",
    `# ${id}: Done`,
    "",
    "**Recovered task completion.**",
    "",
    "## What Happened",
    "",
    "The task finished and wrote its summary.",
    "",
    "## Deviations",
    "",
    "None.",
    "",
    "## Known Issues",
    "",
    "None.",
    "",
  ].join("\n");
}

test("checkEngineHealth never repairs Task completion from a valid SUMMARY projection", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-artifact-db-repair-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const tasksDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "pending", sequence: 1 });

  const relSummaryPath = "milestones/M001/slices/S01/tasks/T01-SUMMARY.md";
  const summary = taskSummary("T01");
  writeFileSync(join(gsdDir, relSummaryPath), summary, "utf-8");
  insertArtifact({
    path: relSummaryPath,
    artifact_type: "SUMMARY",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: summary,
  });

  const detectIssues: any[] = [];
  await checkEngineHealth(base, detectIssues, []);

  const divergence = detectIssues.find((issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === "M001/S01/T01");
  assert.ok(divergence, "doctor should report the artifact/DB divergence");
  assert.equal(divergence.fixable, false);

  const repairIssues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, repairIssues, fixes, { repair: true });

  assert.equal(fixes.some((fix) => fix.includes("task completion")), false);
  assert.equal(
    repairIssues.some((issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === "M001/S01/T01"),
    true,
    "repair mode must preserve the diagnostic until canonical execution resolves it",
  );

  const task = getTask("M001", "S01", "T01");
  assert.equal(task?.status, "pending");
  assert.equal(task?.completed_at, null);
  assert.equal(task?.verification_result, "");
  assert.equal(task?.full_summary_md, "");
});

test("checkEngineHealth keeps failed and negated-pass summaries non-fixable", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-artifact-db-failure-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const tasksDir = join(gsdDir, "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(tasksDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active", risk: "low", depends: [], sequence: 1 });
  const nonPassingResults = [
    ["T02", "failed"],
    ["T03", "not passed"],
    ["T04", "not passing"],
  ] as const;
  for (const [taskId, verificationResult] of nonPassingResults) {
    insertTask({ id: taskId, milestoneId: "M001", sliceId: "S01", title: "Task", status: "pending", sequence: 1 });

    const relSummaryPath = `milestones/M001/slices/S01/tasks/${taskId}-SUMMARY.md`;
    const summary = taskSummary(taskId, verificationResult);
    writeFileSync(join(gsdDir, relSummaryPath), summary, "utf-8");
    insertArtifact({
      path: relSummaryPath,
      artifact_type: "SUMMARY",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: taskId,
      full_content: summary,
    });
  }

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  for (const [taskId] of nonPassingResults) {
    const divergence = issues.find((issue) => issue.code === "artifact_db_status_divergence" && issue.unitId === `M001/S01/${taskId}`);
    assert.ok(divergence, "doctor should still report non-passing summary drift");
    assert.equal(divergence.fixable, false);
  }
});

test("checkEngineHealth reports missing CONTEXT and RESEARCH artifacts as user-content warnings", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-user-content-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertArtifact({
    path: "milestones/M002/M002-CONTEXT.md",
    artifact_type: "CONTEXT",
    milestone_id: "M002",
    slice_id: null,
    task_id: null,
    full_content: "# Context\n",
  });
  insertArtifact({
    path: "milestones/M002/M002-RESEARCH.md",
    artifact_type: "RESEARCH",
    milestone_id: "M002",
    slice_id: null,
    task_id: null,
    full_content: "# Research\n",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes, { repair: true });

  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing"),
    false,
    "missing user-authored artifacts should not be reported as blocking projection errors",
  );

  const contextIssue = issues.find((issue) => issue.code === "artifact_user_content_missing" && issue.file === "milestones/M002/M002-CONTEXT.md");
  assert.ok(contextIssue, "missing CONTEXT should use the user-content code");
  assert.equal(contextIssue.severity, "warning");
  assert.equal(contextIssue.unitId, "M002");
  assert.equal(
    contextIssue.message,
    "Artifact `milestones/M002/M002-CONTEXT.md` is a user-authored CONTEXT file recorded in the database but missing from disk. Re-run `/gsd discuss` in this milestone to regenerate it.",
  );

  const researchIssue = issues.find((issue) => issue.code === "artifact_user_content_missing" && issue.file === "milestones/M002/M002-RESEARCH.md");
  assert.ok(researchIssue, "missing RESEARCH should use the user-content code");
  assert.equal(researchIssue.severity, "warning");

  assert.ok(
    fixes.some((fix) => fix === "skipped user-authored CONTEXT artifact milestones/M002/M002-CONTEXT.md (content cannot be regenerated from the database)"),
    "repair output should explain skipped CONTEXT content",
  );
  assert.ok(
    fixes.some((fix) => fix === "skipped user-authored RESEARCH artifact milestones/M002/M002-RESEARCH.md (content cannot be regenerated from the database)"),
    "repair output should explain skipped RESEARCH content",
  );
});

test("checkEngineHealth clears artifact_file_missing after projection re-render recreates the file", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-stale-missing-artifact-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active", planning: { vision: "Ship the foundation." } });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertArtifact({
    path: "phases/01-foundation/01-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# stale row only\n",
  });
  // CONTEXT is not re-rendered by flushWorkflowProjections, so its missing-file
  // diagnostic must survive the post-re-render cleanup (guards against the
  // clearing logic over-broadening to artifacts the same run did not recreate).
  insertArtifact({
    path: "phases/01-foundation/01-CONTEXT.md",
    artifact_type: "CONTEXT",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# stale context row only\n",
  });
  appendEvent(base, {
    cmd: "plan-milestone",
    params: { milestoneId: "M001" },
    ts: "2999-01-01T00:00:00.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  const fixes: string[] = [];
  await checkEngineHealth(base, issues, fixes);

  assert.ok(fixes.includes("re-rendered missing projections for M001"));
  assert.equal(
    issues.some((issue) => issue.code === "artifact_file_missing" && issue.file === "phases/01-foundation/01-ROADMAP.md"),
    false,
    "doctor should not report a missing artifact that projection repair recreated in the same run",
  );
  const contextIssue = issues.find((issue) => issue.code === "artifact_user_content_missing" && issue.file === "phases/01-foundation/01-CONTEXT.md");
  assert.ok(contextIssue, "doctor should still report missing user content that projection repair did not recreate");
  assert.equal(contextIssue.severity, "warning");
});
