// Project/App: gsd-pi
// File Purpose: Owns the durable UAT run lifecycle behind gsd_uat_result_save.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

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

export interface UatExecEvidenceMetadata {
  id?: unknown;
  exit_code?: unknown;
  signal?: unknown;
  timed_out?: unknown;
  aborted?: unknown;
  metadata?: {
    kind?: unknown;
    milestoneId?: unknown;
    sliceId?: unknown;
    checkId?: unknown;
    intent?: unknown;
  };
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

function pushUnique(paths: string[], candidate: string): void {
  if (!paths.includes(candidate)) paths.push(candidate);
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

function execMetaPathCandidates(basePath: string, ref: string): string[] {
  const trimmed = ref.trim();
  const candidates: string[] = [];
  const execDirs = approvedEvidenceRoots(basePath).map((root) => join(root, "exec"));
  const normalizedRef = trimmed.replace(/\\/g, "/");
  const pathLike = normalizedRef.endsWith(".meta.json") || normalizedRef.includes("/.gsd/exec/");

  if (pathLike) {
    const rawPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(basePath, trimmed);
    pushUnique(candidates, rawPath);

    const relativeExecMarker = ".gsd/exec/";
    const markerIndex = normalizedRef.indexOf(relativeExecMarker);
    if (markerIndex >= 0) {
      const execRelative = normalizedRef.slice(markerIndex + relativeExecMarker.length);
      for (const execDir of execDirs) {
        pushUnique(candidates, join(execDir, execRelative));
      }
    }

    return candidates.filter((candidate) =>
      execDirs.some((execDir) => pathStartsWithin(execDir, candidate))
    );
  }

  for (const execDir of execDirs) {
    pushUnique(candidates, join(execDir, `${trimmed}.meta.json`));
  }
  return candidates;
}

function resolveExecMetaPath(basePath: string, ref: string): string | null {
  for (const candidate of execMetaPathCandidates(basePath, ref)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readUatExecEvidenceMetadata(
  basePath: string,
  ref: string,
): UatExecEvidenceMetadata | null {
  const path = resolveExecMetaPath(basePath, ref);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UatExecEvidenceMetadata;
  } catch {
    return null;
  }
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

function validateEvidenceRef(basePath: string, evidence: UatEvidenceRef): string | null {
  if (!isUatEvidenceKind(evidence.kind)) {
    return `evidence.kind must be one of: ${quoteList(UAT_EVIDENCE_KINDS)}`;
  }
  if (!isNonEmptyString(evidence.ref)) return "evidence.ref is required";
  if (evidence.kind === "gsd_uat_exec" || evidence.kind === "gsd_exec") {
    const path = resolveExecMetaPath(basePath, evidence.ref.trim());
    if (!path) {
      return `${evidence.kind} evidence ref "${evidence.ref}" must resolve to an existing .meta.json file under .gsd/exec/`;
    }
    if (evidence.kind === "gsd_uat_exec") {
      try {
        const meta = JSON.parse(readFileSync(path, "utf-8")) as { metadata?: { kind?: unknown } };
        if (meta.metadata?.kind !== "uat_exec") return `evidence id "${evidence.ref}" is not typed as uat_exec`;
      } catch {
        return `invalid gsd_exec metadata JSON for evidence id "${evidence.ref}"`;
      }
    }
    return null;
  }
  if (evidence.kind === "url") {
    return isHttpUrlRef(evidence.ref)
      ? null
      : `url evidence ref must be an http:// or https:// URL; got "${evidence.ref}"`;
  }
  if (evidence.kind === "screenshot" || evidence.kind === "log") {
    return evidencePathIsApproved(basePath, evidence.ref)
      ? null
      : `${evidence.kind} evidence ref must be a path under approved evidence locations (${approvedRootsText()}); got "${evidence.ref}"`;
  }
  if (evidence.kind === "browser") {
    if (isHttpUrlRef(evidence.ref) || browserArtifactPathIsApproved(basePath, evidence.ref)) return null;
    return `browser evidence ref must be an http:// or https:// URL, or a path under ${approvedRootsText(APPROVED_BROWSER_EVIDENCE_REF_ROOTS)}; got "${evidence.ref}"`;
  }
  return null;
}

function validateUatChecks(basePath: string, params: UatResultSaveParams): string | null {
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
        const error = validateEvidenceRef(basePath, evidence);
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

function nextUatAttempt(basePath: string, milestoneId: string, sliceId: string): number {
  const contract = resolveGsdPathContract(basePath);
  const dir = join(contract.projectGsd, "uat", milestoneId, sliceId);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const entry of readdirSync(dir)) {
    const match = /^attempt-(\d+)\.json$/.exec(entry);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function resolveUatAttempt(basePath: string, params: UatResultSaveParams): number | UatRunValidationError {
  if (params.attempt === "auto" || params.attempt === undefined) {
    return nextUatAttempt(basePath, params.milestoneId, params.sliceId);
  }

  const attempt = typeof params.attempt === "string"
    ? Number.parseInt(params.attempt, 10)
    : params.attempt;
  if (!Number.isInteger(attempt) || attempt < 1) {
    return {
      code: "invalid_attempt",
      message: "attempt must be a positive integer or auto",
    };
  }
  return attempt;
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

  const checkError = validateUatChecks(basePath, params);
  if (checkError) return { ok: false, error: { code: "invalid_evidence", message: checkError } };

  const freshEvidenceError = validateFreshUatOwnedEvidence(params);
  if (freshEvidenceError) {
    return { ok: false, error: { code: "missing_fresh_uat_evidence", message: freshEvidenceError } };
  }

  const modeError = validateUatModePolicy(params);
  if (modeError) return { ok: false, error: { code: "uat_mode_mismatch", message: modeError } };

  const attempt = resolveUatAttempt(basePath, params);
  if (typeof attempt !== "number") return { ok: false, error: attempt };

  const gateVerdict = params.verdict === "PASS" ? "pass" : "flag";
  const gateOutcome = params.verdict === "PASS" ? "pass" : "fail";
  const rationale = params.notes ?? `UAT ${params.verdict} for ${params.sliceId}.`;
  const evaluatedAt = new Date().toISOString();
  const runId = `uat:${params.milestoneId}:${params.sliceId}:attempt-${attempt}`;
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

export async function saveUatAttemptArtifact(basePath: string, run: PreparedUatRun): Promise<string> {
  const contract = resolveGsdPathContract(basePath);
  const relativePath = `uat/${run.params.milestoneId}/${run.params.sliceId}/attempt-${run.attempt}.json`;
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
  await saveFile(join(contract.projectGsd, relativePath), `${JSON.stringify(payload, null, 2)}\n`);
  return relativePath;
}
