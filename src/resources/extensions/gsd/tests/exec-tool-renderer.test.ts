import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@gsd/pi-coding-agent";
import { renderExecCall, renderExecResult } from "../tools/exec-tool-renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  italic: (text: string) => text,
} as Theme;

function details(overrides: Record<string, unknown> = {}) {
  return {
    id: "exec-1", runtime: "bash", exit_code: 0, signal: null,
    timed_out: false, aborted: false, force_resolved: false, duration_ms: 12,
    stdout_bytes: 9, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false,
    stdout_path: "/tmp/project [copy]/.gsd/exec/run.stdout",
    stderr_path: "C:\\project [copy]\\exec\\run.stderr",
    meta_path: "/tmp/project [copy]/.gsd/exec/run.meta.json",
    digest: "9 matches", ...overrides,
  };
}

function render(value: unknown, expanded = false, width = 120): string {
  return renderExecResult(value, { expanded, isPartial: false }, theme)
    .render(width).map((line) => line.trimEnd()).join("\n");
}

test("call renders only muted italic purpose, never script or heading", () => {
  const calls: string[] = [];
  const styled = {
    fg: (color: string, text: string) => { calls.push(color); return text; },
    italic: (text: string) => { calls.push("italic"); return text; },
  } as Theme;
  const output = renderExecCall({ purpose: "Count matches", script: "secret script" }, styled).render(80).join("\n");
  assert.equal(output.trim(), "Count matches");
  assert.deepEqual(calls, ["italic", "muted"]);
});

test("call fallbacks match runtime defaults, aliases, unknown and malformed args", () => {
  for (const [runtime, expected] of [
    [undefined, "Run a Bash script"], ["", "Run a Bash script"], ["SH", "Run a Bash script"],
    ["nodejs", "Run a Node.js script"], [" javascript ", "Run a Node.js script"],
    ["py", "Run a Python script"], ["python3", "Run a Python script"],
    ["ruby", "Run a script"], [42, "Run a script"],
  ] as const) {
    assert.equal(renderExecCall({ runtime, purpose: " \n " }, theme).render(80).join("").trim(), expected);
  }
  assert.equal(renderExecCall(null, theme).render(80).join("").trim(), "Run a Bash script");
});

test("rich result explains logs, bytes, empty/truncated state and preserves exact paths as text", () => {
  const data = details({ purpose: "Inspect matches", stdout_truncated: true });
  const output = render({ details: data });
  for (const expected of [
    "Inspect matches", "runtime: bash", "exit: 0", "duration: 12ms", "9 matches",
    "9B captured; truncated on disk", "0B captured; empty",
    "standard output (command results)", "standard error (diagnostics; not necessarily a failure)",
    data.stdout_path, data.stderr_path, data.meta_path,
  ]) assert.ok(output.includes(expected), `missing ${expected}`);
  assert.doesNotMatch(output, /\x1b|\]\(file:|\]\(https?:/);
});

test("preview cap is applied after wrapping and never hides facts, paths or recording warnings", () => {
  const data = details({
    digest: "x".repeat(400), run_not_recorded: "database unavailable",
    purpose: "Inspect", exit_code: 2,
  });
  for (const expanded of [false, true]) {
    const lines = render({ details: data }, expanded, 10).split("\n");
    const previewRows = lines.filter((line) => /^x+$/.test(line));
    assert.equal(previewRows.length, expanded ? 20 : 6);
    const joined = lines.join("").replace(/\s/g, "");
    assert.match(joined, /previewrowshidden/);
    assert.match(joined, /exit:2/);
    assert.ok(joined.includes(data.stdout_path.replace(/\s/g, "")));
    assert.match(joined, /notverificationorUATevidence/);
    assert.match(joined, /Donotrunthecommandagain/);
  }
});

test("warning-like structured output stays within the preview cap without a recording warning", () => {
  for (const marker of ["--- warning ---", "The command ran, but the host did not record this run"]) {
    for (const expanded of [false, true]) {
      const digest = [marker, ...Array.from({ length: 40 }, (_, i) => `output ${i}`)].join("\n");
      const content = [{ type: "text", text: `header\n--- digest ---\n${digest}` }];
      const output = render({ details: details({ digest }), content }, expanded, 160);
      assert.equal(output.split(marker).length - 1, 1);
      assert.equal(output.split("\n").filter((line) => /^output \d+$/.test(line)).length, expanded ? 19 : 5);
      assert.match(output, /preview rows hidden/);
      assert.doesNotMatch(output, /output 39|not verification or UAT evidence|Do not run the command again/);
    }
  }
});

