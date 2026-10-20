import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerExecTools } from "../bootstrap/exec-tools.ts";
import { executeGsdExec, executeUatExec } from "../tools/exec-tool.ts";
import type { ExecSandboxOptions, ExecSandboxRequest, ExecSandboxResult } from "../exec-sandbox.ts";
import { renderExecCall, renderExecResult } from "../tools/exec-tool-renderer.ts";
import { closeDatabase, openDatabase } from "../gsd-db.ts";

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
  assert.equal(result.details.purpose, "UAT M001/S01/UAT-PRE (uat-artifact-check)");
  assert.equal(requests[0]?.purpose, result.details.purpose);
  assert.equal(result.details.digest, "check passed");
});

test("executeGsdExec adds unchanged purpose and digest without changing raw text", async () => {
  for (const purpose of ["  Inspect counts\nwithout dumping files  ", "", undefined, 42]) {
    let request: ExecSandboxRequest | undefined;
    const result = await executeGsdExec(
      { script: "printf ok", purpose: purpose as string },
      {
        baseDir: "/tmp/gsd-exec-purpose-test",
        preferences: null,
        run: async (req) => {
          request = req;
          return makeExecResult(req);
        },
      },
    );
    assert.equal(result.details.digest, "check passed");
    assert.equal(result.details.purpose, typeof purpose === "string" ? purpose : undefined);
    assert.equal(request?.purpose, typeof purpose === "string" ? purpose : undefined);
    assert.equal(
      result.content[0].text,
      "gsd_exec[exec-1] runtime=bash exit=0 duration=1ms\n" +
      "  stdout: 12B → .gsd/exec/exec-1.stdout\n" +
      "  stderr: 0B → .gsd/exec/exec-1.stderr\n--- digest ---\ncheck passed",
    );
  }
});

test("exec registrations share renderers, request UI purpose, and preserve the UAT schema", () => {
  const tools: any[] = [];
  registerExecTools({ registerTool: (tool: any) => tools.push(tool) } as any);
  for (const name of ["gsd_exec", "gsd_uat_exec"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.equal(tool.renderCall, renderExecCall);
    assert.equal(tool.renderResult, renderExecResult);
  }
  const exec = tools.find((entry) => entry.name === "gsd_exec");
  assert.ok(exec.promptGuidelines.some((line: string) => /concise English purpose/.test(line)));
  assert.ok(!exec.parameters.required?.includes("purpose"));
  assert.equal(tools.find((entry) => entry.name === "gsd_uat_exec").parameters.properties.purpose, undefined);
});

test("purpose and digest survive a recording warning without changing execution success", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "gsd-exec-purpose-warning-"));
  try {
    mkdirSync(join(baseDir, ".gsd"));
    openDatabase(join(baseDir, ".gsd", "gsd.db"));
    const result = await executeGsdExec(
      { script: "printf ok", purpose: "Inspect output" },
      {
        baseDir,
        preferences: null,
        run: async (request) => ({
          ...makeExecResult(request),
          stdout_path: join(baseDir, "missing.stdout"),
        }),
      },
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.exit_code, 0);
    assert.equal(result.details.purpose, "Inspect output");
    assert.equal(result.details.digest, "check passed");
    assert.match(String(result.details.run_not_recorded), /ENOENT/);
    assert.match(result.content[0].text, /--- warning ---\nThe command ran, but the host did not record this run:/);
    assert.match(result.content[0].text, /not verification or UAT evidence\. Do not run the command again/);
  } finally {
    closeDatabase();
    rmSync(baseDir, { recursive: true, force: true });
  }
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
