// Project/App: gsd-pi
// File Purpose: Canonical workflow MCP tool metadata shared across package boundaries.

export type WorkflowToolWritePolicy = "read" | "write";

export interface WorkflowToolContractMetadata {
	canonicalName: string;
	aliases: readonly string[];
	schemaId: string;
	executorId: string;
	writePolicy: WorkflowToolWritePolicy;
	auditEvent: string;
}

// Bounds single streamed tool arguments so large artifacts are saved incrementally.
export const SUMMARY_SAVE_CONTENT_MAX_LENGTH = 50_000;

export const WORKFLOW_TOOL_CONTRACTS = [
	{
		canonicalName: "gsd_decision_save",
		aliases: ["gsd_save_decision"],
		schemaId: "workflow.decision.save",
		executorId: "executeDecisionSave",
		writePolicy: "write",
		auditEvent: "workflow.decision.save",
	},
	{
		canonicalName: "gsd_requirement_update",
		aliases: ["gsd_update_requirement"],
		schemaId: "workflow.requirement.update",
		executorId: "executeRequirementUpdate",
		writePolicy: "write",
		auditEvent: "workflow.requirement.update",
	},
	{
		canonicalName: "gsd_requirement_save",
		aliases: ["gsd_save_requirement"],
		schemaId: "workflow.requirement.save",
		executorId: "executeRequirementSave",
		writePolicy: "write",
		auditEvent: "workflow.requirement.save",
	},
	{
		canonicalName: "gsd_milestone_generate_id",
		aliases: ["gsd_generate_milestone_id"],
		schemaId: "workflow.milestone.generate_id",
		executorId: "executeMilestoneGenerateId",
		writePolicy: "read",
		auditEvent: "workflow.milestone.generate_id",
	},
	{
		canonicalName: "gsd_plan_milestone",
		aliases: ["gsd_milestone_plan"],
		schemaId: "workflow.milestone.plan",
		executorId: "executePlanMilestone",
		writePolicy: "write",
		auditEvent: "workflow.milestone.plan",
	},
	{
		canonicalName: "gsd_plan_slice",
		aliases: ["gsd_slice_plan"],
		schemaId: "workflow.slice.plan",
		executorId: "executePlanSlice",
		writePolicy: "write",
		auditEvent: "workflow.slice.plan",
	},
	{
		canonicalName: "gsd_plan_task",
		aliases: ["gsd_task_plan"],
		schemaId: "workflow.task.plan",
		executorId: "executePlanTask",
		writePolicy: "write",
		auditEvent: "workflow.task.plan",
	},
	{
		canonicalName: "gsd_replan_slice",
		aliases: ["gsd_slice_replan"],
		schemaId: "workflow.slice.replan",
		executorId: "executeReplanSlice",
		writePolicy: "write",
		auditEvent: "workflow.slice.replan",
	},
	{
		canonicalName: "gsd_replan_task",
		aliases: [],
		schemaId: "workflow.task.replan",
		executorId: "executeReplanTask",
		writePolicy: "write",
		auditEvent: "workflow.task.replan",
	},
	{
		canonicalName: "gsd_rework_brief_save",
		aliases: [],
		schemaId: "workflow.rework_brief.save",
		executorId: "executeReworkBriefSave",
		writePolicy: "write",
		auditEvent: "workflow.rework_brief.save",
	},
	{
		canonicalName: "gsd_slice_complete",
		aliases: ["gsd_complete_slice"],
		schemaId: "workflow.slice.complete",
		executorId: "executeSliceComplete",
		writePolicy: "write",
		auditEvent: "workflow.slice.complete",
	},
	{
		canonicalName: "gsd_skip_slice",
		aliases: [],
		schemaId: "workflow.slice.skip",
		executorId: "executeSkipSlice",
		writePolicy: "write",
		auditEvent: "workflow.slice.skip",
	},
	{
		canonicalName: "gsd_complete_milestone",
		aliases: ["gsd_milestone_complete"],
		schemaId: "workflow.milestone.complete",
		executorId: "executeCompleteMilestone",
		writePolicy: "write",
		auditEvent: "workflow.milestone.complete",
	},
	{
		canonicalName: "gsd_validate_milestone",
		aliases: ["gsd_milestone_validate"],
		schemaId: "workflow.milestone.validate",
		executorId: "executeValidateMilestone",
		writePolicy: "write",
		auditEvent: "workflow.milestone.validate",
	},
	{
		canonicalName: "gsd_prepare_milestone_subjective_uat",
		aliases: [],
		schemaId: "workflow.milestone.subjective_uat.prepare",
		executorId: "executePrepareMilestoneSubjectiveUat",
		writePolicy: "write",
		auditEvent: "workflow.milestone.subjective_uat.prepare",
	},
	{
		canonicalName: "gsd_answer_milestone_subjective_uat",
		aliases: [],
		schemaId: "workflow.milestone.subjective_uat.answer",
		executorId: "executeAnswerMilestoneSubjectiveUat",
		writePolicy: "write",
		auditEvent: "workflow.milestone.subjective_uat.answer",
	},
	{
		canonicalName: "gsd_reassess_roadmap",
		aliases: ["gsd_roadmap_reassess"],
		schemaId: "workflow.roadmap.reassess",
		executorId: "executeReassessRoadmap",
		writePolicy: "write",
		auditEvent: "workflow.roadmap.reassess",
	},
	{
		canonicalName: "gsd_save_gate_result",
		aliases: [],
		schemaId: "workflow.gate.save_result",
		executorId: "executeSaveGateResult",
		writePolicy: "write",
		auditEvent: "workflow.gate.save_result",
	},
	{
		canonicalName: "gsd_uat_result_save",
		aliases: [],
		schemaId: "workflow.uat.result.save",
		executorId: "executeUatResultSave",
		writePolicy: "write",
		auditEvent: "workflow.uat.result.save",
	},
	{
		canonicalName: "gsd_summary_save",
		aliases: ["gsd_save_summary"],
		schemaId: "workflow.summary.save",
		executorId: "executeSummarySave",
		writePolicy: "write",
		auditEvent: "workflow.summary.save",
	},
	{
		canonicalName: "gsd_task_complete",
		aliases: ["gsd_complete_task"],
		schemaId: "workflow.task.complete",
		executorId: "executeTaskComplete",
		writePolicy: "write",
		auditEvent: "workflow.task.complete",
	},
	{
		canonicalName: "gsd_task_reopen",
		aliases: ["gsd_reopen_task"],
		schemaId: "workflow.task.reopen",
		executorId: "executeTaskReopen",
		writePolicy: "write",
		auditEvent: "workflow.task.reopen",
	},
	{
		canonicalName: "gsd_task_recovery_resume",
		aliases: [],
		schemaId: "workflow.task.recovery.resume",
		executorId: "executeTaskRecoveryResume",
		writePolicy: "write",
		auditEvent: "workflow.task.recovery.resume",
	},
	{
		canonicalName: "gsd_task_settle",
		aliases: [],
		schemaId: "workflow.task.settle",
		executorId: "executeTaskSettle",
		writePolicy: "write",
		auditEvent: "workflow.task.settle",
	},
	{
		canonicalName: "gsd_slice_reopen",
		aliases: ["gsd_reopen_slice"],
		schemaId: "workflow.slice.reopen",
		executorId: "executeSliceReopen",
		writePolicy: "write",
		auditEvent: "workflow.slice.reopen",
	},
	{
		canonicalName: "gsd_milestone_reopen",
		aliases: ["gsd_reopen_milestone"],
		schemaId: "workflow.milestone.reopen",
		executorId: "executeMilestoneReopen",
		writePolicy: "write",
		auditEvent: "workflow.milestone.reopen",
	},
	{
		canonicalName: "gsd_milestone_status",
		aliases: [],
		schemaId: "workflow.milestone.status",
		executorId: "executeMilestoneStatus",
		writePolicy: "read",
		auditEvent: "workflow.milestone.status",
	},
	{
		canonicalName: "gsd_checkpoint_db",
		aliases: [],
		schemaId: "workflow.database.checkpoint",
		executorId: "executeCheckpointDb",
		writePolicy: "read",
		auditEvent: "workflow.database.checkpoint",
	},
	{
		canonicalName: "gsd_journal_query",
		aliases: [],
		schemaId: "workflow.journal.query",
		executorId: "executeJournalQuery",
		writePolicy: "read",
		auditEvent: "workflow.journal.query",
	},
	{
		canonicalName: "gsd_uat_exec",
		aliases: [],
		schemaId: "workflow.uat.exec",
		executorId: "executeUatExec",
		writePolicy: "write",
		auditEvent: "workflow.uat.exec",
	},
	{
		canonicalName: "gsd_exec",
		aliases: [],
		schemaId: "workflow.exec.run",
		executorId: "executeGsdExec",
		writePolicy: "write",
		auditEvent: "workflow.exec.run",
	},
	{
		canonicalName: "gsd_exec_search",
		aliases: [],
		schemaId: "workflow.exec.search",
		executorId: "executeGsdExecSearch",
		writePolicy: "read",
		auditEvent: "workflow.exec.search",
	},
	{
		canonicalName: "gsd_resume",
		aliases: [],
		schemaId: "workflow.resume",
		executorId: "executeGsdResume",
		writePolicy: "read",
		auditEvent: "workflow.resume",
	},
	{
		canonicalName: "gsd_capture_thought",
		aliases: [],
		schemaId: "workflow.memory.capture_thought",
		executorId: "executeCaptureThought",
		writePolicy: "write",
		auditEvent: "workflow.memory.capture_thought",
	},
	{
		canonicalName: "gsd_memory_query",
		aliases: [],
		schemaId: "workflow.memory.query",
		executorId: "executeMemoryQuery",
		writePolicy: "read",
		auditEvent: "workflow.memory.query",
	},
	{
		canonicalName: "gsd_memory_graph",
		aliases: [],
		schemaId: "workflow.memory.graph",
		executorId: "executeMemoryGraph",
		writePolicy: "read",
		auditEvent: "workflow.memory.graph",
	},
	{
		canonicalName: "gsd_requirement_list",
		aliases: [],
		schemaId: "workflow.requirement.list",
		executorId: "executeRequirementList",
		writePolicy: "read",
		auditEvent: "workflow.requirement.list",
	},
	{
		canonicalName: "gsd_requirement_get",
		aliases: [],
		schemaId: "workflow.requirement.get",
		executorId: "executeRequirementGet",
		writePolicy: "read",
		auditEvent: "workflow.requirement.get",
	},
	{
		canonicalName: "gsd_decision_list",
		aliases: [],
		schemaId: "workflow.decision.list",
		executorId: "executeDecisionList",
		writePolicy: "read",
		auditEvent: "workflow.decision.list",
	},
	{
		canonicalName: "gsd_decision_get",
		aliases: [],
		schemaId: "workflow.decision.get",
		executorId: "executeDecisionGet",
		writePolicy: "read",
		auditEvent: "workflow.decision.get",
	},
	{
		canonicalName: "gsd_project_snapshot",
		aliases: [],
		schemaId: "workflow.project.snapshot",
		executorId: "executeProjectSnapshot",
		writePolicy: "read",
		auditEvent: "workflow.project.snapshot",
	},
	{
		canonicalName: "gsd_project_init",
		aliases: [],
		schemaId: "workflow.project.init",
		executorId: "executeProjectInit",
		writePolicy: "write",
		auditEvent: "workflow.project.init",
	},
] as const satisfies readonly WorkflowToolContractMetadata[];

