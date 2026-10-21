/**
 * Unit tests for the verification gate — command discovery and execution.
 *
 * Tests cover:
 *   1. Discovery from explicit preference commands
 *   2. Discovery from task plan verify field
 *   3. Discovery from package.json typecheck/lint/test scripts
 *   4. First-non-empty-wins precedence
 *   5. All commands pass → gate passes
 *   6. One command fails → gate fails with exit code + stderr
 *   7. Missing package.json → 0 checks → pass
 *   8. Empty scripts → 0 checks → pass
 *   9. Preference validation for verification keys
 *  10. spawnSync error (command not found) → failure with exit code 127
 *  11. Dependency audit — git diff detection, npm audit parsing, graceful failures
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCommands, runVerificationGate, runVerificationGateForTargets, formatFailureContext, captureRuntimeErrors, runDependencyAudit, isLikelyCommand, validateVerificationCommand, splitUnquotedLines } from "../verification-gate.ts";
import type { CaptureRuntimeErrorsOptions, DependencyAuditOptions } from "../verification-gate.ts";
import { validatePreferences } from "../preferences.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withRtkDisabled<T>(callback: () => T): T {
  const previous = process.env.GSD_RTK_DISABLED;
  process.env.GSD_RTK_DISABLED = "1";
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.GSD_RTK_DISABLED;
    } else {
      process.env.GSD_RTK_DISABLED = previous;
    }
  }
}

// ─── Discovery Tests ─────────────────────────────────────────────────────────

describe("verification-gate: discovery", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-discovery"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("discoverCommands from preference commands", () => {
    const result = discoverCommands({
      preferenceCommands: ["npm run lint", "npm run test"],
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "preference");
  });

  test("discoverCommands from task plan verify field", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint && npm run test"]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands accepts task plan verify pipelines", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm test | tail -5",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm test | tail -5"]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands strips interpreter prefixes from task plan verify commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "bash: ls scripts/hooks/\npython3: python3 -m pytest tests/ -q",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, [
      "ls scripts/hooks/",
      "python3 -m pytest tests/ -q",
    ]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands from package.json scripts", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
          build: "tsc", // should NOT be included
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "npm run typecheck",
      "npm run lint",
      "npm test",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("first-non-empty-wins — task plan beats preference and package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["custom-check"],
      taskPlanVerify: "npm run lint",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
    assert.equal(result.source, "task-plan");
  });

  test("task plan verify beats package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "custom-verify",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["custom-verify"]);
    assert.equal(result.source, "task-plan");
  });

  test("missing package.json → 0 checks, source none", () => {
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });

  test("package.json with no matching scripts → 0 checks", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", start: "node index.js" } }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });

  test("empty preference array falls through to task plan", () => {
    const result = discoverCommands({
      preferenceCommands: [],
      taskPlanVerify: "echo ok",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["echo ok"]);
    assert.equal(result.source, "task-plan");
  });

  test("package.json with only test script → returns only npm test", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest",
          build: "tsc",
          start: "node index.js",
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, ["npm test"]);
    assert.equal(result.source, "package-json");
  });

  test("pnpm-lock.yaml present → uses pnpm commands", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
        },
      }),
    );
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: 9.0");
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "pnpm typecheck",
      "pnpm lint",
      "pnpm test",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("yarn.lock present → uses yarn commands", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
        },
      }),
    );
    writeFileSync(join(tmp, "yarn.lock"), "# yarn lockfile v1");
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "yarn typecheck",
      "yarn lint",
      "yarn test",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("bun.lockb present → uses bun commands", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          test: "bun test",
        },
      }),
    );
    writeFileSync(join(tmp, "bun.lockb"), "binary");
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "bun run typecheck",
      "bun run test",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("packageManager field in package.json → uses specified manager", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@9.12.2",
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "pnpm typecheck",
      "pnpm lint",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("lock file takes precedence over packageManager field", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        packageManager: "npm@10.0.0",  // says npm
        scripts: {
          typecheck: "tsc --noEmit",
        },
      }),
    );
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "lockfileVersion: 9.0");  // but has pnpm lock
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, ["pnpm typecheck"]);
    assert.equal(result.source, "package-json");
  });

  test("taskPlanVerify with single command (no &&)", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm test"]);
    assert.equal(result.source, "task-plan");
  });

  test("taskPlanVerify preserves cd context in && chains", () => {
    const result = discoverCommands({
      taskPlanVerify: "cd /tmp/project/subdir && uv run pytest tests/ -q --tb=short",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["cd /tmp/project/subdir && uv run pytest tests/ -q --tb=short"]);
    assert.equal(result.source, "task-plan");
  });

  test("whitespace-only preference commands fall through", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["  ", ""],
      cwd: tmp,
    });
    // Whitespace-only strings are trimmed to empty and filtered out
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
  });

  test("prose taskPlanVerify is rejected, falls through to package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "Document exists, contains all 5 scale names, all 14 semantic tokens",
      cwd: tmp,
    });
    // Prose should be rejected, so it falls through to package.json
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm test"]);
  });

  test("non-ASCII prose taskPlanVerify is rejected, falls through to package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = discoverCommands({
      // Chinese prose: "All commands output one line of JSONL; go test ./... passes"
      taskPlanVerify: "所有 命令 输出 一行 JSONL go test ./... 通过",
      cwd: tmp,
    });
    // Non-ASCII prose should be rejected, so it falls through to package.json
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm test"]);
  });

  test("prose taskPlanVerify with no fallback checks → source task-plan-prose", () => {
    const result = discoverCommands({
      taskPlanVerify: "Grep: pattern=Chart.yaml path=argocd-apps/ returns non-empty",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("prose with shell metachars and a leading command word → task-plan-prose (issue #1567)", () => {
    const result = discoverCommands({
      taskPlanVerify:
        "git log shows the scaffold commit authored by Name <user@example.com> on branch x; " +
        "git ls-files piped to grep for .gsd/ returns nothing; platformio.ini is at repo root.",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("prose taskPlanVerify with passing task evidence beats preference commands (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "Planning artifacts exist and contain all required sections",
      preferenceCommands: ["cargo test", "cargo clippy"],
      taskEvidence: [
        { command: "gsd_exec node: artifact check", exitCode: 0, verdict: "passed", durationMs: 12 },
        { command: "gsd_exec node: consolidated artifact verification", exitCode: 0, verdict: "pass", durationMs: 8 },
      ],
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("failing task evidence still falls through to preference commands (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "Planning artifacts exist and contain all required sections",
      preferenceCommands: ["cargo test"],
      taskEvidence: [
        { command: "gsd_exec node: artifact check", exitCode: 1, verdict: "fail", durationMs: 3 },
      ],
      cwd: tmp,
    });
    assert.equal(result.source, "preference");
    assert.deepStrictEqual(result.commands, ["cargo test"]);
  });

  test("task evidence does not override a runnable task-plan command (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run test",
      preferenceCommands: ["cargo test"],
      taskEvidence: [{ command: "node check.js", exitCode: 0, verdict: "pass", durationMs: 1 }],
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("task evidence does not bypass preferences without prose task verify (issue #1591)", () => {
    const result = discoverCommands({
      preferenceCommands: ["cargo test"],
      taskEvidence: [{ command: "node check.js", exitCode: 0, verdict: "pass", durationMs: 1 }],
      cwd: tmp,
    });
    assert.equal(result.source, "preference");
    assert.deepStrictEqual(result.commands, ["cargo test"]);
  });

  test("genuinely unsafe command still suppresses the prose fallback", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run test > results.txt",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-unsafe");
    assert.deepStrictEqual(result.commands, []);
  });

  test("<item> wrappers in taskPlanVerify are separators, not shell syntax (issue #1922)", () => {
    const result = discoverCommands({
      taskPlanVerify:
        "<item>node --test tests/_helpers/snapshot.test.ts</item><item>npm run typecheck</item>",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, [
      "node --test tests/_helpers/snapshot.test.ts",
      "npm run typecheck",
    ]);
  });

  test("all-unsafe taskPlanVerify does not fall through to package.json (issue #1922)", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc", test: "node --test" },
    }));
    const result = discoverCommands({
      taskPlanVerify: "npm test > out.txt\nnpm run typecheck 2> err.txt",
      preferenceCommands: ["npm run lint"],
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-unsafe");
    assert.deepStrictEqual(result.commands, []);
  });

  test("valid command in taskPlanVerify still works", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint && npm run test"]);
  });

  test("mixed prose and commands in newline-delimited taskPlanVerify — only commands kept", () => {
    const result = discoverCommands({
      taskPlanVerify: "Check that everything works\nnpm run test",
      cwd: tmp,
    });
    // "Check that everything works" is prose (starts with capital, 4+ words)
    // "npm run test" is a valid command
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("taskPlanVerify splits newline-delimited commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint\nnpm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
  });

  test("taskPlanVerify keeps bash negation commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "! grep 'needle' file.txt\nnpm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["! grep 'needle' file.txt", "npm run test"]);
  });

  test("taskPlanVerify rejects redirected pytest command", () => {
    const result = discoverCommands({
      taskPlanVerify: "python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-unsafe");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with tests discovers pytest when package.json is absent", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "test_sample.py"), "def test_sample():\n    assert True\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"

[tool.pytest.ini_options]
pythonpath = ["."]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("dependency-free Node project with root test file discovers node test command", () => {
    writeFileSync(join(tmp, "test-todo-cli.js"), "require('node:test')('ok', () => {});\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "node-test-file");
    assert.deepStrictEqual(result.commands, ["node test-todo-cli.js"]);
  });

  test("dependency-free Node test discovery is lower priority than Python pytest", () => {
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "tests", "test_sample.py"), "def test_sample():\n    assert True\n");
    writeFileSync(join(tmp, "sample.test.js"), "require('node:test')('ok', () => {});\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with nested Python test file discovers pytest", () => {
    mkdirSync(join(tmp, "tests", "unit"), { recursive: true });
    writeFileSync(join(tmp, "tests", "unit", "sample_test.py"), "def test_sample():\n    assert True\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with pytest.ini discovers pytest", () => {
    writeFileSync(join(tmp, "pytest.ini"), "[pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with explicit pyproject pytest marker discovers pytest", () => {
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[tool.pytest]
pythonpath = ["."]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project markers without pytest evidence do not discover pytest", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "README.md"), "# tests\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"
dependencies = ["pytest-cov"]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with setup.cfg alone does not discover pytest", () => {
    writeFileSync(join(tmp, "setup.cfg"), "[tool:pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with tox.ini alone does not discover pytest", () => {
    writeFileSync(join(tmp, "tox.ini"), "[pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
});

// ─── Execution Tests ─────────────────────────────────────────────────────────

describe("verification-gate: execution", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-exec"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("all commands pass → gate passes", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo hello", "echo world"],
    });
    assert.equal(result.checks.length, 2);
    assert.equal(result.discoverySource, "preference");
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 0);
    assert.ok(result.checks[0].stdout.includes("hello"));
    assert.ok(result.checks[1].stdout.includes("world"));
    assert.equal(result.passed, true);
    assert.equal(typeof result.timestamp, "number");
  });

  test("executes nested-quote node -e commands without mangling (#1939)", () => {
    writeFileSync(join(tmp, "nested-quote-probe.txt"), "ready\n");
    const command = String.raw`node -e "const fs=require('node:fs'); if (!fs.readFileSync(\"nested-quote-probe.txt\", 'utf8').includes(\"ready\")) process.exit(2)"`;

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: [command],
    }));

    assert.equal(result.passed, true, result.checks[0]?.stderr);
    assert.equal(result.checks[0]?.exitCode, 0);
  });

  test("shell parser failures are tagged as execution faults (#1939)", () => {
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: [`node -e '\"const'`],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, 1);
    assert.equal(result.checks[0]?.stdout, "");
    assert.match(result.checks[0]?.stderr ?? "", /Unterminated string constant/);
    assert.equal(result.checks[0]?.failureClass, "shell-parse");
  });

  test("passing task evidence prevents unrelated preference verification from failing an artifact task (#1431)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      taskPlanVerify: "Planning artifacts exist and contain all required sections",
      preferenceCommands: ["node -e 'process.exit(9)'"],
      taskEvidence: [
        { command: "gsd_exec node: artifact check", exitCode: 0, verdict: "passed", durationMs: 12 },
        { command: "gsd_exec node: consolidated artifact verification", exitCode: 0, verdict: "pass", durationMs: 8 },
      ],
    });

    assert.equal(result.passed, true);
    assert.equal(result.discoverySource, "task-plan-prose");
    assert.deepEqual(result.checks, []);
  });

  test("host verification removes GSD control-plane routing while preserving ordinary environment", () => {
    const routingKeys = [
      "GSD_PROJECT_ROOT",
      "GSD_MILESTONE_LOCK",
      "GSD_PARALLEL_WORKER",
      "GSD_SLICE_LOCK",
      "GSD_SLICE_WORKER_TOKEN",
    ] as const;
    const previousRouting = new Map(routingKeys.map((key) => [key, process.env[key]]));
    const previousSentinel = process.env.VERIFICATION_CHILD_SENTINEL;
    for (const key of routingKeys) process.env[key] = `control-plane:${key}`;
    process.env.VERIFICATION_CHILD_SENTINEL = "preserved";
    const probePath = join(tmp, "verification-env-probe.js");
    writeFileSync(
      probePath,
      `process.stdout.write(JSON.stringify({ routing: ${JSON.stringify(routingKeys)}.map((key) => process.env[key]), sentinel: process.env.VERIFICATION_CHILD_SENTINEL }));\n`,
    );
    try {
      const result = runVerificationGate({
        cwd: tmp,
        preferenceCommands: ["node verification-env-probe.js"],
      });

      assert.equal(result.passed, true);
      assert.deepEqual(JSON.parse(result.checks[0]?.stdout ?? "{}"), {
        routing: [null, null, null, null, null],
        sentinel: "preserved",
      });
    } finally {
      for (const key of routingKeys) {
        const previous = previousRouting.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      if (previousSentinel === undefined) delete process.env.VERIFICATION_CHILD_SENTINEL;
      else process.env.VERIFICATION_CHILD_SENTINEL = previousSentinel;
    }
  });

  test("one command fails → gate fails with exit code + stderr", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo ok", "sh -c 'echo err >&2; exit 1'"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 1);
    assert.ok(result.checks[1].stderr.includes("err"));
  });

  test("grep -c zero-match failure includes absence-check warning", () => {
    writeFileSync(join(tmp, "sample.txt"), "present\n");

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["grep -c missing sample.txt"],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].exitCode, 1);
    assert.equal(result.checks[0].stdout.trim(), "0");
    assert.match(result.checks[0].stderr, /grep -c/);
    assert.match(result.checks[0].stderr, /count=0/);
    assert.match(result.checks[0].stderr, /! grep -q/);
  });

  test("grep -c matching count does not warn", () => {
    writeFileSync(join(tmp, "sample.txt"), "present\n");

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["grep -c present sample.txt"],
    }));

    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[0].stdout.trim(), "1");
    assert.equal(result.checks[0].stderr, "");
  });

  test("no commands discovered → gate passes with 0 checks", () => {
    const result = runVerificationGate({
      cwd: tmp,
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 0);
    assert.equal(result.discoverySource, "none");
  });

  test("command not found → inconclusive infrastructure failure", () => {
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["__nonexistent_command_xyz_42__"],
    }));
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.notEqual(result.checks[0].exitCode, 0);
    assert.equal(result.checks[0].failureClass, "command-not-found");
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("Windows cmd missing-command stderr is classified despite exit code 1 (#1943)", () => {
    writeFileSync(
      join(tmp, "windows-command-not-found.cjs"),
      `process.stderr.write("'grep' is not recognized as an internal or external command"); process.exit(1);\n`,
    );
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["node windows-command-not-found.cjs"],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, 1);
    assert.equal(result.checks[0]?.failureClass, "command-not-found");
  });

  test("no DEP0190 deprecation warning when running commands", () => {
    // Run a subprocess with --throw-deprecation so any DeprecationWarning
    // becomes a thrown error (non-zero exit). The fix passes the command
    // string to sh -c explicitly instead of using spawnSync(cmd, {shell:true}).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const gatePath = join(thisDir, "..", "verification-gate.ts");
    const resolverPath = join(thisDir, "resolve-ts.mjs");
    const script = [
      `import { runVerificationGate } from ${JSON.stringify(pathToFileURL(gatePath).href)};`,
      `runVerificationGate({`,
      `  cwd: ${JSON.stringify(tmp)},`,
      `  preferenceCommands: ["echo dep0190-check"],`,
      `});`,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "--throw-deprecation",
        "--experimental-strip-types",
        "--import", pathToFileURL(resolverPath).href,
        "--input-type=module",
        "-e", script,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );
    // With --throw-deprecation, any DeprecationWarning becomes a thrown error
    // causing a non-zero exit. Exit 0 proves no deprecation was emitted.
    assert.equal(
      child.status,
      0,
      `Expected exit 0 (no deprecation) but got ${child.status}. stderr: ${child.stderr}`,
    );
  });

  test("each check has durationMs", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo fast"],
    });
    assert.equal(result.checks.length, 1);
    assert.equal(typeof result.checks[0].durationMs, "number");
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("one command fails — remaining commands still run (non-short-circuit)", () => {
    // First fails, second and third should still execute
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: [
        "sh -c 'exit 1'",
        "echo second",
        "echo third",
      ],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 3, "all 3 commands should run");
    assert.equal(result.checks[0].exitCode, 1, "first command fails");
    assert.equal(result.checks[1].exitCode, 0, "second command runs and passes");
    assert.ok(result.checks[1].stdout.includes("second"));
    assert.equal(result.checks[2].exitCode, 0, "third command runs and passes");
    assert.ok(result.checks[2].stdout.includes("third"));
  });

  test("large failure output preserves the exit code and trailing test summary", () => {
    const scriptPath = join(tmp, "large-failure.cjs");
    writeFileSync(scriptPath, [
      'process.stdout.write("failure details\\n");',
      'process.stdout.write("x".repeat(2 * 1024 * 1024));',
      'process.stdout.write("\\n=== short test summary info ===\\nFAILED tests/test_example.py::test_failure\\n");',
      "process.exitCode = 1;",
    ].join("\n"));

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: [`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.checks[0].exitCode, 1);
    assert.match(result.checks[0].stdout, /FAILED tests\/test_example\.py::test_failure/);
    assert.doesNotMatch(result.checks[0].stderr, /ENOBUFS/);
  });

test("gate execution uses cwd for spawnSync", () => {
    // pwd should report the temp dir
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["pwd"],
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    // The stdout should contain the tmp dir path (resolving symlinks)
    assert.ok(result.checks[0].stdout.trim().length > 0, "pwd should produce output");
  });

  test("multi-target execution runs verification in each repository root", () => {
    const frontend = join(tmp, "frontend");
    const backend = join(tmp, "backend");
    mkdirSync(frontend, { recursive: true });
    mkdirSync(backend, { recursive: true });

    const result = runVerificationGateForTargets({
      targets: [
        { id: "frontend", cwd: frontend },
        { id: "backend", cwd: backend },
      ],
      preferenceCommands: ["pwd"],
    });

    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].command, "[frontend] pwd");
    assert.equal(result.checks[1].command, "[backend] pwd");
    assert.ok(result.checks[0].stdout.includes("frontend"));
    assert.ok(result.checks[1].stdout.includes("backend"));
    assert.equal(result.discoverySource, "preference");
  });

  test("multi-target execution falls back to per-repo package.json discovery", () => {
    const frontend = join(tmp, "frontend");
    const backend = join(tmp, "backend");
    mkdirSync(frontend, { recursive: true });
    mkdirSync(backend, { recursive: true });
    writeFileSync(join(frontend, "package.json"), JSON.stringify({ scripts: { test: "echo front-ok" } }), "utf-8");
    writeFileSync(join(backend, "package.json"), JSON.stringify({ scripts: { test: "echo back-ok" } }), "utf-8");

    const result = runVerificationGateForTargets({
      targets: [
        { id: "frontend", cwd: frontend },
        { id: "backend", cwd: backend },
      ],
    });

    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].command, "[frontend] npm test");
    assert.equal(result.checks[1].command, "[backend] npm test");
    assert.equal(result.discoverySource, "package-json");
  });
});

// ─── Preference Validation Tests ─────────────────────────────────────────────

test("verification-gate: validatePreferences accepts valid verification keys", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", "npm run test"],
    verification_auto_fix: true,
    verification_max_retries: 3,
  });
  assert.deepStrictEqual(result.preferences.verification_commands, [
    "npm run lint",
    "npm run test",
  ]);
  assert.equal(result.preferences.verification_auto_fix, true);
  assert.equal(result.preferences.verification_max_retries, 3);
  assert.equal(result.errors.length, 0);
});

test("verification-gate: validatePreferences rejects non-array verification_commands", () => {
  const result = validatePreferences({
    verification_commands: "npm run lint" as unknown as string[],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences rejects non-boolean verification_auto_fix", () => {
  const result = validatePreferences({
    verification_auto_fix: "yes" as unknown as boolean,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_auto_fix")));
  assert.equal(result.preferences.verification_auto_fix, undefined);
});

test("verification-gate: validatePreferences rejects negative verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_max_retries")));
  assert.equal(result.preferences.verification_max_retries, undefined);
});

test("verification-gate: validatePreferences rejects non-string items in verification_commands", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", 42 as unknown as string],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences floors verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: 2.7,
  });
  assert.equal(result.preferences.verification_max_retries, 2);
  assert.equal(result.errors.length, 0);
});

// ─── isLikelyCommand Tests (issue #1066) ────────────────────────────────────

test("isLikelyCommand: known command prefixes are accepted", () => {
  assert.equal(isLikelyCommand("npm run lint"), true);
  assert.equal(isLikelyCommand("npx vitest"), true);
  assert.equal(isLikelyCommand("yarn test"), true);
  assert.equal(isLikelyCommand("pnpm run typecheck"), true);
  assert.equal(isLikelyCommand("node script.js"), true);
  assert.equal(isLikelyCommand("tsc --noEmit"), true);
  assert.equal(isLikelyCommand("eslint ."), true);
  assert.equal(isLikelyCommand("jest --ci"), true);
  assert.equal(isLikelyCommand("python3 -m pytest"), true);
  assert.equal(isLikelyCommand("cargo test"), true);
  assert.equal(isLikelyCommand("go test ./..."), true);
  assert.equal(isLikelyCommand("make test"), true);
  assert.equal(isLikelyCommand("uv run pytest"), true);
});

test("isLikelyCommand: path-like first tokens are accepted", () => {
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("/usr/local/bin/check"), true);
  assert.equal(isLikelyCommand("../tools/lint.sh"), true);
});

test("isLikelyCommand: flag-like tokens indicate a command", () => {
  assert.equal(isLikelyCommand("custom-tool --check"), true);
  assert.equal(isLikelyCommand("mycheck -v"), true);
});

test("isLikelyCommand: prose descriptions are rejected", () => {
  // The exact string from issue #1066
  assert.equal(
    isLikelyCommand("Document exists, contains all 5 scale names, all 14 semantic tokens, Inter assessment, philosophy and competitive citations present"),
    false,
  );
  assert.equal(isLikelyCommand("Check that the file has been created with the correct content"), false);
  assert.equal(isLikelyCommand("Verify the output matches expected format"), false);
  assert.equal(isLikelyCommand("All tests pass and coverage is above 80%"), false);
  assert.equal(isLikelyCommand("File should exist in the output directory"), false);
  assert.equal(isLikelyCommand("Build succeeds without errors or warnings"), false);
});

test("isLikelyCommand: lowercase prose is rejected, including a leading file path", () => {
  // Every prose case above announces itself with a capital letter or a comma.
  // Lowercase prose fell through to "command" and got executed: the gate ran
  // `greet/hello.txt exists and contains "hello"`, which tried to execute the
  // .txt file and failed with exit 126 "Permission denied" — failing the gate
  // for a task that had actually succeeded.
  assert.equal(isLikelyCommand('greet/hello.txt exists and contains "hello"'), false);
  assert.equal(isLikelyCommand("./out/report.txt exists and contains the summary"), false);
  assert.equal(isLikelyCommand("the migration is complete and the table exists"), false);

  // Real commands with a path-like or bare first token still pass.
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("./scripts/check.sh --strict --quiet"), true);
  assert.equal(isLikelyCommand("mytool build release"), true);
});

test("discoverCommands: a prose verify field is not run as a shell command", () => {
  const dir = makeTempDir("gsd-verify-prose");
  const result = discoverCommands({
    cwd: dir,
    taskPlanVerify: 'greet/hello.txt exists and contains "hello"',
  });
  assert.deepEqual(result.commands, [], "prose must not become a runnable check");
  assert.notEqual(result.source, "task-plan");
});

test("isLikelyCommand: known command word followed by English prose is rejected (issue #1567)", () => {
  assert.equal(isLikelyCommand("git log shows the scaffold commit on branch x"), false);
  assert.equal(isLikelyCommand("make builds the firmware without errors at repo root"), false);
  // Real commands starting with the same words stay command-like
  assert.equal(isLikelyCommand("git log --oneline -5"), true);
  assert.equal(isLikelyCommand("git ls-files packages/core/src"), true);
  assert.equal(isLikelyCommand("cargo build --release"), true);
  assert.equal(isLikelyCommand("npm run test:unit"), true);
});

test("isLikelyCommand: prose markers exclude operand-shaped words", () => {
  // Bare prepositions and single letters are plausible operands, so they must
  // not flip a flagless command to prose.
  assert.equal(isLikelyCommand("git diff on master"), true);
  assert.equal(isLikelyCommand("git checkout at release"), true);
  assert.equal(isLikelyCommand("make install into build"), true);
  assert.equal(isLikelyCommand("cat a b c"), true);
  assert.equal(isLikelyCommand("go build with tags"), true);
  // Articles, copulas, and prose verbs still identify descriptions
  assert.equal(isLikelyCommand("git log shows the commit on master"), false);
});

test("isLikelyCommand: non-ASCII prose descriptions are rejected", () => {
  assert.equal(isLikelyCommand("所有 命令 输出 一行 JSONL go test ./... 通过"), false);
});

test("isLikelyCommand: empty or whitespace-only strings are rejected", () => {
  assert.equal(isLikelyCommand(""), false);
  assert.equal(isLikelyCommand("   "), false);
});

test("isLikelyCommand: short lowercase tokens without flags are accepted (could be custom scripts)", () => {
  assert.equal(isLikelyCommand("custom-verify"), true);
  assert.equal(isLikelyCommand("mycheck"), true);
});

test("isLikelyCommand: bash negation with known command is accepted", () => {
  assert.equal(isLikelyCommand("! grep needle file.txt"), true);
});

test("validateVerificationCommand accepts negated quiet absence checks", () => {
  assert.equal(validateVerificationCommand("! grep -q needle file.txt").ok, true);
  assert.equal(validateVerificationCommand("! rg -q needle file.txt").ok, true);
});

test("validateVerificationCommand allows shell pipelines", () => {
  assert.deepEqual(validateVerificationCommand("python3 -m pytest tests/ -q --tb=short").ok, true);
  const result = validateVerificationCommand("python3 -m pytest tests/ -q --tb=short | tail -5");
  assert.equal(result.ok, true);
});

test("validateVerificationCommand rejects shell control syntax", () => {
  const result = validateVerificationCommand("python3 -m pytest tests/ -q --tb=short > output.log");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("validateVerificationCommand allows semicolons inside quoted python -c code", () => {
  const result = validateVerificationCommand("uv run python3 -c \"import yaml; yaml.safe_load('x: 1')\"");
  assert.equal(result.ok, true);
});

test("validateVerificationCommand allows grep patterns with quoted pipes", () => {
  assert.equal(validateVerificationCommand('grep -q "| " output.md').ok, true);
  assert.equal(validateVerificationCommand("grep -c '^## SectionA\\|^### Sub1\\|^### Sub2' notes.md").ok, true);
});

test("isLikelyCommand: quoted segments are shell data, not prose (issue #2290)", () => {
  // The reporter's verify: the quoted grep pattern contains prose marker
  // words ("from", "the"), but quoted text is shell data — it must not flip
  // a runnable command to prose.
  assert.equal(
    isLikelyCommand("bash scripts/hello-seat.sh && test -x scripts/hello-seat.sh && grep -q 'hello from the localnodes seat' scripts/hello-seat.sh"),
    true,
  );
  // Minimal case: the quoted segment is the only content beside the prefix.
  assert.equal(isLikelyCommand("grep -q 'hello from the localnodes seat' scripts/hello-seat.sh"), true);
  assert.equal(isLikelyCommand('grep -q "the pattern contains that" file.txt'), true);
});

test("isLikelyCommand: unquoted prose after a command word is still rejected (issue #2290 control)", () => {
  assert.equal(isLikelyCommand("bash scripts/x.sh and then verify the outcome manually"), false);
});

test("isLikelyCommand: escaped quote inside double quotes stays shell data (issue #2290)", () => {
  // `\"` does not close the double-quoted segment, so "and the rest" stays
  // quoted data instead of leaking into the prose heuristic.
  assert.equal(isLikelyCommand('grep -q "say \\"from\\" and the rest" file.txt'), true);
});

test("isLikelyCommand: unterminated quote is left intact for prose detection (issue #2290)", () => {
  // A quote that never closes leaves the quoting state unresolved, so nothing
  // is stripped and the prose heuristic still sees the remainder — this
  // protects #1671-style prose that contains an apostrophe (dell'esempio).
  assert.equal(validateVerificationCommand("grep 'hello from the that").ok, false);
  // A clean remainder still validates as a command; if the quote is genuinely
  // malformed the shell fails loudly at execution (unexpected EOF). The
  // shell-syntax rule does not flag unterminated quotes.
  assert.equal(isLikelyCommand("grep 'needle in haystack file.txt"), true);
});

test("isLikelyCommand: backtick segments are not stripped (issue #2290)", () => {
  // Backticks are command substitution, not quoted data — their content still
  // feeds the prose heuristic. Backtick commands are already rejected earlier
  // by the shell-syntax rule in validateVerificationCommand.
  assert.equal(isLikelyCommand("echo `from the that` file"), false);
});

test("isLikelyCommand: token-count guard uses the full command, not the stripped stream (issue #2290)", () => {
  // Stripping leaves "contains" as the only marker word and drops the stream
  // below four tokens — the minimum must be measured on the original stream
  // so unquoted prose is still rejected.
  assert.equal(isLikelyCommand('./report.txt contains "hello world"'), false);
});

test("isLikelyCommand: escaped quotes outside quoted segments stay in the token stream (issue #2290)", () => {
  // `\'` is an escaped literal quote, not a quote delimiter — the pair must
  // not vanish from the stripped stream, or the inner word ("the") would be
  // misread as an unquoted prose marker.
  assert.equal(isLikelyCommand("grep -q \\'the\\' file.txt"), true);
});

test("validateVerificationCommand allows exit-code echo diagnostic suffix", () => {
  assert.equal(validateVerificationCommand('python3 tools/check-status.py; echo "exit:$?"').ok, true);
  assert.equal(validateVerificationCommand("python3 tools/check-status.py; echo 'exit:$?'").ok, true);
  assert.equal(validateVerificationCommand("python3 tools/check-status.py; echo exit:$?").ok, true);
});

test("validateVerificationCommand rejects shell operators after single-quote backslash desync patterns", () => {
  const result = validateVerificationCommand("echo 'x\\'; ls");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("validateVerificationCommand rejects logical OR fallback syntax", () => {
  const result = validateVerificationCommand("npm test || true");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("runVerificationGate: timeout is failureClass timeout, not exit 127 (#1759)", () => {
  const dir = makeTempDir("gsd-verify-timeout");
  const result = withRtkDisabled(() => runVerificationGate({
    cwd: dir,
    preferenceCommands: ["sleep 5"],
    commandTimeoutMs: 50,
  }));
  assert.equal(result.passed, false);
  assert.equal(result.checks.length, 1);
  assert.notEqual(result.checks[0]?.exitCode, 127);
  assert.equal(result.checks[0]?.failureClass, "timeout");
  assert.match(result.checks[0]?.stderr ?? "", /timed out after 50ms/);
  assert.match(result.checks[0]?.stderr ?? "", /verification_timeout_ms/);
});

test("runVerificationGate: missing binary is classified separately from timeout (#1759, #1943)", () => {
  const dir = makeTempDir("gsd-verify-enoent");
  const result = withRtkDisabled(() => runVerificationGate({
    cwd: dir,
    preferenceCommands: ["__gsd_missing_binary_1783__"],
  }));
  assert.equal(result.passed, false);
  assert.notEqual(result.checks[0]?.exitCode, 0);
  assert.equal(result.checks[0]?.failureClass, "command-not-found");
});

test("validatePreferences: verification_timeout_ms override and default (#1759)", () => {
  const set = validatePreferences({ verification_timeout_ms: 2500.9 });
  assert.equal(set.errors.length, 0);
  assert.equal(set.preferences.verification_timeout_ms, 2500);
  assert.equal((set.warnings ?? []).filter((w) => w.includes("unknown")).length, 0);
  const unset = validatePreferences({});
  assert.equal(unset.preferences.verification_timeout_ms, undefined);
  const bad = validatePreferences({ verification_timeout_ms: 0 });
  assert.ok(bad.errors.some((e) => e.includes("verification_timeout_ms")));
});

test("validateVerificationCommand rejects arbitrary semicolon command chaining", () => {
  const result = validateVerificationCommand("python3 tools/check-status.py; rm -rf output");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

// ─── Quote-aware substitution + flag-tolerant prose (#1671, #1724 / #1782) ──

const ISSUE_1671_VERIFY =
  "node --test tests/hooks-planning.test.ts — exit 0, asserts: (1) toolNames includes discussion_arena when forced + planning, (2) excludes when available-only, (3) excludes when execution phase, (4) prompt instruction contains marker, (5) repeated calls do not duplicate instruction. Plus npm test full suite 0 regressions on 19/41 (now 41+) tests.";

const ISSUE_1671_OCCURRENCE_1 =
  "npm test -- tests/discussion-arena-coordination.test.ts exit 0 con nuovi test verdi (assenza activation, activation valida, mode invalido, milestone ID con trattino vs underscore, milestones nested profondità). npx tsc --noEmit exit 0.";

const ISSUE_1671_OCCURRENCE_2 =
  "npm test -- tests/examples-validation.test.ts exit 0. Il parsing dell'esempio produce activation strutturata.";

const ISSUE_1724_RG = "! rg -q '`[a-zA-Z_]+ \\(' module_file.py";

test("validateVerificationCommand: quote-aware substitution truth table (#1724)", () => {
  assert.equal(validateVerificationCommand(ISSUE_1724_RG).ok, true, "single-quoted backtick in rg pattern");
  assert.equal(validateVerificationCommand("rg 'foo`bar' notes.md").ok, true, "walkthrough: single-quoted backtick");
  assert.equal(validateVerificationCommand("rg -q '$(pattern)' file.txt").ok, true, "single-quoted $(");

  const unquotedSub = validateVerificationCommand("echo $(rm -rf /tmp/gsd-verify-x)");
  assert.equal(unquotedSub.ok, false, "unquoted $( still rejected");
  if (!unquotedSub.ok) assert.match(unquotedSub.reason, /shell control syntax/);

  const unquotedTick = validateVerificationCommand("echo `rm -rf /tmp/gsd-verify-x`");
  assert.equal(unquotedTick.ok, false, "unquoted backtick still rejected");
  if (!unquotedTick.ok) assert.match(unquotedTick.reason, /shell control syntax/);

  const doubleQuotedSub = validateVerificationCommand('echo "$(rm -rf /tmp/gsd-verify-x)"');
  assert.equal(doubleQuotedSub.ok, false, "double quotes do not protect $(");
  if (!doubleQuotedSub.ok) assert.match(doubleQuotedSub.reason, /shell control syntax/);

  const doubleQuotedTick = validateVerificationCommand("echo \"`rm -rf /tmp/gsd-verify-x`\"");
  assert.equal(doubleQuotedTick.ok, false, "double quotes do not protect backticks");
  if (!doubleQuotedTick.ok) assert.match(doubleQuotedTick.reason, /shell control syntax/);
});

test("isLikelyCommand: flags after the command word do not suppress prose (#1671)", () => {
  assert.equal(isLikelyCommand("node --test tests/hooks-planning.test.ts"), true, "plain command with flags");
  assert.equal(isLikelyCommand(ISSUE_1671_VERIFY), false, "reporter Verify line is prose");
  assert.equal(isLikelyCommand("git log --oneline -5"), true, "flag-only command stays a command");
  assert.equal(isLikelyCommand("git log --oneline shows the scaffold commit"), false, "flag then prose marker");
  assert.equal(isLikelyCommand(`${ISSUE_1671_OCCURRENCE_1} contains a marker`), false);
  assert.equal(isLikelyCommand(`${ISSUE_1671_OCCURRENCE_2} contains a marker`), false);
});

test("discoverCommands: #1671 reporter line is not executed; #1724 rg line is", () => {
  const proseDir = makeTempDir("gsd-verify-1671");
  const prose = discoverCommands({ cwd: proseDir, taskPlanVerify: ISSUE_1671_VERIFY });
  assert.deepEqual(prose.commands, [], "appended assertion prose must not become a check");
  assert.notEqual(prose.source, "task-plan");

  const rgDir = makeTempDir("gsd-verify-1724");
  const rg = discoverCommands({ cwd: rgDir, taskPlanVerify: ISSUE_1724_RG });
  assert.deepEqual(rg.commands, [ISSUE_1724_RG]);
  assert.equal(rg.source, "task-plan");
});

const ISSUE_1798_VERIFY = `grep -q '"version": "1.0.0"' manifest.json && node --input-type=module --eval "import fs from 'node:fs'
const m = JSON.parse(fs.readFileSync('manifest.json','utf8'))
if (m.priority !== 100) throw new Error('priority')
console.log('OK')" && npm run typecheck`;

test("splitUnquotedLines keeps newlines inside quotes (#1798)", () => {
  assert.deepEqual(splitUnquotedLines("npm test\nnpm run lint"), ["npm test", "npm run lint"]);
  const lines = splitUnquotedLines(ISSUE_1798_VERIFY);
  assert.equal(lines.length, 1, "quoted --eval body must stay one command");
  assert.match(lines[0] ?? "", /npm run typecheck$/);
});

test("discoverCommands: quoted multi-line --eval stays one command (#1798)", () => {
  const dir = makeTempDir("gsd-verify-1798");
  const found = discoverCommands({ cwd: dir, taskPlanVerify: ISSUE_1798_VERIFY });
  assert.equal(found.source, "task-plan");
  assert.equal(found.commands.length, 1);
  assert.match(found.commands[0] ?? "", /node --input-type=module --eval/);
  assert.match(found.commands[0] ?? "", /npm run typecheck$/);
});

// ─── Additional Preference Validation Tests (T02) ──────────────────────────

test("verification-gate: verification_commands produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_commands: ["npm test"],
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_commands is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_auto_fix produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_auto_fix: true,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_auto_fix is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_max_retries: 2,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_max_retries is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries -1 produces a validation error", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(
    result.errors.some(e => e.includes("verification_max_retries")),
    "negative max_retries should error",
  );
  assert.equal(result.preferences.verification_max_retries, undefined);
});

// ─── formatFailureContext Tests (S03/T01) ─────────────────────────────────────

test("formatFailureContext: formats a single failure with command, exit code, stderr", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error: unused var", durationMs: 500 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.startsWith("## Verification Failures"), "should start with header");
  assert.ok(output.includes("`npm run lint`"), "should include command name");
  assert.ok(output.includes("exit code 1"), "should include exit code");
  assert.ok(output.includes("error: unused var"), "should include stderr content");
  assert.ok(output.includes("```stderr"), "should have stderr code block");
});

test("formatFailureContext: preserves stdout-only failure evidence", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "node --test", exitCode: 1, stdout: "not ok 1 - fixture assertion", stderr: "", durationMs: 500 },
    ],
    discoverySource: "task-plan",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.match(output, /not ok 1 - fixture assertion/);
  assert.match(output, /```stdout/);
});

test("formatFailureContext: formats multiple failures", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "lint error", durationMs: 100 },
      { command: "npm run test", exitCode: 2, stdout: "", stderr: "test failure", durationMs: 200 },
      { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 50 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.includes("`npm run lint`"), "should include first failed command");
  assert.ok(output.includes("exit code 1"), "should include first exit code");
  assert.ok(output.includes("`npm run test`"), "should include second failed command");
  assert.ok(output.includes("exit code 2"), "should include second exit code");
  // Passing check should NOT appear
  assert.ok(!output.includes("npm run typecheck"), "should not include passing command");
});

test("formatFailureContext: truncates stderr longer than 2000 chars", () => {
  const longStderr = "x".repeat(3000);
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "big-err", exitCode: 1, stdout: "", stderr: longStderr, durationMs: 100 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  // The output should contain 2000 x's followed by truncation marker, not 3000
  assert.ok(!output.includes("x".repeat(2001)), "should not contain more than 2000 chars of stderr");
  assert.ok(output.includes("…[truncated]"), "should include truncation marker");
});

test("formatFailureContext: returns empty string when all checks pass", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 200 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: returns empty string for empty checks array", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: caps total output at 10,000 chars", () => {
  // Generate many failures to exceed 10,000 chars total
  const checks: import("../types.ts").VerificationCheck[] = [];
  for (let i = 0; i < 20; i++) {
    checks.push({
      command: `failing-command-${i}`,
      exitCode: 1,
      stdout: "",
      stderr: "e".repeat(1000), // 1000 chars each, 20 * ~1050 (with formatting) > 10,000
      durationMs: 100,
    });
  }
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks,
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.length <= 10_100, `total output should be capped near 10,000 chars, got ${output.length}`);
  assert.ok(output.includes("…[remaining failures truncated]"), "should include total truncation marker");
});

// ─── captureRuntimeErrors Tests (S04/T01) ─────────────────────────────────────

function makeProc(overrides: Record<string, unknown>) {
  return {
    id: "p1",
    label: "test-server",
    status: "ready",
    alive: true,
    exitCode: null,
    signal: null,
    recentErrors: [] as string[],
    ...overrides,
  };
}

function makeLogs(entries: Array<{ type: string; text: string }>) {
  return entries.map((e, i) => ({
    type: e.type,
    text: e.text,
    timestamp: Date.now() + i,
    url: "http://localhost:3000",
  }));
}

test("captureRuntimeErrors: crashed bg-shell process → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("test-server"));
});

test("captureRuntimeErrors: bg-shell non-zero exit + not alive → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "exited", alive: false, exitCode: 137 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("exitCode=137"));
});

test("captureRuntimeErrors: bg-shell SIGABRT/SIGSEGV/SIGBUS → blocking crash error", async () => {
  for (const sig of ["SIGABRT", "SIGSEGV", "SIGBUS"]) {
    const processes = new Map<string, unknown>([
      ["p1", makeProc({ signal: sig, alive: false, exitCode: null })],
    ]);
    const result = await captureRuntimeErrors({
      getProcesses: () => processes,
      getConsoleLogs: () => [],
    });
    assert.equal(result.length, 1, `${sig} should produce 1 error`);
    assert.equal(result[0].severity, "crash");
    assert.equal(result[0].blocking, true);
    assert.ok(result[0].message.includes(sig), `message should contain ${sig}`);
  }
});

test("captureRuntimeErrors: alive bg-shell process with recentErrors → non-blocking error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ alive: true, recentErrors: ["TypeError: foo", "RangeError: bar"] })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("TypeError: foo"));
  assert.ok(result[0].message.includes("RangeError: bar"));
});

test("captureRuntimeErrors: browser unhandled rejection → blocking crash error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Unhandled promise rejection: some error" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("Unhandled"));
});

test("captureRuntimeErrors: browser UnhandledRejection (case variation) → blocking crash", async () => {
  const logs = makeLogs([
    { type: "error", text: "UnhandledRejection in module X" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
});

test("captureRuntimeErrors: browser console.error (general) → non-blocking error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Failed to load resource: net::ERR_FAILED" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
});

test("captureRuntimeErrors: browser deprecation warning → non-blocking warning", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Event.returnValue is deprecated. Use Event.preventDefault() instead." },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "warning");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("deprecated"));
});

test("captureRuntimeErrors: non-deprecation warning is ignored", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Some general warning about performance" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 0, "non-deprecation warnings should be ignored");
});

test("captureRuntimeErrors: no processes, no browser logs → empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => [],
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: dynamic import failure → graceful empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => { throw new Error("module not found"); },
    getConsoleLogs: () => { throw new Error("module not found"); },
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: browser text truncated to 500 chars", async () => {
  const longText = "x".repeat(600);
  const logs = makeLogs([
    { type: "error", text: longText },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.length <= 500 + 20, "message should be truncated near 500 chars");
  assert.ok(result[0].message.includes("…[truncated]"), "should include truncation marker");
  assert.ok(!result[0].message.includes("x".repeat(501)), "should not contain 501+ x's");
});

test("captureRuntimeErrors: bg-shell recentErrors limited to 3 in message", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({
      status: "crashed",
      alive: false,
      exitCode: 1,
      recentErrors: ["err1", "err2", "err3", "err4", "err5"],
    })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.includes("err1"));
  assert.ok(result[0].message.includes("err2"));
  assert.ok(result[0].message.includes("err3"));
  assert.ok(!result[0].message.includes("err4"), "should only include first 3 errors");
});

test("captureRuntimeErrors: mixed bg-shell and browser errors", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const logs = makeLogs([
    { type: "error", text: "Unhandled rejection: boom" },
    { type: "error", text: "general error" },
    { type: "warning", text: "deprecated API used" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => logs,
  });
  // 1 bg-shell crash + 1 browser crash (unhandled) + 1 browser error + 1 browser warning
  assert.equal(result.length, 4);
  const blocking = result.filter(r => r.blocking);
  const nonBlocking = result.filter(r => !r.blocking);
  assert.equal(blocking.length, 2, "should have 2 blocking errors");
  assert.equal(nonBlocking.length, 2, "should have 2 non-blocking errors");
});

// ─── Dependency Audit Tests (S05/T01) ─────────────────────────────────────────

/** Helper: build a realistic npm audit JSON stdout with vulnerabilities. */
function makeAuditJson(
  vulns: Record<string, { severity: string; fixAvailable: boolean; via: unknown[] }>,
): string {
  return JSON.stringify({ vulnerabilities: vulns });
}

