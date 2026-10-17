// Project/App: gsd-pi
// File Purpose: runPreMergeCheck package-manager selection tests (#2870).
//
// GIT_NO_PROMPT_ENV snapshots process.env (including PATH) when git-service
// is first evaluated, so the controlled manager executables must be put on
// PATH BEFORE this file imports git-service. POSIX-sh fakes; this suite only
// runs in the Linux CI lane (test:integration).
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";

// ─── Controlled manager executables (installed before importing git-service) ──

const fixtureRoot = mkdtempSync(join(tmpdir(), "gsd-premerge-pm-"));
const binDir = join(fixtureRoot, "bin");
const recordFile = join(fixtureRoot, "invocations.log");
mkdirSync(binDir);

// Each fake manager appends a record line "<name> <arg1><arg2>..." to the
// record file and exits 0. Angle brackets preserve argv boundaries so the
// assertions verify the exact arguments, not just their concatenation.
const MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
for (const name of MANAGERS) {
  const script = [
    "#!/bin/sh",
    'record=""',
    "for arg do",
    'record="$record<$arg>"',
    "done",
    `printf '%s\\n' "${name} $record" >> '${recordFile}'`,
    "exit 0",
    "",
  ].join("\n");
  const path = join(binDir, name);
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
}
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

const { GitServiceImpl } = await import("../../git-service.ts");
type GitServiceImplType = InstanceType<typeof GitServiceImpl>;

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// ─── Repo fixture helper ──────────────────────────────────────────────────────

function initPreMergeRepo(opts: { lockfile?: string; packageManager?: string }): string {
  const repo = mkdtempSync(join(tmpdir(), "gsd-premerge-repo-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Pi Test"]);
  run(["config", "user.email", "pi@example.com"]);

  const pkg: Record<string, unknown> = {
    name: "premerge-pm-fixture",
    scripts: { test: "exit 0" },
  };
  if (opts.packageManager) pkg.packageManager = opts.packageManager;
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg, null, 2));
  if (opts.lockfile) writeFileSync(join(repo, opts.lockfile), "fixture\n");

  run(["add", "-A"]);
  run(["commit", "-m", "init", "--no-verify"]);
  return repo;
}

function clearRecord(): void {
  writeFileSync(recordFile, "");
}

function recordedInvocations(): string[] {
  return readFileSync(recordFile, "utf-8").split("\n").filter(Boolean);
}

// ─── Automatic selection follows the project's package manager ───────────────

describe("runPreMergeCheck: package-manager-aware auto-detection (#2870)", () => {
  const cases: { label: string; lockfile?: string; packageManager?: string; expected: string; argvRecord: string }[] = [
    { label: "pnpm project (pnpm-lock.yaml)", lockfile: "pnpm-lock.yaml", expected: "pnpm test", argvRecord: "pnpm <test>" },
    { label: "yarn project (yarn.lock)", lockfile: "yarn.lock", expected: "yarn test", argvRecord: "yarn <test>" },
    { label: "bun project (bun.lockb)", lockfile: "bun.lockb", expected: "bun run test", argvRecord: "bun <run><test>" },
    { label: "npm project (package-lock.json)", lockfile: "package-lock.json", expected: "npm test", argvRecord: "npm <test>" },
    {
      label: "pnpm via packageManager field (no lockfile)",
      packageManager: "pnpm@9.12.2",
      expected: "pnpm test",
      argvRecord: "pnpm <test>",
    },
  ];

  for (const c of cases) {
    test(`auto-detect selects \`${c.expected}\` for ${c.label}`, (t) => {
      const repo = initPreMergeRepo({ lockfile: c.lockfile, packageManager: c.packageManager });
      t.after(() => rmSync(repo, { recursive: true, force: true }));
      clearRecord();
      const svc: GitServiceImplType = new GitServiceImpl(repo, { pre_merge_check: true });
      const result = svc.runPreMergeCheck();

      assert.equal(result.passed, true, "fake manager exits 0, so the check passes");
      assert.ok(!result.skipped, "check is not skipped when scripts.test exists");
      assert.equal(result.command, c.expected, "selected command matches the detected manager");

      assert.deepEqual(recordedInvocations(), [c.argvRecord], "fake manager invoked with expected argv");
    });
  }

  test("explicit custom command wins over detected manager", (t) => {
    const repo = initPreMergeRepo({ lockfile: "pnpm-lock.yaml" });
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    clearRecord();
    const custom = "echo custom-ran";
    const svc: GitServiceImplType = new GitServiceImpl(repo, { pre_merge_check: custom });
    const result = svc.runPreMergeCheck();

    assert.equal(result.passed, true);
    assert.ok(!result.skipped);
    assert.equal(result.command, custom, "explicit command string is used verbatim");
    assert.deepEqual(recordedInvocations(), [], "no manager executable invoked for explicit command");
  });
});
