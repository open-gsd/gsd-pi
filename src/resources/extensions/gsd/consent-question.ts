/**
 * Consent Question module — the single home for the user-question lifecycle:
 * classification → gating → answer validation → cancellation.
 *
 * Every question the assistant puts to a human is classified into a kind, and
 * the kind alone decides the fail policy:
 *
 *   - "gate"          — mechanical write gates (depth verification, destructive
 *                       confirm). Fail-closed; structural answer validation is
 *                       delegated to the write-gate validators.
 *   - "consent"       — approval/confirmation questions ("ready to write?",
 *                       "is this correct?"). Fail-closed.
 *   - "decision"      — explicit user decisions (research vs skip). Fail-closed.
 *   - "informational" — anything that is not asking the user to consent or
 *                       decide. Fail-open.
 *
 * Fail-closed means an empty/missing answer is NEVER treated as an answer —
 * evaluateAnswer returns "waiting" so callers pause instead of proceeding.
 * This fixes #528 (empty `selected` on a non-gate question used to pass
 * through as a real answer) by construction.
 *
 * shouldPauseForQuestion replaces the old unit-type allowlist: a classified
 * consent/decision question pauses regardless of unit type, including
 * interactive mode where no unit is active. This fixes #682 (prose approval
 * questions outside the 4 allowlisted discuss units rendered as un-gated
 * prose menus) by construction.
 */

import { isGateQuestionId } from "./bootstrap/write-gate.js";
import {
  evaluateGateAnswer,
  hasNotesValue,
  hasSelectedValue,
  type VerdictAnswerDetails,
  type VerdictQuestionShape,
} from "./consent-verdict.js";
import { isDestructiveConfirmGateId } from "./safety/destructive-confirmation.js";

// ── Taxonomy ────────────────────────────────────────────────────────────────

export type QuestionKind = "gate" | "consent" | "decision" | "informational";

export type GateSubKind = "depth-verification" | "approval" | "destructive-confirm";

export type FailPolicy = "closed" | "open";

export type AnswerOutcome = "waiting" | "answered" | "verified" | "declined" | "cancelled" | "timeout";

export interface ClassifiedQuestion {
  kind: QuestionKind;
  gateSubKind?: GateSubKind;
}

/** Fail policy is derived from the kind — there is no per-question override. */
export function failPolicyForKind(kind: QuestionKind): FailPolicy {
  return kind === "informational" ? "open" : "closed";
}

// ── Prose detectors (moved from user-input-boundary) ────────────────────────

const REMOTE_QUESTION_FAILURE_RE =
  /(?:Remote (?:auth failed|questions failed|channel configured but returned no result|questions timed out|questions timed out or failed)|Failed to send questions via)/i;

const APPROVAL_WAIT_RE =
  /\bwait(?:ing)?\s+for\s+(?:your\s+)?(?:confirmation|approval|input|response|answer)\b/i;

const APPROVAL_QUESTION_RE =
  /\b(?:confirm|confirmation|approve|approval|approved|captured|correct|correctly|happy\s+with|ready\s+to\s+(?:write|save|proceed|ship)|(?:want|need)\s+to\s+adjust|should\s+I\s+(?:write|save|proceed)|do\s+you\s+want\s+me\s+to\s+(?:write|save|proceed)|ship\s+it)\b/i;

const APPROVAL_RIGHT_QUESTION_RE =
  /\b(?:does|do|is|are|was|were|did)\b[^\n?]{0,120}\bright\b/i;

const APPROVAL_CHANGE_QUESTION_RE =
  /\b(?:anything\s+else|anything|something)\s+to\s+(?:adjust|add|remove|reclassify)\b/i;

const RESEARCH_DECISION_QUESTION_RE =
  /\b(?:research|skip)\b/i;

const ASK_USER_QUESTIONS_CANCELLED_RE =
  /ask_user_questions was cancelled before receiving a response/i;

/** Scan question-mark-terminated fragments of `text` against `patterns`. */
function hasQuestionMatching(text: string, patterns: RegExp[]): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "?") continue;
    const previousBreak = Math.max(
      text.lastIndexOf("\n", i),
      text.lastIndexOf(".", i),
      text.lastIndexOf("!", i),
      text.lastIndexOf("?", i - 1),
    );
    const fragment = text.slice(previousBreak + 1, i + 1);
    if (patterns.some((pattern) => pattern.test(fragment))) return true;
  }
  return false;
}