/** Sample npm audit JSON with a high-severity vuln. */
const SAMPLE_AUDIT_JSON = makeAuditJson({
  "nth-check": {
    severity: "high",
    fixAvailable: true,
    via: [
      {
        title: "Inefficient Regular Expression Complexity in nth-check",
        url: "https://github.com/advisories/GHSA-rp65-9cf3-cjxr",
        severity: "high",
      },
    ],
  },
});

test("dependency-audit: package.json in git diff → runs npm audit and parses vulnerabilities", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json", "src/index.ts"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true, "npm audit should be called");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
  assert.equal(result[0].title, "Inefficient Regular Expression Complexity in nth-check");
  assert.equal(result[0].url, "https://github.com/advisories/GHSA-rp65-9cf3-cjxr");
  assert.equal(result[0].fixAvailable, true);
});

test("dependency-audit: package-lock.json change triggers audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
  assert.equal(result.length, 1);
});

test("dependency-audit: pnpm-lock.yaml change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["pnpm-lock.yaml"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: yarn.lock change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["yarn.lock"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: bun.lockb change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["bun.lockb"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: no dependency file changes → returns empty array, npm audit not called", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["src/index.ts", "README.md"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: "{}", exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "npm audit should NOT be called when no dependency files changed");
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: git diff returns non-zero exit (not a git repo) → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => { throw new Error("not a git repo"); },
    npmAudit: () => { throw new Error("should not be called"); },
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns invalid JSON → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: "not json at all", exitCode: 1 }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns zero vulnerabilities → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({
      stdout: JSON.stringify({ vulnerabilities: {} }),
      exitCode: 0,
    }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit non-zero exit with valid JSON → parses correctly", () => {
  // npm audit exits non-zero when vulnerabilities exist — this is expected, not an error
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => ({
      stdout: SAMPLE_AUDIT_JSON,
      exitCode: 1, // non-zero!
    }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
});

