import { saveReworkBrief, type ReworkBriefFindingInput } from "../gsd-db.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";

export interface ReworkBriefSaveParams {
  briefId?: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findings: ReworkBriefFindingInput[];
}

export interface ReworkBriefSaveResult {
  briefId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
  findingCount: number;
}

function validateFinding(finding: ReworkBriefFindingInput, index: number): ReworkBriefFindingInput {
  if (!isNonEmptyString(finding?.findingId)) throw new Error(`findings[${index}].findingId is required`);
  if (finding.severity !== "blocking" && finding.severity !== "advisory") {
    throw new Error(`findings[${index}].severity must be blocking or advisory`);
  }
  if (!isNonEmptyString(finding.description)) throw new Error(`findings[${index}].description is required`);
  if (!isNonEmptyString(finding.requiredFix)) throw new Error(`findings[${index}].requiredFix is required`);

  const status = finding.status ?? "pending";
  if (status !== "pending" && status !== "resolved" && status !== "deferred-with-override") {
    throw new Error(`findings[${index}].status must be pending, resolved, or deferred-with-override`);
  }

  // A blocking finding is only enforced by gsd_task_complete while it is
  // `pending` (getUnresolvedBlockingReworkFindingsForTask returns pending rows
  // only). Persisting a blocking finding as resolved/deferred-with-override
  // at save time therefore bypasses the completion gate entirely, so require
  // the same justification a reworkResolution would (evidence for `resolved`,
  // evidence + decisionRef for `deferred-with-override`). Advisory findings do
  // not gate completion, so their status is left as-is.
  if (finding.severity === "blocking" && status !== "pending") {
    if (!isNonEmptyString(finding.evidence)) {
      throw new Error(`findings[${index}].evidence is required when a blocking finding is saved as ${status}`);
    }
    if (status === "deferred-with-override" && !isNonEmptyString(finding.decisionRef)) {
      throw new Error(`findings[${index}].decisionRef is required when a blocking finding is saved as deferred-with-override`);
    }
  }

  return {
    ...finding,
    verificationCommands: validateStringArray(finding.verificationCommands, `findings[${index}].verificationCommands`),
    status,
  };
}

function validateParams(params: ReworkBriefSaveParams): ReworkBriefSaveParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!Array.isArray(params.findings) || params.findings.length === 0) {
    throw new Error("findings must be a non-empty array");
  }
  return {
    ...params,
    findings: params.findings.map(validateFinding),
  };
}

export async function handleReworkBriefSave(
  rawParams: ReworkBriefSaveParams,
): Promise<ReworkBriefSaveResult | { error: string }> {
  let params: ReworkBriefSaveParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  try {
    const { briefId } = saveReworkBrief(params);
    return {
      briefId,
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      findingCount: params.findings.length,
    };
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }
}
