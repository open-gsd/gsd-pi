// Project/App: gsd-pi
// File Purpose: Regression tests for decisions-register enforcement at plan write time (#2248).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { saveDecisionToDb } from "../db-writer.ts";
import {
  activeVerifyFieldDecisions,
  isVerifyFieldDecision,
  validateVerifyAgainstActiveDecisions,
} from "../planning-decision-guard.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-planning-decision-guard-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Fix disclosure banner", status: "pending", demo: "Demo." });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("isVerifyFieldDecision matches verify-related scopes and decision text", () => {
  assert.equal(
    isVerifyFieldDecision({
      id: "D001",
      seq: 1,
      when_context: "",
      scope: "verify-field-rules",
      decision: "Shell only",
      choice: "grep",
      rationale: "x",
      revisable: "Yes",
      made_by: "agent",
      source: "planning",
      superseded_by: null,
    }),
    true,
  );
  assert.equal(
    isVerifyFieldDecision({
      id: "D002",
      seq: 2,
      when_context: "M001",
      scope: "auth",
      decision: "Keep verify commands shell-checkable",
      choice: "yes",
      rationale: "x",
      revisable: "Yes",
      made_by: "agent",
      source: "planning",
      superseded_by: null,
    }),
    true,
  );
});

test("validateVerifyAgainstActiveDecisions cites governing decisions on prose verify (#2248)", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const saved = await saveDecisionToDb({
    when_context: "",
    scope: "verify-field-rules",
    decision: "Every verify line must be a directly runnable shell command.",
    choice: "Shell commands only",
    rationale: "Pre-exec gate",
  }, base);
  assert.equal(activeVerifyFieldDecisions("M001").length, 1);
  const error = validateVerifyAgainstActiveDecisions(
    "Document exists and contains all required sections",
    "M001",
  );
  assert.ok(error);
  assert.match(error, new RegExp(saved.id));
  assert.match(error, /does not look like a runnable command/);
});

test("validateVerifyAgainstActiveDecisions passes shell verify when verify decisions are active", async (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  await saveDecisionToDb({
    when_context: "",
    scope: "verify-field-rules",
    decision: "Every verify line must be a directly runnable shell command.",
    choice: "Shell commands only",
    rationale: "Pre-exec gate",
  }, base);
  assert.equal(
    validateVerifyAgainstActiveDecisions("grep -q needle docs/file.md", "M001"),
    null,
  );
});
