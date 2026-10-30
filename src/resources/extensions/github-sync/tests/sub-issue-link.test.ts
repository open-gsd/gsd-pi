import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runGitHubSync,
  bootstrapSync,
  _resetConfigCache,
  _setGhCreateOverridesForTest,
} from "../sync.ts";
import {
  ghCreateIssue,
  _resetGhCache,
  _setGhAvailableForTest,
  _setGhRateLimitOkForTest,
} from "../cli.ts";
import {
  createEmptyMapping,
  loadSyncMapping,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord,
} from "../mapping.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../../gsd/gsd-db.ts";

const TS = "2025-01-01T00:00:00Z";

function seedDb(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "M001: Platform", status: "active" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Foundation", status: "pending", sequence: 1 });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Render data",
    sequence: 1,
    planning: { description: "Render the rows" },
  });
}

function seedPreferences(base: string): void {
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "version: 1", "github:", "  enabled: true", "  repo: owner/repo", "---"].join("\n"),
    "utf-8",
  );
}

function writeMapping(base: string, mutate: (mapping: ReturnType<typeof createEmptyMapping>) => void): void {
  const mapping = createEmptyMapping("owner/repo");
  mutate(mapping);
  writeFileSync(join(base, ".gsd", "github-sync.json"), JSON.stringify(mapping), "utf-8");
}

function openMilestoneMapping(base: string): void {
  writeMapping(base, (mapping) => {
    setMilestoneRecord(mapping, "M001", {
      issueNumber: 10,
      ghMilestoneNumber: 3,
      lastSyncedAt: TS,
      state: "open",
    });
  });
}

