// gsd-pi — Unit tests for additional commands (explore, spike, sketch, …)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseCoreFlags,
  slugify,
  nextArtifactId,
  handleExplore,
  handleSpike,
  handleSketch,
  handleMapCodebase,
  handleDocsUpdate,
  handleGraphify,
  handleStats,
  handleProgress,
  handleHealth,
  handleSurface,
  parsePathsFlag,
  parseProgressMode,
  handleCodeReview,
  handleReview,
  handleAuditMilestone,
  handleAuditUat,
  handleAuditFix,
  handleUiReview,
  handleSecurePhase,
  handleValidatePhase,
  handleVerifyWork,
  handlePlanReviewConvergence,
  parseListFlag,
  nextReviewId,
  handleDiscussPhase,
  handlePlanPhase,
  handleExecutePhase,
  handleSpecPhase,
  handleMvpPhase,
  handleUiPhase,
  handleAiIntegrationPhase,
  handleUltraplanPhase,
  handleAutonomous,
  handlePauseWork,
  handleResumeWork,
  handleManager,
  handlePhase,
  handleThread,
  handleWorkstreams,
  handleWorkspace,
  handleMilestoneSummary,
  handleReviewBacklog,
  handleInbox,
  handleImport,
  handleIngestDocs,
  handleProfileUser,
  handleSettings,
  parseAutonomousScope,
  parseInboxFocus,
} from "../commands-gsd-core.ts";
import { handleGSDCommand } from "../commands/dispatcher.ts";
import { withCommandCwd } from "../commands/context.ts";
import { loadPrompt } from "../prompt-loader.ts";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function createMockPi() {
  const sent: any[] = [];
  return {
    sent,
    sendMessage(message: any, _opts?: any) {
      sent.push(message);
    },
  };
}

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  };
}

function createMockCtxWithCwd(cwd: string) {
  return {
    ...createMockCtx(),
    cwd,
  };
}

function createTempGsdProject(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function createTempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withTempCommandCwd(
  fn: (ctx: ReturnType<typeof createMockCtxWithCwd>, base: string) => Promise<void>,
): Promise<void> {
  const base = createTempGsdProject("gsd-core-handler-");
  const ctx = createMockCtxWithCwd(base);
  await withCommandCwd(base, async () => fn(ctx, base));
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("parseCoreFlags", () => {
  test("extracts --quick and --text and leaves the idea text", () => {
    const f = parseCoreFlags("auth via magic links --quick --text");
    assert.equal(f.quick, true);
    assert.equal(f.textMode, true);
    assert.equal(f.frontier, false);
    assert.equal(f.text, "auth via magic links");
  });

  test("frontier mode when input is empty", () => {
    const f = parseCoreFlags("");
    assert.equal(f.frontier, true);
    assert.equal(f.text, "");
  });

  test("frontier mode when the word 'frontier' is given", () => {
    const f = parseCoreFlags("frontier");
    assert.equal(f.frontier, true);
  });

  test("strips recognized flags but keeps unknown words", () => {
    const f = parseCoreFlags("investigate redis --quick for caching");
    assert.equal(f.quick, true);
    assert.equal(f.text, "investigate redis for caching");
  });

  test("no flags → all off, text preserved", () => {
    const f = parseCoreFlags("a normal idea");
    assert.equal(f.quick, false);
    assert.equal(f.textMode, false);
    assert.equal(f.frontier, false);
    assert.equal(f.text, "a normal idea");
  });
});

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    assert.equal(slugify("Auth Via Magic Links!"), "auth-via-magic-links");
  });

  test("truncates to 40 chars on a boundary", () => {
    const long = "a".repeat(80);
    const out = slugify(long);
    assert.ok(out.length <= 40, `expected <= 40 chars, got ${out.length}`);
  });
});

describe("nextArtifactId", () => {
  test("returns 001 when the directory does not exist", () => {
    const id = nextArtifactId("/definitely/not/a/real/path/xyz");
    assert.equal(id, "001");
  });
});

// ─── Prompt templates load with the exact vars each handler passes ──────────

