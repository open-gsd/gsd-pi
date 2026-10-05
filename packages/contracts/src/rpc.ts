// Project/App: gsd-pi
// File Purpose: Canonical RPC protocol contracts shared across runtime, SDK, MCP, and app surfaces.

export const RPC_CONTRACT_VERSION = 1 as const;

export const RPC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const RPC_COMMAND_TYPES = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"get_state",
	"get_project_progress",
	"get_project_snapshot",
	"workflow_command",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"get_fork_messages",
	"get_last_assistant_text",
	"set_session_name",
	"get_messages",
	"get_commands",
	"terminal_input",
	"terminal_resize",
	"terminal_redraw",
	"init",
	"shutdown",
	"subscribe",
] as const;

export const RPC_V2_EVENT_TYPES = ["execution_complete", "cost_update", "workflow_outcome"] as const;

export const RPC_EXTENSION_UI_METHODS = [
	"select",
	"confirm",
	"input",
	"editor",
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
] as const;

export type ThinkingLevel = (typeof RPC_THINKING_LEVELS)[number];

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export type ProjectProgressReadMetadata =
	| { source: "database"; authority: "db-authoritative" }
	| { source: "projection"; authority: "projection-fallback" };

export interface ProjectProgress {
	activeMilestone: { id: string; title: string } | null;
	activeSlice: { id: string; title: string } | null;
	activeTask: { id: string; title: string } | null;
	phase: string;
	milestones: { total: number; done: number; active: number; pending: number; parked: number };
	slices: { total: number; done: number; active: number; pending: number };
	tasks: { total: number; done: number; pending: number };
	requirements: { active: number; validated: number; deferred: number; outOfScope: number } | null;
	blockers: string[];
	nextAction: string;
	milestoneDetails?: Array<{
		id: string;
		title: string;
		status: string;
		truncated: boolean;
		slices: Array<{
			id: string;
			title: string;
			status: string;
			truncated: boolean;
			tasks: Array<{ id: string; title: string; status: string }>;
		}>;
	}>;
	milestoneDetailsTruncated?: boolean;
	milestoneDetailsTasksTruncated?: boolean;
	readMetadata?: ProjectProgressReadMetadata;
}

export interface ProjectSnapshotBlocker {
	blockerId: string;
	blockerKind: string;
	resolutionOwner: string;
	description: string;
	requestedAction: string;
	openedAt: string;
	openedProjectRevision: number;
}

export interface ProjectSnapshotOpenQuestion {
	questionId: string;
	questionText: string;
	createdAt: string;
}

export interface ProjectSnapshotVerification {
	assessments: { total: number; pass: number; fail: number };
	evidence: { total: number; passed: number; failed: number };
}

/**
 * The canonical lifecycle status vocabulary (ADR-046) and its version. A
 * snapshot names the version it uses in `lifecycleStatusVersion`; a change of
 * the list is a new version.
 */