/** Literal union of canonical workflow tool names. Typing a name list with this union makes drift from WORKFLOW_TOOL_CONTRACTS a compile error. */
export type CanonicalWorkflowToolName = (typeof WORKFLOW_TOOL_CONTRACTS)[number]["canonicalName"];

/** Literal union of backwards-compatibility alias names. */
export type WorkflowToolAliasName = (typeof WORKFLOW_TOOL_CONTRACTS)[number]["aliases"][number];

export const WORKFLOW_TOOL_NAMES = WORKFLOW_TOOL_CONTRACTS.flatMap((tool) => [
	tool.canonicalName,
	...tool.aliases,
]) as readonly string[];

/** Canonical tool names only (excludes backwards-compatibility aliases). */
export const CANONICAL_WORKFLOW_TOOL_NAMES = WORKFLOW_TOOL_CONTRACTS.map(
	(tool) => tool.canonicalName,
) as readonly string[];

/**
 * Backwards-compatibility alias names (each forwards to a canonical twin).
 * Callers may exclude these from an advertised tool surface to save tokens —
 * see registerWorkflowTools({ advertiseAliases }).
 */
export const WORKFLOW_TOOL_ALIAS_NAMES = WORKFLOW_TOOL_CONTRACTS.flatMap(
	(tool) => tool.aliases,
) as readonly string[];
