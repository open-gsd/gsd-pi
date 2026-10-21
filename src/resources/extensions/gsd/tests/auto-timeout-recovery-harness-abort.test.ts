import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverTimedOutUnit } from "../auto-timeout-recovery.ts";
import {
  readUnitHarnessAbort,
  readUnitRuntimeRecord,
  recordUnitHarnessAbort,
} from "../unit-runtime.ts";

test("timeout recovery retry clears stale harness abort for the same unit run", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-timeout-recovery-abort-"));
  const startedAt = Date.now();
  mkdirSync(join(base, ".gsd"), { recursive: true });
  try {
    recordUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt, {
      kind: "turn-abort",
      reason: "Agent turn aborted before the unit could complete its gate evaluation.",
    });
    assert.equal(
      readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt)?.kind,
      "turn-abort",
      "test setup should start with an abort marker",
    );

    const messages: Array<{ message: unknown; options: unknown }> = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const result = await recoverTimedOutUnit(
      { ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) } } as any,
      { sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }) } as any,
      "gate-evaluate",
      "M001/S01/gates+Q3",
      "idle",
      {
        basePath: base,
        verbose: false,
        currentUnitStartedAt: startedAt,
        unitRecoveryCount: new Map(),
      },
    );

    assert.equal(result, "recovered");
    assert.equal(readUnitHarnessAbort(base, "gate-evaluate", "M001/S01/gates+Q3", startedAt), null);
    const record = readUnitRuntimeRecord(base, "gate-evaluate", "M001/S01/gates+Q3");
    assert.equal(record?.phase, "recovered");
    assert.equal(record?.lastProgressKind, "idle-recovery-retry");
    assert.equal(messages.length, 1, "retry recovery should send one steering message");
    assert.equal(notifications.length, 1, "retry recovery should notify once");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
