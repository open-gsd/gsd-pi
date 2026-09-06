// Project/App: gsd-pi
// File Purpose: Registers DB-backed GSD workflow tools and compatibility aliases.
import { StringEnum, Type } from "@gsd/pi-ai";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";
import { SUMMARY_SAVE_CONTENT_MAX_LENGTH } from "@opengsd/contracts";
import { existsSync } from "node:fs";
import { getErrorMessage } from "../error-utils.js";
import { piExecutionInvocation } from "../execution-invocation.js";
import { incrementLegacyTelemetry } from "../legacy-telemetry.js";
import { piPlanningInvocation } from "../planning-invocation.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import type { DbAdapter } from "../db-adapter.js";
import {
	openWorkflowDatabaseIsolated,
	resolveProjectRootDbPath,
} from "../db-workspace.js";
import { prepareSaveGateResultArguments } from "../tools/save-gate-result-args.js";
import { logError } from "../workflow-logger.js";
import { importWorkflowExecutorsModule } from "../workflow-mcp.js";
import { aliasesForWorkflowTool } from "../workflow-tool-surface.js";
import {
	ensureDbOpen,
	resolveCtxCwd,
	resolveTaskRecoveryResumeBasePath,
	resolveWorkflowToolBasePath,
} from "./dynamic-tools.js";
import {
	loadWriteGateSnapshot,
	shouldBlockRootArtifactSaveInSnapshot,
} from "./write-gate.js";

async function loadWorkflowExecutors(): Promise<
	typeof import("../tools/workflow-tool-executors.js")
> {
	return importWorkflowExecutorsModule();
}

function formatWorkflowToolLoadError(err: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: { operation: string; error: string };
	isError: true;
} {
	const msg = getErrorMessage(err);
	return {
		content: [{ type: "text", text: `Error: ${msg}` }],
		details: { operation: "workflow_tool_load", error: msg },
		isError: true,
	};
}