export function hasApprovalQuestion(text: string): boolean {
  return hasQuestionMatching(text, [
    APPROVAL_QUESTION_RE,
    APPROVAL_RIGHT_QUESTION_RE,
    APPROVAL_CHANGE_QUESTION_RE,
  ]);
}

export function hasResearchDecisionQuestion(text: string): boolean {
  return hasQuestionMatching(text, [RESEARCH_DECISION_QUESTION_RE]);
}

/**
 * Detect a plain-text "Next steps:" menu — numbered options with an "Other"
 * choice — emitted as prose instead of a structured ask_user_questions call.
 * Without this, auto-mode treats the menu as informational and loops on its
 * own turn until tokens are exhausted (#454).
 */
export function hasPlainTextNextStepsMenu(lines: string[]): boolean {
  const nextStepsIndex = lines.findIndex((line) => /^next steps\s*:?$/i.test(line));
  if (nextStepsIndex < 0) return false;
  const menuLines = lines.slice(nextStepsIndex + 1);
  const numberedOptions = menuLines.filter((line) => /^\d+[.)]\s+\S/.test(line));
  return numberedOptions.length >= 2 && numberedOptions.some((line) => /\bother\b/i.test(line));
}

// ── Message text extraction (moved from user-input-boundary) ────────────────

function extractMessageText(msg: unknown, includeThinking: boolean): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
    // Thinking blocks are internal reasoning, not user-visible — included only
    // when the caller asks for the full transcript text.
    if (includeThinking && typed.type === "thinking" && typeof typed.thinking === "string") {
      parts.push(typed.thinking);
    }
  }
  return parts.join("\n");
}

function lastAssistantMessageText(
  messages: unknown[] | null | undefined,
  includeThinking: boolean,
): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    if ((msg as { role?: unknown }).role !== "assistant") continue;
    const text = extractMessageText(msg, includeThinking).trim();
    if (text) return text;
  }
  return "";
}

export function lastAssistantText(messages: unknown[] | null | undefined): string {
  return lastAssistantMessageText(messages, true);
}

function lastAssistantVisibleText(messages: unknown[] | null | undefined): string {
  return lastAssistantMessageText(messages, false);
}

function anyMessageMatches(messages: unknown[] | undefined, patterns: RegExp[]): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => {
    if (!msg || typeof msg !== "object") return false;
    if ((msg as { role?: unknown }).role === "user") return false;
    const text = extractMessageText(msg, false);
    return patterns.some((pattern) => pattern.test(text));
  });
}

// ── Classification ──────────────────────────────────────────────────────────

const APPROVAL_GATE_ID_RE = /^depth_verification_.+_confirm$/;

export interface ClassifyQuestionInput {
  /** ask_user_questions question id, when classifying a structured question. */
  id?: unknown;
  /** Question options, when classifying a structured question. */
  options?: Array<{ label?: string }> | undefined;
  /** Prose text, when classifying a streamed text boundary. */
  text?: string;
  /** Active unit type, used to pick the prose detector for decisions. */
  unitType?: string;
}

/**
 * Classify a question — structured (by id) or prose (by text) — into a kind.
 *
 * Structured questions with a recognized gate id are gates; every other
 * structured question is asking the user something, so it classifies as
 * consent (fail-closed). Prose classifies by the approval/decision detectors;
 * prose that matches neither is informational (fail-open).
 */
export function classifyQuestion(input: ClassifyQuestionInput): ClassifiedQuestion {
  if (isDestructiveConfirmGateId(input.id)) {
    return { kind: "gate", gateSubKind: "destructive-confirm" };
  }
  if (typeof input.id === "string" && isGateQuestionId(input.id)) {
    return {
      kind: "gate",
      gateSubKind: APPROVAL_GATE_ID_RE.test(input.id) ? "approval" : "depth-verification",
    };
  }
  // Any other structured question is a real elicitation of the user.
  if (typeof input.id === "string" || Array.isArray(input.options)) {
    return { kind: "consent" };
  }
  const text = input.text ?? "";
  if (input.unitType === "research-decision" && hasResearchDecisionQuestion(text)) {
    return { kind: "decision" };
  }
  if (hasApprovalQuestion(text)) {
    return { kind: "consent" };
  }
  return { kind: "informational" };
}

// ── Answer validation ───────────────────────────────────────────────────────