describe("task sub-issue link handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-gh-subissue-"));
    seedDb(tmpDir);
    seedPreferences(tmpDir);
    _resetGhCache();
    _resetConfigCache();
    _setGhAvailableForTest(true);
    _setGhRateLimitOkForTest(true);
    _setGhCreateOverridesForTest(null);
  });

  afterEach(() => {
    _setGhCreateOverridesForTest(null);
    _setGhAvailableForTest(null);
    _setGhRateLimitOkForTest(null);
    _resetGhCache();
    _resetConfigCache();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("successful attachment records the issue without a link error", async () => {
    openMilestoneMapping(tmpDir);
    const createOpts: Array<{ parentIssue?: number }> = [];
    _setGhCreateOverridesForTest({
      createIssue: (_cwd, opts) => {
        createOpts.push(opts);
        return { ok: true, data: 42 };
      },
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(createOpts.length, 1);
    assert.equal(createOpts[0]!.parentIssue, 10, "task creation must request the milestone tracking issue as parent");
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.issueNumber, 42);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
  });

  it("failed attachment is persisted on the mapping instead of being dropped", async () => {
    openMilestoneMapping(tmpDir);
    let createCalls = 0;
    _setGhCreateOverridesForTest({
      createIssue: () => {
        createCalls++;
        return {
          ok: true,
          data: 42,
          attachmentError: "issue created, but native sub-issue link to #10 failed: HTTP 403: insufficient permissions",
        };
      },
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    const loaded = loadSyncMapping(tmpDir);
    assert.equal(createCalls, 1);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.issueNumber, 42);
    assert.match(loaded?.tasks["M001/S01/T01"]?.lastSyncError ?? "", /HTTP 403/);
  });

  it("a later sync retries the link without re-creating the issue", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 77,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let createCalls = 0;
    const linkCalls: Array<[number, number]> = [];
    _setGhCreateOverridesForTest({
      createIssue: () => {
        createCalls++;
        return { ok: true, data: 42 };
      },
      addSubIssue: (_cwd, _repo, parent, child) => {
        linkCalls.push([parent, child]);
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: null }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(createCalls, 0, "retry must not duplicate the already-created issue");
    assert.deepEqual(linkCalls, [[10, 42]]);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.issueNumber, 42, "mapping must be preserved");
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
    // Reconciliation must not clobber the existing slice record.
    assert.equal(loaded?.slices["M001/S01"]?.prNumber, 77);
    assert.equal(loaded?.slices["M001/S01"]?.branch, "milestone/M001/S01");
  });

  it("reconciliation is idempotent once the link is recorded as fixed", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
      });
    });
    let createCalls = 0;
    let parentCalls = 0;
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      createIssue: () => {
        createCalls++;
        return { ok: true, data: 42 };
      },
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => {
        parentCalls++;
        return { ok: true, data: { number: 10, repo: "owner/repo" } };
      },
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(createCalls, 0);
    assert.equal(parentCalls, 0, "no repair probes without a pending link error");
    assert.equal(linkCalls, 0);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
  });

  it("an already-correct parent clears the pending error without re-linking", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: connection reset",
      });
    });
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: { number: 10, repo: "owner/repo" } }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(linkCalls, 0, "already-linked children must not be re-linked");
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
  });

  it("a conflicting parent is reported and never silently reparented", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: { number: 99, repo: "owner/repo" } }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(linkCalls, 0, "a conflicting parent must not be reparented silently");
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.issueNumber, 42);
    const error = loaded?.tasks["M001/S01/T01"]?.lastSyncError ?? "";
    assert.match(error, /#99/);
    assert.match(error, /#10/);
    assert.match(error, /reparent/);
  });

  it("a failed parent lookup keeps the pending error for a later sync", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => ({ ok: false, error: "HTTP 502: Bad Gateway" }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(linkCalls, 0, "must not link blindly when the parent lookup fails");
    const loaded = loadSyncMapping(tmpDir);
    assert.match(loaded?.tasks["M001/S01/T01"]?.lastSyncError ?? "", /HTTP 403|HTTP 502/);
  });

  it("an execute-task event reconciles a pending link for that task", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    const linkCalls: Array<[number, number]> = [];
    _setGhCreateOverridesForTest({
      addSubIssue: (_cwd, _repo, parent, child) => {
        linkCalls.push([parent, child]);
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: null }),
    });

    await runGitHubSync(tmpDir, "execute-task", "M001/S01/T01");

    assert.deepEqual(linkCalls, [[10, 42]]);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
  });

  it("a same-numbered parent in another repository is a conflict, not a confirmed link", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: { number: 10, repo: "other/repo" } }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    assert.equal(linkCalls, 0);
    const loaded = loadSyncMapping(tmpDir);
    const error = loaded?.tasks["M001/S01/T01"]?.lastSyncError ?? "";
    assert.match(error, /other\/repo#10/);
    assert.match(error, /owner\/repo#10/);
    assert.match(error, /reparent/);
  });

  it("a closed task record with a pending link is still reconciled", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "closed",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let linkCalls = 0;
    _setGhCreateOverridesForTest({
      addSubIssue: () => {
        linkCalls++;
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: null }),
    });

    await runGitHubSync(tmpDir, "execute-task", "M001/S01/T01");

    assert.equal(linkCalls, 1);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.state, "closed", "repair must not reopen the record");
  });

  it("a failed retry updates the pending error instead of clearing it", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    _setGhCreateOverridesForTest({
      addSubIssue: () => ({ ok: false, error: "HTTP 422: validation failed" }),
      getParentIssue: () => ({ ok: true, data: null }),
    });

    await runGitHubSync(tmpDir, "plan-slice", "M001/S01");

    const loaded = loadSyncMapping(tmpDir);
    assert.match(loaded?.tasks["M001/S01/T01"]?.lastSyncError ?? "", /HTTP 422/);
  });

  it("bootstrap reconciles pending links for already-synced slices", async () => {
    writeMapping(tmpDir, (mapping) => {
      setMilestoneRecord(mapping, "M001", {
        issueNumber: 10,
        ghMilestoneNumber: 3,
        lastSyncedAt: TS,
        state: "open",
      });
      setSliceRecord(mapping, "M001", "S01", {
        issueNumber: 0,
        prNumber: 0,
        branch: "milestone/M001/S01",
        lastSyncedAt: TS,
        state: "open",
      });
      setTaskRecord(mapping, "M001", "S01", "T01", {
        issueNumber: 42,
        lastSyncedAt: TS,
        state: "open",
        lastSyncError: "issue created, but native sub-issue link to #10 failed: HTTP 403",
      });
    });
    let createCalls = 0;
    const linkCalls: Array<[number, number]> = [];
    _setGhCreateOverridesForTest({
      createIssue: () => {
        createCalls++;
        return { ok: true, data: 42 };
      },
      addSubIssue: (_cwd, _repo, parent, child) => {
        linkCalls.push([parent, child]);
        return { ok: true };
      },
      getParentIssue: () => ({ ok: true, data: null }),
    });

    const counts = await bootstrapSync(tmpDir);

    assert.equal(createCalls, 0, "bootstrap must not re-create mapped issues");
    assert.deepEqual(linkCalls, [[10, 42]]);
    assert.equal(counts.tasks, 0);
    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.tasks["M001/S01/T01"]?.lastSyncError, undefined);
  });
});

