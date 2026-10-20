import test from "node:test";
import assert from "node:assert/strict";
import { renderExecCall, renderExecResult, renderUatExecCall, sanitizeExecDisplayText } from "../tools/exec-tool-renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

function render(result: unknown, expanded = false, width = 120): string {
  return renderExecResult(result, { expanded }, theme).render(width).join("\n");
}

test("upstream call API retains standalone purpose and honors explicit native ownership", () => {
  for (const context of [undefined, { state: {} }, { state: { gsdExecPurposeInFrame: true } }]) {
    const owned = context?.state.gsdExecPurposeInFrame === true;
    const args = { purpose: "Inspect application", script: "echo private-command" };
    for (const call of [
      renderExecCall("Exec (Sandboxed)", args, theme, context),
      renderUatExecCall(args, theme, context),
    ]) {
      const output = call.render(120).join("\n");
      assert.equal(output.includes("Inspect application"), !owned);
      assert.doesNotMatch(output, /private-command/);
    }
  }
});

test("display sanitization removes DCS payloads and bidi controls without changing UAT args", () => {
  assert.equal(sanitizeExecDisplayText("safe\x1bPprivate-payload\x1b\\\u202etail"), "safetail");
  const args = { milestoneId: "\x1b[31mM001\x1b[0m", sliceId: "S01\n", checkId: "C01\u202e", intent: "uat-runtime-check" };
  const before = structuredClone(args);
  const output = renderUatExecCall(args, theme).render(180).join("\n");
  assert.match(output, /UAT M001\/S01\/C01 \(uat-runtime-check\)/);
  assert.doesNotMatch(output, /\u202e|\x1b/);
  assert.deepEqual(args, before);
});

test("ordinary warning text remains within visual preview budgets with or without metadata", () => {
  for (const details of [undefined, { id: "exec-1", exit_code: 0 }]) {
    for (const marker of ["--- warning ---", "The command ran, but the host did not record this run: command output."]) {
      for (const expanded of [false, true]) {
        const output = render({ details, content: [{ type: "text", text: `${marker}\n${"x".repeat(400)}` }] }, expanded, 10);
        assert.ok(output.split("\n").filter(line => /^x+$/.test(line.trim())).length <= (expanded ? 20 : 6));
        assert.match(output.replace(/\s/g, ""), /previewrowshidden/);
        assert.doesNotMatch(output.replace(/\s/g, ""), /notverificationorUATevidence/);
      }
    }
  }
});

test("structured digest wrapping is capped without shortening persisted log paths", () => {
  const path = `/tmp/${"directory".repeat(12)}/run.stdout`;
  for (const expanded of [false, true]) {
    const output = render({ details: { digest: "x".repeat(400), stdout_bytes: 400, stdout_path: path } }, expanded, 10);
    assert.ok(output.split("\n").filter(line => /^x+$/.test(line.trim())).length <= (expanded ? 20 : 6));
    assert.ok(output.replace(/\s/g, "").includes(path));
    // Upstream's per-line elision can fit exactly within the visual-row budget.
    assert.match(output.replace(/\s/g, ""), /previewrowshidden|…/);
  }
});

test("only explicit native recording-warning ownership suppresses the standalone row", () => {
  const result = { details: { run_not_recorded: "database offline" }, content: [], isError: true };
  for (const context of [undefined, { state: {} }, { state: { gsdExecPurposeInFrame: true } }]) {
    const output = renderExecResult(result, {}, theme, context).render(120).join("\n");
    assert.match(output, /not recorded \(database offline\)/);
    assert.match(output, /not verification or UAT evidence/);
  }
  const owned = renderExecResult(result, {}, theme, { state: { gsdExecRecordingWarningInFrame: true } }).render(120).join("\n");
  assert.doesNotMatch(owned, /not verification or UAT evidence/);
});

test("metadata reason wins without digest and empty recording failures remain visible", () => {
  const imitation = "--- warning ---\nThe command ran, but the host did not record this run: command imitation.";
  const output = render({ details: { run_not_recorded: "stored database reason" }, content: [{ type: "text", text: imitation }] });
  assert.match(output, /not recorded \(stored database reason\)/);
  const empty = render({ details: { run_not_recorded: "" }, content: [{ type: "text", text: "ready" }] });
  assert.match(empty, /not verification or UAT evidence/);
  const recorded = render({ details: { id: "exec-1", exit_code: 0 }, content: [{ type: "text", text: imitation }] });
  assert.doesNotMatch(recorded, /not verification or UAT evidence/);
});

test("genuine paired historical host warnings survive a long preview but normal markers do not", () => {
  const footer = "--- warning ---\nThe command ran, but the host did not record this run: database offline.";
  for (const expanded of [false, true]) {
    const output = render({ content: [{ type: "text", text: `${"x".repeat(800)}\n${footer}` }] }, expanded, 20);
    assert.match(output.replace(/\s/g, ""), /databaseoffline/);
    assert.match(output.replace(/\s/g, ""), /notverificationorUATevidence/);
  }
});
