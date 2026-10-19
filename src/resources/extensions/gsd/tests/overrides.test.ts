// Project/App: gsd-pi
// File Purpose: Steer overrides are database rows; OVERRIDES.md is only a render.

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { verifyExpectedArtifact } from "../artifact-verification.ts";
import { DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import type { DoctorIssue } from "../doctor-types.ts";
import { handleDoctor, handleSteer } from "../commands-handlers.ts";
import { withCommandCwd } from "../commands/context.ts";
import { formatOverridesSection, type Override } from "../files.ts";
import { _getAdapter, closeDatabase, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import {
  getRewriteCount,
  importFileOverrides,
  loadActiveOverrides,
  recordRewriteAttempt,
  registerOverride,
  resolveAllOverrides,
  unimportedFileOverrides,
} from "../overrides.ts";
import { preserveProjectionChangesBeforeDispatch, projectionRendererFor } from "../projection-worker.ts";
import { invalidateStateCache } from "../state.ts";

// The file an older release wrote: overrides lived only in OVERRIDES.md.
const LEGACY_OVERRIDES = [
  "# GSD Overrides",
  "",
  "User-issued overrides that supersede plan document content.",
  "",
  "---",
  "",
  "## Override: 2026-03-13T09:00:00.000Z",
  "",
  "**Change:** Legacy resolved override",
  "**Scope:** resolved",
  "**Applied-at:** M001/S01/T01",
  "",
  "---",
  "",
  "## Override: 2026-03-14T10:00:00.000Z",
  "",
  "**Change:** Legacy active override",
  "**Scope:** active",
  "**Applied-at:** M001/S01/T02",
  "",
  "---",
  "",
].join("\n");

function operations(type: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = :type",
  ).get({ ":type": type });
  return Number(row?.["count"]);
}

async function overrideIssues(
  base: string,
  options: { repair?: boolean; importFileOverrides?: boolean },
  fixesApplied: string[] = [],
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  await checkEngineHealth(base, issues, fixesApplied, options);
  return issues.filter((issue) => issue.code === "override_file_block_unimported");
}

function rewriteDocsRule() {
  const rule = DISPATCH_RULES.find((candidate) => candidate.name === "rewrite-docs (override gate)");
  assert.ok(rule, "rewrite-docs rule is registered");
  return rule;
}

function dispatchContext(base: string, preview = false): DispatchContext {
  return {
    basePath: base,
    mid: "M001",
    midTitle: "Overrides",
    state: {
      activeMilestone: { id: "M001", title: "Overrides" },
      activeSlice: null,
      activeTask: null,
      phase: "executing",
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 1 } },
    },
    prefs: undefined,
    preview,
  } as DispatchContext;
}

