import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@gsd/pi-agent-core";
import type { ImageContent, Model } from "@gsd/pi-ai";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionRunner,
	ExtensionUIContext,
	InputSource,
	ShutdownHandler,
	ToolDefinition,
} from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import type { ResourceLoader } from "@gsd/pi-coding-agent/core/resource-loader.js";
import type { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import type { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { SourceInfo } from "@gsd/pi-coding-agent/core/source-info.js";
import type { SessionStartEvent } from "@gsd/pi-coding-agent/core/extensions/index.js";
import type { CompactionResult } from "../compaction/index.js";

// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const prefix = '<skill name="';
	if (!text.startsWith(prefix)) return null;
	const nameEnd = text.indexOf('" location="', prefix.length);
	if (nameEnd === -1) return null;
	const locationStart = nameEnd + '" location="'.length;
	const locationEnd = text.indexOf('">\n', locationStart);
	if (locationEnd === -1) return null;
	const closingTag = "\n</skill>";
	const contentStart = locationEnd + '">\n'.length;
	const contentEnd = text.indexOf(closingTag, contentStart);
	if (contentEnd === -1) return null;
	const trailerStart = contentEnd + closingTag.length;
	const trailer = text.slice(trailerStart);
	if (trailer.length > 0 && !trailer.startsWith("\n\n")) return null;
	return {
		name: text.slice(prefix.length, nameEnd),
		location: text.slice(locationStart, locationEnd),
		content: text.slice(contentStart, contentEnd),
		userMessage: trailer.startsWith("\n\n") ? text.slice(trailerStart + 2).trim() || undefined : undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_state_changed"; reason: SessionStateChangeReason }
	| {
			/** Freshness boundary for RPC owner observations; this does not authorize actions. */
			type: "owner_generation_transition";
			reason: "new_session" | "switch_session" | "fork" | "reload";
			phase: "starting" | "settled";
	  }
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
	| {
			type: "auto_compaction_end";
			reason: "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "fallback_provider_switch";
			fromProvider: string;
			toProvider: string;
			model: Model<any>;
			reason: string;
	  }
	| { type: "fallback_provider_restored"; provider: string; model: Model<any> }
	| { type: "fallback_chain_exhausted"; model: Model<any>; providers: string[] }
	| { type: "image_overflow_recovery"; strippedCount: number; imageCount: number };

export type SessionStateChangeReason =
	| "new_session"
	| "switch_session"
	| "fork"
	| "reload"
	| "set_session_name"
	| "set_model"
	| "set_thinking_level";

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	/** Host-trusted local TUI admission; absent/false for RPC, embedded, and print modes. */
	localInteractiveDesktop?: boolean;
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
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
	contextUsage?: ContextUsage;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}
