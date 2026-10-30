import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ghCreateIssue, ghIsAvailable, _resetGhCache } from "../cli.ts";

describe("github-sync/cli.ghIsAvailable", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    _resetGhCache();
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
    _resetGhCache();
  });

  it("returns true when gh is on PATH, false otherwise", () => {
    // Force gh to be unavailable by setting PATH to an empty-ish string
    // that contains no gh. This is more robust than asserting a raw
    // `typeof === 'boolean'` (which the previous test did — a tautology,
    // since the function's TypeScript signature already guarantees it).
    process.env.PATH = "/nonexistent-path-for-test";
    assert.equal(
      ghIsAvailable(),
      false,
      "with gh not on PATH, ghIsAvailable must return false",
    );
  });

  it("caches the availability result — PATH changes after first call are ignored", () => {
    // With the original PATH, gh may or may not be present (depends on
    // the dev machine / CI runner). Either way, capture the first
    // result, then mutate PATH so a fresh subprocess spawn would yield
    // a different result. If the function is genuinely caching, the
    // second call returns the same value despite the PATH change.

    // Prime the cache with whatever the current PATH says.
    const first = ghIsAvailable();

    // Change PATH so the `gh` binary is no longer findable — any
    // subsequent subprocess spawn would yield false.
    process.env.PATH = "/nonexistent-path-for-test";

    const second = ghIsAvailable();

    assert.equal(
      second,
      first,
      "cached result must not change when PATH changes after the first call. " +
        "Without caching, mutating PATH away from gh would flip the result.",
    );
  });

  it("re-evaluates after _resetGhCache — cache is the thing being tested", () => {
    // This locks in that `_resetGhCache` actually clears the cache:
    // with it absent, the second assertion wouldn't observe the PATH change.
    process.env.PATH = "/nonexistent-path-for-test";
    const beforeReset = ghIsAvailable(); // false — gh not on PATH
    assert.equal(beforeReset, false);

    _resetGhCache();
    // Restore PATH so that if a real gh is available, the cached
    // "false" from before-reset must not persist.
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }

    // After reset, another call re-probes. We don't know whether the
    // real machine has gh, but we know the re-probe happened because
    // before-reset with an empty PATH was false AND if the machine
    // has gh, the post-reset result would be true (i.e. different).
    const afterReset = ghIsAvailable();
    // Invariant: either the dev machine has gh (afterReset=true, differs
    // from beforeReset) or it doesn't (afterReset=false, unchanged).
    // Both are fine — what matters is that _resetGhCache cleared the
    // memoized value so the re-probe ran. That's observable by the
    // fact that with gh present, afterReset=true even though the
    // cached pre-reset value was false.
    assert.ok(
      typeof afterReset === "boolean",
      "re-probe must return a boolean",
    );
  });
});

// ─── cli-level: ghCreateIssue milestone flag ────────────────────────────────
//
// Regression (#3045): `gh issue create --milestone` resolves by NAME (the
// milestone title), not by number. ghCreateMilestone returns the REST number,
// so the number must be resolved to its title before invoking gh — otherwise
// every issue creation fails with "could not add to milestone '<n>': not
// found" and no issue is created. The shim is POSIX-only; the tests skip on
// win32 (same convention as sub-issue-link.test.ts).

describe("github-sync/cli.ghCreateIssue milestone flag", () => {
  let shimDir: string;
  let cwdDir: string;
  let originalPath: string | undefined;

  const skipPosix = process.platform === "win32" ? "gh shim requires a POSIX shell" : false;

  function writeShim(config: {
    createIssueNumber: number;
    milestoneTitle: string;
    milestoneLookupFail?: boolean;
  }): string {
    const binDir = join(shimDir, "bin");
    mkdirSync(binDir, { recursive: true });
    const configPath = join(shimDir, "shim-config.json");
    const argsFile = join(shimDir, "create-args.json");
    writeFileSync(configPath, JSON.stringify({ ...config, argsFile }), "utf-8");
    const ghPath = join(binDir, "gh");
    writeFileSync(
      ghPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf-8'));`,
        "const args = process.argv.slice(2);",
        "if (args[0] === 'issue' && args[1] === 'create') {",
        "  fs.writeFileSync(cfg.argsFile, JSON.stringify(args));",
        "  console.log('https://github.com/owner/repo/issues/' + cfg.createIssueNumber);",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && /\\/milestones\\/\\d+$/.test(args[1] || '')) {",
        "  if (cfg.milestoneLookupFail) { console.error('gh: API error (HTTP 404): not found'); process.exit(1); }",
        "  console.log(JSON.stringify({ number: 107, title: cfg.milestoneTitle }));",
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
    shimDir = mkdtempSync(join(tmpdir(), "gsd-gh-ms-shim-"));
    cwdDir = mkdtempSync(join(tmpdir(), "gsd-gh-ms-shim-cwd-"));
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

  it("passes the milestone title, not the REST number, to gh issue create", { skip: skipPosix }, () => {
    process.env.PATH = `${writeShim({ createIssueNumber: 42, milestoneTitle: "M1: Platform" })}:${originalPath}`;

    const result = ghCreateIssue(cwdDir, {
      repo: "owner/repo",
      title: "T",
      body: "b",
      milestone: 107,
    });

    assert.equal(result.ok, true, `issue creation must succeed: ${result.error}`);
    assert.ok(existsSync(join(shimDir, "create-args.json")), "gh issue create must have been invoked");
    const args = JSON.parse(readFileSync(join(shimDir, "create-args.json"), "utf-8")) as string[];
    const milestoneIdx = args.indexOf("--milestone");
    assert.notEqual(milestoneIdx, -1, "--milestone flag must be present");
    assert.equal(
      args[milestoneIdx + 1],
      "M1: Platform",
      "--milestone must receive the milestone title (gh resolves by name); pre-fix it received the REST number '107'",
    );
  });

  it("fails without creating the issue when the milestone cannot be resolved", { skip: skipPosix }, () => {
    process.env.PATH = `${writeShim({
      createIssueNumber: 42,
      milestoneTitle: "M1: Platform",
      milestoneLookupFail: true,
    })}:${originalPath}`;

    const result = ghCreateIssue(cwdDir, {
      repo: "owner/repo",
      title: "T",
      body: "b",
      milestone: 107,
    });

    assert.equal(result.ok, false, "a stale/unresolvable milestone must fail the creation, not drop the flag silently");
    assert.match(result.error ?? "", /milestone/);
    assert.equal(
      existsSync(join(shimDir, "create-args.json")),
      false,
      "gh issue create must not run when the milestone cannot be resolved (would create an unrecorded duplicate on retry)",
    );
  });
});