// ─── bootstrap creation failures ────────────────────────────────────────────
//
// Regression (#3045): a failing `gh issue create` was silently dropped, the
// slice was still marked synced with a zero-record (issueNumber 0), and
// bootstrap counters were incremented regardless of outcome — reporting
// fictional creations while the mapping was permanently poisoned.

describe("bootstrap creation failures", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-gh-bootstrap-fail-"));
    seedDb(tmpDir);
    seedPreferences(tmpDir);
    _resetGhCache();
    _resetConfigCache();
    _setGhAvailableForTest(true);
    _setGhRateLimitOkForTest(true);
    _setGhCreateOverridesForTest(null);
  });

  afterEach(() => {
    _setGhCreateOverridesForTest(null);
    _setGhAvailableForTest(null);
    _setGhRateLimitOkForTest(null);
    _resetGhCache();
    _resetConfigCache();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a failing task issue creation writes no slice/task records and is reported", async () => {
    openMilestoneMapping(tmpDir);
    _setGhCreateOverridesForTest({
      createIssue: () => ({ ok: false, error: "could not add to milestone '107': '107' not found" }),
    });

    const counts = await bootstrapSync(tmpDir);

    assert.equal(counts.milestones, 0, "the already-synced milestone must not be counted as created");
    assert.equal(counts.slices, 0, "a slice whose task creation failed must not be counted as created");
    assert.equal(counts.tasks, 0, "a failed task creation must not be counted");
    const errors = (counts as { errors?: string[] }).errors ?? [];
    assert.equal(errors.length, 1, "the failure must be reported, not dropped");
    assert.match(errors[0] ?? "", /T01/);
    assert.match(errors[0] ?? "", /could not add to milestone/);

    const loaded = loadSyncMapping(tmpDir);
    assert.equal(
      loaded?.slices["M001/S01"],
      undefined,
      "a failed slice creation must not poison the mapping with a zero-record",
    );
    assert.equal(loaded?.tasks["M001/S01/T01"], undefined, "a failed task creation must not be recorded");
    assert.ok(loaded?.milestones.M001, "the pre-existing milestone record must be untouched");
  });

  it("a failing tracking issue creation records nothing and aggregates the error", async () => {
    // No mapping file at all — bootstrap starts from scratch.
    _setGhCreateOverridesForTest({
      createMilestone: () => ({ ok: true, data: 107 }),
      createIssue: () => ({ ok: false, error: "could not add to milestone '107': '107' not found" }),
    });

    const counts = await bootstrapSync(tmpDir);

    assert.equal(counts.milestones, 0, "a milestone whose tracking issue failed must not be counted as created");
    assert.equal(counts.slices, 0, "slices under a failed milestone must not be counted as created");
    assert.equal(counts.tasks, 0);
    const errors = (counts as { errors?: string[] }).errors ?? [];
    assert.ok(errors.length > 0, "failures must be aggregated and reported");
    assert.equal(errors.some((e) => /could not add to milestone/.test(e)), true);

    const loaded = loadSyncMapping(tmpDir);
    assert.deepEqual(loaded?.milestones, {}, "no milestone record for a failed tracking issue");
    assert.deepEqual(loaded?.slices, {}, "no slice zero-record under a failed milestone");
    assert.deepEqual(loaded?.tasks, {}, "no task records under a failed milestone");
  });

  it("successful creations are counted and recorded", async () => {
    _setGhCreateOverridesForTest({
      createMilestone: () => ({ ok: true, data: 107 }),
      createIssue: (() => {
        let n = 54;
        return () => ({ ok: true, data: ++n });
      })(),
    });

    const counts = await bootstrapSync(tmpDir);

    assert.equal(counts.milestones, 1);
    assert.equal(counts.slices, 1);
    assert.equal(counts.tasks, 1);
    assert.deepEqual((counts as { errors?: string[] }).errors ?? [], []);

    const loaded = loadSyncMapping(tmpDir);
    assert.equal(loaded?.milestones.M001?.ghMilestoneNumber, 107);
    assert.equal(loaded?.milestones.M001?.issueNumber, 55);
    assert.ok(loaded?.slices["M001/S01"], "a successful slice creation must be recorded");
    assert.equal(loaded?.tasks["M001/S01/T01"]?.issueNumber, 56);
  });
});