describe("prompt templates resolve", () => {
  test("explore.md loads with topic only", () => {
    const out = loadPrompt("explore", { topic: "test topic" });
    assert.match(out, /test topic/);
    assert.match(out, /Socratic/i);
  });

  test("spike.md loads with all four vars", () => {
    const out = loadPrompt("spike", {
      input: "an idea",
      quickFlag: "off",
      textFlag: "off",
      frontierFlag: "off",
      spikeId: "001",
    });
    assert.match(out, /an idea/);
    assert.match(out, /001/);
  });

  test("sketch.md loads with all four vars", () => {
    const out = loadPrompt("sketch", {
      input: "a design",
      quickFlag: "off",
      textFlag: "off",
      frontierFlag: "off",
      sketchId: "002",
    });
    assert.match(out, /a design/);
    assert.match(out, /002/);
  });
});

// ─── Handler dispatch (mocked pi + ctx) ──────────────────────────────────────

describe("handleExplore", () => {
  test("dispatches an explore prompt via pi.sendMessage", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleExplore("routing strategy", ctx as any, pi as any);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-explore");
    assert.match(pi.sent[0].content, /routing strategy/);
    assert.equal(ctx.notifications[0].level, "info");
  });
});

describe("handleSpike", () => {
  test("dispatches a spike prompt with parsed flags", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleSpike("validate websocket reconnect --quick", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "spikes")), true);
    });

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-spike");
    // The idea text is interpolated into a "Spike Input" block; --quick must be
    // stripped from that block (the template's flag docs still mention --quick).
    const content = pi.sent[0].content as string;
    const inputBlock = content.split("## Spike Input")[1].split("## Flags")[0];
    assert.match(inputBlock, /validate websocket reconnect/);
    assert.doesNotMatch(inputBlock, /--quick/);
    // --quick flag is reported as ON elsewhere in the prompt.
    assert.match(content, /`--quick` — ON/);
  });
});

describe("handleSketch", () => {
  test("dispatches a sketch prompt", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleSketch("dashboard empty state", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "sketches")), true);
    });

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-sketch");
    assert.match(pi.sent[0].content, /dashboard empty state/);
  });
});

// ─── Batch 2: codebase intelligence ─────────────────────────────────────────

describe("parsePathsFlag", () => {
  test("returns the comma-separated paths when valid", () => {
    assert.equal(parsePathsFlag("--paths apps/api,packages/ui"), "apps/api,packages/ui");
  });

  test("returns empty when no flag present", () => {
    assert.equal(parsePathsFlag("no flag here"), "");
  });

  test("rejects absolute paths", () => {
    assert.equal(parsePathsFlag("--paths /etc,apps"), "apps");
  });

  test("rejects parent traversal", () => {
    assert.equal(parsePathsFlag("--paths ../secret,apps"), "apps");
  });

  test("rejects shell metacharacters", () => {
    assert.equal(parsePathsFlag("--paths apps;rm -rf"), "");
  });
});

describe("parseProgressMode", () => {
  test("default mode", () => {
    assert.equal(parseProgressMode(""), "default");
  });
  test("forensic mode", () => {
    assert.equal(parseProgressMode("--forensic"), "forensic");
  });
  test("next mode", () => {
    assert.equal(parseProgressMode("--next"), "next");
  });
  test("do mode captures the quoted task", () => {
    assert.equal(parseProgressMode('--do "fix the login bug"'), "do: fix the login bug");
  });
});

describe("Batch 2 prompt templates resolve", () => {
  test("map-codebase.md loads with scope + outputDir", () => {
    const out = loadPrompt("map-codebase", { scope: "whole repo", outputDir: ".gsd/codebase" });
    assert.match(out, /whole repo/);
    assert.match(out, /\.gsd\/codebase/);
  });
  test("docs-update.md loads with mode", () => {
    const out = loadPrompt("docs-update", {
      mode: "Default mode",
      process: "Process steps",
      successCriteria: "Success criteria",
    });
    assert.match(out, /Default mode/);
  });
  test("graphify.md loads with action", () => {
    const out = loadPrompt("graphify", { action: "build" });
    assert.match(out, /build/);
  });
  test("stats.md loads with no vars", () => {
    const out = loadPrompt("stats", {});
    assert.match(out, /Project Statistics/i);
  });
  test("progress.md loads with mode", () => {
    const out = loadPrompt("progress", { mode: "default" });
    assert.match(out, /default/);
  });
  test("health.md loads with both flags", () => {
    const out = loadPrompt("health", { repairFlag: "off", contextFlag: "off" });
    assert.match(out, /repair/i);
  });
  test("surface.md loads with action", () => {
    const out = loadPrompt("surface", { action: "status" });
    assert.match(out, /status/);
  });
});

