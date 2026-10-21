/**
 * Regression test for #3470: DB-backed active milestone selection must not
 * prefer a stale queued shell over the real active milestone.
 *
 * Scenario: M068 is a queued placeholder (DB row, no files, no slices).
 * M070 is the real active milestone (context, roadmap, slices, tasks).
 * deriveStateFromDb() must select M070 as active, not M068.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { deriveStateFromDb, invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertArtifact,
} from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-milestone-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeFile(base: string, relativePath: string, content: string): void {
  const full = join(base, ".gsd", relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function seedMilestoneArtifact(
  milestoneId: string,
  artifactType: "CONTEXT" | "CONTEXT-DRAFT",
  content: string,
): void {
  insertArtifact({
    path: `milestones/${milestoneId}/${milestoneId}-${artifactType}.md`,
    artifact_type: artifactType,
    milestone_id: milestoneId,
    slice_id: null,
    task_id: null,
    full_content: content,
  });
}

function seedProjectSequence(content: string): void {
  insertArtifact({
    path: "PROJECT.md",
    artifact_type: "PROJECT",
    milestone_id: null,
    slice_id: null,
    task_id: null,
    full_content: content,
  });
}

describe("stale queued milestone selection (#3470)", () => {
  let base: string;

  afterEach(() => {
    closeDatabase();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("queued shell with no content does not block real active milestone", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued shell — DB row exists, no files, no slices
    insertMilestone({ id: "M068", title: "Queued Shell", status: "queued" });

    // M070: real active milestone — context, roadmap, slices, tasks
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M070", title: "Task One", status: "pending" });

    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active\n\nThis is the real milestone.");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070: Real Active\n\n## Slices\n\n- [ ] **S01: Slice One**");
    writeFile(base, "milestones/M070/slices/S01/S01-PLAN.md", "# S01: Slice One\n\n## Tasks\n\n- [ ] **T01: Task One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "Active milestone must be M070, not queued shell M068");

    // M068 should appear as pending in registry, not active
    const m068Entry = state.registry.find((e: any) => e.id === "M068");
    assert.ok(m068Entry, "M068 should still appear in registry");
    assert.equal(m068Entry!.status, "pending", "M068 should be pending, not active");

    // M070 should be active in registry
    const m070Entry = state.registry.find((e: any) => e.id === "M070");
    assert.ok(m070Entry, "M070 should appear in registry");
    assert.equal(m070Entry!.status, "active", "M070 should be active in registry");
  });

  test("queued milestone with roadmap projection but no DB slices stays deferred", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued shell with a stale ROADMAP projection, but no CONTEXT and no DB slices.
    insertMilestone({ id: "M068", title: "Queued Roadmap Projection", status: "queued" });
    writeFile(base, "milestones/M068/M068-ROADMAP.md", "# M068\n\n## Slices\n\n- [ ] **S99: Stale Slice**");

    // M070: real active milestone — context, roadmap, slices, tasks
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M070", title: "Task One", status: "pending" });

    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active\n\nThis is the real milestone.");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070: Real Active\n\n## Slices\n\n- [ ] **S01: Slice One**");
    writeFile(base, "milestones/M070/slices/S01/S01-PLAN.md", "# S01: Slice One\n\n## Tasks\n\n- [ ] **T01: Task One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "ROADMAP-only queued milestone must not block active M070");

    const m068Entry = state.registry.find((e: any) => e.id === "M068");
    assert.ok(m068Entry, "M068 should still appear in registry");
    assert.equal(m068Entry!.status, "pending", "M068 should stay pending without CONTEXT or DB slices");
  });

  test("queued milestone WITH context file can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has context (discussion started) — should be activatable
    insertMilestone({ id: "M068", title: "Queued With Context", status: "queued" });
    const queuedContext = "# M068: Queued With Context\n\nDiscussion started.";
    writeFile(base, "milestones/M068/M068-CONTEXT.md", queuedContext);
    seedMilestoneArtifact("M068", "CONTEXT", queuedContext);

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with context should become active");
  });

  test("queued milestone WITH context-draft can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has draft (discussion in progress)
    insertMilestone({ id: "M068", title: "Queued With Draft", status: "queued" });
    const queuedDraft = "# M068: Queued With Draft\n\nDraft in progress.";
    writeFile(base, "milestones/M068/M068-CONTEXT-DRAFT.md", queuedDraft);
    seedMilestoneArtifact("M068", "CONTEXT-DRAFT", queuedDraft);

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with draft should become active");
    assert.equal(state.phase, "needs-discussion", "Queued milestone with draft should resume discussion");
  });

  test("queued milestone WITH slices can still be selected as active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued but has slices (planning started)
    insertMilestone({ id: "M068", title: "Queued With Slices", status: "queued" });
    insertSlice({ id: "S01", milestoneId: "M068", title: "Slice One", status: "pending", risk: "low", depends: [] });
    writeFile(base, "milestones/M068/M068-ROADMAP.md", "# M068\n\n## Slices\n\n- [ ] **S01: Slice One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with slices should become active");
  });

  test("multiple queued shells all skipped in favor of real active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // Three queued shells before the real milestone
    insertMilestone({ id: "M065", title: "Shell 1", status: "queued" });
    insertMilestone({ id: "M066", title: "Shell 2", status: "queued" });
    insertMilestone({ id: "M068", title: "Shell 3", status: "queued" });

    // M070: real active
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070\n\n## Slices\n\n- [ ] **S01: Slice One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "Must skip all queued shells to reach M070");

    // All shells should be pending
    for (const id of ["M065", "M066", "M068"]) {
      const entry = state.registry.find((e: any) => e.id === id);
      assert.ok(entry, `${id} should be in registry`);
      assert.equal(entry!.status, "pending", `${id} should be pending, not active`);
    }
  });

  test("queued milestone with stale CONTEXT-DRAFT does not block real active milestone", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued, no slices, has a CONTEXT-DRAFT (abandoned discussion)
    insertMilestone({ id: "M068", title: "Abandoned Draft", status: "queued" });
    writeFile(base, "milestones/M068/M068-CONTEXT-DRAFT.md", "# M068: Abandoned Draft\n\nDraft left over from an abandoned session.");

    // M070: real active milestone with execution artifacts
    insertMilestone({ id: "M070", title: "Real Active", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M070", title: "Slice One", status: "active", risk: "low", depends: [] });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M070", title: "Task One", status: "pending" });

    writeFile(base, "milestones/M070/M070-CONTEXT.md", "# M070: Real Active\n\nThis is the real milestone.");
    writeFile(base, "milestones/M070/M070-ROADMAP.md", "# M070: Real Active\n\n## Slices\n\n- [ ] **S01: Slice One**");
    writeFile(base, "milestones/M070/slices/S01/S01-PLAN.md", "# S01: Slice One\n\n## Tasks\n\n- [ ] **T01: Task One**");

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M070", "Stale draft on M068 must not block real active M070");

    const m068Entry = state.registry.find((e: any) => e.id === "M068");
    assert.ok(m068Entry, "M068 should still appear in registry");
    assert.equal(m068Entry!.status, "pending", "M068 with stale draft should be pending, not active");
  });

  test("phantom queued shell (no content, no draft, no slices) is not promoted to active (#1524)", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M015: phantom row left by gsd_milestone_generate_id — never planned,
    // no CONTEXT/ROADMAP/SUMMARY, no draft, no slices. It is the only
    // milestone, so the old fallback would have promoted it to active.
    insertMilestone({ id: "M015", title: "Phantom", status: "queued" });

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone, null, "Phantom queued shell must not be promoted to active");

    const m015Entry = state.registry.find((e: any) => e.id === "M015");
    assert.ok(m015Entry, "M015 should still appear in registry");
    assert.equal(m015Entry!.status, "pending", "Phantom queued shell should stay pending, not active");
  });

  test("content-less queued shell listed in the PROJECT.md sequence is promoted to pre-planning (#1524)", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M001/M002 are the roadmap the user committed to during deep-project setup:
    // both are still content-less queued shells, but they appear in PROJECT.md's
    // Milestone Sequence, so the first one is a real not-yet-planned stage (not a
    // phantom) and must be promoted to active so the user can plan it.
    insertMilestone({ id: "M001", title: "Foundation", status: "queued" });
    insertMilestone({ id: "M002", title: "Polish", status: "queued" });
    seedProjectSequence(
      [
        "# Project",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "- [ ] M002: Polish - Follow-up experience work.",
        "",
      ].join("\n"),
    );

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M001", "First in-sequence roadmap shell should be promoted to active");
    assert.equal(state.phase, "pre-planning", "A content-less in-sequence shell should go to pre-planning, not needs-discussion");

    const m001Entry = state.registry.find((e: any) => e.id === "M001");
    assert.equal(m001Entry!.status, "active", "M001 should be active in the registry");
    const m002Entry = state.registry.find((e: any) => e.id === "M002");
    assert.equal(m002Entry!.status, "pending", "M002 should stay pending behind the active M001");
  });

  test("content-less queued shell NOT in the PROJECT.md sequence stays a phantom (#1524)", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // PROJECT.md only commits to M001. M099 is a stray row left by
    // gsd_milestone_generate_id that never entered the roadmap, so even though a
    // PROJECT.md exists it must not be promoted.
    insertMilestone({ id: "M099", title: "Stray Phantom", status: "queued" });
    writeFile(
      base,
      "PROJECT.md",
      [
        "# Project",
        "",
        "## Milestone Sequence",
        "",
        "- [ ] M001: Foundation - Establish the first runnable slice.",
        "",
      ].join("\n"),
    );

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone, null, "A queued shell absent from the PROJECT.md sequence must not be promoted");
    const m099Entry = state.registry.find((e: any) => e.id === "M099");
    assert.equal(m099Entry!.status, "pending", "Stray phantom should stay pending");
  });

  test("phantom-only repo surfaces a doctor recovery path, not a misleading dep-block message (#1524)", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // Two phantom shells, neither with content, draft, slices, or deps. With no
    // promotable milestone, deriveStateFromDb falls into handleNoActiveMilestone.
    insertMilestone({ id: "M015", title: "Phantom One", status: "queued" });
    insertMilestone({ id: "M016", title: "Phantom Two", status: "queued" });

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone, null, "Phantom-only repo has no active milestone");
    // Must NOT claim the milestones are dependency-blocked — they have no deps.
    assert.notEqual(state.phase, "blocked", "Phantom-only repo must not report a dependency block");
    assert.deepStrictEqual(state.blockers, [], "No dependency blockers should be surfaced for phantom-only repo");
    // Must direct the user toward a recovery path (doctor / planning).
    assert.match(
      state.nextAction,
      /doctor/,
      "nextAction should direct the user to the doctor for orphaned phantom rows",
    );
  });

  test("queued milestone with CONTEXT-DRAFT becomes active with needs-discussion phase when nothing else is active", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M068: queued, no slices, has a CONTEXT-DRAFT — should resume discussion
    insertMilestone({ id: "M068", title: "Draft Only", status: "queued" });
    const draftOnly = "# M068: Draft Only\n\nPartial context from first question round.";
    writeFile(base, "milestones/M068/M068-CONTEXT-DRAFT.md", draftOnly);
    seedMilestoneArtifact("M068", "CONTEXT-DRAFT", draftOnly);

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    assert.equal(state.activeMilestone?.id, "M068", "Queued milestone with draft should become active when nothing else is");
    assert.equal(state.phase, "needs-discussion", "Should resume discussion for queued milestone with draft");
  });

  test("earlier phantom queued shell does not mask a later draft-bearing queued shell (#1524)", async () => {
    base = createFixtureBase();
    openDatabase(":memory:");

    // M010: phantom shell encountered first — no CONTEXT, no draft, no slices.
    insertMilestone({ id: "M010", title: "Phantom First", status: "queued" });

    // M020: a real resumable draft milestone encountered later.
    insertMilestone({ id: "M020", title: "Draft Later", status: "queued" });
    const laterDraft = "# M020: Draft Later\n\nPartial context from an in-progress discussion.";
    writeFile(base, "milestones/M020/M020-CONTEXT-DRAFT.md", laterDraft);
    seedMilestoneArtifact("M020", "CONTEXT-DRAFT", laterDraft);

    invalidateStateCache();
    const state = await deriveStateFromDb(base);

    // The earlier phantom must not permanently capture the promotion slot; the
    // later draft-bearing shell is the resumable milestone and should win.
    assert.equal(state.activeMilestone?.id, "M020", "Later draft-bearing shell must be promoted, not masked by the earlier phantom");
    assert.equal(state.phase, "needs-discussion", "Promoted draft shell should resume discussion");

    const m010Entry = state.registry.find((e: any) => e.id === "M010");
    assert.ok(m010Entry, "M010 should still appear in registry");
    assert.equal(m010Entry!.status, "pending", "Phantom M010 should stay pending, not active");
  });
});