export const LIFECYCLE_STATUS_VERSION = 1 as const;
export const LIFECYCLE_STATUSES = [
	"pending",
	"ready",
	"in_progress",
	"paused",
	"completed",
	"cancelled",
	"blocker-accepted",
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export interface ProjectSnapshot {
	/** Absent in a snapshot from a producer older than the lifecycle status vocabulary. */
	lifecycleStatusVersion?: typeof LIFECYCLE_STATUS_VERSION;
	authority: {
		projectId: string;
		schemaVersion: number | null;
		revision: number;
		authorityEpoch: number;
	};
	current: {
		activeMilestone: { id: string; title: string } | null;
		activeSlice: { id: string; title: string } | null;
		activeTask: { id: string; title: string } | null;
		phase: string;
		nextAction: string;
	};
	progress: {
		milestones: { total: number; done: number; active: number; pending: number; parked: number };
		slices: { total: number; done: number; active: number; pending: number };
		tasks: { total: number; done: number; pending: number };
	};
	blockers: ProjectSnapshotBlocker[];
	blockersTruncated?: boolean;
	openQuestions: ProjectSnapshotOpenQuestion[];
	openQuestionsTruncated?: boolean;
	verification: ProjectSnapshotVerification;
	milestones: {
		items: Array<{
			id: string;
			title: string;
			/** Legacy status label. Kept for one contract version; use `lifecycleStatus`. */
			status: string;
			/** Canonical lifecycle status; null when it is not known. */
			lifecycleStatus?: LifecycleStatus | null;
			sequence: number;
		}>;
		truncated: boolean;
	};
	capturedAt: string;
}

/**
 * A workflow mutation that a host sends as a typed command, not as
 * slash-command text. It runs the same executor as the workflow tool of the
 * same name. `capture_register` and `override_register` have no workflow
 * tool: they run the Domain Operation of `/gsd capture` and `/gsd steer`,
 * with the operator as the actor.
 */
export type WorkflowCommandRequest =
	| { name: "milestone_park"; args: { milestoneId: string; reason: string } }
	| { name: "milestone_unpark"; args: { milestoneId: string } }
	| { name: "milestone_discard"; args: { milestoneId: string; reason: string } }
	| { name: "milestone_reorder"; args: { order: string[] } }
	| { name: "milestone_set_dependencies"; args: { milestoneId: string; dependsOn: string[] } }
	| { name: "capture_register"; args: { text: string } }
	| { name: "override_register"; args: { change: string } };

export interface WorkflowCommandIdentity {
	/**
	 * Identifies one user action. A command that is sent again with the same key
	 * returns the result of the first send and changes nothing.
	 */
	idempotencyKey: string;
	/**
	 * The project revision that the host last read (`ProjectSnapshot.authority.revision`).
	 * When it is set, the command is refused if the project changed since then.
	 */
	expectedRevision?: number;
}

export interface WorkflowCommandResult {
	/** False when the command was refused. `message` gives the reason. */
	ok: boolean;
	message: string;
	/** The project revision after the command. */
	revision: number;
}

export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
}

export type RpcProtocolVersion = 1 | 2;

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_project_progress" }
	| { id?: string; type: "get_project_snapshot" }
	| ({ id?: string; type: "workflow_command" } & WorkflowCommandRequest & WorkflowCommandIdentity)
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "terminal_input"; data: string }
	| { id?: string; type: "terminal_resize"; cols: number; rows: number }
	| { id?: string; type: "terminal_redraw" }
	| { id?: string; type: "init"; protocolVersion: 2; clientId?: string }
	| { id?: string; type: "shutdown"; graceful?: boolean }
	| { id?: string; type: "subscribe"; events: string[] };

export interface RpcSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	location?: "user" | "project" | "path";
	path?: string;
}

export interface RpcSessionState {
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	retryInProgress: boolean;
	retryAttempt: number;
	messageCount: number;
	pendingMessageCount: number;
	extensionsReady: boolean;
}

export type RpcResponse =
	| { id?: string; type: "response"; command: "prompt"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "steer"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "follow_up"; success: true; runId?: string }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_project_progress"; success: true; data: ProjectProgress | null }
	| { id?: string; type: "response"; command: "get_project_snapshot"; success: true; data: ProjectSnapshot | null }
	| { id?: string; type: "response"; command: "workflow_command"; success: true; data: WorkflowCommandResult }
	| { id?: string; type: "response"; command: "set_model"; success: true; data: ModelInfo }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: ModelInfo; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| { id?: string; type: "response"; command: "get_available_models"; success: true; data: { models: ModelInfo[] } }
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| { id?: string; type: "response"; command: "cycle_thinking_level"; success: true; data: { level: ThinkingLevel } | null }
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "get_fork_messages"; success: true; data: { messages: Array<{ entryId: string; text: string }> } }
	| { id?: string; type: "response"; command: "get_last_assistant_text"; success: true; data: { text: string | null } }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: unknown[] } }
	| { id?: string; type: "response"; command: "get_commands"; success: true; data: { commands: RpcSlashCommand[] } }
	| { id?: string; type: "response"; command: "terminal_input"; success: true }
	| { id?: string; type: "response"; command: "terminal_resize"; success: true }
	| { id?: string; type: "response"; command: "terminal_redraw"; success: true }
	| { id?: string; type: "response"; command: "init"; success: true; data: RpcInitResult }
	| { id?: string; type: "response"; command: "shutdown"; success: true }
	| { id?: string; type: "response"; command: "subscribe"; success: true }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export interface RpcInitResult {
	protocolVersion: 2;
	sessionId: string;
	capabilities: {
		events: string[];
		commands: string[];
	};
}

