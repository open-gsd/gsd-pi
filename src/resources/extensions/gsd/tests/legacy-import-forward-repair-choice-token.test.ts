import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLegacyImportForwardRepairChoice,
  parseLegacyImportForwardRepairChoices,
} from "../legacy-import-forward-repair-choice-token.ts";

test("recover choice tokens round-trip target keys containing colons", () => {
  const choice = {
    instructionIndex: 7,
    targetKind: "artifact",
    targetKey: "external:artifact:one",
    reviewHash: `sha256:${"a".repeat(64)}`,
    decision: "preserve-later" as const,
  };

  const token = formatLegacyImportForwardRepairChoice(choice, choice.decision);

  assert.deepEqual(parseLegacyImportForwardRepairChoices(token), [choice]);
});

test("recover choice tokens reject blank target identities", () => {
  const token = formatLegacyImportForwardRepairChoice({
    instructionIndex: 7,
    targetKind: "artifact",
    targetKey: " ",
    reviewHash: `sha256:${"a".repeat(64)}`,
  }, "preserve-later");

  assert.throws(
    () => parseLegacyImportForwardRepairChoices(token),
    /choice token is invalid/,
  );
});
