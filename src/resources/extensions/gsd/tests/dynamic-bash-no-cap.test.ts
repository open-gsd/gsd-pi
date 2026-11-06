import test from "node:test";
import assert from "node:assert/strict";

import { createBashTool } from "@gsd/pi-coding-agent";

import { registerDynamicTools } from "../bootstrap/dynamic-tools.ts";
import { createAsyncBashTool } from "../../async-jobs/async-bash-tool.ts";

// These tests assert on the runtime tool objects the agent actually receives —
// the registered GSD bash tool, the core bash tool, and the async_bash tool —
// not on source text. The behavioral guarantee (an explicit timeout still
// fires after the silent 120s cap was removed) is exercised by spawning a real
// process at the bottom of the file.

/** Capture the GSD-registered `bash` tool object from registerDynamicTools. */
function registerAndCaptureBash(): any {
  let captured: any = undefined;
  const pi = {
    registerTool: (tool: any) => {
      if (!captured && tool && tool.name === "bash") captured = tool;
    },
  };
  registerDynamicTools(pi as any);
  assert.ok(captured, "registerDynamicTools must register a tool named 'bash'");
  return captured;
}

// 1. Cap removal: the GSD bash tool no longer injects a default timeout. The
//    schema's timeout stays optional (no `default`), so an omitted timeout
//    means "no timeout" rather than a silent 120s cap.
test("GSD bash tool exposes an optional timeout_ms with no injected default", () => {
  const bash = registerAndCaptureBash();
  const timeout = bash.parameters?.properties?.timeout_ms;
  assert.ok(timeout, "bash tool must expose a `timeout_ms` parameter");
  assert.equal(
    "default" in timeout,
    false,
    "the timeout_ms schema must not carry a default — an omitted timeout means uncapped",
  );
  assert.equal(
    bash.parameters?.required?.includes?.("timeout_ms") ?? false,
    false,
    "timeout_ms must remain optional",
  );
  assert.match(
    String(timeout.description ?? ""),
    /millisecond/i,
    "timeout_ms description must state its unit explicitly (issue #3095)",
  );
});

// 2. Watchdog verbiage is GSD-scoped: the core bash tool (reused by non-GSD
//    embeddings with no watchdog) must NOT claim a watchdog, while the
//    GSD-registered tool injects it into both description and timeout schema.
test("core bash tool does not advertise the auto-mode watchdog", () => {
  const core = createBashTool(process.cwd(), { spawnHook: (c: any) => c });
  assert.equal(
    /stalled-tool watchdog/.test(core.description ?? ""),
    false,
    "core bash must not advertise a watchdog — non-GSD embeddings have none",
  );
  assert.equal(
    /stalled-tool watchdog/.test(
      (core.parameters as any)?.properties?.timeout_ms?.description ?? "",
    ),
    false,
    "core bash timeout_ms schema must not advertise a watchdog",
  );
});

test("GSD-registered bash tool advertises the stalled-tool watchdog", () => {
  const bash = registerAndCaptureBash();
  assert.equal(
    /stalled-tool watchdog/.test(bash.description ?? ""),
    true,
    "the GSD bash description must name the stalled-tool watchdog",
  );
  assert.equal(
    /stalled-tool watchdog/.test(
      bash.parameters?.properties?.timeout_ms?.description ?? "",
    ),
    true,
    "the GSD bash timeout_ms schema must name the stalled-tool watchdog",
  );
});

// 3. async_bash guidance frames itself as a non-blocking/background choice and
//    no longer implies sync bash is time-capped.
test("async_bash guidance is non-blocking and drops the sync-cap implication", () => {
  const asyncTool: any = createAsyncBashTool(
    () => ({ register: () => "job-0" }) as any,
    () => process.cwd(),
  );
  const guidance = (asyncTool.promptGuidelines ?? []).join("\n");
  assert.equal(
    /more than a few seconds/.test(guidance),
    false,
    "async_bash guidance must not imply sync bash is time-capped",
  );
  assert.equal(
    /non-blocking/.test(guidance),
    true,
    "async_bash guidance must describe itself as non-blocking",
  );
});

// 4. Behavioral passthrough: an explicitly-set timeout is still honored after
//    the cap removal. A 1s timeout (1000ms, the tool's unit — issue #3095) on a
//    5s sleep must fire well under 5s.
test("GSD bash still forwards an explicit timeout (cap removal did not break passthrough)", async () => {
  const bash = registerAndCaptureBash();

  const start = Date.now();
  let resultText = "";
  try {
    const result: any = await bash.execute(
      "t1",
      { command: "sleep 5", timeout_ms: 1000 },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    resultText = JSON.stringify(result ?? "");
  } catch (err) {
    resultText = String(err instanceof Error ? err.message : err);
  }
  const elapsed = Date.now() - start;

  assert.equal(
    /timed out|timeout|exited with code|force-killed/i.test(resultText),
    true,
    `explicit 1s timeout should fire before the 5s sleep completes; got: ${resultText}`,
  );
  assert.ok(
    elapsed < 4500,
    `explicit timeout should fire quickly, not run to completion (elapsed ${elapsed}ms)`,
  );
});
