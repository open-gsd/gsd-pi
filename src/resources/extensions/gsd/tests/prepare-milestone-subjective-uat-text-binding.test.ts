// Project/App: gsd-pi
// File Purpose: The prepare subjective-UAT tool hands the question to the user, and only the
// host command /gsd uat-answer records Human Acceptance (ADR-046).

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { executePrepareMilestoneSubjectiveUat } from "../tools/workflow-tool-executors.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { handleUatAnswer } from "../commands-uat-answer.ts";
import { WORKFLOW_TOOL_CONTRACTS } from "@opengsd/contracts";
import { normalizeRealPath } from "../paths.ts";

let basePath: string | undefined;

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function textOf(result: { content: Array<{ type: "text"; text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

function prepareExecutorInput() {
  return {
    milestoneId: "M001",
    criterionKey: "guided-flow",
    description: "The guided flow feels natural and clear.",
    focusedPrompt: "Does the guided flow feel natural and clear?",
    recommendedDisposition: "accepted" as const,
    recommendationRationale: "Automated checks passed and the guided path is complete.",
    recommendationEvidence: "Current technical validation receipt.",
    recommendationConfidence: 0.8,
    testedSourceRevision: "source-a",
  };
}

function setup(): string {
  basePath = join(tmpdir(), `gsd-uat-text-binding-${randomUUID()}`);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(normalizeRealPath(basePath), ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Subjective UAT", status: "active" });
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.milestone.adopt",
    idempotencyKey: "fixture/milestone/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { milestoneId: "M001" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.milestone.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: { milestoneId: "M001" },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/milestone/m001",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  return basePath;
}

/**
 * Run the host command and return what it told the caller. "terminal" is the
 * terminal UI with a person at the keyboard. "rpc" has a UI context, but its
 * stdin and stdout are pipes. "headless" is the session `gsd headless` starts.
 */
async function uatAnswer(
  base: string,
  args: string,
  session: "terminal" | "rpc" | "headless" = "terminal",
): Promise<string[]> {
  const messages: string[] = [];
  const ctx = { hasUI: true, ui: { notify: (message: string) => { messages.push(message); } } };
  const previousHeadless = process.env.GSD_HEADLESS;
  if (session === "headless") process.env.GSD_HEADLESS = "1";
  else delete process.env.GSD_HEADLESS;
  try {
    await handleUatAnswer(args, ctx as unknown as Parameters<typeof handleUatAnswer>[1], base, session === "terminal");
  } finally {
    if (previousHeadless === undefined) delete process.env.GSD_HEADLESS;
    else process.env.GSD_HEADLESS = previousHeadless;
  }
  return messages;
}

function humanAcceptances(): Array<Record<string, unknown>> {
  return db().prepare("SELECT disposition, actor_id, rationale FROM workflow_human_acceptances").all();
}

afterEach(() => {
  closeDatabase();
  if (basePath) rmSync(basePath, { recursive: true, force: true });
  basePath = undefined;
});

test("no workflow tool contract records Human Acceptance", () => {
  assert.deepEqual(
    WORKFLOW_TOOL_CONTRACTS.filter((contract) => /answer/.test(contract.canonicalName)).map((contract) => contract.canonicalName),
    [],
    "no workflow tool contract may answer a question for the user",
  );
});

test("prepare subjective UAT hands the question to the user and gives the model no answer binding", async () => {
  const base = setup();
  const result = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/1"),
  );
  assert.notEqual(result.isError, true);

  const text = textOf(result);
  assert.ok(
    text.startsWith("Prepared subjective UAT for M001: Does the guided flow feel natural and clear?"),
  );
  assert.match(text, /\/gsd uat-answer <accept\|reject>/);
  assert.match(text, /You cannot record it/);
  assert.deepEqual(humanAcceptances(), [], "preparing a question records no acceptance");
});

test("/gsd uat-answer accept records Human Acceptance for the prepared question", async () => {
  const base = setup();
  await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/accept"),
  );

  const listed = await uatAnswer(base, "");
  assert.match(listed.join("\n"), /Does the guided flow feel natural and clear\?/);
  assert.deepEqual(humanAcceptances(), [], "listing the open questions records nothing");

  const messages = await uatAnswer(base, 'accept --rationale "The guided flow is clear to me."');

  assert.match(messages.join("\n"), /Recorded your subjective UAT answer for M001 as accepted/);
  assert.deepEqual(humanAcceptances(), [{
    disposition: "accepted",
    actor_id: "gsd-cli-operator",
    rationale: "The guided flow is clear to me.",
  }]);
  assert.deepEqual(
    db().prepare("SELECT question_status FROM workflow_open_questions").all(),
    [{ question_status: "answered" }],
  );
});

test("/gsd uat-answer reject records a rejected Human Acceptance", async () => {
  const base = setup();
  await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/reject"),
  );

  await uatAnswer(base, 'reject --rationale "The second step is confusing."');

  assert.deepEqual(humanAcceptances().map((row) => row["disposition"]), ["rejected"]);
});

test("/gsd uat-answer records nothing without a rationale or without an open question", async () => {
  const base = setup();
  assert.match((await uatAnswer(base, 'accept --rationale "ok"')).join("\n"), /no subjective UAT question is waiting/);

  await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/no-rationale"),
  );
  assert.match((await uatAnswer(base, "accept")).join("\n"), /--rationale is required/);
  assert.deepEqual(humanAcceptances(), []);
});

