/**
 * Live-workflow runner.
 *
 * Drives the REAL `gsd` binary against a REAL model — no fake-LLM transcript.
 * Each `test-*.ts` script seeds a tiny milestone in a throwaway project, then
 * dispatches either one unit (`gsd headless next`, test-tiny-milestone.ts) or
 * the full loop (`gsd headless auto`, test-multi-slice-auto.ts), and
 * asserts on durable outcomes (the verification command passes, git has the
 * agent's work, the milestone is closed in gsd.db) rather than on agent
 * prose, which drifts every run.
 *
 * This is the live counterpart to tests/e2e (fake LLM) and tests/live
 * (provider transport smoke). It is slow and costs real tokens, so it is
 * gated behind GSD_LIVE_TESTS=1 and never runs in the default suite.
 *
 * Child exit codes (POSIX-style, same convention as tests/live/run.ts):
 *   0   pass
 *   77  skip (no credentials / binary not built)
 *   any other non-zero  fail
 *
 * Env:
 *   GSD_LIVE_TESTS=1                 required — otherwise this is a no-op
 *   GSD_SMOKE_BINARY=/path/loader.js the built binary to drive (recommended;
 *                                    falls back to `gsd` on PATH if unset)
 *   GSD_LIVE_WORKFLOW_MODEL=<id>     optional model override; default uses the
 *                                    configured default model (model-agnostic)
 *   GSD_LIVE_WORKFLOW_TIMEOUT_MS     optional dispatch timeout (default 300000
 *                                    for `next`, 1800000 for `auto`)
 *   GSD_LIVE_WORKFLOW_RUNNER_TIMEOUT_MS optional extra per-test deadline for
 *                                    this runner (unset = none; scenarios
 *                                    enforce their own budget)
 *   GSD_LIVE_WORKFLOW_USE_HOME=1     forward the real HOME so the child uses
 *                                    ~/.gsd/agent/auth.json (counts as a credential)
 */
import { readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.GSD_LIVE_TESTS !== "1") {
  console.log("Skipping live-workflow tests (set GSD_LIVE_TESTS=1 to enable)");
  process.exit(0);
}

// Credentials come from the environment only — export a provider key/token
// (*_API_KEY or *_OAUTH_TOKEN) before running. Each test skips (exit 77) if
// none is present, so a no-credentials machine reports SKIP, not FAIL.

const smokeBinary = process.env.GSD_SMOKE_BINARY;
if (smokeBinary && !existsSync(smokeBinary)) {
  console.error(`GSD_SMOKE_BINARY set but not found: ${smokeBinary}`);
  console.error("Build it first: npm run build:core && chmod +x dist/loader.js");
  process.exit(1);
}
if (!smokeBinary) {
  console.log("GSD_SMOKE_BINARY not set — falling back to `gsd` on PATH.");
}

// Each scenario enforces its own wall-clock budget (GSD_LIVE_WORKFLOW_TIMEOUT_MS
// or the scenario default) and kills the gsd child itself, so the runner adds
// no second deadline unless asked to. A runner deadline shorter than a
// scenario budget would mask a real wedge as a runner kill.
const perTestTimeoutMs = process.env.GSD_LIVE_WORKFLOW_RUNNER_TIMEOUT_MS
  ? Number(process.env.GSD_LIVE_WORKFLOW_RUNNER_TIMEOUT_MS)
  : undefined;

const testFiles = readdirSync(__dirname)
  .filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("No live-workflow test files found");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;

for (const file of testFiles) {
  const filePath = join(__dirname, file);
  const label = file.replace(/\.ts$/, "");
  console.log(`\n──  ${label}`);
  try {
    execFileSync("node", ["--experimental-strip-types", filePath], {
      encoding: "utf8",
      stdio: "inherit",
      timeout: perTestTimeoutMs,
      env: process.env,
    });
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err: any) {
    if (err.status === 77) {
      console.log(`  SKIP  ${label}`);
      skipped++;
      continue;
    }
    console.error(`  FAIL  ${label} (status=${err.status ?? "?"} signal=${err.signal ?? "?"})`);
    failed++;
  }
}

console.log(
  `\nLive-workflow tests: ${passed} passed, ${failed} failed, ${skipped} skipped`,
);
if (failed > 0) process.exit(1);
