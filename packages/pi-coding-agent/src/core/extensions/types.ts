/**
 * Extension system types (public barrel).
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

export type {
	AdjustToolSetEvent,
	AdjustToolSetResult,
	BashTransformEvent,
	BashTransformEventResult,
	BeforeCommitEvent,
	BeforeCommitEventResult,
	BeforeModelSelectEvent,
	BeforeModelSelectResult,
	BeforePrEvent,
	BeforePrEventResult,
	BeforePushEvent,
	BeforePushEventResult,
	BeforeVerifyEvent,
	BeforeVerifyEventResult,
	BudgetThresholdEvent,
	BudgetThresholdEventResult,
	CommitEvent,
	GsdExtensionEvent,
	MilestoneEndEvent,
	MilestoneStartEvent,
	NotificationEvent,
	PrOpenedEvent,
	PushEvent,
	SessionEndEvent,
	SessionForkEvent,
	SessionSwitchEvent,
	StopEvent,
	ToolCompatibility,
	ToolFormatValidationErrorEvent,
	ToolFormatValidationErrorEventResult,
	ToolPreparationErrorsTurnEvent,
	ToolPreparationErrorsTurnEventResult,
	UnitEndEvent,
	UnitStartEvent,
	VerifyFailure,
	VerifyResultEvent,
} from "../gsd-extension-types.js";

export type {
	AgentAbortOrigin,
	BashResult,
	CompactionPreparation,
	CompactionResult,
	CompactionSettings,
	FileOperations,
} from "../gsd-seam-types.js";

export type { ExecOptions, ExecResult } from "../exec.js";
export type { BuildSystemPromptOptions } from "../system-prompt.js";
export type { AppKeybinding, KeybindingsManager } from "../keybindings.js";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode } from "@gsd/pi-agent-core";

export * from "./extension-upstream-types.js";
