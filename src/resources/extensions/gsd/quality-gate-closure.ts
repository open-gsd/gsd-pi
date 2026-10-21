// Project/App: gsd-pi
// File Purpose: Canonical quality-gate closure from durable DB and artifact evidence.

import { existsSync, readFileSync } from "node:fs";

import { extractSection } from "./files.js";
import { getGateDefinition } from "./gate-registry.js";
import {
  getGateResults,
  getMilestoneSlices,
  getPendingGates,
  getPendingGatesForTurn,
  saveGateResult,
} from "./gsd-db.js";
import { resolveSliceFile, resolveTaskFile } from "./paths.js";
import type { GateId, GateRow, GateVerdict } from "./types.js";

export interface QualityGateClosureOptions {
  artifactBasePath?: string;
  milestoneValidationPassed?: boolean;
  milestoneValidationAuthorization?: {
    kind: "validated" | "waived";
    eventId: string;
    revision: number;
  };
}

export interface QualityGateClosureResult {
  repaired: Array<{ gateId: GateId; sliceId: string; taskId?: string; verdict: GateVerdict }>;
  unresolved: GateRow[];
}

export interface TaskQualityGateContent {
  failureModes?: string;
  loadProfile?: string;
  negativeTests?: string;
}

interface GateEvidence {
  verdict: GateVerdict;
  rationale: string;
  findings: string;
}

interface PlannedGateClosure {
  row: GateRow;
  evidence: GateEvidence;
}

const GATE_SECTION_HEADINGS: Partial<Record<GateId, string[]>> = {
  Q3: ["Threat Surface", "Abuse Surface"],
  Q4: ["Requirement Impact", "Broken Promises"],
  Q5: ["Failure Modes"],
  Q6: ["Load Profile"],
  Q7: ["Negative Tests"],
  Q8: ["Operational Readiness"],
};