test("/gsd uat-answer sent through an RPC session records no Human Acceptance", async () => {
  const base = setup();
  await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/rpc"),
  );

  const messages = await uatAnswer(base, 'accept --rationale "ok"', "rpc");

  assert.match(messages.join("\n"), /recorded only from the GSD terminal UI/);
  assert.deepEqual(humanAcceptances(), []);
  assert.deepEqual(
    db().prepare("SELECT question_status FROM workflow_open_questions").all(),
    [{ question_status: "open" }],
    "the question stays open for the person",
  );
  assert.match(
    (await uatAnswer(base, "", "rpc")).join("\n"),
    /Does the guided flow feel natural and clear\?/,
    "an RPC session can still list the open questions",
  );
});

test("/gsd uat-answer sent through gsd headless records no Human Acceptance", async () => {
  const base = setup();
  await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    base,
    internalExecutionInvocation("test/uat-text/prepare/headless"),
  );

  const messages = await uatAnswer(base, 'accept --rationale "ok"', "headless");

  assert.match(messages.join("\n"), /recorded only from the GSD terminal UI/);
  assert.deepEqual(humanAcceptances(), []);
});

test("prepare subjective UAT error paths keep their existing text", async () => {
  const missingBase = join(tmpdir(), `gsd-uat-text-missing-${randomUUID()}`);
  const unavailable = await executePrepareMilestoneSubjectiveUat(
    prepareExecutorInput(),
    missingBase,
    internalExecutionInvocation("test/uat-text/prepare/db-unavailable"),
  );
  assert.equal(unavailable.isError, true);
  assert.equal(
    textOf(unavailable),
    "Error: GSD database is not available. Cannot prepare subjective UAT.",
  );
  assert.deepEqual(unavailable.details, {
    operation: "prepare_milestone_subjective_uat",
    error: "db_unavailable",
  });

  const base = setup();
  const failed = await executePrepareMilestoneSubjectiveUat({
    ...prepareExecutorInput(),
    milestoneId: "M404",
  }, base, internalExecutionInvocation("test/uat-text/prepare/no-lifecycle"));
  assert.equal(failed.isError, true);
  assert.ok(textOf(failed).startsWith("Error preparing subjective UAT:"));
  assert.equal(String(failed.details.error).length > 0, true);
  assert.equal(failed.details.operation, "prepare_milestone_subjective_uat");
});