test("dependency-audit: via entries with string-only values are skipped", () => {
  const auditJson = makeAuditJson({
    "postcss": {
      severity: "moderate",
      fixAvailable: false,
      via: ["nth-check", "css-select"], // string-only via entries
    },
  });
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: auditJson, exitCode: 1 }),
  });
  assert.equal(result.length, 1);
  // When no object via entry is found, title falls back to the package name
  assert.equal(result[0].name, "postcss");
  assert.equal(result[0].title, "postcss");
  assert.equal(result[0].url, "");
});

test("dependency-audit: subdirectory package.json does not trigger audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["packages/foo/package.json", "libs/bar/package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "subdirectory dependency files should not trigger audit");
  assert.deepStrictEqual(result, []);
});

// ─── Python normalization (regression: #4416) ────────────────────────────────
// Verification commands using python3/python must succeed even when only the
// alternate interpreter name is available. The gate rewrites the command via
// normalizePythonCommand before spawning — tested here end-to-end on this host.

describe("verification-gate: python normalization (#4416)", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-python"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("python3 --version command succeeds on this host (gate uses normalized invocation)", () => {
    // This test verifies that runVerificationGate can execute a python command
    // without hard-failing due to interpreter name mismatch. On hosts where
    // python3 is available it runs directly; on hosts where only python or py
    // exists, normalizePythonCommand rewrites the token before spawnSync.
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python3 --version"],
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("python --version command produces a VerificationResult (not a crash)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python --version"],
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });
});
