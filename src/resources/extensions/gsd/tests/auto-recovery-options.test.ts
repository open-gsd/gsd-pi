// Project/App: gsd-pi
// File Purpose: Behavioral parser regressions; no source-grep or native DB dependency.
import assert from "node:assert/strict";
import test from "node:test";
import { parseAutoRecoverFlag } from "../auto-recovery-options.ts";

test("auto-recover is off by default and preserves ordinary arguments", () => {
  assert.deepEqual(parseAutoRecoverFlag("auto M001 --verbose"),
    { autoRecover: false, rest: "auto M001 --verbose" });
});

test("one exact flag is removed before model/milestone/wedge parsing", () => {
  assert.deepEqual(parseAutoRecoverFlag("auto --auto-recover M001 --model sol --resume-wedge wedge-1"),
    { autoRecover: true, rest: "auto M001 --model sol --resume-wedge wedge-1" });
});

test("tabs, newlines and trailing flag are normalized", () => {
  assert.deepEqual(parseAutoRecoverFlag("  auto\tM001\n--auto-recover  "),
    { autoRecover: true, rest: "auto M001" });
});

for (const value of ["--auto-recover=true", "--auto-recover=all", "--auto-recovery", "--auto-recover --auto-recover"]) {
  test(`invalid or duplicate auto-recover syntax is refused: ${value}`, () => {
    assert.throws(() => parseAutoRecoverFlag(`auto ${value}`), /without a value/);
  });
}

test("an ignore-UAT spelling cannot enable auto-recover", () => {
  assert.equal(parseAutoRecoverFlag("auto --ignore-uat").autoRecover, false);
});

for (const quotedPath of ['"seed  notes.md"', "'seed  notes.md'", String.raw`"seed  \"quoted\" notes.md"`, '"--auto-recover"']) {
  test(`quoted YOLO value is preserved without auto-recovery: ${quotedPath}`, () => {
    const input = `auto --yolo ${quotedPath}`;
    assert.deepEqual(parseAutoRecoverFlag(input), { autoRecover: false, rest: input });
  });
  test(`quoted YOLO value is preserved when removing auto-recovery: ${quotedPath}`, () => {
    assert.deepEqual(parseAutoRecoverFlag(`auto --auto-recover --yolo ${quotedPath}`),
      { autoRecover: true, rest: `auto --yolo ${quotedPath}` });
  });
}
