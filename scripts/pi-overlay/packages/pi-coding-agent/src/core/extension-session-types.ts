/**
 * Extension-stable re-exports of session types from @gsd/agent-core.
 * Pi extensions compile against these paths without a compile-time package dep cycle.
 */
export type {
	AgentSession,
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ModelCycleResult,
	ParsedSkillBlock,
	PromptOptions,
	SessionStats,
} from "@gsd/agent-core/agent-session.js";

export { parseSkillBlock } from "@gsd/agent-core/agent-session.js";
