import test from "node:test";
import assert from "node:assert/strict";

import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { buildExecOptionsForParams, executeGsdExec, executeUatExec } from "../tools/exec-tool.ts";
import type { ExecSandboxOptions, ExecSandboxRequest, ExecSandboxResult } from "../exec-sandbox.ts";

function makeExecResult(request: ExecSandboxRequest): ExecSandboxResult {
  return {
    id: "exec-1",
    runtime: request.runtime,
    exit_code: 0,
    signal: null,
    timed_out: false,
    aborted: false,
    force_resolved: false,
    duration_ms: 1,
    stdout_bytes: 12,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    stdout_path: ".gsd/exec/exec-1.stdout",
    stderr_path: ".gsd/exec/exec-1.stderr",
    meta_path: ".gsd/exec/exec-1.meta.json",
    digest: "check passed",
  };
}

test("executeUatExec accepts evidence-mode aliases for intent", async () => {
  const requests: ExecSandboxRequest[] = [];
  const result = await executeUatExec(
    {
      milestoneId: "M001",
      sliceId: "S01",
      checkId: "UAT-PRE",
      intent: "artifact",
      runtime: "bash",
      script: "printf ok",
    },
    {
      baseDir: "/tmp/gsd-uat-exec-test",
      preferences: null,
      run: async (request) => {
        requests.push(request);
        return makeExecResult(request);
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(result.details?.operation, "gsd_uat_exec");
  assert.equal(result.details?.intent, "uat-artifact-check");
  assert.equal(requests[0]?.metadata?.intent, "uat-artifact-check");
});

test("executeGsdExec passes AbortSignal into sandbox options", async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;

  const result = await executeGsdExec(
    { runtime: "bash", script: "sleep 60" },
    {
      baseDir: "/tmp/gsd-exec-abort-signal-test",
      preferences: null,
      signal: controller.signal,
      run: async (request, opts: ExecSandboxOptions) => {
        capturedSignal = opts.signal;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(capturedSignal, controller.signal);
});

test("executeGsdExec uses verification_timeout_ms as its configured default", async () => {
  let capturedDefaultTimeout: number | undefined;

  const result = await executeGsdExec(
    { runtime: "bash", script: "pnpm verify:pr" },
    {
      baseDir: "/tmp/gsd-exec-verification-timeout-test",
      preferences: {
        context_mode: { enabled: true },
        verification_timeout_ms: 180_000,
      },
      run: async (request, opts: ExecSandboxOptions) => {
        capturedDefaultTimeout = opts.default_timeout_ms;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(capturedDefaultTimeout, 180_000);
});

test("executeGsdExec keeps the explicit context-mode timeout ahead of verification timeout", async () => {
  let capturedDefaultTimeout: number | undefined;

  await executeGsdExec(
    { runtime: "bash", script: "pnpm test" },
    {
      baseDir: "/tmp/gsd-exec-explicit-timeout-test",
      preferences: {
        context_mode: { enabled: true, exec_timeout_ms: 45_000 },
        verification_timeout_ms: 180_000,
      },
      run: async (request, opts: ExecSandboxOptions) => {
        capturedDefaultTimeout = opts.default_timeout_ms;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(capturedDefaultTimeout, 45_000);
});

test("executeGsdExec keeps the sandbox default for unrelated workloads", async () => {
  let capturedDefaultTimeout: number | undefined;

  await executeGsdExec(
    { runtime: "bash", script: "rg -n TODO src" },
    {
      baseDir: "/tmp/gsd-exec-unrelated-timeout-test",
      preferences: {
        context_mode: { enabled: true },
        verification_timeout_ms: 180_000,
      },
      run: async (request, opts: ExecSandboxOptions) => {
        capturedDefaultTimeout = opts.default_timeout_ms;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(capturedDefaultTimeout, 30_000);
});

test("gsd_exec surfaces aborted child termination distinctly from a clean exit", async () => {
  const result = await executeGsdExec(
    { runtime: "bash", script: "trap 'exit 0' TERM; sleep 60" },
    {
      baseDir: "/tmp/gsd-exec-aborted-test",
      preferences: null,
      run: async (request) => ({
        ...makeExecResult(request),
        aborted: true,
        exit_code: 0,
        signal: null,
        digest: "[no stdout — aborted]",
      }),
    },
  );

  assert.equal(result.isError, true, "an aborted run must be an error even if the child exits 0");
  assert.equal(result.details?.aborted, true, "details must expose aborted");
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /exit=aborted/, "summary must distinguish an aborted result");
});

test("gsd_exec surfaces a force-resolved (D-state) kill distinctly from a clean exit", async () => {
  // A hard-deadline force-resolve sets force_resolved=true with a synthetic SIGKILL
  // signal and null exit code. The tool result must carry that flag in details and
  // render it as exit=timeout(force-killed) so the agent can tell it apart from a
  // normally-exited or cleanly-timed-out command.
  const result = await executeGsdExec(
    { runtime: "bash", script: "sleep 60" },
    {
      baseDir: "/tmp/gsd-exec-force-resolved-test",
      preferences: null,
      run: async (request) => ({
        ...makeExecResult(request),
        exit_code: null,
        signal: "SIGKILL",
        timed_out: true,
        force_resolved: true,
        digest: "[no stdout \u2014 timed out]",
      }),
    },
  );

  assert.equal(result.isError, true, "a force-resolved kill is an error result");
  assert.equal(result.details?.force_resolved, true, "details must expose force_resolved");
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /exit=timeout\(force-killed\)/, "summary must distinguish a force-killed result");
});

test("registerExecTools exposes gsd_uat_exec intent as recoverable string schema", () => {
  const tools: Array<{ name: string; parameters: any }> = [];
  registerExecTools({
    registerTool: (tool: { name: string; parameters: any }) => {
      tools.push(tool);
    },
  } as any);

  const tool = tools.find((registeredTool) => registeredTool.name === "gsd_uat_exec");
  assert.ok(tool, "gsd_uat_exec should be registered");
  const intentSchema = tool.parameters.properties.intent;
  assert.equal(intentSchema.type, "string");
  assert.equal("anyOf" in intentSchema, false);
  assert.match(intentSchema.description, /uat-artifact-check/);
  assert.match(intentSchema.description, /artifact/);
});

// ── One-hour timeout ceiling (issue #2981) ──────────────────────────────────

test("executeGsdExec honors an explicit timeout_ms above the old 600s cap", async () => {
  let capturedClampTimeout: number | undefined;
  let capturedRequest: ExecSandboxRequest | undefined;

  const result = await executeGsdExec(
    { runtime: "bash", script: "pnpm verify:pr", timeout_ms: 1_800_000 },
    {
      baseDir: "/tmp/gsd-exec-long-timeout-test",
      preferences: {
        context_mode: { enabled: true },
        verification_timeout_ms: 120_000,
      },
      run: async (request, opts) => {
        capturedClampTimeout = opts.clamp_timeout_ms;
        capturedRequest = request;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(capturedClampTimeout, 3_600_000, "sandbox ceiling must be one hour, not 600s");
  assert.equal(capturedRequest?.timeout_ms, 1_800_000, "a 30-minute request must reach the sandbox unclamped");
});

test("registerExecTools advertises the one-hour timeout_ms ceiling on both exec tools", () => {
  const tools: Array<{ name: string; parameters: any }> = [];
  registerExecTools({
    registerTool: (tool: { name: string; parameters: any }) => {
      tools.push(tool);
    },
  } as any);

  for (const name of ["gsd_exec", "gsd_uat_exec"]) {
    const tool = tools.find((registeredTool) => registeredTool.name === name);
    assert.ok(tool, `${name} should be registered`);
    const timeoutSchema = tool.parameters.properties.timeout_ms;
    assert.ok(timeoutSchema, `${name} should expose timeout_ms`);
    assert.equal(timeoutSchema.maximum, 3_600_000, `${name} timeout_ms maximum must be one hour`);
  }
});

test("buildExecOptionsForParams classifies UAT workloads on the normalized params (issue #2981)", () => {
  const uatParams = {
    milestoneId: "M001",
    sliceId: "S01",
    checkId: "test-login",
    intent: "uat-runtime-check",
    command: "sleep 100",
  };
  const preferences = {
    context_mode: { enabled: true },
    verification_timeout_ms: 120_000,
  };

  // The executor injects a purpose naming the checkId ("test-login"), which
  // makes this UAT call verification-oriented — the deadline helper must see
  // the same 120s sandbox default the executor will apply, not the 30s
  // unrelated-workload default.
  const uat = buildExecOptionsForParams("/tmp/base", uatParams, preferences, true);
  assert.equal(uat.default_timeout_ms, 120_000);

  // The gsd_exec handler classifies raw params: "sleep 100" stays unrelated.
  const plain = buildExecOptionsForParams("/tmp/base", { command: "sleep 100" }, preferences);
  assert.equal(plain.default_timeout_ms, 30_000);
});

test("executeUatExec hands the sandbox the verification default for a verification-named check", async () => {
  let capturedDefaultTimeout: number | undefined;
  const result = await executeUatExec(
    {
      milestoneId: "M001",
      sliceId: "S01",
      checkId: "test-login",
      intent: "uat-runtime-check",
      command: "sleep 100",
    },
    {
      baseDir: "/tmp/gsd-uat-classification-test",
      preferences: {
        context_mode: { enabled: true },
        verification_timeout_ms: 120_000,
      },
      run: async (request, opts) => {
        capturedDefaultTimeout = opts.default_timeout_ms;
        return makeExecResult(request);
      },
    },
  );

  assert.equal(result.isError, false);
  assert.equal(capturedDefaultTimeout, 120_000);
});