function readFile(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function firstSection(content: string | null, gateId: GateId): string | null {
  if (!content) return null;
  for (const heading of GATE_SECTION_HEADINGS[gateId] ?? []) {
    const section = extractSection(content, heading);
    if (section) return section;
  }
  return null;
}

function evidenceArtifactContent(row: GateRow, basePath: string): string | null {
  const def = getGateDefinition(row.gate_id);
  switch (def?.ownerTurn) {
    case "gate-evaluate":
      return readFile(resolveSliceFile(basePath, row.milestone_id, row.slice_id, "PLAN"));
    case "execute-task":
      return readFile(resolveTaskFile(basePath, row.milestone_id, row.slice_id, row.task_id, "SUMMARY"));
    case "complete-slice":
      return readFile(resolveSliceFile(basePath, row.milestone_id, row.slice_id, "SUMMARY"));
    default:
      return null;
  }
}

function closureEvidence(row: GateRow, options: QualityGateClosureOptions): GateEvidence | null {
  const def = getGateDefinition(row.gate_id);
  if (!def) return null;

  if (def.ownerTurn === "validate-milestone" && options.milestoneValidationAuthorization) {
    const authorization = options.milestoneValidationAuthorization;
    const waived = authorization.kind === "waived";
    return {
      verdict: waived ? "omitted" : "pass",
      rationale: waived
        ? `${def.promptSection} omitted by canonical milestone validation waiver ${authorization.eventId} at revision ${authorization.revision}`
        : `${def.promptSection} covered by passing canonical milestone validation ${authorization.eventId} at revision ${authorization.revision}`,
      findings: "",
    };
  }

  if (def.ownerTurn === "validate-milestone" && options.milestoneValidationPassed) {
    return {
      verdict: "pass",
      rationale: `${def.promptSection} covered by passing milestone validation`,
      findings: "",
    };
  }

  if (!options.artifactBasePath) return null;

  const section = firstSection(evidenceArtifactContent(row, options.artifactBasePath), row.gate_id);
  if (section) {
    return {
      verdict: "pass",
      rationale: `${def.promptSection} evidence found in durable artifact`,
      findings: section,
    };
  }

  if (!options.milestoneValidationPassed) return null;
  return {
    verdict: "omitted",
    rationale: `${def.promptSection} has no durable artifact section; milestone validation passed`,
    findings: "",
  };
}

function closeGate(row: GateRow, evidence: GateEvidence): void {
  saveGateResult({
    milestoneId: row.milestone_id,
    sliceId: row.slice_id,
    gateId: row.gate_id,
    taskId: row.task_id,
    verdict: evidence.verdict,
    rationale: evidence.rationale,
    findings: evidence.findings,
  });
}

function gateMatchesEvidence(row: GateRow, evidence: GateEvidence): boolean {
  return row.status === "complete" &&
    row.verdict === evidence.verdict &&
    row.rationale === evidence.rationale &&
    row.findings === evidence.findings;
}

export function closeTaskQualityGates(
  task: { milestoneId: string; sliceId: string; taskId: string },
  content: TaskQualityGateContent,
): void {
  const contentByGate: Partial<Record<GateId, string | undefined>> = {
    Q5: content.failureModes,
    Q6: content.loadProfile,
    Q7: content.negativeTests,
  };

  for (const row of getPendingGatesForTurn(
    task.milestoneId,
    task.sliceId,
    "execute-task",
    task.taskId,
  )) {
    const definition = getGateDefinition(row.gate_id);
    if (!definition) continue;
    if (!(row.gate_id in contentByGate)) {
      throw new Error(`No task quality-gate content mapping exists for ${row.gate_id}`);
    }
    const findings = contentByGate[row.gate_id]?.trim() ?? "";
    const hasContent = findings.length > 0;
    saveGateResult({
      milestoneId: task.milestoneId,
      sliceId: task.sliceId,
      taskId: task.taskId,
      gateId: row.gate_id,
      verdict: hasContent ? "pass" : "omitted",
      rationale: hasContent
        ? `${definition.promptSection} section populated in task summary`
        : `${definition.promptSection} section left empty — recorded as omitted`,
      findings,
    });
  }
}

function planQualityGateClosure(
  milestoneId: string,
  options: QualityGateClosureOptions = {},
): { closures: PlannedGateClosure[]; unresolved: GateRow[] } {
  const closures: PlannedGateClosure[] = [];
  const unresolved: GateRow[] = [];

  for (const slice of getMilestoneSlices(milestoneId)) {
    const sliceId = slice.id;
    const gates = options.milestoneValidationAuthorization
      ? getGateResults(milestoneId, sliceId)
      : getPendingGates(milestoneId, sliceId);
    for (const row of gates) {
      const definition = getGateDefinition(row.gate_id);
      if (!definition) {
        if (row.status !== "complete") {
          unresolved.push(row);
        }
        continue;
      }
      if (row.status !== "pending" && definition.ownerTurn !== "validate-milestone") continue;

      const evidence = closureEvidence(row, options);
      if (!evidence) {
        unresolved.push(row);
        continue;
      }
      if (!gateMatchesEvidence(row, evidence)) closures.push({ row, evidence });
    }
  }

  return { closures, unresolved };
}

function closureResult(plan: ReturnType<typeof planQualityGateClosure>): QualityGateClosureResult {
  return {
    repaired: plan.closures.map(({ row, evidence }) => ({
      gateId: row.gate_id,
      sliceId: row.slice_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      verdict: evidence.verdict,
    })),
    unresolved: plan.unresolved,
  };
}

export function inspectQualityGatesFromEvidence(
  milestoneId: string,
  options: QualityGateClosureOptions = {},
): QualityGateClosureResult {
  return closureResult(planQualityGateClosure(milestoneId, options));
}

export function closeQualityGatesFromEvidence(
  milestoneId: string,
  options: QualityGateClosureOptions = {},
): QualityGateClosureResult {
  const plan = planQualityGateClosure(milestoneId, options);

  for (const { row, evidence } of plan.closures) {
    closeGate(row, evidence);
  }

  return closureResult(plan);
}