describe("steer overrides in the database", () => {
  let base: string;
  let overridesPath: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-overrides-db-")));
    mkdirSync(join(base, ".gsd"), { recursive: true });
    overridesPath = join(base, ".gsd", "OVERRIDES.md");
    assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Overrides", status: "active" });
  });

  afterEach(() => {
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });

  test("/gsd steer writes one operation row and rewrite-docs dispatches with OVERRIDES.md deleted", async () => {
    const sent: string[] = [];
    const notices: string[] = [];
    const ctx = { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
    const pi = { sendMessage: (message: { content: string }) => sent.push(message.content) } as unknown as ExtensionAPI;

    await withCommandCwd(base, () => handleSteer("Use Postgres instead of SQLite", ctx, pi));

    assert.equal(operations("override.register"), 1);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Use Postgres instead of SQLite\n\*\*Scope:\*\* active/);
    assert.equal(sent.length, 1);
    assert.equal(notices.length, 1);

    rmSync(overridesPath);
    const result = await rewriteDocsRule().match(dispatchContext(base));

    assert.equal(result?.action, "dispatch");
    assert.equal(result.action === "dispatch" && result.unitType, "rewrite-docs");
    assert.ok(result.action === "dispatch" && result.prompt.includes("Use Postgres instead of SQLite"));
    assert.ok(result.action === "dispatch" && !result.prompt.includes("**Scope:** active"), "the agent is not told to edit OVERRIDES.md");
  });

  test("an OVERRIDES.md block the database does not hold does not affect dispatch, prompts or verification", async () => {
    writeFileSync(overridesPath, LEGACY_OVERRIDES, "utf-8");

    assert.deepEqual(loadActiveOverrides(base), []);
    assert.equal(verifyExpectedArtifact("rewrite-docs", "M001", base), true);
    assert.equal(await rewriteDocsRule().match(dispatchContext(base)), null);
    assert.equal(operations("override.import"), 0, "dispatch imports nothing");

    registerOverride(base, "Use Postgres instead of SQLite", "M001/S01/T03");

    assert.deepEqual(loadActiveOverrides(base).map((override) => override.change), ["Use Postgres instead of SQLite"]);
    const result = await rewriteDocsRule().match(dispatchContext(base));
    assert.equal(result?.action, "dispatch");
    assert.ok(result.action === "dispatch" && result.prompt.includes("Use Postgres instead of SQLite"));
    assert.ok(result.action === "dispatch" && !result.prompt.includes("Legacy active override"));
    assert.equal(operations("override.import"), 0);

    const rendered = readFileSync(overridesPath, "utf-8");
    assert.match(rendered, /\*\*Change:\*\* Legacy active override\n\*\*Scope:\*\* active/, "the render keeps the block for doctor");
    assert.match(rendered, /\*\*Change:\*\* Legacy resolved override\n\*\*Scope:\*\* resolved/);
  });

  test("doctor reports an un-imported OVERRIDES.md block and imports it only on the operator's --fix", async () => {
    writeFileSync(overridesPath, LEGACY_OVERRIDES, "utf-8");

    let issues = await overrideIssues(base, {});
    assert.deepEqual(issues.map((issue) => [issue.severity, issue.unitId, issue.fixable]), [
      ["warning", "project", true],
      ["warning", "project", true],
    ]);
    assert.match(issues[0]!.message, /2026-03-13T09:00:00\.000Z/);
    assert.match(issues[1]!.message, /2026-03-14T10:00:00\.000Z \("Legacy active override", active\)/);

    // A fix run that no operator asked for (auto-mode resume) does not import.
    issues = await overrideIssues(base, { repair: true });
    assert.equal(issues.length, 2);
    assert.equal(operations("override.import"), 0);
    assert.deepEqual(loadActiveOverrides(base), []);

    const fixesApplied: string[] = [];
    issues = await overrideIssues(base, { repair: true, importFileOverrides: true }, fixesApplied);

    assert.deepEqual(issues, []);
    assert.equal(operations("override.import"), 1);
    assert.ok(fixesApplied.some((fix) => fix.includes("2026-03-14T10:00:00.000Z")));
    assert.deepEqual(loadActiveOverrides(base), [{
      timestamp: "2026-03-14T10:00:00.000Z",
      change: "Legacy active override",
      scope: "active",
      appliedAt: "M001/S01/T02",
    }]);
    assert.equal(verifyExpectedArtifact("rewrite-docs", "M001", base), false);
    const result = await rewriteDocsRule().match(dispatchContext(base));
    assert.equal(result?.action, "dispatch");
    assert.ok(result.action === "dispatch" && result.prompt.includes("Legacy active override"));
    assert.equal(getRewriteCount(), 1, "the dispatch is counted against the imported override");
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Legacy resolved override\n\*\*Scope:\*\* resolved/);

    assert.deepEqual(await overrideIssues(base, { repair: true, importFileOverrides: true }), []);
    assert.equal(operations("override.import"), 1, "a block the database holds is not imported again");

    resolveAllOverrides(base);

    assert.deepEqual(loadActiveOverrides(base), []);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Legacy active override\n\*\*Scope:\*\* resolved/);
  });

  test("/gsd doctor names an un-imported OVERRIDES.md block and /gsd doctor fix imports it", async () => {
    writeFileSync(overridesPath, LEGACY_OVERRIDES, "utf-8");
    const notices: string[] = [];
    const ctx = { ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
    const pi = {} as ExtensionAPI;

    await withCommandCwd(base, () => handleDoctor("", ctx, pi));

    assert.match(notices[0]!, /OVERRIDES\.md override 2026-03-14T10:00:00\.000Z \("Legacy active override", active\) is not in the database/);
    assert.equal(operations("override.import"), 0, "a plain doctor run imports nothing");
    assert.deepEqual(loadActiveOverrides(base), []);

    notices.length = 0;
    await withCommandCwd(base, () => handleDoctor("fix", ctx, pi));

    assert.equal(operations("override.import"), 1);
    assert.match(notices[0]!, /imported 2 override\(s\) from OVERRIDES\.md/);
    assert.doesNotMatch(notices[0]!, /is not in the database/);
    assert.deepEqual(loadActiveOverrides(base).map((override) => override.change), ["Legacy active override"]);
  });

  test("an OVERRIDES.md block with an unknown scope is reported, kept and never imported", async () => {
    writeFileSync(overridesPath, LEGACY_OVERRIDES.replace("**Scope:** active", "**Scope:** paused"), "utf-8");

    const issues = await overrideIssues(base, { repair: true, importFileOverrides: true });

    assert.deepEqual(issues.map((issue) => [issue.unitId, issue.fixable]), [["project", false]]);
    assert.match(issues[0]!.message, /2026-03-14T10:00:00\.000Z .* unknown scope "paused"/);
    assert.equal(operations("override.import"), 1, "the valid block is imported");
    assert.deepEqual(loadActiveOverrides(base), []);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Legacy active override\n\*\*Scope:\*\* paused/);
    assert.throws(
      () => importFileOverrides(base, unimportedFileOverrides(base)),
      /2026-03-14T10:00:00\.000Z has unknown scope "paused"/,
    );
  });

  test("rewrite-docs is verified by resolution in the database, not by file text", () => {
    registerOverride(base, "Switch to JWT auth", "M001/S01/T01");
    // The edit that an older rewrite-docs prompt told the agent to make.
    writeFileSync(
      overridesPath,
      readFileSync(overridesPath, "utf-8").replace("**Scope:** active", "**Scope:** resolved"),
      "utf-8",
    );
    assert.equal(verifyExpectedArtifact("rewrite-docs", "M001", base), false);
    assert.equal(loadActiveOverrides(base).length, 1);

    resolveAllOverrides(base);

    assert.equal(operations("override.resolve"), 1);
    assert.deepEqual(loadActiveOverrides(base), []);
    assert.equal(verifyExpectedArtifact("rewrite-docs", "M001", base), true);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Switch to JWT auth\n\*\*Scope:\*\* resolved/);

    resolveAllOverrides(base);
    assert.equal(operations("override.resolve"), 1, "resolving with nothing active writes no operation");
  });

  test("the rewrite circuit breaker counts dispatches in the database and resolves after the limit", async () => {
    registerOverride(base, "Drop the cache layer", "M001/S01/T01");
    const rule = rewriteDocsRule();

    assert.equal((await rule.match(dispatchContext(base, true)))?.action, "dispatch");
    assert.equal(getRewriteCount(), 0, "a preview records no attempt");

    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal((await rule.match(dispatchContext(base)))?.action, "dispatch");
      assert.equal(getRewriteCount(), attempt);
    }

    assert.equal(await rule.match(dispatchContext(base)), null, "the fourth attempt gives up");
    assert.deepEqual(loadActiveOverrides(base), []);
    assert.equal(getRewriteCount(), 0, "resolution resets the count");

    registerOverride(base, "A new override starts a new count", "M001/S01/T02");
    assert.equal((await rule.match(dispatchContext(base)))?.action, "dispatch");
    assert.equal(getRewriteCount(), 1);
  });

  test("the projection worker renders OVERRIDES.md from the database", async () => {
    registerOverride(base, "Prefer server components", "M001/S02/T01");
    rmSync(overridesPath);

    const renderer = projectionRendererFor("markdown", "overrides");
    assert.ok(renderer, "the overrides key has a renderer");
    await renderer.render(base);

    assert.ok(existsSync(overridesPath));
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Change:\*\* Prefer server components/);
  });

  test("override operations from a worktree leave nothing for dispatch to preserve or hold", async () => {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
    writeFileSync(join(base, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "chore: seed"], { cwd: base, stdio: "ignore" });
    const worktree = join(base, ".gsd-worktrees", "M001");
    execFileSync("git", ["worktree", "add", "-b", "milestone/M001", worktree], { cwd: base, stdio: "ignore" });

    registerOverride(base, "Use Postgres instead of SQLite", "M001/S01/T01");
    recordRewriteAttempt(worktree);

    let observed = await preserveProjectionChangesBeforeDispatch(base);
    assert.deepEqual(observed.preserved, []);
    assert.deepEqual(observed.held, []);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Scope:\*\* active\n.*\n\*\*Rewrite-attempts:\*\* 1/);

    resolveAllOverrides(worktree);

    observed = await preserveProjectionChangesBeforeDispatch(base);
    assert.deepEqual(observed.preserved, []);
    assert.deepEqual(observed.held, []);
    assert.match(readFileSync(overridesPath, "utf-8"), /\*\*Scope:\*\* resolved/);
    assert.equal(existsSync(join(worktree, ".gsd", "OVERRIDES.md")), false, "one OVERRIDES.md, at the project root");
  });

  test("registering an override without a database fails loud", () => {
    closeDatabase();
    assert.throws(() => registerOverride(base, "No DB", "none/none/none"), /requires the GSD database/);
    assert.equal(existsSync(overridesPath), false);
  });
});

describe("formatOverridesSection", () => {
  test("empty array", () => {
    assert.equal(formatOverridesSection([]), "");
  });

  test("formats section", () => {
    const overrides: Override[] = [
      { timestamp: "2026-03-14T10:00:00.000Z", change: "Use Postgres", scope: "active", appliedAt: "M001/S01/T01" },
    ];
    const result = formatOverridesSection(overrides);
    assert.ok(result.includes("## Active Overrides (supersede plan content)"));
    assert.ok(result.includes("**Use Postgres**"));
    assert.ok(result.includes("supersede any conflicting content"));
  });
});
