// Project/App: gsd-pi
// File Purpose: /gsd uat-answer — the host-owned path that records Human
// Acceptance for a prepared subjective Milestone UAT question. The model has
// no tool for this: only a person who types the command in the terminal UI
// can answer.

import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
import { isInteractiveCommandContext } from "./command-feedback.js";
import {
  answerMilestoneSubjectiveUat,
  listOpenMilestoneSubjectiveUat,
  type OpenMilestoneSubjectiveUat,
} from "./milestone-subjective-uat-domain-operation.js";
import { renderStateProjection } from "./workflow-projections.js";

const USAGE =
  'Usage: /gsd uat-answer <accept|reject> --rationale "why" [--question <questionId>]\n' +
  "Run /gsd uat-answer with no arguments to list the open subjective UAT questions.";

interface ParsedArgs {
  disposition?: "accepted" | "rejected";
  rationale?: string;
  questionId?: string;
}

function parseArgs(raw: string): ParsedArgs | null {
  const tokens = [...raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
  const parsed: ParsedArgs = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--rationale" || token === "--question") {
      const value = tokens[index + 1];
      if (!value) return null;
      if (token === "--rationale") parsed.rationale = value;
      else parsed.questionId = value;
      index += 1;
    } else if (token === "accept" || token === "reject") {
      parsed.disposition = token === "accept" ? "accepted" : "rejected";
    } else {
      return null;
    }
  }
  return parsed;
}

function describe(question: OpenMilestoneSubjectiveUat): string {
  return [
    `${question.milestoneId} — question ${question.questionId}`,
    `  ${question.focusedPrompt}`,
    `  Recommendation: ${question.recommendation}`,
  ].join("\n");
}

export async function handleUatAnswer(
  args: string,
  ctx: ExtensionCommandContext,
  basePath: string,
  atTerminal: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed) {
    ctx.ui.notify(USAGE, "warning");
    return;
  }
  // An RPC or headless session (gsd_execute, gsd headless) takes its commands
  // from a program over a pipe, and a model can be that program. Only the
  // terminal UI has a person at the keyboard.
  if (parsed.disposition && !(atTerminal && isInteractiveCommandContext(ctx))) {
    ctx.ui.notify(
      "gsd uat-answer: Human Acceptance is recorded only from the GSD terminal UI. " +
        "Start gsd in a terminal and type /gsd uat-answer there.",
      "error",
    );
    return;
  }
  if (!await ensureDbOpen(basePath)) {
    ctx.ui.notify("gsd uat-answer: GSD database is not available.", "error");
    return;
  }
  const open = listOpenMilestoneSubjectiveUat();
  if (open.length === 0) {
    ctx.ui.notify("gsd uat-answer: no subjective UAT question is waiting for an answer.", "info");
    return;
  }
  if (!parsed.disposition) {
    ctx.ui.notify(`Open subjective UAT questions:\n${open.map(describe).join("\n")}\n${USAGE}`, "info");
    return;
  }
  const matches = parsed.questionId ? open.filter((question) => question.questionId === parsed.questionId) : open;
  if (matches.length !== 1) {
    ctx.ui.notify(
      parsed.questionId
        ? `gsd uat-answer: no open subjective UAT question has the id ${parsed.questionId}.`
        : `gsd uat-answer: more than one question is open. Add --question <questionId>:\n${open.map(describe).join("\n")}`,
      "warning",
    );
    return;
  }
  if (!parsed.rationale?.trim()) {
    ctx.ui.notify(`gsd uat-answer: --rationale is required.\n${USAGE}`, "warning");
    return;
  }
  const question = matches[0]!;
  const option = parsed.disposition === "accepted" ? question.accepted : question.rejected;
  const id = randomUUID();
  try {
    const result = answerMilestoneSubjectiveUat({
      invocation: {
        idempotencyKey: `cli:gsd_uat_answer:${id}`,
        sourceTransport: "internal",
        actorType: "user",
        actorId: "gsd-cli-operator",
        traceId: id,
      },
      criterionId: question.criterionId,
      questionId: question.questionId,
      interactionId: question.interactionId,
      selectedOptionId: option.optionId,
      verbatimResponse: option.label,
      rationale: parsed.rationale.trim(),
      testedSourceRevision: question.testedSourceRevision,
    });
    await renderStateProjection(basePath);
    ctx.ui.notify(
      `Recorded your subjective UAT answer for ${question.milestoneId} as ${result.disposition}. Resume with /gsd auto.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`gsd uat-answer: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