// ─── cli-level: ghCreateIssue attachment capture ────────────────────────────
//
// The silent drop lived in cli.ts (the ghAddSubIssue result was discarded),
// so these tests exercise the real ghCreateIssue with a scripted `gh` on
// PATH. The shim is POSIX-only; the suite that includes it runs on macOS
// and Linux (CI's unit job is ubuntu-only), and the tests skip on win32.

describe("github-sync/cli.ghCreateIssue sub-issue attachment", () => {
  let shimDir: string;
  let cwdDir: string;
  let originalPath: string | undefined;

  const skipPosix = process.platform === "win32" ? "gh shim requires a POSIX shell" : false;

  function writeShim(config: {
    createIssueNumber: number;
    nodeIdFail?: boolean;
    mutationError?: string;
  }): string {
    const binDir = join(shimDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const configPath = join(shimDir, "shim-config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const ghPath = join(binDir, "gh");
    writeFileSync(
      ghPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf-8'));`,
        "const args = process.argv.slice(2);",
        "if (args[0] === 'issue' && args[1] === 'create') {",
        "  console.log('https://github.com/owner/repo/issues/' + cfg.createIssueNumber);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && /\\/issues\\/\\d+$/.test(args[1] || '')) {",
        "  if (cfg.nodeIdFail) { console.error('gh: API error (HTTP 500)'); process.exit(1); }",
        "  console.log(JSON.stringify({ id: 'node_' + args[1].split('/').pop() }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && args[1] === 'graphql') {",
        "  if (cfg.mutationError) { console.error(cfg.mutationError); process.exit(1); }",
        "  console.log('{}');",
        "  process.exit(0);",
        "}",
        "console.error('gh shim: unexpected args ' + JSON.stringify(args));",
        "process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return binDir;
  }

  beforeEach(() => {
    shimDir = mkdtempSync(join(tmpdir(), "gsd-gh-shim-"));
    cwdDir = mkdtempSync(join(tmpdir(), "gsd-gh-shim-cwd-"));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  });

  it("reports attachment success when the sub-issue link mutation succeeds", { skip: skipPosix }, () => {
    process.env.PATH = `${writeShim({ createIssueNumber: 42 })}:${originalPath}`;

    const result = ghCreateIssue(cwdDir, {
      repo: "owner/repo",
      title: "M001/S01/T01: Render data",
      body: "body",
      parentIssue: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.data, 42);
    assert.equal(result.attachmentError, undefined);
  });

  it("reports a failed attachment separately instead of dropping it (simulated 403)", { skip: skipPosix }, () => {
    process.env.PATH = `${writeShim({
      createIssueNumber: 42,
      mutationError: "gh: HTTP 403: Must have triage permissions to add sub-issues (HTTP 403)",
    })}:${originalPath}`;

    const result = ghCreateIssue(cwdDir, {
      repo: "owner/repo",
      title: "M001/S01/T01: Render data",
      body: "body",
      parentIssue: 10,
    });

    // Creation still succeeded — the issue must not be reported as failed
    // (a naive failure return would invite a duplicate-creating retry).
    assert.equal(result.ok, true);
    assert.equal(result.data, 42);
    assert.match(result.attachmentError ?? "", /#10/);
    assert.match(result.attachmentError ?? "", /403/);
  });

  it("reports which node-ID lookup failed when resolution errors", { skip: skipPosix }, () => {
    process.env.PATH = `${writeShim({ createIssueNumber: 42, nodeIdFail: true })}:${originalPath}`;

    const result = ghCreateIssue(cwdDir, {
      repo: "owner/repo",
      title: "M001/S01/T01: Render data",
      body: "body",
      parentIssue: 10,
    });

    assert.equal(result.ok, true);
    assert.equal(result.data, 42);
    assert.match(result.attachmentError ?? "", /parent #10/);
    assert.match(result.attachmentError ?? "", /node IDs/);
  });
});