/**
 * Register an alias tool that shares the same execute function as its canonical counterpart.
 * The alias description and promptGuidelines direct the LLM to prefer the canonical name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but typing it fully requires generics
function registerAlias(
	pi: ExtensionAPI,
	toolDef: any,
	aliasName: string,
	canonicalName: string,
): void {
	const execute =
		typeof toolDef.execute === "function"
			? async (...args: any[]) => {
					incrementLegacyTelemetry("legacy.mcpAliasUsed");
					return toolDef.execute(...args);
				}
			: toolDef.execute;

	pi.registerTool({
		...toolDef,
		name: aliasName,
		description:
			toolDef.description +
			` (alias for ${canonicalName} — prefer the canonical name)`,
		promptGuidelines: [
			`Alias for ${canonicalName} — prefer the canonical name.`,
		],
		execute,
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but varies by schema
function registerWorkflowTool(pi: ExtensionAPI, toolDef: any): void {
	pi.registerTool(toolDef);
	if (process.env.GSD_ADVERTISE_TOOL_ALIASES !== "1") return; // canonical-only model surface (see plan 035)
	for (const alias of aliasesForWorkflowTool(toolDef.name)) {
		registerAlias(pi, toolDef, alias, toolDef.name);
	}
}

function requirementRootWriteGuard(
	operation: string,
	basePath: string,
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError: true;
} | null {
	const guard = shouldBlockRootArtifactSaveInSnapshot(
		loadWriteGateSnapshot(basePath),
		"REQUIREMENTS",
	);
	if (!guard.block) return null;
	return {
		content: [
			{
				type: "text",
				text: `Error ${operation} requirement: ${guard.reason ?? "requirements write blocked"}`,
			},
		],
		details: { operation, error: "root_artifact_write_blocked" },
		isError: true,
	};
}

/**
 * Read a tool result's structured payload, accommodating MCP's `details` →
 * `structuredContent` rename (#4472, #4477). In-process executions still
 * deliver the payload on `result.details`; MCP-routed executions deliver it
 * on `result.structuredContent` (post `adaptExecutorResult` transform). All
 * `renderResult` callbacks in this file route through this helper so a future
 * field rename only needs to be applied in one place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- result shape varies by tool
function readDetails(result: any): any {
	return result?.details ?? result?.structuredContent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- result shape varies by tool
function formatToolErrorText(result: any, details: any): string {
	if (typeof details?.displayReason === "string" && details.displayReason) {
		return details.displayReason;
	}
	const message =
		details?.error ??
		result?.content?.find(
			(entry: { type?: string; text?: string }) => entry.type === "text",
		)?.text ??
		"unknown";
	return typeof message === "string" && message.startsWith("Error")
		? message
		: `Error: ${message}`;
}

function withCanonicalReadAdapter<T>(
	basePath: string,
	run: (adapter: DbAdapter) => Promise<T>,
): Promise<T> {
	const dbPath = resolveProjectRootDbPath(basePath);
	if (!existsSync(dbPath)) {
		throw new Error("Database adapter not available (db_unavailable)");
	}
	const adapter = openWorkflowDatabaseIsolated(dbPath);
	if (!adapter) {
		throw new Error("Database adapter not available (db_unavailable)");
	}
	return Promise.resolve()
		.then(() => run(adapter))
		.finally(() => {
			adapter.close();
		});
}

const UAT_EVIDENCE_KIND_VALUES = [
	"gsd_uat_exec",
	"gsd_exec",
	"screenshot",
	"log",
	"url",
	"browser",
] as const;
const UAT_EVIDENCE_REF_DESCRIPTION =
	"Kind-specific evidence ref: gsd_uat_exec/gsd_exec use an evidence id or .gsd/exec/*.meta.json path; " +
	"screenshot/log use a path under .gsd/exec/, .gsd/uat/, or .artifacts/browser/; " +
	"url uses an http(s) URL; browser uses an http(s) URL or .artifacts/browser/ path.";

export function registerDbTools(pi: ExtensionAPI): void {
	// ─── gsd_decision_save (formerly gsd_save_decision) ─────────────────────

	const decisionSaveExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		const dbAvailable = await ensureDbOpen(basePath);
		if (!dbAvailable) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: GSD database is not available. Cannot save decision.",
					},
				],
				details: { operation: "save_decision", error: "db_unavailable" } as any,
			};
		}
		try {
			const { saveDecisionToDb } = await import("../db-writer.js");
			const { id } = await saveDecisionToDb(
				{
					scope: params.scope,
					decision: params.decision,
					choice: params.choice,
					rationale: params.rationale,
					revisable: params.revisable,
					when_context: params.when_context,
					made_by: params.made_by,
				},
				basePath,
			);
			return {
				content: [{ type: "text" as const, text: `Saved decision ${id}` }],
				details: { operation: "save_decision", id } as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logError("tool", `gsd_decision_save tool failed: ${msg}`, {
				tool: "gsd_decision_save",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error saving decision: ${msg}` },
				],
				details: { operation: "save_decision", error: msg } as any,
			};
		}
	};

	const decisionSaveTool = {
		name: "gsd_decision_save",
		label: "Save Decision",
		description:
			"Record a project decision to the GSD database and regenerate DECISIONS.md. " +
			"Decision IDs are auto-assigned — never provide an ID manually.",
		promptSnippet:
			"Record a project decision to the GSD database (auto-assigns ID, regenerates DECISIONS.md)",
		promptGuidelines: [
			"Use gsd_decision_save when recording an architectural, pattern, library, or observability decision.",
			"Decision IDs are auto-assigned (D001, D002, ...) — never guess or provide an ID.",
			"All fields except revisable, when_context, and made_by are required.",
			"The tool writes to the DB and regenerates .gsd/DECISIONS.md automatically.",
			"Set made_by to 'human' when the user explicitly directed the decision, 'agent' when the LLM chose autonomously (default), or 'collaborative' when it was discussed and agreed together.",
		],
		parameters: Type.Object({
			scope: Type.String({
				description:
					"Scope of the decision (e.g. 'architecture', 'library', 'observability')",
			}),
			decision: Type.String({ description: "What is being decided" }),
			choice: Type.String({ description: "The choice made" }),
			rationale: Type.String({ description: "Why this choice was made" }),
			revisable: Type.Optional(
				Type.String({
					description: "Whether this can be revisited (default: 'Yes')",
				}),
			),
			when_context: Type.Optional(
				Type.String({
					description: "When/context for the decision (e.g. milestone ID)",
				}),
			),
			made_by: Type.Optional(
				StringEnum(["human", "agent", "collaborative"], {
					description:
						"Who made this decision: 'human' (user directed), 'agent' (LLM decided autonomously), or 'collaborative' (discussed and agreed). Default: 'agent'",
				}),
			),
		}),
		execute: decisionSaveExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("decision_save "));
			if (args.scope) text += theme.fg("accent", `[${args.scope}] `);
			if (args.decision) text += theme.fg("muted", args.decision);
			if (args.choice) text += theme.fg("dim", ` — ${args.choice}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			let text = theme.fg("success", `Decision ${d?.id ?? ""} saved`);
			if (d?.id) text += theme.fg("dim", ` → DECISIONS.md`);
			return new Text(text, 0, 0);
		},
	};

	registerWorkflowTool(pi, decisionSaveTool);

	// ─── gsd_requirement_update (formerly gsd_update_requirement) ───────────

	const requirementUpdateExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		const gateBlock = requirementRootWriteGuard("update_requirement", basePath);
		if (gateBlock) return gateBlock;
		const dbAvailable = await ensureDbOpen(basePath);
		if (!dbAvailable) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: GSD database is not available. Cannot update requirement.",
					},
				],
				details: {
					operation: "update_requirement",
					id: params.id,
					error: "db_unavailable",
				} as any,
			};
		}
		try {
			const { updateRequirementInDb } = await import("../db-writer.js");
			const updates: Record<string, string | undefined> = {};
			if (params.status !== undefined) updates.status = params.status;
			if (params.validation !== undefined)
				updates.validation = params.validation;
			if (params.notes !== undefined) updates.notes = params.notes;
			if (params.description !== undefined)
				updates.description = params.description;
			if (params.primary_owner !== undefined)
				updates.primary_owner = params.primary_owner;
			if (params.supporting_slices !== undefined)
				updates.supporting_slices = params.supporting_slices;
			await updateRequirementInDb(params.id, updates, basePath);
			return {
				content: [
					{ type: "text" as const, text: `Updated requirement ${params.id}` },
				],
				details: { operation: "update_requirement", id: params.id } as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logError("tool", `gsd_requirement_update tool failed: ${msg}`, {
				tool: "gsd_requirement_update",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error updating requirement: ${msg}` },
				],
				details: {
					operation: "update_requirement",
					id: params.id,
					error: msg,
				} as any,
			};
		}
	};

	const requirementUpdateTool = {
		name: "gsd_requirement_update",
		label: "Update Requirement",
		description:
			"Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md. " +
			"Provide the requirement ID (e.g. R001) and any fields to update.",
		promptSnippet:
			"Update an existing GSD requirement by ID (regenerates REQUIREMENTS.md)",
		promptGuidelines: [
			"Use gsd_requirement_update to change status, validation, notes, or other fields on an existing requirement.",
			"The id parameter is required — it must be an existing RXXX identifier.",
			"All other fields are optional — only provided fields are updated.",
			"The tool verifies the requirement exists before updating.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "The requirement ID (e.g. R001, R014)" }),
			status: Type.Optional(
				Type.String({
					description: "New status (e.g. 'active', 'validated', 'deferred')",
				}),
			),
			validation: Type.Optional(
				Type.String({ description: "Validation criteria or proof" }),
			),
			notes: Type.Optional(Type.String({ description: "Additional notes" })),
			description: Type.Optional(
				Type.String({ description: "Updated description" }),
			),
			primary_owner: Type.Optional(
				Type.String({ description: "Primary owning slice" }),
			),
			supporting_slices: Type.Optional(
				Type.String({ description: "Supporting slices" }),
			),
		}),
		execute: requirementUpdateExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("requirement_update "));
			if (args.id) text += theme.fg("accent", args.id);
			const fields = ["status", "validation", "notes", "description"].filter(
				(f) => args[f],
			);
			if (fields.length > 0) text += theme.fg("dim", ` (${fields.join(", ")})`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			let text = theme.fg("success", `Requirement ${d?.id ?? ""} updated`);
			text += theme.fg("dim", ` → REQUIREMENTS.md`);
			return new Text(text, 0, 0);
		},
	};

	registerWorkflowTool(pi, requirementUpdateTool);

	// ─── gsd_requirement_save ─────────────────────────────────────────────

	const requirementSaveExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		const gateBlock = requirementRootWriteGuard("save_requirement", basePath);
		if (gateBlock) return gateBlock;
		const dbAvailable = await ensureDbOpen(basePath);
		if (!dbAvailable) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: GSD database is not available. Cannot save requirement.",
					},
				],
				details: {
					operation: "save_requirement",
					error: "db_unavailable",
				} as any,
			};
		}
		try {
			const { saveRequirementToDb } = await import("../db-writer.js");
			const result = await saveRequirementToDb(
				{
					class: params.class,
					status: params.status,
					description: params.description,
					why: params.why,
					source: params.source,
					primary_owner: params.primary_owner,
					supporting_slices: params.supporting_slices,
					validation: params.validation,
					notes: params.notes,
				},
				basePath,
			);
			return {
				content: [
					{ type: "text" as const, text: `Saved requirement ${result.id}` },
				],
				details: { operation: "save_requirement", id: result.id } as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logError("tool", `gsd_requirement_save tool failed: ${msg}`, {
				tool: "gsd_requirement_save",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error saving requirement: ${msg}` },
				],
				details: { operation: "save_requirement", error: msg } as any,
			};
		}
	};

	const requirementSaveTool = {
		name: "gsd_requirement_save",
		label: "Save Requirement",
		description:
			"Record a new requirement to the GSD database and regenerate REQUIREMENTS.md. " +
			"Requirement IDs are auto-assigned — never provide an ID manually.",
		promptSnippet:
			"Record a new GSD requirement to the database (auto-assigns ID, regenerates REQUIREMENTS.md)",
		promptGuidelines: [
			"Use gsd_requirement_save when recording a new capability, quality attribute, constraint, or anti-feature requirement.",
			"Use one of these classes: core-capability, primary-user-loop, launchability, continuity, failure-visibility, integration, quality-attribute, operability, admin/support, compliance/security, differentiator, constraint, anti-feature.",
			"Requirement IDs are auto-assigned (R001, R002, ...) — never guess or provide an ID.",
			"class, description, why, and source are required. All other fields are optional.",
			"The tool writes to the DB and regenerates .gsd/REQUIREMENTS.md automatically.",
		],
		parameters: Type.Object({
			class: StringEnum(
				[
					"core-capability",
					"primary-user-loop",
					"launchability",
					"continuity",
					"failure-visibility",
					"integration",
					"quality-attribute",
					"operability",
					"admin/support",
					"compliance/security",
					"differentiator",
					"constraint",
					"anti-feature",
				],
				{ description: "Requirement class" },
			),
			description: Type.String({
				description: "Short description of the requirement",
			}),
			why: Type.String({ description: "Why this requirement matters" }),
			source: Type.String({
				description:
					"Origin of the requirement (e.g. 'user-research', 'design', 'M001')",
			}),
			status: Type.Optional(
				Type.String({ description: "Status (default: 'active')" }),
			),
			primary_owner: Type.Optional(
				Type.String({ description: "Primary owning slice" }),
			),
			supporting_slices: Type.Optional(
				Type.String({ description: "Supporting slices" }),
			),
			validation: Type.Optional(
				Type.String({ description: "Validation criteria" }),
			),
			notes: Type.Optional(Type.String({ description: "Additional notes" })),
		}),
		execute: requirementSaveExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("requirement_save "));
			if (args.class) text += theme.fg("accent", `[${args.class}] `);
			if (args.description) text += theme.fg("muted", args.description);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			let text = theme.fg("success", `Requirement ${d?.id ?? ""} saved`);
			text += theme.fg("dim", ` → REQUIREMENTS.md`);
			return new Text(text, 0, 0);
		},
	};

	registerWorkflowTool(pi, requirementSaveTool);

	// ─── gsd_summary_save (formerly gsd_save_summary) ──────────────────────

	const summarySaveExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		try {
			const { executeSummarySave } = await loadWorkflowExecutors();
			return await executeSummarySave(
				params,
				resolveWorkflowToolBasePath(_ctx, params),
			);
		} catch (err) {
			return {
				...formatWorkflowToolLoadError(err),
				details: { operation: "save_summary", error: getErrorMessage(err) },
			};
		}
	};

	const summarySaveTool = {
		name: "gsd_summary_save",
		label: "Save Summary",
		description:
			"Save a summary, research, UI spec, context, or assessment artifact to the GSD database and write it to disk. " +
			"Computes the file path from milestone/slice/task IDs automatically.",
		promptSnippet:
			"Save a GSD artifact (summary/research/UI spec/context/assessment) to DB and disk",
		promptGuidelines: [
			"Use gsd_summary_save to persist structured artifacts (SUMMARY, RESEARCH, UI-SPEC, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT).",
			"milestone_id is required for milestone/slice/task artifacts. Omit milestone_id only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT.",
			"The tool computes the relative path automatically: milestones/M001/M001-SUMMARY.md, milestones/M001/slices/S01/S01-SUMMARY.md, etc.",
			"Root-level artifact paths are PROJECT.md, PROJECT-DRAFT.md, REQUIREMENTS.md, and REQUIREMENTS-DRAFT.md.",
			"artifact_type must be one of: SUMMARY, RESEARCH, UI-SPEC, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT.",
			"Use CONTEXT-DRAFT for incremental draft persistence; use CONTEXT for the final milestone context after depth verification.",
			`Keep each content payload under ${SUMMARY_SAVE_CONTENT_MAX_LENGTH} characters; save large context incrementally with CONTEXT-DRAFT/PROJECT-DRAFT/REQUIREMENTS-DRAFT instead of one oversized call.`,
		],
		parameters: Type.Object({
			milestone_id: Type.Optional(
				Type.String({
					description:
						"Milestone ID (e.g. M001). Omit only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts.",
				}),
			),
			slice_id: Type.Optional(
				Type.String({ description: "Slice ID (e.g. S01)" }),
			),
			task_id: Type.Optional(
				Type.String({ description: "Task ID (e.g. T01)" }),
			),
			artifact_type: StringEnum(
				[
					"SUMMARY",
					"RESEARCH",
					"UI-SPEC",
					"CONTEXT",
					"ASSESSMENT",
					"CONTEXT-DRAFT",
					"PROJECT",
					"PROJECT-DRAFT",
					"REQUIREMENTS",
					"REQUIREMENTS-DRAFT",
				],
				{ description: "Artifact type to save" },
			),
			content: Type.String({
				description: `The full markdown content of the artifact. Maximum ${SUMMARY_SAVE_CONTENT_MAX_LENGTH} characters per save.`,
				maxLength: SUMMARY_SAVE_CONTENT_MAX_LENGTH,
			}),
		}),
		execute: summarySaveExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("summary_save "));
			if (args.artifact_type) text += theme.fg("accent", args.artifact_type);
			const path = [args.milestone_id, args.slice_id, args.task_id]
				.filter(Boolean)
				.join("/");
			if (path) text += theme.fg("dim", ` ${path}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			let text = theme.fg("success", `${d?.artifact_type ?? "Artifact"} saved`);
			if (d?.path) text += theme.fg("dim", ` → ${d.path}`);
			return new Text(text, 0, 0);
		},
	};

	registerWorkflowTool(pi, summarySaveTool);

	// ─── gsd_uat_result_save ─────────────────────────────────────────────────

	const uatResultSaveExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeUatResultSave } = await loadWorkflowExecutors();
		return executeUatResultSave(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
		);
	};

	const uatEvidenceRef = Type.Object({
		kind: StringEnum(UAT_EVIDENCE_KIND_VALUES, {
			description: `Evidence kind. Valid values: ${UAT_EVIDENCE_KIND_VALUES.join(", ")}`,
		}),
		ref: Type.String({ description: UAT_EVIDENCE_REF_DESCRIPTION }),
		note: Type.Optional(Type.String({ description: "Short evidence note" })),
		unitType: Type.Optional(
			Type.String({ description: "Unit that produced the evidence" }),
		),
		tool: Type.Optional(
			Type.String({ description: "Tool that produced the evidence" }),
		),
		executionId: Type.Optional(
			Type.String({ description: "Stable execution or artifact id" }),
		),
	});

	const uatCheck = Type.Object({
		id: Type.String({ description: "Stable check ID from the UAT spec" }),
		description: Type.String({ description: "Check description" }),
		mode: StringEnum(["artifact", "runtime", "browser", "human-follow-up"], {
			description: "Evidence mode",
		}),
		result: StringEnum(["PASS", "FAIL", "NEEDS-HUMAN"], {
			description: "Check result",
		}),
		evidence: Type.Optional(
			Type.Array(uatEvidenceRef, {
				description: "Objective evidence references",
			}),
		),
		notes: Type.Optional(
			Type.String({
				description: "Observed result, failure notes, or human instruction",
			}),
		),
		nonAutomatable: Type.Optional(
			Type.Boolean({
				description: "True when the check is explicitly non-automatable",
			}),
		),
	});

	const toolPresentationBlock = Type.Object({
		surface: Type.Optional(
			StringEnum(["provider-tools", "claude-code-sdk", "mcp", "hybrid"], {
				description: "Tool presentation surface",
			}),
		),
		model: Type.Optional(
			Type.Object({
				provider: Type.Optional(Type.String()),
				api: Type.Optional(Type.String()),
				id: Type.Optional(Type.String()),
			}),
		),
		presentedTools: Type.Optional(
			Type.Array(Type.String(), {
				description: "Tool names actually presented to the model",
			}),
		),
		blockedTools: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String(),
					reason: Type.String(),
				}),
				{ description: "Tool names blocked from the model with reasons" },
			),
		),
		aliases: Type.Optional(
			Type.Array(
				Type.Object({
					requested: Type.String(),
					canonical: Type.String(),
				}),
			),
		),
		fallbackToolsUsed: Type.Optional(Type.Array(Type.String())),
		toolPresentationPlanId: Type.Optional(Type.String()),
		notes: Type.Optional(Type.String()),
	});

	const uatResultSaveTool = {
		name: "gsd_uat_result_save",
		label: "Save UAT Result",
		description:
			"Save a structured UAT result for a slice. Validates evidence, writes the ASSESSMENT artifact, " +
			"records attempt history, and saves the aggregate UAT gate result.",
		promptSnippet:
			"Save structured UAT checks, evidence, verdict, and tool-presentation proof",
		promptGuidelines: [
			"Call gsd_uat_result_save once after all UAT checks have been executed.",
			"Every PASS or FAIL check must cite objective evidence, preferably a gsd_uat_exec evidence ID.",
			"Include the presented and blocked tool set in presentation so tool timing is auditable.",
			"Do not use raw gsd_summary_save as a substitute for UAT results.",
		],
		parameters: Type.Object({
			milestoneId: Type.Optional(
				Type.String({ description: "Milestone ID (e.g. M001)" }),
			),
			sliceId: Type.Optional(
				Type.String({ description: "Slice ID (e.g. S01)" }),
			),
			uatType: Type.Optional(Type.String({ description: "Declared UAT mode" })),
			verdict: Type.Optional(
				Type.String({
					description: "Overall UAT verdict: PASS, FAIL, or PARTIAL",
				}),
			),
			checks: Type.Optional(
				Type.Array(uatCheck, { description: "Structured check results" }),
			),
			presentation: Type.Optional(toolPresentationBlock),
			notes: Type.Optional(
				Type.String({ description: "Overall verdict rationale" }),
			),
			attempt: Type.Optional(
				Type.String({ description: "Attempt number or auto" }),
			),
			previousAttemptId: Type.Optional(
				Type.String({ description: "Prior attempt ID, when retrying" }),
			),
		}),
		execute: uatResultSaveExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("uat_result_save "));
			text += theme.fg(
				"accent",
				`${args.milestoneId ?? "?"}/${args.sliceId ?? "?"}`,
			);
			if (args.verdict) text += theme.fg("dim", ` → ${args.verdict}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			return new Text(
				theme.fg(
					"success",
					`UAT ${d?.sliceId ?? ""}: ${d?.verdict ?? "saved"}`,
				),
				0,
				0,
			);
		},
	};

	registerWorkflowTool(pi, uatResultSaveTool);

	// ─── gsd_milestone_generate_id (formerly gsd_generate_milestone_id) ────

	const milestoneGenerateIdExecute = async (
		_toolCallId: string,
		_params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		try {
			const basePath = resolveCtxCwd(_ctx);
			// Claim a reserved ID if the guided-flow already previewed one to the user.
			// This guarantees the ID shown in the UI matches the one materialised on disk.
			const {
				claimReservedId,
				findMilestoneIds,
				getReservedMilestoneIds,
				nextMilestoneId,
			} = await import("../guided-flow.js");
			const reserved = claimReservedId();
			if (reserved) {
				await ensureMilestoneDbRow(reserved, basePath);
				return {
					content: [{ type: "text" as const, text: reserved }],
					details: {
						operation: "generate_milestone_id",
						id: reserved,
						source: "reserved",
					} as any,
				};
			}

			await ensureDbOpen(basePath);
			const { getAllMilestones } = await import("../gsd-db.js");
			const existingIds = [
				...findMilestoneIds(basePath),
				...getAllMilestones().map((m) => m.id),
			];
			const uniqueEnabled =
				!!loadEffectiveGSDPreferences(basePath)?.preferences
					?.unique_milestone_ids;
			const allIds = [
				...new Set([...existingIds, ...getReservedMilestoneIds()]),
			];
			const newId = nextMilestoneId(allIds, uniqueEnabled);
			await ensureMilestoneDbRow(newId, basePath);
			return {
				content: [{ type: "text" as const, text: newId }],
				details: {
					operation: "generate_milestone_id",
					id: newId,
					existingCount: existingIds.length,
					uniqueEnabled,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text" as const,
						text: `Error generating milestone ID: ${msg}`,
					},
				],
				details: { operation: "generate_milestone_id", error: msg } as any,
			};
		}
	};

	/**
	 * Insert a minimal DB row for a milestone ID so it's visible to the state
	 * machine. Uses INSERT OR IGNORE — safe to call even if gsd_plan_milestone
	 * later writes the full row. Silently skips if the DB isn't available yet
	 * (pre-migration).
	 */
	async function ensureMilestoneDbRow(
		milestoneId: string,
		basePath: string,
	): Promise<void> {
		const dbAvailable = await ensureDbOpen(basePath);
		if (!dbAvailable) return;
		try {
			const { insertMilestone } = await import("../gsd-db.js");
			insertMilestone({ id: milestoneId, status: "queued" });
		} catch (e) {
			logError(
				"tool",
				`insertMilestone failed for ${milestoneId}: ${(e as Error).message}`,
			);
		}
	}

	const milestoneGenerateIdTool = {
		name: "gsd_milestone_generate_id",
		label: "Generate Milestone ID",
		description:
			"Generate the next milestone ID for a new GSD milestone. " +
			"Scans existing milestones on disk and respects the unique_milestone_ids preference. " +
			"Always use this tool when creating a new milestone — never invent milestone IDs manually.",
		promptSnippet:
			"Generate a valid milestone ID (respects unique_milestone_ids preference)",
		promptGuidelines: [
			"ALWAYS call gsd_milestone_generate_id before creating a new milestone directory or writing milestone files.",
			"Never invent or hardcode milestone IDs like M001, M002 — always use this tool.",
			"Call it once per milestone you need to create. For multi-milestone projects, call it once for each milestone in sequence.",
			"The tool returns the correct format based on project preferences (e.g. M001 or M001-r5jzab).",
		],
		parameters: Type.Object({}),
		execute: milestoneGenerateIdExecute,
		renderCall(_args: any, theme: any) {
			return new Text(
				theme.fg("toolTitle", theme.bold("milestone_generate_id")),
				0,
				0,
			);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			let text = theme.fg("success", `Generated ${d?.id ?? "ID"}`);
			if (d?.source === "reserved") text += theme.fg("dim", " (reserved)");
			return new Text(text, 0, 0);
		},
	};

	registerWorkflowTool(pi, milestoneGenerateIdTool);

	// ─── gsd_plan_milestone (gsd_milestone_plan alias) ─────────────────────

	const planMilestoneExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executePlanMilestone } = await loadWorkflowExecutors();
		return executePlanMilestone(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piPlanningInvocation("gsd_plan_milestone", toolCallId),
		);
	};

	const planMilestoneTool = {
		name: "gsd_plan_milestone",
		label: "Plan Milestone",
		description:
			"Write milestone planning state to the GSD database, render ROADMAP.md from DB, and clear caches after a successful render.",
		promptSnippet:
			"Plan a milestone via DB write + roadmap render + cache invalidation",
		promptGuidelines: [
			"Use gsd_plan_milestone for milestone planning instead of writing ROADMAP.md directly.",
			"Requires milestoneId, title, vision, and slices[] — never pass only milestoneId + sliceId (that is gsd_plan_slice).",
			"Keep parameters flat and provide the full milestone planning payload, including slices.",
			"Milestone and slice titles must not contain forward slash (/), en dash, or em dash characters.",
			"The tool validates input, writes milestone and slice planning data transactionally, renders ROADMAP.md from DB, and clears both state and parse caches after success.",
			"Use the canonical name gsd_plan_milestone; gsd_milestone_plan is only an alias.",
		],
		parameters: Type.Object({
			// ── Core identification + content (required) ──────────────────────
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			title: Type.String({
				description:
					"Milestone title; must not contain forward slash (/), en dash, or em dash characters",
			}),
			vision: Type.String({ description: "Milestone vision" }),
			slices: Type.Array(
				Type.Object({
					sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
					title: Type.String({
						description:
							"Slice title; must not contain forward slash (/), en dash, or em dash characters",
					}),
					risk: Type.String({ description: "Slice risk" }),
					depends: Type.Array(Type.String(), {
						description: "Slice dependency IDs",
					}),
					demo: Type.String({ description: "Roadmap demo text / After this" }),
					goal: Type.String({ description: "Slice goal" }),
					// ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
					successCriteria: Type.Optional(
						Type.String({
							description:
								"Slice success criteria block (required for full slices; omit for sketches)",
						}),
					),
					proofLevel: Type.Optional(
						Type.String({
							description:
								"Slice proof level (required for full slices; omit for sketches)",
						}),
					),
					integrationClosure: Type.Optional(
						Type.String({
							description:
								"Slice integration closure (required for full slices; omit for sketches)",
						}),
					),
					observabilityImpact: Type.Optional(
						Type.String({
							description:
								"Slice observability impact (required for full slices; omit for sketches)",
						}),
					),
					// ADR-011 sketch-then-refine fields.
					isSketch: Type.Optional(
						Type.Boolean({
							description:
								"ADR-011: true marks this slice as a sketch awaiting refine-slice expansion",
						}),
					),
					sketchScope: Type.Optional(
						Type.String({
							description:
								"ADR-011: 2–3 sentence scope boundary, required when isSketch=true",
						}),
					),
				}),
				{ description: "Planned slices for the milestone" },
			),
			// ── Enrichment metadata (optional — defaults to empty) ────────────
			status: Type.Optional(
				Type.String({ description: "Milestone status (defaults to active)" }),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String(), { description: "Milestone dependencies" }),
			),
			successCriteria: Type.Optional(
				Type.Array(Type.String(), {
					description: "Top-level success criteria bullets",
				}),
			),
			keyRisks: Type.Optional(
				Type.Array(
					Type.Object({
						risk: Type.String({ description: "Risk statement" }),
						whyItMatters: Type.String({ description: "Why the risk matters" }),
					}),
					{ description: "Structured risk entries" },
				),
			),
			proofStrategy: Type.Optional(
				Type.Array(
					Type.Object({
						riskOrUnknown: Type.String({
							description: "Risk or unknown to retire",
						}),
						retireIn: Type.String({ description: "Where it will be retired" }),
						whatWillBeProven: Type.String({
							description: "What proof will be produced",
						}),
					}),
					{ description: "Structured proof strategy entries" },
				),
			),
			verificationContract: Type.Optional(
				Type.String({ description: "Verification contract text" }),
			),
			verificationIntegration: Type.Optional(
				Type.String({ description: "Integration verification text" }),
			),
			verificationOperational: Type.Optional(
				Type.String({ description: "Operational verification text" }),
			),
			verificationUat: Type.Optional(
				Type.String({ description: "UAT verification text" }),
			),
			definitionOfDone: Type.Optional(
				Type.Array(Type.String(), {
					description: "Definition of done bullets",
				}),
			),
			requirementCoverage: Type.Optional(
				Type.String({ description: "Requirement coverage text" }),
			),
			boundaryMapMarkdown: Type.Optional(
				Type.String({ description: "Boundary map markdown block" }),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'plan-phase complete')",
				}),
			),
		}),
		execute: planMilestoneExecute,
	};

	registerWorkflowTool(pi, planMilestoneTool);

	// ─── gsd_plan_slice (gsd_slice_plan alias) ─────────────────────────────

	const planSliceExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executePlanSlice } = await loadWorkflowExecutors();
		return executePlanSlice(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piPlanningInvocation("gsd_plan_slice", toolCallId),
		);
	};

	const planSliceTool = {
		name: "gsd_plan_slice",
		label: "Plan Slice",
		description:
			"Write slice planning state to the GSD database, render S##-PLAN.md plus task PLAN artifacts from DB, and clear caches after a successful render.",
		promptSnippet:
			"Plan a slice via DB write + PLAN render + cache invalidation",
		promptGuidelines: [
			"Use gsd_plan_slice for slice planning instead of writing S##-PLAN.md or task PLAN files directly.",
			"For incremental planning, call gsd_plan_slice with slice metadata only, then call gsd_plan_task once per task.",
			"When tasks is omitted or empty, the tool writes only slice planning metadata and preserves existing tasks.",
			"When tasks is non-empty, the tool validates input, requires an existing parent slice, writes slice/task planning data, renders PLAN.md and task plan files from DB, and clears both state and parse caches after success.",
			"Every task must declare requiredWorkflowTools; use [] for ordinary implementation tasks. Tools unavailable to execute-task are rejected before persistence.",
			"Use the canonical name gsd_plan_slice; gsd_slice_plan is only an alias.",
		],
		parameters: Type.Object({
			// ── Core identification + content (required) ──────────────────────
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			goal: Type.String({ description: "Slice goal" }),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						taskId: Type.String({ description: "Task ID (e.g. T01)" }),
						title: Type.String({ description: "Task title" }),
						description: Type.String({
							description: "Task description / steps block",
						}),
						estimate: Type.String({ description: "Task estimate string" }),
						files: Type.Array(Type.String(), {
							description:
								'Array<string> of files likely touched; pass ["path"] or [], never a single string',
						}),
						verify: Type.String({
							description: "Verification command or block",
						}),
						inputs: Type.Array(Type.String(), {
							description:
								'Array<string> of input files or references; pass ["path"] or [], never a single string',
						}),
						expectedOutput: Type.Array(Type.String(), {
							description:
								'Array<string> of files this task creates or overwrites; pass ["path"] or [], never prose or a single string',
						}),
						requiredWorkflowTools: Type.Array(Type.String(), {
							description:
								"Workflow tools required during execution; pass [] for ordinary tasks. Lifecycle mutations such as gsd_requirement_update are completion-owned and rejected here.",
						}),
						observabilityImpact: Type.Optional(
							Type.String({ description: "Task observability impact" }),
						),
						targetRepositories: Type.Optional(
							Type.Array(Type.String(), {
								description:
									"Repository id(s) this task touches (parent workspace); must match a Declared Repository. Omit for single-repo projects.",
							}),
						),
					}),
					{
						description:
							"Optional full task replacement for the slice. Omit for incremental planning, then call gsd_plan_task once per task.",
					},
				),
			),
			// ── Enrichment metadata (optional — defaults to empty) ────────────
			successCriteria: Type.Optional(
				Type.String({ description: "Slice success criteria block" }),
			),
			proofLevel: Type.Optional(
				Type.String({ description: "Slice proof level" }),
			),
			integrationClosure: Type.Optional(
				Type.String({ description: "Slice integration closure" }),
			),
			observabilityImpact: Type.Optional(
				Type.String({ description: "Slice observability impact" }),
			),
			targetRepositories: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Slice-wide default repository id(s) (parent workspace); must match a Declared Repository. Omit for single-repo projects.",
				}),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'plan-phase complete')",
				}),
			),
		}),
		execute: planSliceExecute,
	};

	registerWorkflowTool(pi, planSliceTool);

	// ─── gsd_plan_task (gsd_task_plan alias) ───────────────────────────────

	const planTaskExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		const dbAvailable = await ensureDbOpen(basePath);
		if (!dbAvailable) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: GSD database is not available. Cannot plan task.",
					},
				],
				details: { operation: "plan_task", error: "db_unavailable" } as any,
			};
		}
		try {
			const { handlePlanTask } = await import("../tools/plan-task.js");
			const result = await handlePlanTask(
				params,
				basePath,
				piPlanningInvocation("gsd_plan_task", toolCallId),
			);
			if ("error" in result) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error planning task: ${result.error}`,
						},
					],
					details: { operation: "plan_task", error: result.error } as any,
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})`,
					},
				],
				details: {
					operation: "plan_task",
					milestoneId: result.milestoneId,
					sliceId: result.sliceId,
					taskId: result.taskId,
					taskPlanPath: result.taskPlanPath,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logError("tool", `plan_task tool failed: ${msg}`, {
				tool: "gsd_plan_task",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error planning task: ${msg}` },
				],
				details: { operation: "plan_task", error: msg } as any,
			};
		}
	};

	const planTaskTool = {
		name: "gsd_plan_task",
		label: "Plan Task",
		description:
			"Write task planning state to the GSD database, render the slice PLAN from DB, and clear caches after a successful render.",
		promptSnippet:
			"Plan a task via DB write + slice PLAN render + cache invalidation",
		promptGuidelines: [
			"Use gsd_plan_task for task planning instead of writing task PLAN files directly.",
			"Keep parameters flat and provide the full task planning payload.",
			"Declare requiredWorkflowTools explicitly; use [] for ordinary implementation tasks. Tools unavailable to execute-task are rejected before persistence.",
			"The tool validates input, requires an existing parent slice, writes task planning data, renders the slice PLAN file from DB, and clears both state and parse caches after success.",
			"Use the canonical name gsd_plan_task; gsd_task_plan is only an alias.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			taskId: Type.String({ description: "Task ID (e.g. T01)" }),
			title: Type.String({ description: "Task title" }),
			description: Type.String({
				description: "Task description / steps block",
			}),
			estimate: Type.String({ description: "Task estimate string" }),
			files: Type.Array(Type.String(), {
				description:
					'Array<string> of files likely touched; pass ["path"] or [], never a single string',
			}),
			verify: Type.String({ description: "Verification command or block" }),
			inputs: Type.Array(Type.String(), {
				description:
					'Array<string> of input files or references; pass ["path"] or [], never a single string',
			}),
			expectedOutput: Type.Array(Type.String(), {
				description:
					'Array<string> of files this task creates or overwrites; pass ["path"] or [], never prose or a single string',
			}),
			requiredWorkflowTools: Type.Array(Type.String(), {
				description:
					"Workflow tools required during execution; pass [] for ordinary tasks. Lifecycle mutations such as gsd_requirement_update are completion-owned and rejected here.",
			}),
			observabilityImpact: Type.Optional(
				Type.String({ description: "Task observability impact" }),
			),
			targetRepositories: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Repository id(s) this task touches (parent workspace); must match a Declared Repository. Omit for single-repo projects.",
				}),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'plan-phase complete')",
				}),
			),
		}),
		execute: planTaskExecute,
	};

	registerWorkflowTool(pi, planTaskTool);

	// ─── gsd_task_complete (gsd_complete_task alias) ────────────────────────

	const taskCompleteExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeTaskComplete } = await loadWorkflowExecutors();
		return executeTaskComplete(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_task_complete", toolCallId),
		);
	};

	const taskCompleteTool = {
		name: "gsd_task_complete",
		label: "Complete Task",
		description:
			"Record a Task execution result and verification input in SQLite. Canonical Tasks advance to host verification or recovery and publish completion only after a current passing Technical Verdict; legacy Tasks complete directly and refresh readable projections.",
		promptSnippet:
			"Record a GSD Task result and advance verification or recovery",
		promptGuidelines: [
			"Use gsd_task_complete (or gsd_complete_task) when a task is finished and needs to be recorded.",
			"Include verification whenever possible. If verification is omitted, the executor derives it from verificationEvidence when possible.",
			"verificationEvidence is an array of objects with command, exitCode, verdict, durationMs.",
			"The tool validates required fields and returns an error message if verification cannot be derived.",
			"Canonical success returns attemptId, resultId, nextStage, and summaryPath while completion awaits host verification; a blocker routes to recovery.",
			"Legacy success returns summaryPath and may report stale projection repair or a duplicate non-mutating retry; matching parameters alone do not make a replay.",
		],
		parameters: Type.Object({
			// ── Core identification + content (required) ──────────────────────
			taskId: Type.String({ description: "Task ID (e.g. T01)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			oneLiner: Type.String({
				description: "One-line summary of what was accomplished",
			}),
			narrative: Type.String({
				description: "Detailed narrative of what happened during the task",
			}),
			verification: Type.Optional(
				Type.String({
					description:
						"What was verified and how — commands run, tests passed, behavior confirmed. If omitted, derived from verificationEvidence when possible.",
				}),
			),
			// ── Enrichment metadata (optional — defaults to empty) ────────────
			deviations: Type.Optional(
				Type.String({
					description: "Deviations from the task plan, or 'None.'",
				}),
			),
			knownIssues: Type.Optional(
				Type.String({
					description: "Known issues discovered but not fixed, or 'None.'",
				}),
			),
			failureModes: Type.Optional(
				Type.String({
					description:
						"Q5: what breaks when dependencies fail; leave empty only when genuinely not applicable",
				}),
			),
			loadProfile: Type.Optional(
				Type.String({
					description:
						"Q6: expected load, 10x breakpoint, and protection; leave empty only when genuinely not applicable",
				}),
			),
			negativeTests: Type.Optional(
				Type.String({
					description:
						"Q7: malformed inputs, error paths, and boundary tests; leave empty only when genuinely not applicable",
				}),
			),
			keyFiles: Type.Optional(
				Type.Array(Type.String(), {
					description: "List of key files created or modified",
				}),
			),
			keyDecisions: Type.Optional(
				Type.Array(Type.String(), {
					description: "List of key decisions made during this task",
				}),
			),
			blockerDiscovered: Type.Optional(
				Type.Boolean({
					description: "Whether a plan-invalidating blocker was discovered",
				}),
			),
			// ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
			escalation: Type.Optional(
				Type.Object(
					{
						question: Type.String({
							description:
								"The question the user needs to answer — one clear sentence.",
						}),
						options: Type.Array(
							Type.Object({
								id: Type.String({
									description:
										"Short id (e.g. 'A', 'B') used by /gsd escalate resolve.",
								}),
								label: Type.String({ description: "One-line label." }),
								tradeoffs: Type.String({
									description: "1-2 sentences on the tradeoffs of this option.",
								}),
							}),
							{
								minItems: 2,
								maxItems: 4,
								description: "2–4 options the user can choose between.",
							},
						),
						recommendation: Type.String({
							description: "Option id the executor recommends.",
						}),
						recommendationRationale: Type.String({
							description: "Why the recommendation — 1–2 sentences.",
						}),
						continueWithDefault: Type.Boolean({
							description:
								"When true, the recommendation is recorded as the default, but auto-mode still pauses until the user resolves via /gsd escalate resolve.",
						}),
					},
					{
						description:
							"ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true.",
					},
				),
			),
			verificationEvidence: Type.Optional(
				Type.Array(
					Type.Object({
						command: Type.String({
							description: "Verification command that was run",
						}),
						exitCode: Type.Number({ description: "Exit code of the command" }),
						verdict: Type.String({
							description: "Pass/fail verdict (e.g. '✅ pass', '❌ fail')",
						}),
						durationMs: Type.Number({
							description: "Duration of the command in milliseconds",
						}),
					}),
					{
						description:
							"Array of verification evidence entries (structured objects only)",
					},
				),
			),
			reworkResolution: Type.Optional(
				Type.Array(
					Type.Object({
						findingId: Type.String({
							description: "Rework finding ID being resolved (e.g. F1)",
						}),
						status: StringEnum(["resolved", "deferred-with-override"], {
							description: "Resolution status for this finding",
						}),
						evidence: Type.String({
							description:
								"Concrete evidence that the required fix was completed",
						}),
						decisionRef: Type.Optional(
							Type.String({
								description:
									"Decision reference required for deferred-with-override findings",
							}),
						),
					}),
					{
						description:
							"Resolution evidence for structured rework findings linked to this task",
					},
				),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'task verified after retry')",
				}),
			),
		}),
		execute: taskCompleteExecute,
	};

	registerWorkflowTool(pi, taskCompleteTool);

	// ─── gsd_slice_complete (gsd_complete_slice alias) ─────────────────────

	const sliceCompleteExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeSliceComplete } = await loadWorkflowExecutors();
		return executeSliceComplete(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_slice_complete", toolCallId),
		);
	};

	const sliceCompleteTool = {
		name: "gsd_slice_complete",
		label: "Complete Slice",
		description:
			"Commit evidence-backed Slice completion and closeout facts to SQLite in one revision- and Authority-Epoch-fenced operation, then refresh readable projections. " +
			"Projection failure leaves the database completion committed and is reported as stale.",
		promptSnippet:
			"Complete a GSD Slice in SQLite, then refresh readable projections",
		promptGuidelines: [
			"Use gsd_slice_complete (or gsd_complete_slice) when every Task is terminal with current durable completion proof or a current authorized cancellation Waiver.",
			"Open Tasks, running Attempts, missing current passing evidence, and unauthorized cancellation block completion.",
			"On a current success, returns summaryPath and uatPath; stale identifies projection repair, while duplicate and superseded classify an exact receipt replay.",
			"Exact retries require the host to preserve the private invocation identity; matching parameters alone are not replay identity.",
		],
		parameters: Type.Object({
			// ── Core identification + content (required) ──────────────────────
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceTitle: Type.String({ description: "Title of the slice" }),
			oneLiner: Type.String({
				description: "One-line summary of what the slice accomplished",
			}),
			narrative: Type.String({
				description: "Detailed narrative of what happened across all tasks",
			}),
			verification: Type.Optional(
				Type.String({
					description:
						"Optional closeout prose describing verification. Durable Task proof is read from SQLite and cannot be supplied by this field.",
				}),
			),
			uatContent: Type.String({
				description: "UAT test content (markdown body)",
			}),
			// ── Enrichment metadata (optional — defaults to empty) ────────────
			deviations: Type.Optional(
				Type.String({
					description: "Deviations from the slice plan, or 'None.'",
				}),
			),
			knownLimitations: Type.Optional(
				Type.String({ description: "Known limitations or gaps, or 'None.'" }),
			),
			followUps: Type.Optional(
				Type.String({
					description: "Follow-up work discovered during execution, or 'None.'",
				}),
			),
			keyFiles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Key files created or modified",
				}),
			),
			keyDecisions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Key decisions made during this slice",
				}),
			),
			patternsEstablished: Type.Optional(
				Type.Array(Type.String(), {
					description: "Patterns established by this slice",
				}),
			),
			observabilitySurfaces: Type.Optional(
				Type.Array(Type.String(), {
					description: "Observability surfaces added",
				}),
			),
			provides: Type.Optional(
				Type.Array(Type.String(), {
					description: "What this slice provides to downstream slices",
				}),
			),
			requirementsSurfaced: Type.Optional(
				Type.Array(Type.String(), { description: "New requirements surfaced" }),
			),
			drillDownPaths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Paths to task summaries for drill-down",
				}),
			),
			affects: Type.Optional(
				Type.Array(Type.String(), {
					description: "Downstream slices affected",
				}),
			),
			requirementsAdvanced: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "Requirement ID" }),
						how: Type.String({ description: "How it was advanced" }),
					}),
					{ description: "Requirements advanced by this slice" },
				),
			),
			requirementsValidated: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "Requirement ID" }),
						proof: Type.String({ description: "What proof validates it" }),
					}),
					{ description: "Requirements validated by this slice" },
				),
			),
			requirementsInvalidated: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "Requirement ID" }),
						what: Type.String({ description: "What changed" }),
					}),
					{ description: "Requirements invalidated or re-scoped" },
				),
			),
			filesModified: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "File path" }),
						description: Type.String({ description: "What changed" }),
					}),
					{ description: "Files modified with descriptions" },
				),
			),
			requires: Type.Optional(
				Type.Array(
					Type.Object({
						slice: Type.String({ description: "Dependency slice ID" }),
						provides: Type.String({ description: "What was consumed from it" }),
					}),
					{ description: "Upstream slice dependencies consumed" },
				),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'all tasks verified')",
				}),
			),
		}),
		execute: sliceCompleteExecute,
	};

	registerWorkflowTool(pi, sliceCompleteTool);

	// ─── gsd_skip_slice (#3477 / #3487) ───────────────────────────────────

	const skipSliceExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeSkipSlice } = await loadWorkflowExecutors();
		return executeSkipSlice(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_skip_slice", toolCallId),
		);
	};

	registerWorkflowTool(pi, {
		name: "gsd_skip_slice",
		label: "Skip Slice",
		description:
			"Cancel a Slice in one revision- and Authority-Epoch-fenced SQLite operation: preserve completed work, interrupt running Attempts, cancel unfinished Tasks, and record a current Slice-scoped Waiver for dependency satisfaction. " +
			"Readable projections refresh after commit and may be reported stale.",
		promptSnippet:
			"Cancel a GSD Slice durably, then refresh readable projections",
		promptGuidelines: [
			"Use gsd_skip_slice when a slice should be bypassed — descoped, superseded, or no longer relevant.",
			"Cannot skip a slice that is already complete.",
			"A current Slice-scoped Waiver makes the cancelled Slice satisfy downstream dependencies until reopen revokes it.",
			"Completed and already-cancelled Tasks are preserved; other Tasks are cancelled, and a running Attempt is interrupted and settled first.",
			"Exact invocation replays report duplicate; a historical replay may also report superseded. stale means the readable projection needs repair.",
		],
		parameters: Type.Object({
			sliceId: Type.String({ description: "Slice ID (e.g. S02)" }),
			milestoneId: Type.String({ description: "Milestone ID (e.g. M003)" }),
			reason: Type.Optional(
				Type.String({ description: "Reason for skipping this slice" }),
			),
		}),
		execute: skipSliceExecute,
	});

	// ─── gsd_complete_milestone ────────────────────────────────────────────

	const milestoneCompleteExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeCompleteMilestone } = await loadWorkflowExecutors();
		return executeCompleteMilestone(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_complete_milestone", toolCallId),
		);
	};

	const milestoneCompleteTool = {
		name: "gsd_complete_milestone",
		label: "Complete Milestone",
		description:
			"Commit validated Milestone completion in one revision- and Authority-Epoch-fenced SQLite operation, then render the readable SUMMARY projection.",
		promptSnippet:
			"Complete a validated GSD Milestone atomically, then refresh its readable summary",
		promptGuidelines: [
			"Use gsd_complete_milestone when all slices in a milestone are finished and the milestone needs to be recorded.",
			"Adopted Milestones require every Slice to be terminal with current completion or cancellation authorization; legacy imports still require every Slice complete.",
			"Adopted Milestones derive completion readiness from current durable validation evidence; verificationPassed remains required for legacy imports.",
			"Exact invocation replays return the original receipt; historical replays report superseded instead of presenting stale work as current.",
			"On success, summaryPath identifies the readable SUMMARY projection; stale means it needs automated repair.",
		],
		parameters: Type.Object({
			// ── Core identification + content (required) ──────────────────────
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			title: Type.String({ description: "Milestone title" }),
			oneLiner: Type.String({
				description: "One-sentence summary of what the milestone achieved",
			}),
			narrative: Type.String({
				description: "Detailed narrative of what happened during the milestone",
			}),
			verificationPassed: Type.Boolean({
				description:
					"Must be true — confirms that code change verification, success criteria, and definition of done checks all passed before completion",
			}),
			// ── Enrichment metadata (optional — defaults to empty) ────────────
			successCriteriaResults: Type.Optional(
				Type.String({
					description:
						"Markdown detailing how each success criterion was met or not met",
				}),
			),
			definitionOfDoneResults: Type.Optional(
				Type.String({
					description:
						"Markdown detailing how each definition-of-done item was met",
				}),
			),
			requirementOutcomes: Type.Optional(
				Type.String({
					description:
						"Markdown detailing requirement status transitions with evidence",
				}),
			),
			keyDecisions: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Key architectural/pattern decisions made during the milestone",
				}),
			),
			keyFiles: Type.Optional(
				Type.Array(Type.String(), {
					description: "Key files created or modified during the milestone",
				}),
			),
			lessonsLearned: Type.Optional(
				Type.Array(Type.String(), {
					description: "Lessons learned during the milestone",
				}),
			),
			followUps: Type.Optional(
				Type.String({ description: "Follow-up items for future milestones" }),
			),
			deviations: Type.Optional(
				Type.String({ description: "Deviations from the original plan" }),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'milestone validation passed')",
				}),
			),
		}),
		execute: milestoneCompleteExecute,
	};

	registerWorkflowTool(pi, milestoneCompleteTool);

	// ─── gsd_validate_milestone (gsd_milestone_validate alias) ─────────────

	const milestoneValidateExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeValidateMilestone } = await loadWorkflowExecutors();
		return executeValidateMilestone(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			{
				invocation: piExecutionInvocation("gsd_validate_milestone", toolCallId),
			},
		);
	};

	const milestoneValidateTool = {
		name: "gsd_validate_milestone",
		label: "Validate Milestone",
		description:
			"Validate a milestone before completion — persist validation results to the DB, render VALIDATION.md to disk. " +
			"Records verdict (pass/needs-attention/needs-remediation) and rationale.",
		promptSnippet: "Validate a GSD milestone (DB write + VALIDATION.md render)",
		promptGuidelines: [
			"Use gsd_validate_milestone when all slices are done and the milestone needs validation before completion.",
			"Parameters: milestoneId, verdict, remediationRound, successCriteriaChecklist, sliceDeliveryAudit, crossSliceIntegration, requirementCoverage, verificationClasses (optional), verificationEvidence (required for planned classes), verdictRationale, remediationPlan (optional).",
			"If verification classes were planned, verificationClasses must be a complete canonical table with one row for every applicable planned class using the exact class names Contract, Integration, Operational, and UAT. Do not submit a partial table.",
			"Planned verification text marked as none/not required/not applicable/N/A (including suffixed variants such as 'not required - backend-only') is treated as not applicable and does not require a class row.",
			"If verdict is 'needs-remediation', also provide remediationPlan and use gsd_reassess_roadmap to add remediation slices to the roadmap.",
			"On success, returns validationPath where VALIDATION.md was written.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			verdict: StringEnum(["pass", "needs-attention", "needs-remediation"], {
				description: "Validation verdict",
			}),
			remediationRound: Type.Number({
				description: "Remediation round (0 for first validation)",
			}),
			successCriteriaChecklist: Type.String({
				description:
					"Markdown checklist of success criteria with pass/fail and evidence",
			}),
			sliceDeliveryAudit: Type.String({
				description:
					"Markdown table auditing each slice's claimed vs delivered output",
			}),
			crossSliceIntegration: Type.String({
				description: "Markdown describing any cross-slice boundary mismatches",
			}),
			requirementCoverage: Type.String({
				description: "Markdown describing any unaddressed requirements",
			}),
			verificationClasses: Type.Optional(
				Type.String({
					description:
						"Complete markdown table describing verification class compliance and gaps; include one canonical row for every applicable planned class (Contract, Integration, Operational, UAT)",
				}),
			),
			verificationEvidence: Type.Optional(
				Type.Array(
					Type.Object(
						{
							verificationClass: StringEnum([
								"Contract",
								"Integration",
								"Operational",
								"UAT",
							]),
							sliceId: Type.Optional(
								Type.String({
									minLength: 1,
									description:
										"Required Slice binding when this evidence satisfies a browser-required Slice",
								}),
							),
							evidenceClass: StringEnum([
								"command",
								"runtime",
								"browser",
								"artifact",
							]),
							rationale: Type.String({ minLength: 1 }),
							commandOrTool: Type.String({ minLength: 1 }),
							workingDirectory: Type.String({ minLength: 1 }),
							startedAt: Type.String({ minLength: 1 }),
							endedAt: Type.String({ minLength: 1 }),
							exitCode: Type.Optional(Type.Number()),
							observation: StringEnum(["passed", "failed", "inconclusive"]),
							durableOutputRef: Type.String({ minLength: 1 }),
							testedSourceRevision: Type.String({ minLength: 1 }),
							environment: Type.Record(Type.String(), Type.Unknown(), {
								minProperties: 1,
							}),
						},
						{ additionalProperties: false },
					),
					{
						description:
							"Current source-bound structured evidence for each applicable planned verification class",
					},
				),
			),
			verdictRationale: Type.String({
				description: "Why this verdict was chosen",
			}),
			remediationPlan: Type.Optional(
				Type.String({
					description:
						"Remediation plan (required if verdict is needs-remediation)",
				}),
			),
		}),
		execute: milestoneValidateExecute,
	};

	registerWorkflowTool(pi, milestoneValidateTool);

	registerWorkflowTool(pi, {
		name: "gsd_prepare_milestone_subjective_uat",
		label: "Prepare Milestone Subjective UAT",
		description:
			"Prepare one source-bound subjective Milestone acceptance question with a recommendation before requesting a real user decision.",
		promptSnippet: "Prepare a genuine subjective Milestone UAT decision",
		promptGuidelines: [
			"Use only when acceptance genuinely requires human judgment and cannot be decided by executable evidence.",
			"After preparation, present the returned options to the user; do not fabricate or infer their answer.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ minLength: 1 }),
			criterionKey: Type.String({ minLength: 1 }),
			description: Type.String({ minLength: 1 }),
			focusedPrompt: Type.String({ minLength: 1 }),
			recommendedDisposition: StringEnum(["accepted", "rejected"]),
			recommendationRationale: Type.String({ minLength: 1 }),
			recommendationEvidence: Type.String({ minLength: 1 }),
			testedSourceRevision: Type.String({ minLength: 1 }),
			recommendationConfidence: Type.Optional(
				Type.Number({ minimum: 0, maximum: 1 }),
			),
			requirementId: Type.Optional(Type.String({ minLength: 1 })),
			required: Type.Optional(Type.Boolean()),
		}),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) => {
			const { executePrepareMilestoneSubjectiveUat } =
				await loadWorkflowExecutors();
			return executePrepareMilestoneSubjectiveUat(
				params,
				resolveWorkflowToolBasePath(_ctx, params),
				piExecutionInvocation(
					"gsd_prepare_milestone_subjective_uat",
					toolCallId,
				),
			);
		},
	});

	registerWorkflowTool(pi, {
		name: "gsd_answer_milestone_subjective_uat",
		label: "Answer Milestone Subjective UAT",
		description:
			"Record a user-selected answer to a prepared subjective Milestone UAT question using the authenticated Pi session identity.",
		promptSnippet: "Record the user's actual subjective Milestone UAT answer",
		promptGuidelines: [
			"Call only after the user explicitly chooses one of the prepared options.",
			"Pass the user's response verbatim; actor identity is derived from the active session and is not a tool argument.",
		],
		parameters: Type.Object({
			criterionId: Type.String({ minLength: 1 }),
			questionId: Type.String({ minLength: 1 }),
			interactionId: Type.String({ minLength: 1 }),
			selectedOptionId: Type.String({ minLength: 1 }),
			verbatimResponse: Type.String({ minLength: 1 }),
			rationale: Type.String({ minLength: 1 }),
			testedSourceRevision: Type.String({ minLength: 1 }),
		}),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: any,
		) => {
			const actorId = _ctx?.sessionManager?.getSessionId?.();
			if (typeof actorId !== "string" || !actorId.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "Error answering subjective UAT: authenticated Pi session identity is unavailable",
						},
					],
					details: {
						operation: "answer_milestone_subjective_uat",
						error: "user_identity_unavailable",
					},
					isError: true,
				};
			}
			const { executeAnswerMilestoneSubjectiveUat } =
				await loadWorkflowExecutors();
			return executeAnswerMilestoneSubjectiveUat(
				params,
				resolveWorkflowToolBasePath(_ctx, params),
				{
					...piExecutionInvocation(
						"gsd_answer_milestone_subjective_uat",
						toolCallId,
					),
					actorType: "user",
					actorId: actorId.trim(),
				},
			);
		},
	});

	// ─── gsd_replan_slice (gsd_slice_replan alias) ─────────────────────────

	const replanSliceExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeReplanSlice } = await loadWorkflowExecutors();
		return executeReplanSlice(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piPlanningInvocation("gsd_replan_slice", toolCallId),
		);
	};

	const replanSliceTool = {
		name: "gsd_replan_slice",
		label: "Replan Slice",
		description:
			"Replan a slice after a blocker is discovered. Structurally enforces preservation of completed tasks — " +
			"mutations to completed task IDs are rejected with actionable error payloads. Writes replan history to DB, " +
			"applies task mutations, re-renders PLAN.md, and renders REPLAN.md.",
		promptSnippet:
			"Replan a GSD slice with structural enforcement of completed tasks",
		promptGuidelines: [
			"Use gsd_replan_slice (canonical) or gsd_slice_replan (alias) when a blocker is discovered and the slice plan needs rewriting.",
			"The tool structurally enforces that completed tasks cannot be updated or removed — violations return specific error payloads naming the blocked task ID.",
			"Parameters: milestoneId, sliceId, blockerTaskId, blockerDescription, whatChanged, updatedTasks (array), removedTaskIds (array).",
			"updatedTasks items: taskId, title, description, estimate, files, verify, inputs, expectedOutput, requiredWorkflowTools ([] for ordinary tasks).",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			blockerTaskId: Type.String({
				description: "Task ID that discovered the blocker",
			}),
			blockerDescription: Type.String({
				description: "Description of the blocker",
			}),
			whatChanged: Type.String({
				description: "Summary of what changed in the plan",
			}),
			updatedTasks: Type.Array(
				Type.Object({
					taskId: Type.String({ description: "Task ID (e.g. T01)" }),
					title: Type.String({ description: "Task title" }),
					description: Type.String({
						description: "Task description / steps block",
					}),
					estimate: Type.String({ description: "Task estimate string" }),
					files: Type.Array(Type.String(), {
						description: "Files likely touched",
					}),
					verify: Type.String({ description: "Verification command or block" }),
					inputs: Type.Array(Type.String(), {
						description: "Input files or references",
					}),
					expectedOutput: Type.Array(Type.String(), {
						description: "Files this task creates or overwrites",
					}),
					requiredWorkflowTools: Type.Array(Type.String(), {
						description: "Workflow tools required during task execution; use [] for ordinary tasks",
					}),
				}),
				{ description: "Tasks to upsert (update existing or insert new)" },
			),
			removedTaskIds: Type.Array(Type.String(), {
				description: "Task IDs to remove from the slice",
			}),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'blocker discovered during execution')",
				}),
			),
		}),
		execute: replanSliceExecute,
	};

	registerWorkflowTool(pi, replanSliceTool);

	// ─── gsd_replan_task ───────────────────────────────────────────────────

	const replanTaskExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeReplanTask } = await loadWorkflowExecutors();
		return executeReplanTask(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piPlanningInvocation("gsd_replan_task", toolCallId),
		);
	};

	const replanTaskTool = {
		name: "gsd_replan_task",
		label: "Replan Task",
		description:
			"Update one pending task's planning contract after rework without touching sibling tasks. " +
			"Completed tasks are structurally protected. Re-renders the task/slice PLAN projection and records replan history.",
		promptSnippet: "Replan one pending GSD task after rework",
		promptGuidelines: [
			"Use gsd_replan_task when a reopened pending task needs its title, description, files, verify, inputs, or expectedOutput updated for rework.",
			"The task must already exist and be pending; completed tasks are rejected.",
			"Set reworkBriefRef when a structured rework brief triggered the task replan.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			taskId: Type.String({ description: "Task ID (e.g. T01)" }),
			title: Type.String({ description: "Updated task title" }),
			description: Type.String({
				description: "Updated task description incorporating rework scope",
			}),
			estimate: Type.String({ description: "Updated task estimate string" }),
			files: Type.Array(Type.String(), {
				description: "Updated files likely touched",
			}),
			verify: Type.String({
				description: "Updated verification command or block",
			}),
			inputs: Type.Array(Type.String(), {
				description: "Updated input files or references",
			}),
			expectedOutput: Type.Array(Type.String(), {
				description: "Updated files this task creates or overwrites",
			}),
			requiredWorkflowTools: Type.Array(Type.String(), {
				description: "Workflow tools required during task execution; use [] for ordinary tasks",
			}),
			reworkBriefRef: Type.Optional(
				Type.String({
					description:
						"Rework brief ID/reference that triggered this task replan",
				}),
			),
			actorName: Type.Optional(
				Type.String({
					description: "Caller-provided actor identity for the audit trail",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description: "Caller-provided reason this action was triggered",
				}),
			),
		}),
		execute: replanTaskExecute,
	};

	registerWorkflowTool(pi, replanTaskTool);

	// ─── gsd_rework_brief_save ─────────────────────────────────────────────

	const reworkBriefSaveExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeReworkBriefSave } = await loadWorkflowExecutors();
		return executeReworkBriefSave(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
		);
	};

	const reworkBriefSaveTool = {
		name: "gsd_rework_brief_save",
		label: "Save Rework Brief",
		description:
			"Persist a structured rework brief for a task. Blocking findings are enforced by gsd_task_complete until resolved with evidence.",
		promptSnippet: "Persist structured task rework findings",
		promptGuidelines: [
			"Use gsd_rework_brief_save when post-unit checks produce task rework findings.",
			"Use severity 'blocking' for findings that must be resolved before gsd_task_complete succeeds.",
			"Each finding needs a stable findingId, requiredFix, and verificationCommands.",
		],
		parameters: Type.Object({
			briefId: Type.Optional(
				Type.String({
					description:
						"Stable brief ID; omitted defaults to RB-<milestone>-<slice>-<task>",
				}),
			),
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			taskId: Type.String({ description: "Task ID (e.g. T01)" }),
			findings: Type.Array(
				Type.Object({
					findingId: Type.String({
						description: "Stable finding ID (e.g. F1)",
					}),
					severity: StringEnum(["blocking", "advisory"], {
						description: "Whether this finding blocks task completion",
					}),
					description: Type.String({ description: "What was found" }),
					requiredFix: Type.String({ description: "What must change" }),
					verificationCommands: Type.Array(Type.String(), {
						description: "Commands that must pass after the fix",
					}),
					status: Type.Optional(
						StringEnum(["pending", "resolved", "deferred-with-override"], {
							description: "Finding status; defaults to pending",
						}),
					),
					evidence: Type.Optional(
						Type.String({
							description: "Resolution evidence when already resolved",
						}),
					),
					decisionRef: Type.Optional(
						Type.String({
							description: "Decision reference for deferred-with-override",
						}),
					),
				}),
				{ description: "Structured rework findings for this task" },
			),
		}),
		execute: reworkBriefSaveExecute,
	};

	registerWorkflowTool(pi, reworkBriefSaveTool);

	// ─── gsd_reassess_roadmap (gsd_roadmap_reassess alias) ─────────────────

	const reassessRoadmapExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeReassessRoadmap } = await loadWorkflowExecutors();
		return executeReassessRoadmap(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piPlanningInvocation("gsd_reassess_roadmap", toolCallId),
		);
	};

	const reassessRoadmapTool = {
		name: "gsd_reassess_roadmap",
		label: "Reassess Roadmap",
		description:
			"Reassess the milestone roadmap after a slice completes. Structurally enforces preservation of completed slices — " +
			"structural mutations to completed slice IDs are rejected, while explicit evidence-metadata corrections remain available. Writes assessment to DB, " +
			"applies slice mutations, re-renders ROADMAP.md, and renders ROADMAP-ASSESSMENT.md.",
		promptSnippet:
			"Reassess a GSD roadmap with structural enforcement of completed slices",
		promptGuidelines: [
			"Use gsd_reassess_roadmap (canonical) or gsd_roadmap_reassess (alias) after a slice completes to reassess the roadmap.",
			"The tool structurally enforces that completed slices cannot be modified or removed. Use metadataCorrections only for audited acceptance/evidence language; it cannot change status, tasks, or dependencies.",
			"Parameters: milestoneId, completedSliceId, verdict, assessment, sliceChanges (object with modified, added, removed arrays), and optional metadataCorrections.",
			"sliceChanges.modified items: sliceId, title, risk (optional), depends (optional), demo (optional).",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			completedSliceId: Type.String({
				description: "Slice ID that just completed",
			}),
			verdict: Type.String({
				description:
					"Assessment verdict (e.g. 'roadmap-confirmed', 'roadmap-adjusted')",
			}),
			assessment: Type.String({
				description: "Assessment text explaining the decision",
			}),
			sliceChanges: Type.Object(
				{
					modified: Type.Array(
						Type.Object({
							sliceId: Type.String({ description: "Slice ID to modify" }),
							title: Type.String({ description: "Updated slice title" }),
							risk: Type.Optional(
								Type.String({ description: "Updated risk level" }),
							),
							depends: Type.Optional(
								Type.Array(Type.String(), {
									description: "Updated dependencies",
								}),
							),
							demo: Type.Optional(
								Type.String({ description: "Updated demo text" }),
							),
						}),
						{ description: "Slices to modify" },
					),
					added: Type.Array(
						Type.Object({
							sliceId: Type.String({ description: "New slice ID" }),
							title: Type.String({ description: "New slice title" }),
							risk: Type.Optional(Type.String({ description: "Risk level" })),
							depends: Type.Optional(
								Type.Array(Type.String(), { description: "Dependencies" }),
							),
							demo: Type.Optional(Type.String({ description: "Demo text" })),
						}),
						{ description: "New slices to add" },
					),
					removed: Type.Array(Type.String(), {
						description: "Slice IDs to remove",
					}),
				},
				{ description: "Slice changes to apply" },
			),
			metadataCorrections: Type.Optional(Type.Object({
				milestone: Type.Optional(Type.Object({
					successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Corrected milestone success criteria" })),
					verificationContract: Type.Optional(Type.String({ description: "Corrected contract verification language" })),
					verificationIntegration: Type.Optional(Type.String({ description: "Corrected integration verification language" })),
					verificationOperational: Type.Optional(Type.String({ description: "Corrected operational verification language" })),
					verificationUat: Type.Optional(Type.String({ description: "Corrected UAT verification language" })),
					definitionOfDone: Type.Optional(Type.Array(Type.String(), { description: "Corrected definition-of-done criteria" })),
					requirementCoverage: Type.Optional(Type.String({ description: "Corrected requirement coverage text" })),
					boundaryMapMarkdown: Type.Optional(Type.String({ description: "Corrected boundary-map markdown" })),
				}, { description: "Audited milestone acceptance-metadata corrections" })),
				completedSlices: Type.Optional(Type.Array(Type.Object({
					sliceId: Type.String({ description: "Completed slice whose evidence metadata is corrected" }),
					demo: Type.Optional(Type.String({ description: "Corrected completed-slice demo language" })),
					goal: Type.Optional(Type.String({ description: "Corrected completed-slice boundary goal" })),
					successCriteria: Type.Optional(Type.String({ description: "Corrected completed-slice success criteria" })),
					proofLevel: Type.Optional(Type.String({ description: "Corrected completed-slice proof language" })),
					integrationClosure: Type.Optional(Type.String({ description: "Corrected completed-slice integration closure" })),
					observabilityImpact: Type.Optional(Type.String({ description: "Corrected completed-slice verification/observability language" })),
				}), { description: "Evidence-only corrections for completed slices; structural fields are unavailable" })),
			}, { description: "Narrow DB-backed acceptance and completed-slice metadata corrections" })),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'slice S01 completed, reassessing remaining roadmap')",
				}),
			),
		}),
		execute: reassessRoadmapExecute,
	};

	registerWorkflowTool(pi, reassessRoadmapTool);

	// ─── gsd_task_reopen (gsd_reopen_task alias) ───────────────────────────
	// Single-writer v3, Stream 3: reversibility tools for closed units.

	const reopenTaskExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeTaskReopen } = await loadWorkflowExecutors();
		return executeTaskReopen(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_task_reopen", toolCallId),
		);
	};

	const reopenTaskTool = {
		name: "gsd_task_reopen",
		label: "Reopen Task",
		description:
			"Reset a completed task back to 'pending' so it can be re-done. Cleans up SUMMARY.md so the DB-filesystem reconciler does not auto-correct the task back to complete. " +
			"Both the parent slice and milestone must still be open — use gsd_slice_reopen first if the slice has been closed.",
		promptSnippet:
			"Reopen a completed GSD task (resets status to pending, removes SUMMARY.md)",
		promptGuidelines: [
			"Use gsd_task_reopen when a completed task needs to be re-done (e.g. verification missed a regression, requirements changed).",
			"Will fail if the parent slice or milestone is already closed — reopen those first.",
			"Will fail if the task is not currently 'complete' — there is nothing to reopen.",
			"Use the canonical name gsd_task_reopen; gsd_reopen_task is only an alias.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			taskId: Type.String({ description: "Task ID (e.g. T01)" }),
			reason: Type.Optional(
				Type.String({
					description:
						"Why the task is being reopened (recorded in the audit trail)",
				}),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'regression discovered post-completion')",
				}),
			),
		}),
		execute: reopenTaskExecute,
	};

	registerWorkflowTool(pi, reopenTaskTool);

	const taskRecoveryResumeTool = {
		name: "gsd_task_recovery_resume",
		label: "Resume Repaired Task",
		description:
			"Authorize exactly one new Task Attempt after an agent-owned recovery abort or remediation. " +
			"Use only after repairing the recorded cause; the Recovery Action and retry budget remain in history.",
		promptSnippet:
			"Resume one Task after its durable abort or remediation cause has been repaired",
		promptGuidelines: [
			"Use the exact recoveryActionId returned by the current abort or remediation.",
			"Explain the repair in plain language and attach concrete verification evidence.",
			"This authorization is consumed by the next lineage-linked Task Attempt and cannot be reused.",
		],
		parameters: Type.Object(
			{
				recoveryActionId: Type.String({
					minLength: 1,
					description: "Exact current abort or remediate Recovery Action ID",
				}),
				repairSummary: Type.String({
					minLength: 1,
					description: "What was repaired and why retry is now safe",
				}),
				evidence: Type.Record(Type.String(), Type.Unknown(), {
					minProperties: 1,
					description: "Structured evidence proving the repair",
				}),
			},
			{ additionalProperties: false },
		),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) => {
			const { executeTaskRecoveryResume } = await loadWorkflowExecutors();
			return executeTaskRecoveryResume(
				params,
				resolveTaskRecoveryResumeBasePath(ctx, params.recoveryActionId),
				piExecutionInvocation("gsd_task_recovery_resume", toolCallId),
			);
		},
	};

	registerWorkflowTool(pi, taskRecoveryResumeTool);

	const taskSettleTool = {
		name: "gsd_task_settle",
		label: "Settle Task Attempt",
		description:
			"Operator tool: settle a Task's orphaned running Attempt as interrupted after a manual repair. " +
			"Dry-run by default — prints the exact rows it would change; mutation requires apply: true. " +
			"Human-gated: never called by auto mode.",
		promptSnippet:
			"Settle an orphaned running Task Attempt (dry-run first, apply: true to mutate)",
		promptGuidelines: [
			"Run without apply first and read the planned rows before mutating.",
			"Settles under the Attempt's held lease, or safely reclaims an expired/released lease when its worker is no longer live; never steals a live peer's lease.",
			"A second apply is a no-op — the tool is idempotent.",
			"reconcileLifecycle adopts ready/completed after an interrupted Attempt, or completed after a succeeded Attempt, without deleting SUMMARYs.",
		],
		parameters: Type.Object(
			{
				milestoneId: Type.String({ minLength: 1, description: "Milestone ID (e.g. M001)" }),
				sliceId: Type.String({ minLength: 1, description: "Slice ID (e.g. S01)" }),
				taskId: Type.String({ minLength: 1, description: "Task ID (e.g. T01)" }),
				reason: Type.String({
					minLength: 1,
					description: "Operator rationale recorded on the settled Attempt Result",
				}),
				apply: Type.Optional(
					Type.Boolean({
						description: "Actually settle. Omit or false for a dry run that changes nothing.",
					}),
				),
				reconcileLifecycle: Type.Optional(
					Type.Boolean({
						description:
							"After settling or an interrupted Attempt, adopt ready/completed; after a succeeded Attempt, adopt completed. Preserve SUMMARYs.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (
			toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) => {
			const { executeTaskSettle } = await loadWorkflowExecutors();
			return executeTaskSettle(
				params,
				resolveWorkflowToolBasePath(ctx, params),
				{ ...piExecutionInvocation("gsd_task_settle", toolCallId), actorType: "user" },
			);
		},
	};

	registerWorkflowTool(pi, taskSettleTool);

	// ─── gsd_slice_reopen (gsd_reopen_slice alias) ─────────────────────────

	const reopenSliceExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeSliceReopen } = await loadWorkflowExecutors();
		return executeSliceReopen(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_slice_reopen", toolCallId),
		);
	};

	const reopenSliceTool = {
		name: "gsd_slice_reopen",
		label: "Reopen Slice",
		description:
			"Reopen a completed or cancelled Slice and all terminal Tasks in one revision- and Authority-Epoch-fenced SQLite operation while preserving immutable execution history. " +
			"The operation revokes current cancellation Waivers, blocks progressed transitive downstream Slices, and fences projection cleanup against newer lifecycle operations.",
		promptSnippet:
			"Reopen a terminal GSD Slice atomically, then refresh readable projections",
		promptGuidelines: [
			"Use gsd_slice_reopen when a completed or cancelled Slice needs a full redo (e.g. integration issue surfaced, requirements changed).",
			"All terminal Tasks return to pending together; prior Attempts, results, verification evidence, and dispatch history remain immutable.",
			"Will fail under a terminal parent Milestone; reopen the Milestone hierarchy when the entire delivery needs rework.",
			"Will fail if the Slice is not terminal or any transitive downstream Slice has progressed — reopen downstream work first.",
			"Exact invocation replays report duplicate; a historical replay may also report superseded. stale means projection cleanup or refresh needs repair.",
			"Use the canonical name gsd_slice_reopen; gsd_reopen_slice is only an alias.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			reason: Type.Optional(
				Type.String({
					description:
						"Why the slice is being reopened (recorded in the audit trail)",
				}),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'cross-slice regression discovered')",
				}),
			),
		}),
		execute: reopenSliceExecute,
	};

	registerWorkflowTool(pi, reopenSliceTool);

	// ─── gsd_milestone_reopen (gsd_reopen_milestone alias) ─────────────────

	const reopenMilestoneExecute = async (
		toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeMilestoneReopen } = await loadWorkflowExecutors();
		return executeMilestoneReopen(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
			piExecutionInvocation("gsd_milestone_reopen", toolCallId),
		);
	};

	const reopenMilestoneTool = {
		name: "gsd_milestone_reopen",
		label: "Reopen Milestone",
		description:
			"Reopen a terminal Milestone and its completed work in one revision- and Authority-Epoch-fenced SQLite operation while preserving immutable history, then remove stale readable summaries. Pass keepCompleted=true to unlock the milestone without resetting completed slices/tasks or deleting their SUMMARYs.",
		promptSnippet:
			"Reopen a terminal GSD Milestone atomically, then refresh readable projections",
		promptGuidelines: [
			"Use gsd_milestone_reopen when a terminal Milestone needs to be re-done (e.g. validation failure surfaced after closure).",
			"Default is a full cascade: all terminal slices and tasks reopen together while prior Attempts and evidence remain immutable.",
			"Pass keepCompleted=true to unlock the milestone for new work without resetting completed slices/tasks or deleting their SUMMARY projections.",
			"Will fail if the Milestone is not currently terminal — there is nothing to reopen.",
			"Exact invocation replays report duplicate; historical replays report superseded and cannot remove newer projections.",
			"Use the canonical name gsd_milestone_reopen; gsd_reopen_milestone is only an alias.",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			reason: Type.Optional(
				Type.String({
					description:
						"Why the milestone is being reopened (recorded in the audit trail)",
				}),
			),
			keepCompleted: Type.Optional(
				Type.Boolean({
					description:
						"When true, unlock the milestone without resetting completed slices/tasks or deleting their SUMMARY projections. Default false.",
				}),
			),
			// Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
			actorName: Type.Optional(
				Type.String({
					description:
						"Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')",
				}),
			),
			triggerReason: Type.Optional(
				Type.String({
					description:
						"Caller-provided reason this action was triggered (e.g. 'post-closure validation failure')",
				}),
			),
		}),
		execute: reopenMilestoneExecute,
	};

	registerWorkflowTool(pi, reopenMilestoneTool);

	// ─── gsd_save_gate_result ──────────────────────────────────────────────

	const saveGateResultExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const { executeSaveGateResult } = await loadWorkflowExecutors();
		return executeSaveGateResult(
			params,
			resolveWorkflowToolBasePath(_ctx, params),
		);
	};

	const saveGateResultTool = {
		name: "gsd_save_gate_result",
		label: "Save Gate Result",
		description:
			"Save the result of a quality gate evaluation (Q3-Q8 or MV01-MV04) to the GSD database. " +
			"Called by gate evaluation sub-agents after analyzing a specific quality question.",
		promptSnippet:
			"Save quality gate evaluation result (verdict, rationale, findings)",
		promptGuidelines: [
			"Use gsd_save_gate_result after evaluating a quality gate question.",
			"gateId must be one of: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04.",
			"verdict must be: pass (no concerns), flag (concerns found), or omitted (not applicable).",
			"rationale should be a one-sentence justification for the verdict.",
			"findings should contain detailed markdown analysis (or empty string if omitted).",
		],
		parameters: Type.Object({
			milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
			sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
			gateId: Type.String({
				description:
					"Gate ID: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, or MV04",
			}),
			taskId: Type.Optional(
				Type.String({
					description: "Task ID for task-scoped gates (Q5/Q6/Q7)",
				}),
			),
			verdict: Type.String({ description: "pass, flag, or omitted" }),
			rationale: Type.String({ description: "One-sentence justification" }),
			findings: Type.Optional(
				Type.String({ description: "Detailed markdown findings" }),
			),
		}),
		prepareArguments: prepareSaveGateResultArguments,
		execute: saveGateResultExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("save_gate_result "));
			text += theme.fg("accent", args.gateId ?? "");
			text += theme.fg("dim", ` → ${args.verdict ?? ""}`);
			return new Text(text, 0, 0);
		},
		/**
		 * Render the save_gate_result tool output for the TUI.
		 *
		 * Prefers structured fields, but falls back to `content[0].text` when the
		 * structured payload is empty. Defensive: the structural fix on this
		 * branch plumbs `details` through MCP via `structuredContent`, but older
		 * hosts, a future handler that forgets `structuredContent`, or any drop
		 * of non-standard return fields would otherwise render as
		 * "undefined: undefined". Same fallback applies to error rendering, and
		 * we strip a leading `Error:` from the fallback text to avoid producing
		 * `Error: Error: ...`.
		 */
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				const rawMsg = d?.error ?? result.content?.[0]?.text ?? "unknown";
				const msg = rawMsg.replace(/^\s*Error:\s*/i, "");
				return new Text(theme.fg("error", `Error: ${msg}`), 0, 0);
			}
			if (!d?.gateId || !d?.verdict) {
				const text = result.content?.[0]?.text ?? "Gate result saved";
				return new Text(theme.fg("success", text), 0, 0);
			}
			const color = d.verdict === "flag" ? "warning" : "success";
			return new Text(theme.fg(color, `${d.gateId}: ${d.verdict}`), 0, 0);
		},
	};

	registerWorkflowTool(pi, saveGateResultTool);

	// ─── gsd_requirement_list ────────────────────────────────────────────────
	//
	// Read-only: lists requirements from the canonical `requirements` table.
	// Agents previously had to parse REQUIREMENTS.md (stale projection) to
	// answer "what requirements exist?". This tool queries the live DB so the
	// result is always authoritative, even immediately after `gsd migrate`.

	const requirementListExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		try {
			const { queryRequirementsWithLimit } = await import(
				"../context-store.js"
			);
			const results = await withCanonicalReadAdapter(
				basePath,
				async (adapter) => {
					const limit = Math.min(params.limit ?? 200, 500);
					return queryRequirementsWithLimit(
						{
							class: params.class ?? undefined,
							status: params.status ?? undefined,
							milestoneId: params.milestoneId ?? undefined,
							sliceId: params.sliceId ?? undefined,
							limit,
						},
						adapter,
					);
				},
			);

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} requirement(s).`,
					},
				],
				details: {
					operation: "list_requirements",
					count: results.length,
					requirements: results,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("db_unavailable")) {
				logError("tool", `gsd_requirement_list failed: ${msg}`, {
					tool: "gsd_requirement_list",
					error: String(err),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: GSD database is not available.",
						},
					],
					details: {
						operation: "list_requirements",
						error: "db_unavailable",
					} as any,
				};
			}
			logError("tool", `gsd_requirement_list failed: ${msg}`, {
				tool: "gsd_requirement_list",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error listing requirements: ${msg}` },
				],
				details: {
					operation: "list_requirements",
					error: "query_error",
					message: msg,
				} as any,
			};
		}
	};

	const requirementListTool = {
		name: "gsd_requirement_list",
		label: "List Requirements",
		description:
			"List requirements from the GSD database. Returns the canonical store contents — " +
			"always authoritative, never stale. Use instead of parsing REQUIREMENTS.md.",
		promptSnippet: "List GSD requirements from the canonical DB store",
		promptGuidelines: [
			"Use gsd_requirement_list to read what requirements are recorded — do not parse REQUIREMENTS.md.",
			'Filter by class (e.g. "core-capability"), status (e.g. "active"), or milestoneId to narrow results.',
			"The returned requirements array matches the DB canonical state, not the projection on disk.",
			"Default limit is 200; hard cap is 500. Increase limit only if you need a full corpus scan.",
		],
		parameters: Type.Object({
			class: Type.Optional(
				Type.String({
					description:
						"Filter by requirement class: core-capability, primary-user-loop, launchability, " +
						"continuity, failure-visibility, integration, quality-attribute, operability, " +
						"admin/support, compliance/security, differentiator, constraint, anti-feature.",
				}),
			),
			status: Type.Optional(
				Type.String({
					description:
						'Filter by status (e.g. "active", "validated", "deferred").',
				}),
			),
			milestoneId: Type.Optional(
				Type.String({
					description:
						'Filter to requirements owned by or supporting a specific milestone (e.g. "M005").',
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of requirements to return. Default 200, hard cap 500.",
					minimum: 1,
					maximum: 500,
				}),
			),
		}),
		execute: requirementListExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("requirement_list"));
			const filters: string[] = [];
			if (args.class) filters.push(`class=${args.class}`);
			if (args.status) filters.push(`status=${args.status}`);
			if (args.milestoneId) filters.push(`milestone=${args.milestoneId}`);
			if (filters.length) text += theme.fg("dim", ` [${filters.join(", ")}]`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			const count = d?.count ?? 0;
			return new Text(
				theme.fg("success", `${count} requirement(s) found`),
				0,
				0,
			);
		},
	};

	registerWorkflowTool(pi, requirementListTool);

	// ─── gsd_requirement_get ─────────────────────────────────────────────────
	//
	// Point-lookup by stable R### ID. Returns the full requirement row or a
	// typed error object — never throws, never fabricates.

	const requirementGetExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		try {
			const { getRequirementByIdStrict } = await import("../context-store.js");
			const req = await withCanonicalReadAdapter(basePath, async (adapter) =>
				getRequirementByIdStrict(params.id, adapter),
			);

			if (!req) {
				// getRequirementByIdStrict returns null for not found (absent or superseded)
				return {
					content: [
						{
							type: "text" as const,
							text: `Requirement ${params.id} not found (may not exist or is superseded).`,
						},
					],
					details: {
						operation: "get_requirement",
						id: params.id,
						error: "not_found",
					} as any,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Requirement ${req.id}: ${req.description}`,
					},
				],
				details: {
					operation: "get_requirement",
					id: req.id,
					requirement: req,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("db_unavailable")) {
				logError("tool", `gsd_requirement_get failed: ${msg}`, {
					tool: "gsd_requirement_get",
					error: String(err),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: GSD database is not available.",
						},
					],
					details: {
						operation: "get_requirement",
						id: params.id,
						error: "db_unavailable",
					} as any,
				};
			}
			logError("tool", `gsd_requirement_get failed: ${msg}`, {
				tool: "gsd_requirement_get",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error fetching requirement: ${msg}` },
				],
				details: {
					operation: "get_requirement",
					id: params.id,
					error: "query_error",
					message: msg,
				} as any,
			};
		}
	};

	const requirementGetTool = {
		name: "gsd_requirement_get",
		label: "Get Requirement",
		description:
			'Fetch a single requirement by its stable ID (e.g. "R021") from the GSD database. ' +
			"Returns the full row or a typed error (not_found / db_unavailable). " +
			"Use this instead of grepping REQUIREMENTS.md.",
		promptSnippet:
			"Fetch a single GSD requirement by ID from the canonical DB store",
		promptGuidelines: [
			'Use gsd_requirement_get to read a specific requirement by ID (e.g. "R021").',
			'Returns { error: "not_found" } when the ID does not exist or has been superseded.',
			'Returns { error: "db_unavailable" } when the GSD database cannot be opened.',
			"Never fabricate requirement content — if not_found, call gsd_requirement_list to verify what IDs exist.",
		],
		parameters: Type.Object({
			id: Type.String({
				description: 'Requirement ID to fetch (e.g. "R021").',
			}),
		}),
		execute: requirementGetExecute,
		renderCall(args: any, theme: any) {
			return new Text(
				theme.fg("toolTitle", theme.bold("requirement_get ")) +
					theme.fg("accent", args.id ?? ""),
				0,
				0,
			);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				const isNotFound = d?.error === "not_found";
				return new Text(
					theme.fg(
						isNotFound ? "warning" : "error",
						formatToolErrorText(result, d),
					),
					0,
					0,
				);
			}
			const r = d?.requirement;
			return new Text(
				theme.fg("success", `${r?.id ?? ""}: ${r?.description ?? ""}`) +
					theme.fg("dim", ` [${r?.class ?? ""}]`),
				0,
				0,
			);
		},
	};

	registerWorkflowTool(pi, requirementGetTool);

	// ─── gsd_decision_list ────────────────────────────────────────────────────
	//
	// Read-only: lists decisions from the canonical `memories` table
	// (ADR-013 Stage 3 — the legacy `decisions` table is no longer the source
	// of truth). Returns the same Decision shape as the existing query layer.
	//
	// Why this matters: agents cannot verify DB-canonical decision state without
	// parsing DECISIONS.md, which may be stale after `gsd migrate` or a failed
	// projection regen. This tool closes that gap.

	const decisionListExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		try {
			const { queryDecisionsWithLimit } = await import("../context-store.js");

			const results = await withCanonicalReadAdapter(basePath, async (adapter) => {
				const limit = Math.min(params.limit ?? 200, 500);
				return queryDecisionsWithLimit(
					{
						scope: params.scope ?? undefined,
						milestoneId: params.milestoneId ?? undefined,
						includeSuperseded: params.includeSuperseded === true,
						limit,
					},
					adapter,
				);
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} decision(s).`,
					},
				],
				details: {
					operation: "list_decisions",
					count: results.length,
					decisions: results,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("db_unavailable")) {
				logError("tool", `gsd_decision_list failed: ${msg}`, {
					tool: "gsd_decision_list",
					error: String(err),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: GSD database is not available.",
						},
					],
					details: {
						operation: "list_decisions",
						error: "db_unavailable",
					} as any,
				};
			}
			logError("tool", `gsd_decision_list failed: ${msg}`, {
				tool: "gsd_decision_list",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error listing decisions: ${msg}` },
				],
				details: {
					operation: "list_decisions",
					error: "query_error",
					message: msg,
				} as any,
			};
		}
	};

	const decisionListTool = {
		name: "gsd_decision_list",
		label: "List Decisions",
		description:
			"List decisions from the GSD database. Reads from the canonical memories table " +
			"(ADR-013 Stage 3) — always authoritative. Use instead of parsing DECISIONS.md.",
		promptSnippet:
			"List GSD decisions from the canonical DB store (memories table)",
		promptGuidelines: [
			"Use gsd_decision_list to read what decisions are recorded — do not parse DECISIONS.md.",
			'Filter by scope (exact match, e.g. "architecture") or milestoneId to narrow results.',
			"Set includeSuperseded: true to see the full decision chain including overridden decisions.",
			"Decisions are sourced from the memories table (ADR-013 Stage 3), not the legacy decisions table.",
			"Default limit is 200; hard cap is 500.",
		],
		parameters: Type.Object({
			scope: Type.Optional(
				Type.String({
					description:
						'Filter by scope (exact match, e.g. "architecture", "library", "observability").',
				}),
			),
			milestoneId: Type.Optional(
				Type.String({
					description:
						'Filter to decisions whose when_context contains the milestone ID (e.g. "M005").',
				}),
			),
			includeSuperseded: Type.Optional(
				Type.Boolean({
					description:
						"When true, include superseded decisions (full chain). " +
						"Default false — returns only active decisions.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"Maximum number of decisions to return. Default 200, hard cap 500.",
					minimum: 1,
					maximum: 500,
				}),
			),
		}),
		execute: decisionListExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("decision_list"));
			const filters: string[] = [];
			if (args.scope) filters.push(`scope=${args.scope}`);
			if (args.milestoneId) filters.push(`milestone=${args.milestoneId}`);
			if (args.includeSuperseded) filters.push("includeSuperseded");
			if (filters.length) text += theme.fg("dim", ` [${filters.join(", ")}]`);
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			const count = d?.count ?? 0;
			return new Text(theme.fg("success", `${count} decision(s) found`), 0, 0);
		},
	};

	registerWorkflowTool(pi, decisionListTool);

	// ─── gsd_project_snapshot ────────────────────────────────────────────────
	//
	// Read-only: returns the DB-authoritative project snapshot (issue #2102) —
	// progress, milestone, and slice/task state assembled from the canonical
	// database in one payload. Use instead of stitching together multiple read
	// tools or parsing markdown projections, which may lag the DB.

	const projectSnapshotExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath =
			typeof params.projectDir === "string" && params.projectDir
				? params.projectDir
				: resolveCtxCwd(_ctx);
		try {
			const { readProjectSnapshotFromDb } = await import("../state/project-snapshot.js");

			const snapshot = await withCanonicalReadAdapter(
				basePath,
				async () => readProjectSnapshotFromDb(basePath, { preserveGlobalDbHandle: true }),
			);
			if (!snapshot) {
				// The adapter preflight succeeded but the reader could not open
				// through its own path — fail closed like MCP and the CLI.
				throw new Error("GSD database is not available (db_unavailable)");
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(snapshot),
					},
				],
				details: {
					operation: "read_project_snapshot",
					projectDir: basePath,
					snapshot,
				} as any,
			};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Mirror mapCanonicalReadError: "not available" (e.g. missing
				// authority row) classifies as db_unavailable, not query_error.
				if (msg.includes("db_unavailable") || msg.includes("not available")) {
					logError("tool", `gsd_project_snapshot failed: ${msg}`, {
						tool: "gsd_project_snapshot",
						error: String(err),
					});
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: GSD database is not available.",
						},
					],
					details: {
						operation: "read_project_snapshot",
						error: "db_unavailable",
					} as any,
				};
			}
			logError("tool", `gsd_project_snapshot failed: ${msg}`, {
				tool: "gsd_project_snapshot",
				error: String(err),
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Error reading project snapshot: ${msg}`,
					},
				],
				details: {
					operation: "read_project_snapshot",
					error: "query_error",
					message: msg,
				} as any,
			};
		}
	};

	const projectSnapshotTool = {
		name: "gsd_project_snapshot",
		label: "Read Project Snapshot",
		description:
			"Read the DB-authoritative project snapshot (issue #2102): progress, milestone, " +
			"and slice/task state in one payload. Use instead of combining multiple read " +
			"tools or parsing markdown projections.",
		promptSnippet:
			"Read the canonical GSD project snapshot from the database",
		promptGuidelines: [
			"Use gsd_project_snapshot for a one-shot view of project state — do not assemble it from markdown projections.",
			"The snapshot is DB-authoritative; projections may be stale after migrations or failed regens.",
			"Optionally pass projectDir to target a specific project root; defaults to the session working directory.",
		],
		parameters: Type.Object({
			projectDir: Type.Optional(
				Type.String({
					description:
						"Project root to read the snapshot for. Defaults to the current working directory.",
				}),
			),
		}),
		execute: projectSnapshotExecute,
		renderCall(args: any, theme: any) {
			let text = theme.fg("toolTitle", theme.bold("project_snapshot"));
			if (args.projectDir) {
				text += theme.fg("dim", ` [${args.projectDir}]`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				return new Text(
					theme.fg("error", formatToolErrorText(result, d)),
					0,
					0,
				);
			}
			return new Text(
				theme.fg("success", "Project snapshot read"),
				0,
				0,
			);
		},
	};

	registerWorkflowTool(pi, projectSnapshotTool);

	// ─── gsd_decision_get ────────────────────────────────────────────────────
	//
	// Point-lookup by stable D### ID. Sources from the canonical memories table
	// (ADR-013 Stage 3). Returns the full Decision row or a typed error object.

	const decisionGetExecute = async (
		_toolCallId: string,
		params: any,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		_ctx: unknown,
	) => {
		const basePath = resolveCtxCwd(_ctx);
		try {
			const { getDecisionByIdStrict } = await import("../context-store.js");
			const decision = await withCanonicalReadAdapter(basePath, async (adapter) =>
				getDecisionByIdStrict(
					params.id,
					params.includeSuperseded === true,
					adapter,
				),
			);

			if (!decision) {
				// getDecisionByIdStrict returns null for not found (absent, tombstoned, or superseded)
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Decision ${params.id} not found (may not exist, is a tombstone, or is superseded — ` +
								`use includeSuperseded: true to check the full chain).`,
						},
					],
					details: {
						operation: "get_decision",
						id: params.id,
						error: "not_found",
					} as any,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Decision ${decision.id}: ${decision.decision}`,
					},
				],
				details: {
					operation: "get_decision",
					id: decision.id,
					decision,
				} as any,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("db_unavailable")) {
				logError("tool", `gsd_decision_get failed: ${msg}`, {
					tool: "gsd_decision_get",
					error: String(err),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: GSD database is not available.",
						},
					],
					details: {
						operation: "get_decision",
						id: params.id,
						error: "db_unavailable",
					} as any,
				};
			}
			logError("tool", `gsd_decision_get failed: ${msg}`, {
				tool: "gsd_decision_get",
				error: String(err),
			});
			return {
				content: [
					{ type: "text" as const, text: `Error fetching decision: ${msg}` },
				],
				details: {
					operation: "get_decision",
					id: params.id,
					error: "query_error",
					message: msg,
				} as any,
			};
		}
	};

	const decisionGetTool = {
		name: "gsd_decision_get",
		label: "Get Decision",
		description:
			'Fetch a single decision by its stable ID (e.g. "D007") from the GSD database. ' +
			"Reads from the canonical memories table (ADR-013 Stage 3). " +
			"Returns the full row or a typed error (not_found / db_unavailable).",
		promptSnippet:
			"Fetch a single GSD decision by ID from the canonical DB store",
		promptGuidelines: [
			'Use gsd_decision_get to read a specific decision by ID (e.g. "D007").',
			'Returns { error: "not_found" } when the ID is absent, tombstoned, or (by default) superseded.',
			"Set includeSuperseded: true to retrieve a superseded decision by ID.",
			'Returns { error: "db_unavailable" } when the GSD database cannot be opened.',
			"Decision data is sourced from the memories table (ADR-013 Stage 3), not the legacy decisions table.",
			"Never fabricate decision content — if not_found, call gsd_decision_list to verify what IDs exist.",
		],
		parameters: Type.Object({
			id: Type.String({ description: 'Decision ID to fetch (e.g. "D007").' }),
			includeSuperseded: Type.Optional(
				Type.Boolean({
					description:
						"When true, also returns the decision if it is superseded. " +
						"Default false — returns not_found for superseded decisions.",
				}),
			),
		}),
		execute: decisionGetExecute,
		renderCall(args: any, theme: any) {
			let text =
				theme.fg("toolTitle", theme.bold("decision_get ")) +
				theme.fg("accent", args.id ?? "");
			if (args.includeSuperseded) text += theme.fg("dim", " [+superseded]");
			return new Text(text, 0, 0);
		},
		renderResult(result: any, _options: any, theme: any) {
			const d = readDetails(result);
			if (result.isError || d?.error) {
				const isNotFound = d?.error === "not_found";
				return new Text(
					theme.fg(
						isNotFound ? "warning" : "error",
						formatToolErrorText(result, d),
					),
					0,
					0,
				);
			}
			const dec = d?.decision;
			return new Text(
				theme.fg("success", `${dec?.id ?? ""}: ${dec?.decision ?? ""}`) +
					theme.fg("dim", ` → ${dec?.choice ?? ""}`),
				0,
				0,
			);
		},
	};

	registerWorkflowTool(pi, decisionGetTool);
}
