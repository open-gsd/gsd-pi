/**
 * Behavioural tests for /gsd discuss routing fixes:
 *   - pre-planning milestones route to milestone-level discuss
 *   - targeted slice path uses ROADMAP fallback when DB has no slices (#2892)
 *   - discuss target IDs are canonicalized (case normalization)
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _loadDiscussNormSlicesForTest,
  showDiscuss,
} from "../guided-flow.ts";
import { normalizeDiscussTarget } from "../milestone-ids.ts";
import { _parseDiscussArgsForTest } from "../commands/handlers/workflow.ts";
import { openDatabase, closeDatabase, isDbAvailable, insertMilestone } from "../gsd-db.ts";
import { invalidateStateCache } from "../state.ts";
import { clearGuidedUnitContext, getGuidedUnitContext } from "../guided-unit-context.ts";

afterEach(() => {
  if (isDbAvailable()) closeDatabase();
  invalidateStateCache();
  clearGuidedUnitContext();
});

function makeDiscussPi() {
  const sent: Array<{ content?: unknown; unitType?: string }> = [];
  const tmp = mkdtempSync(join(tmpdir(), "gsd-discuss-workflow-"));
  const workflowPath = join(tmp, "GSD-WORKFLOW.md");
  writeFileSync(workflowPath, "# Workflow\n");
  const originalWorkflowPath = process.env.GSD_WORKFLOW_PATH;
  process.env.GSD_WORKFLOW_PATH = workflowPath;
  return {
    sent,
    tmp,
    pi: {
      getActiveTools: () => ["gsd_summary_save", "bash"],
      emitAdjustToolSet: async () => undefined,
      emitBeforeModelSelect: async () => undefined,
      setModel: async () => true,
      setActiveTools: () => {},
      setThinkingLevel: () => {},
      sendMessage: (message: { content?: unknown }) => {
        sent.push(message);
      },
    },
    restore() {
      if (originalWorkflowPath === undefined) delete process.env.GSD_WORKFLOW_PATH;
      else process.env.GSD_WORKFLOW_PATH = originalWorkflowPath;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function makeDiscussCtx(notifications: Array<{ message: string; level?: string }> = []) {
  const model = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" };
  return {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "test-discuss-session",
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus: () => {},
    },
    waitForIdle: async () => {},
    model,
    modelRegistry: {
      getAvailable: () => [model],
      getAll: () => [model],
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: () => true,
    },
  };
}

async function runDiscussTargetFixture(
  target: string,
  milestones: Array<{ id: string; title?: string; status?: string }>,
  writeArtifacts?: (base: string) => void,
) {
  const base = mkdtempSync(join(tmpdir(), "gsd-discuss-target-"));
  const notifications: Array<{ message: string; level?: string }> = [];
  const harness = makeDiscussPi();
  try {
    mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
    writeArtifacts?.(base);
    const dbPath = join(base, ".gsd", "gsd.db");
    assert.equal(openDatabase(dbPath), true);
    for (const milestone of milestones) {
      insertMilestone(milestone);
    }

    await showDiscuss(
      makeDiscussCtx(notifications) as any,
      harness.pi as any,
      base,
      { target },
    );

    return {
      notifications: [...notifications],
      sent: [...harness.sent],
    };
  } finally {
    harness.restore();
    if (isDbAvailable()) closeDatabase();
    invalidateStateCache();
    clearGuidedUnitContext();
    rmSync(base, { recursive: true, force: true });
  }
}

describe("discuss target normalization", () => {
  test("canonicalizes milestone and slice casing", () => {
    assert.equal(normalizeDiscussTarget("m014"), "M014");
    assert.equal(normalizeDiscussTarget("M014/s03"), "M014/S03");
    assert.equal(normalizeDiscussTarget("m014/s03"), "M014/S03");
    assert.equal(_parseDiscussArgsForTest("m014").target, "M014");
    assert.equal(_parseDiscussArgsForTest("--slice m014/s03").target, "M014/S03");
  });
});

describe("showDiscuss targeted milestone guardrails (#1320)", () => {
  test("missing, complete, and parked milestone targets get actionable messages", async () => {
    const cases = [
      {
        target: "M006",
        milestones: [{ id: "M005", title: "Current", status: "active" }],
        level: "warning",
        message: /Milestone M006 was not found in the roadmap\. Use \/gsd new-milestone to add it, or \/gsd status to see available milestones\./,
      },
      {
        target: "M006/S01",
        milestones: [{ id: "M005", title: "Current", status: "active" }],
        level: "warning",
        message: /Milestone M006 was not found in the roadmap\. Use \/gsd new-milestone to add it, or \/gsd status to see available milestones\./,
      },
      {
        target: "M006",
        milestones: [{ id: "M006", title: "Done", status: "complete" }],
        level: "info",
        message: /Milestone M006 is already complete\./,
      },
      {
        target: "M006/S01",
        milestones: [{ id: "M006", title: "Done", status: "complete" }],
        level: "info",
        message: /Milestone M006 is already complete\./,
      },
      {
        target: "M006",
        milestones: [{ id: "M006", title: "Deferred", status: "parked" }],
        level: "warning",
        message: /Milestone M006 is parked\. Run \/gsd unpark M006 to reactivate\./,
      },
      {
        target: "M006/S01",
        milestones: [{ id: "M006", title: "Deferred", status: "parked" }],
        level: "warning",
        message: /Milestone M006 is parked\. Run \/gsd unpark M006 to reactivate\./,
      },
    ];

    for (const testCase of cases) {
      const result = await runDiscussTargetFixture(testCase.target, testCase.milestones);
      assert.equal(result.sent.length, 0, `${testCase.target} must not dispatch`);
      assert.equal(result.notifications.length, 1, `${testCase.target} must emit one notification`);
      assert.equal(result.notifications[0]?.level, testCase.level);
      assert.match(result.notifications[0]?.message ?? "", testCase.message);
      assert.doesNotMatch(result.notifications[0]?.message ?? "", /not discussable/i);
    }
  });

  test("bare milestone targets match unique-suffix milestone IDs", async () => {
    const result = await runDiscussTargetFixture("M006", [
      { id: "M006-abc123", title: "Unique milestone", status: "active" },
    ]);

    assert.equal(result.notifications.length, 0);
    assert.equal(result.sent.length, 1, "bare ID must dispatch the suffixed milestone");
    assert.match(String(result.sent[0]?.content), /M006-abc123|Unique milestone|guided-discuss-milestone/i);
  });

  test("bare slice targets match unique-suffix milestone IDs", async () => {
    const result = await runDiscussTargetFixture(
      "M006/S01",
      [{ id: "M006-abc123", title: "Unique milestone", status: "active" }],
      (base) => {
        mkdirSync(join(base, ".gsd", "milestones", "M006-abc123"), { recursive: true });
        writeFileSync(
          join(base, ".gsd", "milestones", "M006-abc123", "M006-abc123-ROADMAP.md"),
          `# M006-abc123 Roadmap

## Slices
- [ ] **S01: Unique slice** \`risk:medium\` \`depends:[]\`
  > After this: the suffixed milestone slice can be discussed
`,
          "utf-8",
        );
      },
    );

    assert.equal(result.notifications.length, 0);
    assert.equal(result.sent.length, 1, "bare ID slice target must dispatch through the suffixed milestone");
    assert.match(String(result.sent[0]?.content), /M006-abc123|S01|Unique slice|guided-discuss-slice/i);
  });
});

describe("loadDiscussNormSlices roadmap fallback (#2892)", () => {
  test("falls back to ROADMAP when DB has no slice rows", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-discuss-slices-"));
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Test", status: "active" });

      const roadmap = `# M001 Roadmap

## Slices
- [ ] **S01: Core setup** \`risk:low\` \`depends:[]\`
  > After this: basic scaffolding works
`;
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), roadmap, "utf-8");

      const slices = await _loadDiscussNormSlicesForTest(base, "M001");
      assert.equal(slices.length, 1);
      assert.equal(slices[0]?.id, "S01");
      assert.equal(slices[0]?.done, false);
    } finally {
      if (isDbAvailable()) closeDatabase();
      invalidateStateCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("showDiscuss pre-planning routing", () => {
  test("bare /gsd discuss dispatches milestone discuss instead of 'all slices complete'", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-discuss-preplan-"));
    const notifications: Array<{ message: string; level?: string }> = [];
    const harness = makeDiscussPi();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Pre-plan milestone", status: "active" });

      await showDiscuss(makeDiscussCtx(notifications) as any, harness.pi as any, base);

      const allComplete = notifications.find((n) => /all slices are complete/i.test(n.message));
      assert.equal(allComplete, undefined, "pre-planning must not report all slices complete");
      assert.equal(harness.sent.length, 1, "pre-planning must dispatch milestone discuss");
      assert.match(String(harness.sent[0]?.content), /Pre-plan milestone|guided-discuss-milestone|M001/i);
    } finally {
      harness.restore();
      if (isDbAvailable()) closeDatabase();
      invalidateStateCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("showDiscuss targeted slice roadmap fallback", () => {
  test("/gsd discuss M001/S01 resolves slice from ROADMAP when DB is empty", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-discuss-target-slice-"));
    const notifications: Array<{ message: string; level?: string }> = [];
    const harness = makeDiscussPi();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Target slice milestone", status: "active" });

      const roadmap = `# M001 Roadmap

## Slices
- [ ] **S01: Auth module** \`risk:medium\` \`depends:[]\`
  > After this: users can log in
`;
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), roadmap, "utf-8");

      await showDiscuss(
        makeDiscussCtx(notifications) as any,
        harness.pi as any,
        base,
        { target: "m001/s01" },
      );

      const notFound = notifications.find((n) => /not found in discussable slices/i.test(n.message));
      assert.equal(notFound, undefined, "targeted slice must resolve from ROADMAP fallback");
      assert.equal(harness.sent.length, 1, "targeted slice must dispatch discuss-slice");
      assert.match(String(harness.sent[0]?.content), /S01|Auth module|guided-discuss-slice/i);
    } finally {
      harness.restore();
      if (isDbAvailable()) closeDatabase();
      invalidateStateCache();
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("/gsd discuss M001/S01 routes slice discussion through the active worktree", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-discuss-target-worktree-"));
    const notifications: Array<{ message: string; level?: string }> = [];
    const harness = makeDiscussPi();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
      const dbPath = join(base, ".gsd", "gsd.db");
      assert.equal(openDatabase(dbPath), true);
      insertMilestone({ id: "M001", title: "Target slice milestone", status: "active" });

      const rootRoadmap = `# M001 Roadmap

## Slices
- [ ] **S01: Auth module** \`risk:medium\` \`depends:[]\`
  > ROOT-ROADMAP-CONTENT
`;
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), rootRoadmap, "utf-8");

      const worktreeBase = join(base, ".gsd", "worktrees", "M001");
      mkdirSync(join(worktreeBase, ".gsd", "milestones", "M001"), { recursive: true });
      writeFileSync(join(worktreeBase, ".git"), "gitdir: /tmp/gsd-discuss-target-worktree.git\n", "utf-8");
      const worktreeRoadmap = `# M001 Roadmap

## Slices
- [ ] **S01: Auth module** \`risk:medium\` \`depends:[]\`
  > WORKTREE-ROADMAP-CONTENT
`;
      writeFileSync(
        join(worktreeBase, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
        worktreeRoadmap,
        "utf-8",
      );

      await showDiscuss(
        makeDiscussCtx(notifications) as any,
        harness.pi as any,
        base,
        { target: "M001/S01" },
      );

      assert.equal(harness.sent.length, 1, "targeted slice must dispatch discuss-slice");
      const content = String(harness.sent[0]?.content);
      assert.match(content, /WORKTREE-ROADMAP-CONTENT/);
      assert.doesNotMatch(content, /ROOT-ROADMAP-CONTENT/);
      assert.equal(
        getGuidedUnitContext(worktreeBase)?.unitType,
        "discuss-slice",
        "guided unit context must be keyed by the worktree base path",
      );
      assert.equal(getGuidedUnitContext(base), null, "project root must not receive the discuss-slice guided context");
    } finally {
      harness.restore();
      if (isDbAvailable()) closeDatabase();
      invalidateStateCache();
      clearGuidedUnitContext();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