describe("Batch 2 handlers dispatch", () => {
  test("handleMapCodebase dispatches and creates the output dir", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleMapCodebase("--paths src --focus arch", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "codebase")), true);
    });
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-map-codebase");
    assert.match(pi.sent[0].content, /src/);
  });
  test("handleMapCodebase --focus captures quoted multi-word string", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx) => {
      await handleMapCodebase('--focus "auth and routing layer"', ctx as any, pi as any);
    });
    assert.match(pi.sent[0].content, /auth and routing layer/);
  });
  test("handleMapCodebase --focus captures unquoted multi-word string before next flag", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx) => {
      await handleMapCodebase("--focus auth layer --paths src", ctx as any, pi as any);
    });
    // The focus text "auth layer" must appear in full; the next flag must not bleed in
    assert.match(pi.sent[0].content, /auth layer/);
    assert.doesNotMatch(pi.sent[0].content, /auth layer --paths/);
  });

  test("handleDocsUpdate reflects verify-only mode", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleDocsUpdate("--verify-only", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-docs-update");
    assert.match(pi.sent[0].content, /Verify-only/);
    assert.doesNotMatch(pi.sent[0].content, /Write missing canonical docs/);
    assert.doesNotMatch(pi.sent[0].content, /Correct verified inaccuracies directly/);
  });

  test("handleGraphify defaults to build action", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleGraphify("", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "knowledge")), true);
    });
    assert.match(pi.sent[0].content, /build/);
  });

  test("handleStats dispatches with no args", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleStats("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-stats");
  });

  test("handleProgress forensic mode", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleProgress("--forensic", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /forensic/);
  });

  test("handleProgress --next redispatches instead of prompt tunneling", async () => {
    const base = createTempDirectory("gsd-progress-next-no-project-");
    try {
      const pi = createMockPi();
      const ctx = createMockCtxWithCwd(base);
      await handleProgress("--next", ctx as any, pi as any);
      assert.equal(pi.sent.length, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("handleProgress --do redispatches as quick task (no prompt tunneling)", async () => {
    const base = createTempDirectory("gsd-progress-do-no-project-");
    const origCwd = process.cwd();
    try {
      // handleQuick uses process.cwd() directly, so chdir to a no-.gsd dir to
      // make it exit early (notification only, no pi.sendMessage call).
      process.chdir(base);
      const pi = createMockPi();
      const ctx = createMockCtxWithCwd(base);
      await handleProgress('--do "fix the login bug"', ctx as any, pi as any);
      assert.equal(pi.sent.length, 0);
      // handleQuick emits a notification when no .gsd/ is found
      assert.match(ctx.notifications[0].message, /No \.gsd\/ directory found/);
    } finally {
      process.chdir(origCwd);
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("handleHealth repair flag on", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleHealth("--repair", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /`--repair` — ON/);
  });

  test("handleSurface passes the action", async () => {
    const pi = createMockPi();
    const ctx = createMockCtx();
    await handleSurface("profile minimal", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /profile minimal/);
  });
});

// ─── Batch 3: review / audit ────────────────────────────────────────────────

describe("parseListFlag", () => {
  test("extracts the value for --files", () => {
    assert.equal(parseListFlag("--files a.ts,b.ts", "--files"), "a.ts,b.ts");
  });
  test("returns empty when flag absent", () => {
    assert.equal(parseListFlag("nothing here", "--files"), "");
  });
});

describe("nextReviewId", () => {
  test("returns 001 when dir missing", () => {
    assert.equal(nextReviewId("/no/such/review/dir/zzz"), "001");
  });
});

describe("Batch 3 prompt templates resolve", () => {
  test("code-review.md loads with all vars", () => {
    const out = loadPrompt("code-review", { scope: "s", depth: "deep", fixMode: "off", reviewId: "001" });
    assert.match(out, /deep/);
    assert.match(out, /001/);
    assert.match(out, /diff-first/i, "code-review prompt should require diff-first context gathering");
  });
  test("review.md loads with target + reviewers", () => {
    const out = loadPrompt("review", { target: "t", reviewers: "claude, codex" });
    assert.match(out, /claude, codex/);
  });
  test("audit-milestone.md loads with target", () => {
    const out = loadPrompt("audit-milestone", { target: "M001" });
    assert.match(out, /M001/);
  });
  test("audit-uat.md loads with verifyMode", () => {
    const out = loadPrompt("audit-uat", { verifyMode: "off" });
    assert.match(out, /audit/i);
  });
  test("audit-fix.md loads with all vars", () => {
    const out = loadPrompt("audit-fix", { source: "s", severity: "high", maxFixes: "5", dryRun: "off" });
    assert.match(out, /high/);
  });
  test("ui-review.md loads with target + reviewId", () => {
    const out = loadPrompt("ui-review", { target: "t", reviewId: "002" });
    assert.match(out, /002/);
  });
  test("secure-phase.md loads with target", () => {
    const out = loadPrompt("secure-phase", { target: "active slice" });
    assert.match(out, /threat/i);
  });
  test("validate-phase.md loads with target", () => {
    const out = loadPrompt("validate-phase", { target: "active slice" });
    assert.match(out, /validation/i);
  });
  test("verify-work.md loads with target", () => {
    const out = loadPrompt("verify-work", { target: "active slice" });
    assert.match(out, /UAT/i);
  });
  test("plan-review-convergence.md loads with all vars", () => {
    const out = loadPrompt("plan-review-convergence", { target: "plan", reviewers: "claude", maxCycles: "3" });
    assert.match(out, /3/);
  });
});

describe("Batch 3 handlers dispatch", () => {
  test("handleCodeReview depth flag parsed", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleCodeReview("--depth deep --files a.ts", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "reviews")), true);
    });
    assert.equal(pi.sent[0].customType, "gsd-code-review");
    assert.match(pi.sent[0].content, /deep/);
    assert.match(pi.sent[0].content, /a\.ts/);
  });
  test("handleCodeReview fix flag on", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleCodeReview("--fix", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "reviews")), true);
    });
    assert.match(pi.sent[0].content, /Fix mode[\s\S]*ON/);
  });
  test("handleReview milestone + reviewers", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleReview("--milestone M014 --claude --codex", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /M014/);
    assert.match(pi.sent[0].content, /claude, codex/);
  });
  test("handleAuditMilestone passes id", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleAuditMilestone("M014", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /M014/);
  });
  test("handleAuditUat verify flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleAuditUat("--verify", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /Verify mode[\s\S]*ON/);
  });
  test("handleAuditFix severity + max + dry-run", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleAuditFix("--severity high --max 3 --dry-run", ctx as any, pi as any);
    const c = pi.sent[0].content;
    assert.match(c, /Severity filter[\s\S]*high/);
    assert.match(c, /Max fixes[\s\S]*3/);
    assert.match(c, /Dry run[\s\S]*ON/);
  });
  test("handleUiReview target + reviewId", async () => {
    const pi = createMockPi();
    await withTempCommandCwd(async (ctx, base) => {
      await handleUiReview("dashboard", ctx as any, pi as any);
      assert.equal(existsSync(join(base, ".gsd", "reviews")), true);
    });
    assert.match(pi.sent[0].content, /dashboard/);
  });
  test("handleSecurePhase default target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleSecurePhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-secure-phase");
  });
  test("handleValidatePhase default target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleValidatePhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-validate-phase");
  });
  test("handleVerifyWork default target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleVerifyWork("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-verify-work");
  });
  test("handlePlanReviewConvergence max-cycles", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePlanReviewConvergence("--max-cycles 5 --all", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /5/);
    assert.match(pi.sent[0].content, /all/);
  });
});

