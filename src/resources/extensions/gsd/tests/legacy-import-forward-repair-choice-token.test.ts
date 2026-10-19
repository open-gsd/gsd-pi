import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLegacyImportForwardRepairChoice,
  formatLegacyImportKnowledgeFileRowChoice,
  parseLegacyImportForwardRepairChoices,
  parseLegacyImportKnowledgeFileRowChoices,
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

test("recover choice parsing rejects a mistyped Preview choice token", () => {
  assert.deepEqual(parseLegacyImportForwardRepairChoices(`--choice=sha256:${"a".repeat(64)}.preserved`), []);
  assert.throws(
    () => parseLegacyImportForwardRepairChoices(`--choice=sha256:${"a".repeat(63)}.preserved`),
    /choice token is invalid/,
  );
});

test("recover choice parsing reads a knowledge row choice and rejects a mistyped one", () => {
  const token = formatLegacyImportKnowledgeFileRowChoice("P001");

  assert.deepEqual(parseLegacyImportKnowledgeFileRowChoices(`${token} --choice=K002.use-file ${token}`), ["P001", "K002"]);
  assert.deepEqual(parseLegacyImportForwardRepairChoices(token), []);
  assert.throws(
    () => parseLegacyImportForwardRepairChoices("--choice=MEM001.use-file"),
    /choice token is invalid/,
  );
});