// The question/answer shapes are the consent-verdict leaf's shapes — one
// definition shared with write-gate so the two consumers cannot drift.
export type ConsentQuestionShape = VerdictQuestionShape;
export type ConsentAnswerDetails = VerdictAnswerDetails;

/**
 * THE single policy point for whether a question's answer counts as answered.
 *
 * - timed_out rounds → "timeout" for every kind (host elicitation expired
 *   before the user answered; fail-closed, but the caller pauses-and-waits
 *   instead of re-asking into the same timeout loop, #852).
 * - cancelled rounds → "cancelled" for every kind.
 * - gate: delegates to evaluateGateAnswer in the consent-verdict leaf — the
 *   same verdict engine write-gate's applyAskUserQuestionsGateResult consumes;
 *   confirm option → "verified", any other real selection → "declined",
 *   empty/missing → "waiting" (fail-closed).
 * - consent/decision: a non-empty selection or non-empty notes → "answered";
 *   empty/missing → "waiting" (fail-closed; fixes #528).
 * - informational: always "answered" (fail-open).
 */
export function evaluateAnswer(options: {
  question: ConsentQuestionShape;
  details: ConsentAnswerDetails;
}): AnswerOutcome {
  const { question, details } = options;
  if (details.timed_out) return "timeout";
  if (details.cancelled) return "cancelled";

  const { kind } = classifyQuestion({ id: question.id, options: question.options });
  if (failPolicyForKind(kind) === "open") return "answered";

  if (kind === "gate") {
    // Gates keep strict structural validation: only the confirmation option
    // verifies; notes never satisfy a gate.
    return evaluateGateAnswer(question, details);
  }

  const questionId = typeof question.id === "string" ? question.id : "";
  const answer = details.response?.answers?.[questionId];

  if (hasSelectedValue(answer?.selected)) return "answered";
  // Notes-only is a real user utterance for consent/decision questions, but
  // never for gates (handled above).
  if (hasNotesValue(answer?.notes)) return "answered";
  return "waiting";
}

const OUTCOME_PRECEDENCE: AnswerOutcome[] = [
  "cancelled",
  "timeout",
  "waiting",
  "declined",
  "verified",
  "answered",
];

/**
 * Evaluate a whole ask_user_questions round. The round outcome is the most
 * blocking per-question outcome (cancelled > waiting > declined > verified >
 * answered). An empty round with a response is "answered"; an empty round
 * without a response is "waiting" only when cancelled is not set and there is
 * nothing to validate — callers treat a missing response with no questions as
 * a no-op, so it reports "answered" here.
 */
export function evaluateAskUserQuestionsRound(
  questions: ConsentQuestionShape[],
  details: ConsentAnswerDetails,
): AnswerOutcome {
  // timed_out is checked before cancelled: a host elicitation timeout is a
  // more specific signal than the deliberate-dismissal cancelled it is also
  // marked with, and callers must pause-and-wait instead of treating it as a
  // re-ask-able cancel (#852).
  if (details.timed_out) return "timeout";
  if (details.cancelled) return "cancelled";
  let worst: AnswerOutcome = "answered";
  for (const question of questions) {
    const outcome = evaluateAnswer({ question, details });
    if (OUTCOME_PRECEDENCE.indexOf(outcome) < OUTCOME_PRECEDENCE.indexOf(worst)) {
      worst = outcome;
    }
  }
  return worst;
}

export function formatUnansweredConsentQuestionMessage(questions: ConsentQuestionShape[]): string {
  const ids = questions
    .map((question) => (typeof question.id === "string" ? question.id : null))
    .filter((id): id is string => Boolean(id));
  return [
    `ask_user_questions returned without a selection${ids.length ? ` for ${ids.join(", ")}` : ""}.`,
    "An empty answer is not consent — do not infer approval or proceed.",
    "Re-call ask_user_questions with the same question(s) and wait for the user's response.",
  ].join(" ");
}

// ── Pause gating (replaces the unit-type allowlist) ─────────────────────────

/**
 * Shared preamble for the awaiting-input predicates: cancellation and remote
 * delivery failures always pause (an undelivered question can never be
 * answered, so proceeding would be fail-open), as does an explicit
 * "waiting for your approval/input" phrase in the last assistant text.
 *
 * Returns `forced: true` when the boundary is unconditional, plus the last
 * assistant visible text for the caller's own classification.
 */