// ─── Batch 4: workflow phases ───────────────────────────────────────────────

describe("parseAutonomousScope", () => {
  test("default scope", () => {
    assert.match(parseAutonomousScope(""), /All remaining work on the active milestone/);
  });
  test("only scope", () => {
    assert.equal(parseAutonomousScope("--only 3"), "Only slice/milestone 3");
  });
  test("from/to scope", () => {
    assert.match(parseAutonomousScope("--from 1 --to 4"), /from 1/);
    assert.match(parseAutonomousScope("--from 1 --to 4"), /to 4/);
  });
});

describe("Batch 4 handlers dispatch", () => {
  test("handleDiscussPhase milestone + auto", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleDiscussPhase("--milestone M014 --auto", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /M014/);
    assert.match(pi.sent[0].content, /`--auto` — ON/);
  });
  test("handlePlanPhase research flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePlanPhase("--research --tdd", ctx as any, pi as any);
    // The research flag line renders the value (research), not the placeholder name.
    assert.match(pi.sent[0].content, /--research` \/ `--skip-research` — research/);
    assert.match(pi.sent[0].content, /gsd_summary_save/);
    assert.match(pi.sent[0].content, /artifact_type: "RESEARCH"/);
    assert.match(pi.sent[0].content, /`--tdd` — ON/);
  });
  test("handlePlanPhase skip-research flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePlanPhase("--skip-research", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /skip-research/);
  });
  test("handleExecutePhase wave + gaps-only", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleExecutePhase("--wave 4 --gaps-only", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /4/);
    assert.match(pi.sent[0].content, /`--gaps-only` — ON/);
  });
  test("handleSpecPhase default target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleSpecPhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-spec-phase");
  });
  test("handleMvpPhase target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleMvpPhase("--milestone M002", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /M002/);
  });
  test("handleUiPhase default", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleUiPhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-ui-phase");
    assert.match(pi.sent[0].content, /gsd_summary_save/);
    assert.match(pi.sent[0].content, /artifact_type: "UI-SPEC"/);
  });
  test("handleAiIntegrationPhase default", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleAiIntegrationPhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-ai-integration-phase");
  });
  test("handleUltraplanPhase default", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleUltraplanPhase("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-ultraplan-phase");
  });
  test("handleAutonomous converge flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleAutonomous("--converge", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /`--converge` — ON/);
  });
  test("handlePauseWork report flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePauseWork("--report", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /`--report` — ON/);
  });
  test("handleResumeWork dispatches", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleResumeWork("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-resume-work");
  });
});

// ─── Batch 5: project management ────────────────────────────────────────────

describe("parseInboxFocus", () => {
  test("default both", () => {
    assert.match(parseInboxFocus(""), /issues and PRs \(default\)/);
  });
  test("issues only", () => {
    assert.equal(parseInboxFocus("--issues"), "issues only");
  });
  test("prs only", () => {
    assert.equal(parseInboxFocus("--prs"), "PRs only");
  });
  test("both explicit", () => {
    assert.equal(parseInboxFocus("--issues --prs"), "issues and PRs");
  });
});

describe("Batch 5 handlers dispatch", () => {
  test("handleManager analyze-deps", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleManager("--analyze-deps", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /`--analyze-deps` — ON/);
  });
  test("handleManager dispatches without ctx.cwd (no early exit)", async () => {
    // Regression: resolveManagerVars previously returned early when ctx.cwd was absent,
    // skipping the blocker check entirely. Verify the manager still dispatches normally
    // when ctx.cwd is undefined (no blockers active → normal prompt).
    const pi = createMockPi();
    const ctx = { ...createMockCtx(), cwd: undefined };
    await handleManager("", ctx as any, pi as any);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-manager");
  });
  test("handlePhase keeps conversational edits prompt-driven", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePhase("edit M001", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-phase");
    assert.match(pi.sent[0].content, /edit M001/);
  });
  test("handlePhase keeps remove prompt-driven for confirmation", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePhase("remove M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-phase");
    assert.match(pi.sent[0].content, /remove M001/);
  });
  test("handlePhase keeps insert prompt-driven for queue positioning", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePhase("insert M002 after M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-phase");
    assert.match(pi.sent[0].content, /insert M002 after M001/);
  });
  test("handlePhase keeps targeted add prompt-driven", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handlePhase("add M002 after M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-phase");
    assert.match(pi.sent[0].content, /add M002 after M001/);
  });
  test("handleThread close", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleThread("close auth-thread", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /close auth-thread/);
  });
  test("handleWorkstreams keeps unknown actions prompt-driven", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleWorkstreams("inspect M001", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-workstreams");
  });
  test("dispatcher routes workstreams status through parallel status", async () => {
    const base = createTempGsdProject("gsd-workstreams-route-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("workstreams status", ctx as any, pi as any);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].customType, "gsd-parallel");
    assert.match(pi.sent[0].content, /No parallel orchestration/);
  });
  test("dispatcher rejects targeted workstreams create", async () => {
    const base = createTempGsdProject("gsd-workstreams-target-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("workstreams create M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /workstreams create does not accept a milestone target/);
    assert.match(ctx.notifications[0].message, /\/gsd parallel start/);
  });
  test("dispatcher rejects targeted workstreams progress", async () => {
    const base = createTempGsdProject("gsd-workstreams-progress-target-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("workstreams progress M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /workstreams progress does not accept a milestone target/);
    assert.match(ctx.notifications[0].message, /\/gsd parallel status/);
  });
  test("dispatcher rejects targeted workstreams switch", async () => {
    const base = createTempGsdProject("gsd-workstreams-switch-target-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("workstreams switch M001", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /workstreams switch does not accept a milestone target/);
    assert.match(ctx.notifications[0].message, /\/gsd parallel watch/);
  });
  test("handleWorkspace rejects unsupported new action", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleWorkspace("--new experiment", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /Unsupported workspace action/);
  });
  test("dispatcher routes workspace list through worktree list", async () => {
    const base = createTempGsdProject("gsd-workspace-route-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("workspace --list", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /No worktrees/);
  });
  test("dispatcher routes phase list through queue status", async () => {
    const base = createTempGsdProject("gsd-phase-route-");
    const pi = createMockPi(); const ctx = createMockCtxWithCwd(base);
    await handleGSDCommand("phase list", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /No milestones exist/);
  });
  test("handleMilestoneSummary target", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleMilestoneSummary("M014", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /M014/);
  });
  test("handleReviewBacklog dispatches", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleReviewBacklog("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-review-backlog");
  });
  test("handleInbox repo + focus", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleInbox("--issues --repo open-gsd/other", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /issues only/);
    assert.match(pi.sent[0].content, /open-gsd\/other/);
  });
  test("handleInbox passes label filter into the prompt", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleInbox("--label customer-bug", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /customer-bug/);
  });
  test("handleInbox passes quoted multi-word label filter into the prompt", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleInbox('--label "help wanted" --close-incomplete', ctx as any, pi as any);
    assert.match(pi.sent[0].content, /help wanted/);
    assert.doesNotMatch(pi.sent[0].content, /"help/);
  });
  test("handleInbox warns when label value is missing before another flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleInbox("--label --close-incomplete", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /--label requires a value/);
  });
  test("handleInbox warns when repo value is missing before another flag", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleInbox("--repo --close-incomplete", ctx as any, pi as any);
    assert.equal(pi.sent.length, 0);
    assert.equal(ctx.notifications[0].level, "warning");
    assert.match(ctx.notifications[0].message, /--repo requires a value/);
  });
  test("handleImport from file", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleImport("--from plan.md", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /plan\.md/);
  });
  test("handleImport from-gsd2", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleImport("--from-gsd2", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /\.planning/);
  });
  test("handleImport --resolve auto is threaded into prompt", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleImport("--from plan.md --resolve auto", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /auto/);
  });
  test("handleImport defaults to interactive resolve mode", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleImport("--from plan.md", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /interactive/);
  });
  test("handleIngestDocs mode + manifest", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleIngestDocs("docs/ --mode merge --manifest docs/m.json", ctx as any, pi as any);
    const c = pi.sent[0].content;
    assert.match(c, /merge/);
    assert.match(c, /m\.json/);
  });
  test("handleProfileUser questionnaire", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleProfileUser("--questionnaire", ctx as any, pi as any);
    assert.match(pi.sent[0].content, /`--questionnaire` — ON/);
  });
  test("handleSettings dispatches", async () => {
    const pi = createMockPi(); const ctx = createMockCtx();
    await handleSettings("", ctx as any, pi as any);
    assert.equal(pi.sent[0].customType, "gsd-settings");
  });
});
