/**
 * GSD-specific extension event types and compatibility metadata.
 * Kept separate from upstream types.ts for vendoring seam maintenance.
 */
import type { AgentMessage } from "@gsd/pi-agent-core";
import type { AgentAbortOrigin } from "./gsd-seam-types.js";

export interface ToolCompatibility {
	producesImages?: boolean;
	schemaFeatures?: string[];
	minCapabilityTier?: "light" | "standard" | "heavy";
}

export interface SessionSwitchEvent {
	type: "session_switch";
	reason: "new" | "resume";
	previousSessionFile: string | undefined;
}

export interface SessionForkEvent {
	type: "session_fork";
	previousSessionFile: string | undefined;
}

export interface SessionEndEvent {
	type: "session_end";
	reason: "user" | "idle" | "error" | "programmatic";
	sessionFile?: string;
}

export interface StopEvent {
	type: "stop";
	reason: "completed" | "cancelled" | "error" | "blocked";
	lastMessage?: AgentMessage;
	sessionId?: string;
	turnId?: string;
	abortOrigin?: AgentAbortOrigin;
}

export interface NotificationEvent {
	type: "notification";
	kind: "blocked" | "input_needed" | "milestone_ready" | "idle" | "error";
	message: string;
	details?: Record<string, unknown>;
}

export interface BeforeCommitEvent {
	type: "before_commit";
	message: string;
	files: string[];
	cwd: string;
	author?: string;
}

export interface BeforeCommitEventResult {
	cancel?: boolean;
	reason?: string;
	message?: string;
}

export interface CommitEvent {
	type: "commit";
	sha: string;
	message: string;
	files: string[];
	cwd: string;
}

export interface BeforePushEvent {
	type: "before_push";
	remote: string;
	branch: string;
	cwd: string;
}

export interface BeforePushEventResult {
	cancel?: boolean;
	reason?: string;
}

export interface PushEvent {
	type: "push";
	remote: string;
	branch: string;
	cwd: string;
}

export interface BeforePrEvent {
	type: "before_pr";
	branch: string;
	targetBranch: string;
	title: string;
	body: string;
	cwd: string;
}

export interface BeforePrEventResult {
	cancel?: boolean;
	reason?: string;
	title?: string;
	body?: string;
}

export interface PrOpenedEvent {
	type: "pr_opened";
	url: string;
	branch: string;
	targetBranch: string;
	cwd: string;
}

export interface BeforeVerifyEvent {
	type: "before_verify";
	unitType?: string;
	unitId?: string;
	cwd: string;
}

export interface BeforeVerifyEventResult {
	cancel?: boolean;
	reason?: string;
}

export interface VerifyFailure {
	kind: "type" | "lint" | "test" | "diagnostic" | "gate" | "other";
	file?: string;
	line?: number;
	message: string;
}

export interface VerifyResultEvent {
	type: "verify_result";
	passed: boolean;
	failures: VerifyFailure[];
	unitType?: string;
	unitId?: string;
	cwd: string;
}

export interface BudgetThresholdEvent {
	type: "budget_threshold";
	fraction: number;
	spent: number;
	limit: number;
	currency: "USD";
}

export interface BudgetThresholdEventResult {
	action?: "pause" | "downgrade" | "continue";
}

export interface MilestoneStartEvent {
	type: "milestone_start";
	milestoneId: string;
	title?: string;
	cwd: string;
}

export interface MilestoneEndEvent {
	type: "milestone_end";
	milestoneId: string;
	status: "completed" | "failed" | "cancelled";
	cwd: string;
}

export interface UnitStartEvent {
	type: "unit_start";
	unitType: string;
	unitId: string;
	milestoneId?: string;
	cwd: string;
}

export interface UnitEndEvent {
	type: "unit_end";
	unitType: string;
	unitId: string;
	milestoneId?: string;
	status: "completed" | "failed" | "cancelled" | "blocked";
	cwd: string;
}

export interface BeforeModelSelectEvent {
	type: "before_model_select";
	unitType: string;
	unitId: string;
	classification: { tier: string; reason: string; downgraded: boolean };
	taskMetadata?: Record<string, unknown>;
	eligibleModels: string[];
	phaseConfig?: { primary: string; fallbacks: string[] };
}

export interface BeforeModelSelectResult {
	modelId: string;
}

export interface AdjustToolSetRequestCustomMessage {
	index: number;
	customType: string;
}

export interface AdjustToolSetEvent {
	type: "adjust_tool_set";
	selectedModelApi: string;
	selectedModelProvider: string;
	selectedModelId: string;
	activeToolNames: string[];
	filteredTools: string[];
	requestCustomMessages?: AdjustToolSetRequestCustomMessage[];
}

export interface AdjustToolSetResult {
	toolNames?: string[];
}

export interface BashTransformEvent {
	type: "bash_transform";
	command: string;
	cwd: string;
}

export interface BashTransformEventResult {
	command?: string;
}

export interface ToolFormatValidationErrorEvent {
	type: "tool_format_validation_error";
	toolName: string;
	toolCallId: string;
	arguments: Record<string, unknown>;
	baseMessage: string;
}

export interface ToolFormatValidationErrorEventResult {
	message?: string;
}

export interface ToolPreparationErrorFailure {
	toolName: string;
	arguments: Record<string, unknown>;
	errorText: string;
}

export interface ToolPreparationErrorsTurnEvent {
	type: "tool_preparation_errors_turn";
	failures: ToolPreparationErrorFailure[];
	preparationErrorCount: number;
}

export interface ToolPreparationErrorsTurnEventResult {
	steeringContent?: string;
	resetValidationFailureCap?: boolean;
}

export type GsdExtensionEvent =
	| SessionSwitchEvent
	| SessionForkEvent
	| SessionEndEvent
	| StopEvent
	| NotificationEvent
	| BeforeCommitEvent
	| CommitEvent
	| BeforePushEvent
	| PushEvent
	| BeforePrEvent
	| PrOpenedEvent
	| BeforeVerifyEvent
	| VerifyResultEvent
	| BudgetThresholdEvent
	| MilestoneStartEvent
	| MilestoneEndEvent
	| UnitStartEvent
	| UnitEndEvent
	| BeforeModelSelectEvent
	| AdjustToolSetEvent
	| BashTransformEvent
	| ToolFormatValidationErrorEvent
	| ToolPreparationErrorsTurnEvent;
