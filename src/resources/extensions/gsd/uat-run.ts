// Project/App: gsd-pi
// File Purpose: Owns the durable UAT run lifecycle behind gsd_uat_result_save.

import { existsSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

import {
  hasUatBrowserToolSurface,
  isUatType,
  UAT_MODE_POLICIES,
  UAT_TYPES,
  validateUatModePolicy,
  type UatCheckMode,
  type UatCheckResult,
  type UatType,
  type UatVerdict,
} from "./uat-policy.js";
import {
  buildRunUatPresentationForType,
  canonicalWorkflowToolName,
  parseMcpToolName,
  RUN_UAT_FORBIDDEN_TOOL_NAMES,
  RUN_UAT_TOOL_PRESENTATION_PLAN_ID,
  RUN_UAT_WORKFLOW_TOOL_NAMES,
} from "./tool-presentation-plan.js";
import { getLatestUatAttempt } from "./db/queries.js";
import { execRunSucceeded, readExecRun, uatAttemptRef, type ExecRunRow } from "./db/writers/exec-runs.js";
import { saveFile } from "./files.js";
import { relSliceFile, resolveGsdPathContract } from "./paths.js";
import { buildManualValidationGuidance, resolveCanonicalMilestoneRoot } from "./worktree-manager.js";

export const UAT_EVIDENCE_KINDS = [
  "gsd_uat_exec",
  "gsd_exec",
  "screenshot",
  "log",
  "url",
  "browser",
] as const;
export type UatEvidenceKind = typeof UAT_EVIDENCE_KINDS[number];

const UAT_EVIDENCE_KIND_SET = new Set<string>(UAT_EVIDENCE_KINDS);
const APPROVED_EVIDENCE_REF_ROOTS = [".gsd/exec/", ".gsd/uat/", ".artifacts/browser/"] as const;
const APPROVED_BROWSER_EVIDENCE_REF_ROOTS = [".artifacts/browser/"] as const;

export interface UatEvidenceRef {
  kind: UatEvidenceKind;
  ref: string;
  note?: string;
  unitType?: string;
  tool?: string;
  executionId?: string;
}

export interface UatCheckResultInput {
  id: string;
  description: string;
  mode: UatCheckMode;
  result: UatCheckResult;
  evidence?: UatEvidenceRef[];
  notes?: string;
  nonAutomatable?: boolean;
}

export interface UatPresentationInput {
  surface: "provider-tools" | "claude-code-sdk" | "mcp" | "hybrid";
  model?: { provider?: string; api?: string; id?: string };
  presentedTools: string[];
  blockedTools: Array<{ name: string; reason: string }>;
  aliases?: Array<{ requested: string; canonical: string }>;
  fallbackToolsUsed?: string[];
  toolPresentationPlanId?: string;
  notes?: string;
}

export interface UatResultSaveParams {
  milestoneId: string;
  sliceId: string;
  uatType: UatType;
  verdict: UatVerdict;
  checks: UatCheckResultInput[];
  presentation: UatPresentationInput;
  notes?: string;
  attempt?: number | string | "auto";
  previousAttemptId?: string;
}

export interface PreparedUatRun {
  params: UatResultSaveParams;
  runId: string;
  attempt: number;
  gateVerdict: "pass" | "flag";
  gateOutcome: "pass" | "fail";
  rationale: string;
  assessment: string;
  evaluatedAt: string;
  hasHuman: boolean;
  manualGuidance: string | null;
  worktreeRoot: string;
  browserToolsPresented: boolean;
}

export interface UatRunValidationError {
  code: string;
  message: string;
}

export type PrepareUatRunResult =
  | { ok: true; run: PreparedUatRun }
  | { ok: false; error: UatRunValidationError };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mergeBlockedTools(
  current: UatPresentationInput["blockedTools"] | undefined,
  canonical: UatPresentationInput["blockedTools"],
): UatPresentationInput["blockedTools"] {
  const merged = new Map<string, { name: string; reason: string }>();
  for (const entry of [...(current ?? []), ...canonical]) {
    merged.set(canonicalWorkflowToolName(parseMcpToolName(entry.name)?.toolName ?? entry.name), entry);
  }
  return [...merged.values()];
}

function mergePresentedTools(current: readonly string[] | undefined, canonical: readonly string[]): string[] {
  return [...new Set([...(current ?? []), ...canonical])];
}

function normalizeUatVerdict(params: UatResultSaveParams): UatResultSaveParams {
  const raw = params as Partial<UatResultSaveParams> & Record<string, unknown>;
  if (typeof raw.verdict === "string") {
    return { ...params, verdict: raw.verdict.toUpperCase() as UatVerdict };
  }
  return params;
}

function supplyDefaultPresentation(params: UatResultSaveParams): UatResultSaveParams {
  const raw = params as Partial<UatResultSaveParams> & Record<string, unknown>;
  if (!raw.presentation) {
    return { ...params, presentation: buildRunUatPresentationForType(params.uatType) };
  }
  return params;
}

function mergeCanonicalPresentation(params: UatResultSaveParams): UatResultSaveParams {
  const canonicalPresentation = buildRunUatPresentationForType(params.uatType);
  const providedPresentation = params.presentation as Partial<UatPresentationInput>;
  return {
    ...params,
    presentation: {
      ...providedPresentation,
      surface: providedPresentation.surface ?? canonicalPresentation.surface,
      presentedTools: mergePresentedTools(providedPresentation.presentedTools, canonicalPresentation.presentedTools),
      blockedTools: mergeBlockedTools(providedPresentation.blockedTools, canonicalPresentation.blockedTools),
      toolPresentationPlanId: RUN_UAT_TOOL_PRESENTATION_PLAN_ID,
    } as UatPresentationInput,
  };
}

function ensureUatRequiredFields(params: UatResultSaveParams): string | null {
  if (!isNonEmptyString(params.milestoneId)) return "milestoneId is required";
  if (!isNonEmptyString(params.sliceId)) return "sliceId is required";
  if (!isNonEmptyString(params.uatType)) return "uatType is required";
  if (!isUatType(params.uatType)) {
    return `uatType must be one of: ${UAT_TYPES.join(", ")}`;
  }
  if (!["PASS", "FAIL", "PARTIAL"].includes(params.verdict)) return "verdict must be PASS, FAIL, or PARTIAL";
  if (!Array.isArray(params.checks) || params.checks.length === 0) return "checks must contain at least one UAT check";
  if (!params.presentation || !Array.isArray(params.presentation.presentedTools)) return "presentation.presentedTools is required";
  if (!Array.isArray(params.presentation.blockedTools)) return "presentation.blockedTools is required";
  return null;
}

function approvedEvidenceRoots(basePath: string): string[] {
  const contract = resolveGsdPathContract(basePath);
  return [contract.worktreeGsd, contract.projectGsd].filter((root): root is string => typeof root === "string");
}

function approvedBrowserArtifactRoots(basePath: string): string[] {
  const contract = resolveGsdPathContract(basePath);
  const roots = [contract.workRoot, contract.projectRoot].map((root) => join(root, ".artifacts", "browser"));
  return [...new Set(roots)];
}

function pathStartsWithin(parent: string, target: string): boolean {
  const normalizedParent = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedTarget = target.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedTarget === normalizedParent || normalizedTarget.startsWith(`${normalizedParent}/`);
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function approvedRootsText(roots: readonly string[] = APPROVED_EVIDENCE_REF_ROOTS): string {
  return roots.join(", ");
}

function isUatEvidenceKind(value: unknown): value is UatEvidenceKind {
  return typeof value === "string" && UAT_EVIDENCE_KIND_SET.has(value);
}

function isHttpUrlRef(ref: string): boolean {
  try {
    const parsed = new URL(ref);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeEvidenceRef(ref: string): string {
  return normalize(ref).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function relativeRefStartsWithin(root: string, ref: string): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedRef = normalizeEvidenceRef(ref);
  return normalizedRef === normalizedRoot || normalizedRef.startsWith(`${normalizedRoot}/`);
}

/** The exec_runs row an exec evidence ref names: a run id, or a path to one of the files of the run. */
export function readExecRunOfRef(ref: string): ExecRunRow | null {
  const id = basename(ref.trim().replace(/\\/g, "/")).replace(/\.(?:meta\.json|stdout|stderr)$/, "");
  return readExecRun(id);
}

/** Every place a relative evidence path can be: the work root, and the .gsd and browser artifact roots. */
function evidenceFileExists(basePath: string, ref: string): boolean {
  if (isAbsolute(ref)) return existsSync(ref);
  const normalizedRef = normalizeEvidenceRef(ref);
  const candidates = [resolve(basePath, ref)];
  if (normalizedRef.startsWith(".gsd/")) {
    for (const root of approvedEvidenceRoots(basePath)) candidates.push(join(root, normalizedRef.slice(".gsd/".length)));
  }
  if (normalizedRef.startsWith(".artifacts/browser/")) {
    for (const root of approvedBrowserArtifactRoots(basePath)) {
      candidates.push(join(root, normalizedRef.slice(".artifacts/browser/".length)));
    }
  }
  return candidates.some((candidate) => existsSync(candidate));
}

function evidencePathIsApproved(basePath: string, ref: string): boolean {
  if (APPROVED_EVIDENCE_REF_ROOTS.some((root) => relativeRefStartsWithin(root, ref))) {
    return true;
  }
  const resolvedRef = isAbsolute(ref) ? resolve(ref) : resolve(basePath, ref);
  const gsdEvidenceApproved = approvedEvidenceRoots(basePath).some((root) => {
    return pathStartsWithin(join(root, "exec"), resolvedRef) || pathStartsWithin(join(root, "uat"), resolvedRef);
  });
  if (gsdEvidenceApproved) return true;
  return approvedBrowserArtifactRoots(basePath).some((root) => pathStartsWithin(root, resolvedRef));
}

function browserArtifactPathIsApproved(basePath: string, ref: string): boolean {
  if (!APPROVED_BROWSER_EVIDENCE_REF_ROOTS.some((root) => relativeRefStartsWithin(root, ref)) && !isAbsolute(ref)) {
    return false;
  }
  const resolvedRef = isAbsolute(ref) ? resolve(ref) : resolve(basePath, ref);
  return approvedBrowserArtifactRoots(basePath).some((root) => pathStartsWithin(root, resolvedRef));
}

/**
 * Exec evidence is the exec_runs row the host stored when the command ran. A
 * gsd_uat_exec run must be a run of this slice and of this run-uat attempt,
 * so a run of another slice or of an earlier attempt proves nothing here. The
 * stored row decides this, not the kind the model cites.
 */
function validateExecEvidenceRef(
  params: UatResultSaveParams,
  runId: string,
  check: UatCheckResultInput,
  evidence: UatEvidenceRef,
): string | null {
  const run = readExecRunOfRef(evidence.ref);
  if (!run) {
    return `${evidence.kind} evidence ref "${evidence.ref}" names no host-recorded run; run the check with gsd_uat_exec and cite the id it returns`;
  }
  if (evidence.kind === "gsd_uat_exec" && run.kind !== "uat_exec") {
    return `evidence id "${evidence.ref}" is not typed as uat_exec`;
  }
  if (run.kind === "uat_exec") {
    if (run.milestone_id !== params.milestoneId || run.slice_id !== params.sliceId) {
      return `gsd_uat_exec evidence id "${evidence.ref}" was recorded for ${run.milestone_id}/${run.slice_id}, not for ${params.milestoneId}/${params.sliceId}`;
    }
    if (run.attempt_ref !== runId) {
      return `gsd_uat_exec evidence id "${evidence.ref}" was recorded in ${run.attempt_ref}, not in this run (${runId}); re-run the check`;
    }
  }
  if (check.result === "PASS" && !execRunSucceeded(run)) {
    return (
      `PASS cites ${evidence.kind} evidence id "${evidence.ref}" whose execution ` +
      `recorded exit_code=${String(run.exit_code)}, signal=${String(run.signal)}, ` +
      `timed_out=${String(run.timed_out === 1)}, aborted=${String(run.aborted === 1)}; ` +
      "re-run the check or fix the result"
    );
  }
  return null;
}

function validateEvidenceRef(
  basePath: string,
  params: UatResultSaveParams,
  runId: string,
  check: UatCheckResultInput,
  evidence: UatEvidenceRef,
): string | null {
  if (!isUatEvidenceKind(evidence.kind)) {
    return `evidence.kind must be one of: ${quoteList(UAT_EVIDENCE_KINDS)}`;
  }
  if (!isNonEmptyString(evidence.ref)) return "evidence.ref is required";
  if (evidence.kind === "gsd_uat_exec" || evidence.kind === "gsd_exec") {
    return validateExecEvidenceRef(params, runId, check, evidence);
  }
  if (evidence.kind === "url") {
    return isHttpUrlRef(evidence.ref)
      ? null
      : `url evidence ref must be an http:// or https:// URL; got "${evidence.ref}"`;
  }
  if (evidence.kind === "browser" && isHttpUrlRef(evidence.ref)) return null;
  const approved = evidence.kind === "browser"
    ? browserArtifactPathIsApproved(basePath, evidence.ref)
    : evidencePathIsApproved(basePath, evidence.ref);
  if (!approved) {
    return evidence.kind === "browser"
      ? `browser evidence ref must be an http:// or https:// URL, or a path under ${approvedRootsText(APPROVED_BROWSER_EVIDENCE_REF_ROOTS)}; got "${evidence.ref}"`
      : `${evidence.kind} evidence ref must be a path under approved evidence locations (${approvedRootsText()}); got "${evidence.ref}"`;
  }
  return evidenceFileExists(basePath, evidence.ref)
    ? null
    : `${evidence.kind} evidence ref "${evidence.ref}" names a file that does not exist`;
}

function validateUatChecks(basePath: string, params: UatResultSaveParams, runId: string): string | null {
  for (const check of params.checks) {
    if (!isNonEmptyString(check.id)) return "every check must have a non-empty id";
    if (!isNonEmptyString(check.description)) return `check ${check.id} must have a description`;
    if (!["artifact", "runtime", "browser", "human-follow-up"].includes(check.mode)) {
      return `check ${check.id} has invalid mode "${check.mode}"`;
    }
    if (!["PASS", "FAIL", "NEEDS-HUMAN"].includes(check.result)) {
      return `check ${check.id} has invalid result "${check.result}"`;
    }
    if (check.result === "PASS" || check.result === "FAIL") {
      if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
        return `check ${check.id} is ${check.result} but has no objective evidence`;
      }
      for (const evidence of check.evidence) {
        const error = validateEvidenceRef(basePath, params, runId, check, evidence);
        if (error) return `check ${check.id}: ${error}`;
      }
    } else if (!isNonEmptyString(check.notes)) {
      return `check ${check.id} is NEEDS-HUMAN but has no manual instruction or reason`;
    }
  }
  return null;
}

function validateFreshUatOwnedEvidence(params: UatResultSaveParams): string | null {
  const hasFreshUatEvidence = params.checks.some((check) =>
    (check.evidence ?? []).some((evidence) => evidence.kind === "gsd_uat_exec")
  );
  return hasFreshUatEvidence
    ? null
    : "UAT Assessment requires at least one fresh gsd_uat_exec evidence reference from run-uat";
}

function quoteToolNames(toolNames: readonly string[]): string {
  return toolNames.map((toolName) => `"${toolName}"`).join(", ");
}

function validateCanonicalPresentation(params: UatResultSaveParams): string | null {
  const errors: string[] = [];
  for (const toolName of params.presentation.presentedTools) {
    const baseName = parseMcpToolName(toolName)?.toolName ?? toolName;
    const canonical = canonicalWorkflowToolName(baseName);
    if (canonical !== baseName) {
      errors.push(`presentation tool "${toolName}" uses an alias; use canonical "${canonical}"`);
    }
  }

  const presentedCanonical = new Set(
    params.presentation.presentedTools.map((toolName) =>
      canonicalWorkflowToolName(parseMcpToolName(toolName)?.toolName ?? toolName)
    ),
  );
  const missingRequiredTools = RUN_UAT_WORKFLOW_TOOL_NAMES.filter(
    (requiredTool) => !presentedCanonical.has(requiredTool),
  );
  if (missingRequiredTools.length === 1) {
    errors.push(`presentation is missing required UAT tool "${missingRequiredTools[0]}"`);
  } else if (missingRequiredTools.length > 1) {
    errors.push(`presentation is missing required UAT tools ${quoteToolNames(missingRequiredTools)}`);
  }

  const forbiddenCanonical = new Set(
    RUN_UAT_FORBIDDEN_TOOL_NAMES
      .filter((toolName) => !toolName.includes("*"))
      .map((toolName) => canonicalWorkflowToolName(parseMcpToolName(toolName)?.toolName ?? toolName)),
  );
  const forbiddenPresentedTools: string[] = [];
  for (const toolName of params.presentation.presentedTools) {
    const canonical = canonicalWorkflowToolName(parseMcpToolName(toolName)?.toolName ?? toolName);
    if (toolName === "mcp__gsd-workflow__*" || forbiddenCanonical.has(canonical)) {
      forbiddenPresentedTools.push(toolName);
    }
  }
  if (forbiddenPresentedTools.length === 1) {
    errors.push(`presentation includes forbidden run-uat tool "${forbiddenPresentedTools[0]}"`);
  } else if (forbiddenPresentedTools.length > 1) {
    errors.push(`presentation includes forbidden run-uat tools ${quoteToolNames(forbiddenPresentedTools)}`);
  }

  const blockedCanonical = new Set(
    params.presentation.blockedTools.map((entry) =>
      canonicalWorkflowToolName(parseMcpToolName(entry.name)?.toolName ?? entry.name)
    ),
  );
  const missingBlockedTools = ["gsd_exec", "gsd_summary_save", "gsd_save_gate_result"].filter(
    (blockedTool) => !blockedCanonical.has(blockedTool),
  );
  if (missingBlockedTools.length === 1) {
    errors.push(`presentation must record "${missingBlockedTools[0]}" as blocked during run-uat`);
  } else if (missingBlockedTools.length > 1) {
    errors.push(`presentation must record ${quoteToolNames(missingBlockedTools)} as blocked during run-uat`);
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

/**
 * The attempt number of a save comes from the saved runs. A caller cannot
 * choose it: a save under an earlier number would accept the evidence of that
 * earlier attempt.
 */
function resolveUatAttempt(params: UatResultSaveParams): number | UatRunValidationError {
  const next = getLatestUatAttempt(params.milestoneId, params.sliceId) + 1;
  if (params.attempt === "auto" || params.attempt === undefined || Number(params.attempt) === next) return next;
  return {
    code: "invalid_attempt",
    message:
      `attempt must be auto or ${next}, the next run-uat attempt of ${params.milestoneId}/${params.sliceId}; ` +
      `got "${String(params.attempt)}"`,
  };
}

function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/[\\|]/g, (char) => `\\${char}`)
    .replace(/\r?\n/g, "<br>");
}

interface UatAssessmentContext {
  attempt: number;
  gateVerdict: "pass" | "flag";
  runId: string;
  worktreeRoot: string;
  evaluatedAt: string;
  manualGuidance: string | null;
}

function renderCheckRow(check: UatCheckResultInput): string {
  const evidence = (check.evidence ?? []).map((entry) => `${entry.kind}:${entry.ref}`).join("<br>") || "-";
  return `| ${escapeMarkdownTableCell(check.description)} | ${escapeMarkdownTableCell(check.mode)} | ${escapeMarkdownTableCell(check.result)} | ${escapeMarkdownTableCell(evidence)} | ${escapeMarkdownTableCell(check.notes)} |`;
}

function renderUatAssessment(params: UatResultSaveParams, run: UatAssessmentContext): string {
  const lines = [
    "---",
    `sliceId: ${params.sliceId}`,
    `uatType: ${params.uatType}`,
    `verdict: ${params.verdict}`,
    `attempt: ${run.attempt}`,
    `runId: ${run.runId}`,
    `worktreeRoot: ${run.worktreeRoot}`,
    `date: ${run.evaluatedAt}`,
    "---",
    "",
    `# UAT Result - ${params.sliceId}`,
    "",
    "## Checks",
    "",
    "| Check | Mode | Result | Evidence | Notes |",
    "|-------|------|--------|----------|-------|",
    ...params.checks.map(renderCheckRow),
    "",
    "## Overall Verdict",
    "",
    `${params.verdict} - ${params.notes ?? "UAT result saved."}`,
    "",
    "## Tool Presentation",
    "",
    "```json",
    JSON.stringify(params.presentation, null, 2),
    "```",
    "",
    "## Gate",
    "",
    `Aggregate UAT gate saved as ${run.gateVerdict}.`,
  ];

  if (run.manualGuidance) {
    lines.push(
      "",
      "## Manual Validation",
      "",
      "One or more checks are marked `NEEDS-HUMAN` and require a person to validate:",
      "",
      ...run.manualGuidance.split("\n").map((line) => `- ${line}`),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function prepareUatRun(basePath: string, rawParams: UatResultSaveParams): PrepareUatRunResult {
  let params = normalizeUatVerdict(rawParams);
  params = supplyDefaultPresentation(params);

  const requiredError = ensureUatRequiredFields(params);
  if (requiredError) return { ok: false, error: { code: "invalid_params", message: requiredError } };

  const presentationError = validateCanonicalPresentation(params);
  if (presentationError) return { ok: false, error: { code: "alias_tool_name", message: presentationError } };

  params = mergeCanonicalPresentation(params);

  const attempt = resolveUatAttempt(params);
  if (typeof attempt !== "number") return { ok: false, error: attempt };
  const runId = uatAttemptRef(params.milestoneId, params.sliceId, attempt);

  const checkError = validateUatChecks(basePath, params, runId);
  if (checkError) return { ok: false, error: { code: "invalid_evidence", message: checkError } };

  const freshEvidenceError = validateFreshUatOwnedEvidence(params);
  if (freshEvidenceError) {
    return { ok: false, error: { code: "missing_fresh_uat_evidence", message: freshEvidenceError } };
  }

  const modeError = validateUatModePolicy(params);
  if (modeError) return { ok: false, error: { code: "uat_mode_mismatch", message: modeError } };

  const gateVerdict = params.verdict === "PASS" ? "pass" : "flag";
  const gateOutcome = params.verdict === "PASS" ? "pass" : "fail";
  const rationale = params.notes ?? `UAT ${params.verdict} for ${params.sliceId}.`;
  const evaluatedAt = new Date().toISOString();
  const worktreeRoot = resolveCanonicalMilestoneRoot(basePath, params.milestoneId);
  const hasHuman = params.checks.some((check) => check.result === "NEEDS-HUMAN");
  const manualGuidance = hasHuman
    ? buildManualValidationGuidance(basePath, params.milestoneId, {
        uatPath: relSliceFile(basePath, params.milestoneId, params.sliceId, "UAT"),
      })
    : null;
  const browserToolsPresented = hasUatBrowserToolSurface(params.presentation.presentedTools);
  const assessment = renderUatAssessment(params, {
    attempt,
    gateVerdict,
    runId,
    worktreeRoot,
    evaluatedAt,
    manualGuidance,
  });

  return {
    ok: true,
    run: {
      params,
      runId,
      attempt,
      gateVerdict,
      gateOutcome,
      rationale,
      assessment,
      evaluatedAt,
      hasHuman,
      manualGuidance,
      worktreeRoot,
      browserToolsPresented,
    },
  };
}

/** Path of the attempt record of a run, relative to the project `.gsd` directory. */
export function uatAttemptArtifactPath(run: PreparedUatRun): string {
  return `uat/${run.params.milestoneId}/${run.params.sliceId}/attempt-${run.attempt}.json`;
}

/** Content of the attempt record file of a run. */
export function renderUatAttemptRecord(run: PreparedUatRun): string {
  const payload = {
    runId: run.runId,
    attempt: run.attempt,
    milestoneId: run.params.milestoneId,
    sliceId: run.params.sliceId,
    uatType: run.params.uatType,
    verdict: run.params.verdict,
    gateVerdict: run.gateVerdict,
    evaluatedAt: run.evaluatedAt,
    worktreeRoot: run.worktreeRoot,
    browserToolsPresented: run.browserToolsPresented,
    modePolicy: UAT_MODE_POLICIES[run.params.uatType],
    checks: run.params.checks,
    presentation: run.params.presentation,
    notes: run.params.notes,
    previousAttemptId: run.params.previousAttemptId,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Write the attempt record file. It is a render of the saved UAT result. */
export async function saveUatAttemptArtifact(basePath: string, relativePath: string, record: string): Promise<void> {
  await saveFile(join(resolveGsdPathContract(basePath).projectGsd, relativePath), record);
}