function awaitingBoundary(messages: unknown[] | undefined): { forced: boolean; text: string } {
  if (anyMessageMatches(messages, [ASK_USER_QUESTIONS_CANCELLED_RE, REMOTE_QUESTION_FAILURE_RE])) {
    return { forced: true, text: "" };
  }
  const text = lastAssistantVisibleText(messages);
  if (text && APPROVAL_WAIT_RE.test(text)) return { forced: true, text };
  return { forced: false, text };
}

/**
 * Decide whether the assistant should pause for a prose user question.
 *
 * Unlike the retired USER_APPROVAL_UNIT_TYPES allowlist, this pauses for any
 * classified consent/decision question regardless of unit type — including
 * interactive mode where no unit is active (#682).
 */
export function shouldPauseForQuestion(
  unitType: string | undefined,
  messages: unknown[] | undefined,
): boolean {
  const { forced, text } = awaitingBoundary(messages);
  if (forced) return true;
  // Streaming hot path: this runs on every message_update for every unit type.
  // The classifiers only ever match question-mark-terminated fragments, so
  // text without a "?" can never classify as consent/decision — bail before
  // the multi-regex scan.
  if (!text || !text.includes("?")) return false;
  const { kind } = classifyQuestion({ text, unitType });
  return kind === "consent" || kind === "decision";
}

// ── Awaiting-input boundaries (moved from user-input-boundary) ──────────────

export function isAwaitingUserInput(messages: unknown[] | undefined): boolean {
  const { forced, text } = awaitingBoundary(messages);
  if (forced) return true;
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => line.endsWith("?"))) return true;
  if (hasPlainTextNextStepsMenu(lines)) return true;
  return hasApprovalQuestion(text);
}

export function isAwaitingApprovalBoundary(messages: unknown[] | undefined): boolean {
  // With no unit type, classification reduces to the approval detectors —
  // exactly the approval boundary.
  return shouldPauseForQuestion(undefined, messages);
}

// ── Approval gate ids + explicit responses (moved from user-input-boundary) ─

export function approvalGateIdForUnit(
  unitType: string | undefined,
  unitId?: string | null,
): string | null {
  if (!unitType) return null;
  if (unitType === "discuss-project") return "depth_verification_project_confirm";
  if (unitType === "discuss-requirements") return "depth_verification_requirements_confirm";
  if (unitType === "research-decision") return "depth_verification_research_decision_confirm";
  if (unitType === "discuss-milestone") {
    const safeUnitId = typeof unitId === "string" && /^[A-Za-z0-9_-]+$/.test(unitId)
      ? unitId
      : "milestone";
    return `depth_verification_${safeUnitId}_confirm`;
  }
  return null;
}

const CHANGE_REQUEST_RESPONSE_RE =
  /\b(?:no|nope|nah|not\s+yet|don't|do\s+not|change|add|remove|reclassify|adjust|clarify|missing|instead|but|however|wait|hold)\b/i;

const APPROVAL_RESPONSE_RE =
  /^(?:y|yes|yeah|yep|approve|approved|confirm|confirmed|correct|right|looks\s+(?:good|right)|sounds\s+good|all\s+good|ok|okay|go\s+ahead|proceed|write\s+it|save\s+it|do\s+it)\b/i;

const RESEARCH_DECISION_RESPONSE_RE =
  /^(?:research|run\s+research|do\s+research|skip|skip\s+research|no\s+research)\b/i;

export function isExplicitApprovalResponse(
  input: string | undefined,
  pendingGateId?: string | null,
): boolean {
  const text = input?.trim() ?? "";
  if (!text) return false;
  if (pendingGateId?.includes("research_decision")) {
    return RESEARCH_DECISION_RESPONSE_RE.test(text);
  }
  if (CHANGE_REQUEST_RESPONSE_RE.test(text)) return false;
  return APPROVAL_RESPONSE_RE.test(text);
}

/** True when an assistant message already has an in-flight ask_user_questions tool call. */
export function messageHasPendingAskUserQuestionsTool(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    // Claude Code marks completion by attaching externalResult, not by setting state.
    // Streaming blocks often carry no state; serverToolUse is the claude-code-cli MCP path.
    const tool = block as { type?: string; name?: string; state?: string; externalResult?: unknown };
    if (tool.type !== "toolCall" && tool.type !== "serverToolUse") return false;
    const name = String(tool.name ?? "").toLowerCase();
    if (!name.includes("ask_user_questions")) return false;
    if (tool.externalResult !== undefined) return false;
    return tool.state !== "completed" && tool.state !== "done";
  });
}