export interface RpcExecutionCompleteEvent {
	type: "execution_complete";
	runId: string;
	status: "completed" | "error" | "cancelled";
	reason?: string;
	stats: SessionStats;
}

export interface RpcCostUpdateEvent {
	type: "cost_update";
	runId: string;
	turnCost: number;
	cumulativeCost: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/**
 * The typed outcome of a GSD workflow run (ADR-046). The extension emits it
 * when auto-mode stops or pauses, so hosts derive the run's terminal state
 * from the event instead of matching notification text; the text classifiers
 * stay as a fallback for runs of an older extension.
 *
 * Exit codes keep their meaning: completed → 0, error and timeout → 1,
 * blocked → 10, cancelled → 11.
 */
export type WorkflowOutcomeStatus = "completed" | "error" | "timeout" | "blocked" | "cancelled";

export interface RpcWorkflowOutcomeEvent {
	type: "workflow_outcome";
	status: WorkflowOutcomeStatus;
	/** The standardized exit code the status maps to. */
	exitCode: 0 | 1 | 10 | 11;
	/** Human-readable reason, when the run ended with one. */
	reason?: string;
	/** The unit that was active when the run ended, when one was. */
	unitType?: string;
	unitId?: string;
}

export type RpcV2Event = RpcExecutionCompleteEvent | RpcCostUpdateEvent | RpcWorkflowOutcomeEvent;

/** The custom message type that carries the typed outcome on the event stream. */
export const WORKFLOW_OUTCOME_CUSTOM_TYPE = "gsd-workflow-outcome" as const;

/**
 * Read the typed outcome a GSD extension reported on a custom message. Returns
 * null for every other message or for a payload that does not match the
 * contract, so a host falls back to the notification-text classifiers.
 */
export function parseWorkflowOutcomeCustomMessage(event: {
	type: string;
	message?: { customType?: unknown; content?: unknown };
}): RpcWorkflowOutcomeEvent | null {
	if (event.type !== "message_end") return null;
	if (!event.message || event.message.customType !== WORKFLOW_OUTCOME_CUSTOM_TYPE) return null;
	try {
		const parsed = JSON.parse(String(event.message.content ?? "")) as Record<string, unknown>;
		if (parsed["type"] !== "workflow_outcome") return null;
		const status = parsed["status"];
		const exitCode = parsed["exitCode"];
		if (typeof status !== "string") return null;
		if (exitCode !== 0 && exitCode !== 1 && exitCode !== 10 && exitCode !== 11) return null;
		const outcome: RpcWorkflowOutcomeEvent = {
			type: "workflow_outcome",
			status: status as WorkflowOutcomeStatus,
			exitCode: exitCode as 0 | 1 | 10 | 11,
		};
		if (typeof parsed["reason"] === "string") outcome.reason = parsed["reason"] as string;
		if (typeof parsed["unitType"] === "string") outcome.unitType = parsed["unitType"] as string;
		if (typeof parsed["unitId"] === "string") outcome.unitId = parsed["unitId"] as string;
		return outcome;
	} catch {
		return null;
	}
}

/** Agent event — a loosely typed record from the RPC event stream. */
export interface SdkAgentEvent {
	type: string;
	[key: string]: unknown;
}

export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number; allowMultiple?: boolean }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number; secure?: boolean }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; values: string[] }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type McpBlockerMethod = Extract<RpcExtensionUIRequest, { type: "extension_ui_request" }>["method"];

export interface McpPendingBlocker {
	id: string;
	method: McpBlockerMethod;
	message: string;
	event: RpcExtensionUIRequest;
}

export type RpcCommandType = RpcCommand["type"];
