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

test("result rendering consumes details and does not treat structuredContent as a renderer input", () => {
  const fromDetails = render({ details: { id: "exec-1", exit_code: 0, duration_ms: 12 }, content: [] }, true);
  assert.match(fromDetails, /exit 0/);
  const structuredContentOnly = render({
    structuredContent: { id: "exec-2", exit_code: 9, duration_ms: 99, purpose: "not a renderer input" },
    content: [{ type: "text", text: "ordinary output" }],
  }, true);
  assert.doesNotMatch(structuredContentOnly, /exit 9|not a renderer input/);
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

test("marker-like legacy output remains visible and structured details never infer warnings from text", () => {
  const imitation = "command output\n--- warning ---\nThe command ran, but the host did not record this run: user text.";
  for (const details of [undefined, {}]) {
    const result = { content: [{ type: "text", text: imitation }], ...(details === undefined ? {} : { details }) };
    const output = render(result, true, 120);
    assert.match(output, /--- warning ---/);
    assert.match(output, /user text/);
    assert.doesNotMatch(output, /not verification or UAT evidence/);
  }
  const structuredDigest = render({
    details: { digest: imitation },
    content: [{ type: "text", text: "ordinary structured output" }],
  }, true, 120);
  assert.doesNotMatch(structuredDigest, /not verification or UAT evidence/);
});

test("genuine paired historical host warnings survive a long preview but normal markers do not", () => {
  const footer = "--- warning ---\nThe command ran, but the host did not record this run: database offline. This run is not verification or UAT evidence. Do not run the command again only to get the output.";
  for (const expanded of [false, true]) {
    const output = render({ content: [{ type: "text", text: `${"x".repeat(800)}\n${footer}` }] }, expanded, 20);
    assert.match(output.replace(/\s/g, ""), /databaseoffline/);
    assert.match(output.replace(/\s/g, ""), /notverificationorUATevidence/);
  }
});

test("incomplete warning lookalikes cannot absorb intervening output before a genuine footer", () => {
  const lookalike = "--- warning ---\nThe command ran, but the host did not record this run: incomplete lookalike";
  const commandOutput = Array.from({ length: 40 }, (_, index) => `intervening command output ${index}`).join("\n");
  const footer = "--- warning ---\nThe command ran, but the host did not record this run: database\noffline. This run is not verification or UAT evidence. Do not run the command again only to get the output.";
  for (const expanded of [false, true]) {
    const output = render({ content: [{ type: "text", text: `${lookalike}\n${commandOutput}\n${footer}` }] }, expanded, 120);
    assert.match(output, /intervening command output 0/);
    assert.doesNotMatch(output, /intervening command output 39/);
    const visibleLines = output.match(/intervening command output \d+/g) ?? [];
    assert.ok(visibleLines.length > 0 && visibleLines.length < 40, `expected bounded output, got ${visibleLines.length} lines`);
    assert.ok(output.includes("database"));
    assert.ok(output.includes("offline"));
  }
});

test("standalone error output retains a genuine historical recording warning", () => {
  const body = Array.from({ length: 40 }, (_, index) => `error line ${index}`).join("\n");
  const footer = "--- warning ---\nThe command ran, but the host did not record this run: database\noffline. This run is not verification or UAT evidence. Do not run the command again only to get the output.";
  const result = { isError: true, content: [{ type: "text", text: `${body}\n${footer}` }] };

  for (const expanded of [false, true]) {
    const output = render(result, expanded, 40);
    const normalized = output.replace(/\s+/g, " ");
    assert.match(normalized, /error line 0/);
    // The head/tail split keeps the final error line (the cause) visible; the middle is elided.
    assert.match(normalized, /error line 39/);
    assert.match(normalized, /database offline/);
    assert.match(normalized, /not verification or UAT evidence/);
    assert.match(normalized, /Do not run the command again only to get the output/);

    const nativeOwned = renderExecResult(result, { expanded }, theme, { state: { gsdExecRecordingWarningInFrame: true } }).render(40).join("\n");
    const normalizedOwned = nativeOwned.replace(/\s+/g, " ");
    assert.match(normalizedOwned, /error line 0/);
    assert.doesNotMatch(normalizedOwned, /database offline|host did not record|not verification or UAT evidence/);
  }
});