test("structured recording failure uses its reason rather than warning-like command output", () => {
  const digest = "The command ran, but the host did not record this run: printed by command.\n--- warning ---";
  const output = render({
    details: details({ digest, run_not_recorded: "actual database failure" }),
    content: [{ type: "text", text: `header\n--- digest ---\n${digest}` }],
  }, true, 160).replace(/\s+/g, " ");
  assert.match(output, /Warning: The command ran, but the host did not record this run: actual database failure/);
  assert.equal(output.split("printed by command").length - 1, 1);
  assert.equal(output.split("Do not run the command again").length - 1, 1);
});

test("an empty structured digest does not enable legacy warning extraction", () => {
  const result = {
    details: details({ digest: "" }),
    content: [{ type: "text", text: "--- warning ---\nThe command ran, but the host did not record this run" }],
  };
  for (const expanded of [false, true]) {
    const output = render(result, expanded);
    assert.match(output, /no output preview/);
    assert.doesNotMatch(output, /--- warning ---|did not record this run/);
  }
});

test("execution status preserves abort, timeout, force-kill, signal and unknown distinctions", () => {
  for (const [extra, expected] of [
    [{ aborted: true }, "aborted"],
    [{ aborted: true, force_resolved: true }, "aborted (force-killed)"],
    [{ timed_out: true }, "timeout"],
    [{ force_resolved: true }, "timeout (force-killed)"],
    [{ signal: "SIGTERM" }, "signal: SIGTERM"],
    [{ exit_code: null }, "unknown"],
  ] as const) assert.ok(render({ details: details(extra) }).includes(`exit: ${expected}`));
});

test("preview budgets count wide Unicode cells and reflow on width or expansion changes", () => {
  const component = renderExecResult({ details: details({ digest: "界".repeat(40) }) }, { expanded: false }, theme);
  assert.equal(component.render(8).filter((line) => /^界+\s*$/.test(line)).length, 6);
  assert.equal(component.render(80).filter((line) => /^界+\s*$/.test(line)).length, 1);
  component.invalidate();
  const expanded = renderExecResult({ details: details({ digest: "界".repeat(40) }) }, { expanded: true }, theme);
  assert.equal(expanded.render(8).filter((line) => /^界+\s*$/.test(line)).length, 10);
});

test("sanitizes terminal controls and bidi overrides without mutating stored values", () => {
  const unsafe = "\x1b[2JCount\x1b]8;;https://example.com\x07 matches\x1b]8;;\x07\x00\u202e\x1bPprivate payload\x1b\\";
  const data = details({ purpose: unsafe, digest: unsafe, stdout_path: "/tmp/\x1b[31mout.stdout" });
  const output = render({ details: data });
  assert.doesNotMatch(output, /[\x00-\x08\x1b\u202e]|https:\/\/example.com|private payload/);
  assert.match(output, /Count matches/);
  assert.match(output, /\/tmp\/out.stdout/);
  assert.equal((data as Record<string, unknown>).purpose, unsafe);
  assert.equal(renderExecCall({ purpose: "Count\n\tmatches" }, theme).render(80).join("").trim(), "Count matches");
});

test("legacy/malformed results fall back to safe text and preserve warnings outside preview caps", () => {
  for (const value of [null, undefined, {}, { content: [null, { type: "image" }] }, { details: [] }]) {
    assert.match(render(value), /no output preview/);
  }
  const warning = "The command ran, but the host did not record this run: locked. This run is not verification or UAT evidence.";
  const legacy = { content: [{ type: "text", text: `${"line\n".repeat(100)}--- warning ---\n${warning}` }] };
  const output = render(legacy);
  assert.match(output, /preview rows hidden/);
  assert.ok(output.includes(warning));
  assert.match(render({ content: [{ type: "text", text: "Error: invalid runtime" }], details: { error: "invalid_params" } }), /Error: invalid runtime/);
  assert.match(render({ details: details({ digest: undefined }), content: [{ type: "text", text: "header\n--- digest ---\nlegacy preview" }] }), /legacy preview/);
});

test("empty digest and unknown stream metadata remain readable", () => {
  const output = render({ details: details({ digest: "", stdout_bytes: NaN, stderr_path: null, duration_ms: "bad", run_not_recorded: "" }) });
  assert.match(output, /no output preview/);
  assert.match(output, /unknown captured/);
  assert.match(output, /duration: unknown/);
  assert.match(output, /path unavailable/);
  assert.match(output, /did not record this run/);
});
