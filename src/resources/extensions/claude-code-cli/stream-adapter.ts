// gsd-pi - Claude Code CLI provider stream adapter
/**
 * Stream adapter: bridges the Claude Agent SDK into GSD's streamSimple contract.
 *
 * The SDK runs the full agentic loop (multi-turn, tool execution, compaction)
 * in one call. This adapter translates the SDK's streaming output into
 * AssistantMessageEvents for TUI rendering, then preserves externally executed
 * tool-call blocks on the final AssistantMessage so Agent Core can render them
 * while `externalToolExecution` prevents local redispatch.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
	ToolCall,
} from "@gsd/pi-ai";
import type { ExtensionUIContext } from "@gsd/pi-coding-agent";
import { EventStream } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage } from "./partial-builder.js";
import {
	attachExternalResultsToToolBlocks,
	buildFinalAssistantContent,
	extractToolResultsFromSdkUserMessage,
	handleClaudeCodePartialStreamEvent,
	shouldSuppressDuplicateToolUnavailableBlock,
} from "./turn-assembler.js";
import type {
	ExternalToolResultPayload,
	ToolCallWithExternalResult,
} from "./turn-assembler.js";
import {
	buildWorkflowMcpServers,
	getRequiredWorkflowToolsForAutoUnit,
	resolveWorkflowMcpProjectRoot,
} from "../gsd/workflow-mcp.js";
import { resolveWorkflowQuestionToolSurface } from "../gsd/question-transport.js";
import { buildProjectGsdMcpServers, ensureProjectWorkflowMcpConfig } from "../gsd/mcp-project-config.js";
import { loadEffectiveGSDPreferences, loadProjectGSDPreferences } from "../gsd/preferences.js";
import { markToolStart, markToolEnd } from "../gsd/auto.js";
import {
	markInteractiveElicitationStart,
	markInteractiveElicitationEnd,
	isInteractiveElicitationInFlight,
} from "../gsd/auto-tool-tracking.js";
import {
	discoverBrowserMcpServerName,
	discoverMcpServers,
	discoverMcpServerNames,
	discoverUserMcpServerNames,
	discoverWorkflowMcpServerName,
	computeMcpDisallowedTools,
} from "../gsd/mcp-filter.js";
import { RUN_UAT_CLAUDE_NATIVE_TOOL_NAMES, RUN_UAT_FORBIDDEN_TOOL_NAMES, RUN_UAT_WORKFLOW_TOOL_NAMES, resolveToolPresentationPlan } from "../gsd/tool-presentation-plan.js";
import { getUnitToolSurfaceContract } from "../gsd/unit-tool-contracts.js";
import {
	awaitWorkflowMcpToolRegistration,
	getToolSurfaceReadinessError,
	POST_PREFLIGHT_READINESS_RETRY_DELAYS_MS,
	POST_PREFLIGHT_SDK_SETTLE_MS,
	TOOL_SURFACE_NOT_READY,
	type LiveToolSurfaceObservation,
} from "../gsd/tool-surface-readiness.js";
import {
	beginWorkflowMcpSdkSession,
	endWorkflowMcpSdkSession,
} from "../gsd/workflow-mcp-readiness-cache.js";
import { getGuidedUnitContext } from "../gsd/guided-unit-context.js";
import { autoSession, getActiveAutoUnitType, isAutoActive } from "../gsd/auto-runtime-state.js";
import {
	beginMilestoneStatusObservationTurn,
	classifyMilestoneStatusRuntimeMode,
	clearMilestoneStatusObservationTurn,
	MILESTONE_STATUS_OBSERVATION_TOKEN_ENV,
	MILESTONE_STATUS_OBSERVATION_PENDING_SOURCE_REVISION,
} from "../gsd/milestone-status-observation-context.js";
import { resolveUokFlags } from "../gsd/uok/flags.js";
import { hasBrowserContractPrefix } from "../shared/browser-contract.js";
import { showInterviewRound, type Question, type RoundResult } from "../shared/tui.js";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "./sdk-types.js";

export {
	buildFinalAssistantContent,
	extractToolResultsFromSdkUserMessage,
	handleClaudeCodePartialStreamEvent,
	mergePendingToolCalls,
	shouldSuppressDuplicateToolUnavailableBlock,
} from "./turn-assembler.js";
export type {
	ExternalToolResultContentBlock,
	ExternalToolResultPayload,
	ToolCallWithExternalResult,
} from "./turn-assembler.js";

interface PromptToolContextOptions {
	workflowMcpServerName?: string | null;
	browserMcpServerName?: string | null;
	questionToolAvailable?: boolean;
}

/** `SimpleStreamOptions` extended with an optional extension UI context for elicitation dialogs. */
interface ClaudeCodeStreamOptions extends SimpleStreamOptions {
	extensionUIContext?: ExtensionUIContext;
	onExternalToolCall?: (toolCall: ToolCall) => Promise<void> | void;
	onExternalToolResult?: (event: { toolCall: ToolCall; result: ExternalToolResultPayload }) => Promise<void> | void;
	_findConcurrentClaudeCodeProcessesForTest?: (cwd: string) => ConcurrentClaudeCodeProcess[];
	_sdkQueryForTest?: (args: {
		prompt: string | AsyncIterable<unknown>;
		options?: Record<string, unknown>;
	}) => AsyncIterable<SDKMessage>;
	_skipWorkflowMcpPreflightForTest?: boolean;
}

export function serverToolUseToToolCallLike(block: {
	id: string;
	name: string;
	input: unknown;
}): ToolCall {
	const argumentsValue =
		block.input && typeof block.input === "object" && !Array.isArray(block.input)
			? (block.input as Record<string, unknown>)
			: { input: block.input };
	return {
		type: "toolCall",
		id: block.id,
		name: block.name,
		arguments: argumentsValue,
	};
}

/** Resolve the workspace root for local Claude Code process execution. */
export function resolveClaudeCodeCwd(options?: SimpleStreamOptions): string {
	return options?.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
}

export interface ConcurrentClaudeCodeProcess {
	pid: number;
	cwd: string;
	command: string;
}

const warnedConcurrentClaudeCodeCwds = new Set<string>();

function hasArgValue(argv: string[], flag: string, value: string): boolean {
	return argv.some((arg, index) =>
		arg === `${flag}=${value}` || (arg === flag && argv[index + 1] === value)
	);
}

function referencesClaudeCodeExecutable(argv: string[]): boolean {
	return argv.some((arg) => {
		const normalized = arg.replaceAll("\\", "/");
		return /(?:^|\/)claude(?:\.cmd|\.exe)?$/i.test(normalized)
			|| /@anthropic-ai\/claude-agent-sdk\/cli\.js$/i.test(normalized);
	});
}

export function isClaudeCodeSdkProcessArgv(argv: string[]): boolean {
	return referencesClaudeCodeExecutable(argv)
		&& hasArgValue(argv, "--output-format", "stream-json")
		&& hasArgValue(argv, "--input-format", "stream-json");
}

function readProcArgv(procRoot: string, pid: string): string[] {
	const raw = readFileSync(join(procRoot, pid, "cmdline"), "utf-8");
	return raw.split("\0").filter(Boolean);
}

export function findConcurrentClaudeCodeProcesses(
	cwd: string,
	options: { procRoot?: string; currentPid?: number } = {},
): ConcurrentClaudeCodeProcess[] {
	const procRoot = options.procRoot ?? "/proc";
	if (procRoot === "/proc" && process.platform !== "linux") return [];

	let targetCwd: string;
	try {
		targetCwd = realpathSync(cwd);
	} catch {
		return [];
	}

	const entries = (() => {
		try {
			return readdirSync(procRoot, { withFileTypes: true });
		} catch {
			return undefined;
		}
	})();
	if (!entries) {
		return [];
	}

	const currentPid = options.currentPid ?? process.pid;
	const matches: ConcurrentClaudeCodeProcess[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number(entry.name);
		if (pid === currentPid) continue;

		let processCwd: string;
		let argv: string[];
		try {
			processCwd = realpathSync(join(procRoot, entry.name, "cwd"));
			if (processCwd !== targetCwd) continue;
			argv = readProcArgv(procRoot, entry.name);
		} catch {
			continue;
		}

		if (!isClaudeCodeSdkProcessArgv(argv)) continue;
		matches.push({ pid, cwd: processCwd, command: argv.join(" ") });
	}

	return matches.sort((a, b) => a.pid - b.pid);
}

export function buildConcurrentClaudeCodeProcessWarning(
	cwd: string,
	processes: ConcurrentClaudeCodeProcess[],
): string {
	const pids = processes.map((processInfo) => processInfo.pid).join(", ");
	const pidLabel = processes.length === 1 ? `PID ${pids}` : `PIDs ${pids}`;
	return `Another Claude Code SDK process is already running in ${cwd} (${pidLabel}). ` +
		`Its in-memory Agent tasks will not appear in this session's TaskList/TaskGet/TaskOutput; ` +
		`wait for it to finish or stop it before redoing work in this working tree.`;
}

/** A single selectable option within an SDK elicitation schema field. */
interface SdkElicitationRequestOption {
	const?: string;
	title?: string;
}

/** JSON-Schema-like descriptor for a single field within an SDK elicitation request schema. */
interface SdkElicitationFieldSchema {
	type?: string;
	title?: string;
	description?: string;
	format?: string;
	writeOnly?: boolean;
	oneOf?: SdkElicitationRequestOption[];
	items?: {
		anyOf?: SdkElicitationRequestOption[];
	};
}

/** The full elicitation request object received from an MCP server via the Claude Agent SDK. */
interface SdkElicitationRequest {
	serverName: string;
	message: string;
	mode?: "form" | "url";
	requestedSchema?: {
		type?: string;
		properties?: Record<string, SdkElicitationFieldSchema>;
		required?: string[];
	};
}

/** The result returned by an elicitation handler back to the Claude Agent SDK. */
interface SdkElicitationResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string | string[]>;
}

/** A TUI `Question` extended with an optional note-field ID for "None of the above" free-text capture. */
interface ParsedElicitationQuestion extends Question {
	noteFieldId?: string;
}

interface HeadlessAnswersFile {
	questions?: Record<string, string | string[]>;
	defaults?: { strategy?: "first_option" | "cancel" };
}

/** Descriptor for a single free-text input field parsed from an SDK elicitation form schema. */
interface ParsedTextInputField {
	id: string;
	title: string;
	description: string;
	required: boolean;
	secure: boolean;
}

/** A base64-encoded image block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputImageBlock {
	type: "image";
	source: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

/** A plain-text block in the format accepted by the Claude Agent SDK input message. */
interface SDKInputTextBlock {
	type: "text";
	text: string;
}

/** Union of content block types that may appear in a Claude Agent SDK user input message. */
type SDKInputUserContentBlock = SDKInputImageBlock | SDKInputTextBlock;

/** A synthetic user message in the Claude Agent SDK's async-iterable prompt format, used when images are present. */
interface SDKInputUserMessage {
	type: "user";
	message: {
		role: "user";
		content: SDKInputUserContentBlock[];
	};
	parent_tool_use_id: null;
}

/** Label used for the free-text fallback option in single-choice elicitation questions. */
const OTHER_OPTION_LABEL = "None of the above";
/** Regex pattern that identifies field names and descriptions that should be treated as sensitive/secure inputs. */
const SENSITIVE_FIELD_PATTERN = /(password|passphrase|secret|token|api[_\s-]*key|private[_\s-]*key|credential)/i;
/** Mirrors @opengsd/mcp-server's ask_user_questions host elicitation timeout. */
const WORKFLOW_ELICIT_TIMEOUT_MS = 10 * 60 * 1000;
/** Close the local form just before the server drops the MCP elicitation request. */
const WORKFLOW_ELICIT_TIMEOUT_SKEW_MS = 1_000;
export const CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS = Math.max(
	1,
	WORKFLOW_ELICIT_TIMEOUT_MS - WORKFLOW_ELICIT_TIMEOUT_SKEW_MS,
);
const ELICITATION_EXPIRED_NOTICE =
	"Question expired before you answered - the form was closed and no answers were sent.";
const activeAskUserQuestionElicitationTimeoutAborters = new Set<() => void>();

function isAskUserQuestionsToolName(toolName: string | undefined): boolean {
	const name = String(toolName ?? "");
	return name === "ask_user_questions" || name.endsWith("__ask_user_questions");
}

function isAskUserQuestionsTimedOutResult(
	toolCall: Pick<ToolCall, "name">,
	result: ExternalToolResultPayload,
): boolean {
	return isAskUserQuestionsToolName(toolCall.name) && result.details?.timed_out === true;
}

function abortActiveAskUserQuestionElicitationsForTimeout(): void {
	if (!isInteractiveElicitationInFlight()) return;
	for (const abort of [...activeAskUserQuestionElicitationTimeoutAborters]) {
		abort();
	}
}

// ---------------------------------------------------------------------------
// Stream factory
// ---------------------------------------------------------------------------

/**
 * Construct an AssistantMessageEventStream using EventStream directly.
 * (The class itself is only re-exported as a type from the @gsd/pi-ai barrel.)
 */
function createAssistantStream(): AssistantMessageEventStream {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type for final result");
		},
	) as AssistantMessageEventStream;
}

/** Extract a human-readable error string from an SDK result message. */
export function getResultErrorMessage(result: SDKResultMessage): string {
	if ("errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
		return result.errors.join("; ");
	}

	if ("result" in result && typeof result.result === "string" && result.result.trim().length > 0) {
		return result.result.trim();
	}

	return result.subtype === "success" ? "claude_code_request_failed" : result.subtype;
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

/** Cached result of the Claude executable/script resolution so lookup runs once per process. */
let cachedClaudePath: string | null = null;
const requireFromHere = createRequire(import.meta.url);

/** Return the shell command used to locate the `claude` binary on the given platform. */
export function getClaudeLookupCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "where claude" : "which claude";
}

/**
 * Pick the most suitable path from `which`/`where` output.
 *
 * On Windows, `where claude` can return shim entries first (for example
 * `...\\npm\\claude` / `...\\npm\\claude.cmd`) that the Claude Agent SDK treats
 * as a native executable path and then fails to spawn. Prefer a native
 * `.exe` candidate when present.
 */
export function parseClaudeLookupOutput(output: Buffer | string, platform: NodeJS.Platform = process.platform): string {
	const lines = output
		.toString()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	if (lines.length === 0) return "";
	if (platform !== "win32") return lines[0] ?? "";

	const exeCandidate = lines.find((line) => /\.exe$/i.test(line));
	if (exeCandidate) return exeCandidate;

	const cmdCandidate = lines.find((line) => /\.cmd$/i.test(line));
	if (cmdCandidate) return cmdCandidate;

	return lines[0] ?? "";
}

/** Resolve the SDK-bundled cli.js path if available. */
export function resolveBundledClaudeCliPath(): string | null {
	try {
		const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
		const cliPath = join(dirname(sdkEntry), "cli.js");
		return existsSync(cliPath) ? cliPath : null;
	} catch {
		return null;
	}
}

/**
 * Normalize a discovered path for Claude Agent SDK consumption.
 *
 * On Windows, the SDK treats non-`.js` paths as native binaries. NPM shims
 * like `claude`/`claude.cmd` are not native binaries and can fail with
 * `ENOENT`/`EINVAL` in that mode. When no `.exe` is available, prefer the
 * SDK-bundled `cli.js` so the SDK runs via Node.
 */
export function normalizeClaudePathForSdk(
	resolvedPath: string,
	platform: NodeJS.Platform = process.platform,
	bundledCliPath: string | null = resolveBundledClaudeCliPath(),
): string {
	if (platform !== "win32") return resolvedPath;
	if (/\.exe$/i.test(resolvedPath)) return resolvedPath.replaceAll("\\", "/");
	if (bundledCliPath) return bundledCliPath.replaceAll("\\", "/");
	return resolvedPath;
}

/** Resolve the path passed to `pathToClaudeCodeExecutable`. */
function getClaudePath(): string {
	if (cachedClaudePath) return cachedClaudePath;

	const fallback = process.platform === "win32"
		? (resolveBundledClaudeCliPath() ?? "claude.cmd")
		: "claude";

	try {
		const lookupOutput = execSync(getClaudeLookupCommand(), { timeout: 5_000, stdio: "pipe" });
		const parsed = parseClaudeLookupOutput(lookupOutput, process.platform);
		cachedClaudePath = normalizeClaudePathForSdk(parsed || fallback, process.platform);
	} catch {
		cachedClaudePath = fallback;
	}

	return cachedClaudePath;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Extract text content from a single message regardless of content shape.
 */
function extractMessageText(msg: { role: string; content: unknown }): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		const textParts = msg.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text ?? part.thinking ?? "");
		if (textParts.length > 0) return textParts.join("\n");
	}
	return "";
}

// Patterns are anchored to the `UNIT: <Phase>` dispatch header ONLY. The old
// patterns also matched bare slugs (`run-uat`, `plan-slice`, `gsd_plan_slice`,
// …) anywhere in the text, so any incidental occurrence — a branch name like
// `milestone/M039`, an untracked file `m039-s05-…spec.ts`, a forensic report,
// or the user literally typing "slice"/"UAT" while describing a problem — would
// misclassify the turn as a dispatched unit. Only the dispatch header is an
// authoritative phase signal, so match nothing else.
const GSD_PHASE_PATTERNS: Array<[string, RegExp]> = [
	["run-uat", /\bUNIT:\s*Run UAT\b/i],
	["complete-milestone", /\bUNIT:\s*Complete Milestone\b/i],
	["validate-milestone", /\bUNIT:\s*Validate Milestone\b/i],
	["reassess-roadmap", /\bUNIT:\s*Reassess Roadmap\b/i],
	["complete-slice", /\bUNIT:\s*Complete Slice\b/i],
	["replan-slice", /\bUNIT:\s*Replan Slice\b/i],
	["refine-slice", /\bUNIT:\s*Refine Slice\b/i],
	["plan-slice", /\bUNIT:\s*Plan Slice\b/i],
	["plan-milestone", /\bUNIT:\s*Plan Milestone\b/i],
	["execute-task", /\bUNIT:\s*Execute Task\b/i],
	["gate-evaluate", /\bUNIT:\s*Gate Evaluate\b/i],
	["research-milestone", /\bUNIT:\s*Research Milestone\b/i],
	["research-slice", /\bUNIT:\s*Research Slice\b/i],
	["research-decision", /\bUNIT:\s*Research Decision\b/i],
	["discuss-milestone", /\bUNIT:\s*Discuss Milestone\b/i],
	["discuss-slice", /\bUNIT:\s*Discuss Slice\b/i],
	["discuss-project", /\bUNIT:\s*Discuss Project\b/i],
	["discuss-requirements", /\bUNIT:\s*Discuss Requirements\b/i],
];

/** The set of GSD phases this adapter recognises, derived from the patterns above. */
const KNOWN_GSD_PHASES = new Set(GSD_PHASE_PATTERNS.map(([phase]) => phase));

export function inferGsdPhaseFromContext(context: Context): string | undefined {
	// Scan only the system prompt and the most recent user directive. Scanning
	// the entire scrollback let a phase header that merely appeared in history
	// (e.g. a SUMMARY the agent read, or a pasted prior dispatch) re-classify
	// every subsequent turn.
	const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
	const text = [
		context.systemPrompt ?? "",
		lastUser ? extractMessageText(lastUser) : "",
	].join("\n");
	for (const [phase, pattern] of GSD_PHASE_PATTERNS) {
		if (pattern.test(text)) return phase;
	}
	return undefined;
}

/**
 * Resolve the GSD unit phase for Claude Code SDK sessions. Guided-flow
 * dispatch records the authoritative unit type before the turn is queued;
 * prefer that over regex inference from prompt text.
 */
export function resolveGsdPhaseForSdk(context: Context, projectRoot: string): string | undefined {
	const resolvedRoot = resolveWorkflowMcpProjectRoot(projectRoot);
	const guided =
		getGuidedUnitContext(resolvedRoot)
		?? getGuidedUnitContext(projectRoot)
		?? getGuidedUnitContext();
	if (guided?.unitType) {
		const guidedRoot = resolveWorkflowMcpProjectRoot(guided.basePath);
		if (guidedRoot === resolvedRoot) {
			return guided.unitType;
		}
	}
	// Auto-mode records the dispatched unit type before each turn — that is the
	// authoritative phase, so prefer it over any inference. (Guided interactive
	// dispatch is handled above via getGuidedUnitContext.) Ignore `hook/*`
	// pseudo-units and anything not a recognised GSD phase.
	const autoUnit = getActiveAutoUnitType();
	if (autoUnit && KNOWN_GSD_PHASES.has(autoUnit)) {
		return autoUnit;
	}

	// No authoritative guided/auto signal → ad-hoc turn. Do NOT regex-infer a
	// phase from prose: that would fire the workflow MCP preflight and, for
	// run-uat, strip Bash/Write/Edit/gsd_exec for the rest of the session the
	// moment the conversation (or the GSD system prompt itself) happened to
	// mention a phase token. An ad-hoc turn keeps the full tool surface.
	//
	// The header-anchored inference remains only as a last resort while auto is
	// running but the current unit wasn't recorded for some reason; even then it
	// matches the `UNIT:` dispatch header only, never bare slugs in scrollback.
	if (!isAutoActive()) {
		return undefined;
	}
	return inferGsdPhaseFromContext(context);
}

/**
 * Build a full conversational prompt from GSD's context messages.
 *
 * Previous behaviour sent only the last user message, making every SDK
 * call effectively stateless. This version serialises the complete
 * conversation history (system prompt + all user/assistant turns) so
 * Claude Code has full context for multi-turn continuity.
 *
 * History is wrapped in XML-tag structure rather than `[User]`/`[Assistant]`
 * bracket headers. Bracket headers read to the model as an in-context
 * demonstration of how turns are delimited, causing it to fabricate fake
 * user turns in its own output. XML tags read as document structure and
 * don't get mirrored in free text.
 */
export function buildPromptFromContext(context: Context, toolContext: PromptToolContextOptions = {}): string {
	const hasContent = Boolean(context.systemPrompt) || context.messages.some((m) => extractMessageText(m));
	if (!hasContent) return "";

	const parts: string[] = [
		"Respond only to the final user message below. " +
			"Do not emit <user_message>, <assistant_message>, or <prior_system_context> tags in your response.",
	];
	const workflowToolLine = toolContext.workflowMcpServerName
		? "- GSD workflow tools (gsd_exec, gsd_slice_complete, gsd_task_complete, gsd_plan_slice, gsd_save_gate_result, etc.) " +
			`are MCP tools — call them as mcp__${toolContext.workflowMcpServerName}__<tool_name> ` +
			`(e.g. mcp__${toolContext.workflowMcpServerName}__gsd_exec, mcp__${toolContext.workflowMcpServerName}__gsd_save_gate_result)\n` +
			(toolContext.questionToolAvailable !== false
				? `- Structured user input: call mcp__${toolContext.workflowMcpServerName}__ask_user_questions. ` +
					"Do not call bare ask_user_questions. Do not call native AskUserQuestion.\n"
				: "")
		: "- GSD workflow MCP tools are unavailable in this Claude Code run.\n";
	const toolSearchLine = toolContext.workflowMcpServerName
		? "- ToolSearch is available only for Claude Code deferred workflow MCP hydration. " +
			`If mcp__${toolContext.workflowMcpServerName}__<tool_name> is missing or Claude Code reports the server is still connecting, ` +
			`use ToolSearch with select:mcp__${toolContext.workflowMcpServerName}__<tool_name> or the base tool name, then call the returned MCP tool directly. ` +
			"Do not use ToolSearch for browser_* tools or general discovery.\n"
		: "- ToolSearch is NOT available — never use it to discover tools\n";
	const browserToolLine = toolContext.browserMcpServerName
		? "- Browser verification uses gsd-browser MCP by default — call browser tools as " +
			`mcp__${toolContext.browserMcpServerName}__<browser_tool_name> ` +
			`(e.g. mcp__${toolContext.browserMcpServerName}__browser_snapshot_refs, mcp__${toolContext.browserMcpServerName}__browser_assert). ` +
			"Do not call pi-native browser_* names directly.\n"
		: "- Pi/GSD browser_* tools from prior context (for example browser_navigate, browser_find, browser_evaluate, browser_close) are not Claude Code tools. " +
			"Never use ToolSearch to select browser_* tools; for browser verification, use Bash to run a local Playwright/Node check unless an explicit browser MCP tool is already listed.\n";

	// The prior system context lists pi-native tool names (lowercase: bash, read, gsd_exec, etc.)
	// but this process runs inside Claude Code where tool names differ. Inject a remapping note
	// before the prior context so the model uses correct names regardless of what the prior
	// context describes.
	parts.push(
		"<tool_context>\n" +
			"You are running inside Claude Code. Use these exact tool names — do not use lowercase or pi-native names:\n" +
			"- Shell commands: 'Bash' (not 'bash')\n" +
			"- File operations: 'Read', 'Write', 'Edit', 'Glob', 'Grep' (PascalCase, not lowercase)\n" +
			workflowToolLine +
			browserToolLine +
			toolSearchLine +
			"</tool_context>",
	);

	if (context.systemPrompt) {
		parts.push(`<prior_system_context>\n${context.systemPrompt}\n</prior_system_context>`);
	}

	const turns: string[] = [];
	for (const msg of context.messages) {
		const text = extractMessageText(msg);
		if (!text) continue;
		const tag =
			msg.role === "user" ? "user_message" : msg.role === "assistant" ? "assistant_message" : "system_message";
		turns.push(`<${tag}>\n${text}\n</${tag}>`);
	}
	if (turns.length > 0) {
		parts.push(`<conversation_history>\n${turns.join("\n")}\n</conversation_history>`);
	}

	return parts.join("\n\n");
}

/** Strip the `data:<mime>;base64,` prefix from a data URI, returning only the raw base64 payload. */
function stripDataUriPrefix(value: string): string {
	const commaIndex = value.indexOf(",");
	if (value.startsWith("data:") && commaIndex !== -1) {
		return value.slice(commaIndex + 1);
	}
	return value;
}

/** Extract the MIME type from a data URI string, or return `null` if the value is not a valid data URI. */
function inferMimeTypeFromDataUri(value: string): string | null {
	const match = /^data:([^;,]+);base64,/.exec(value);
	return match?.[1] ?? null;
}

/** Collect all base64 image blocks from user messages in the context for inclusion in the SDK prompt. */
export function extractImageBlocksFromContext(context: Context): SDKInputImageBlock[] {
	const imageBlocks: SDKInputImageBlock[] = [];
	const seenImageKeys = new Set<string>();

	for (const msg of context.messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const block = part as { type?: unknown; data?: unknown; mimeType?: unknown };
			if (block.type !== "image" || typeof block.data !== "string") continue;

			const mimeType =
				typeof block.mimeType === "string" && block.mimeType.length > 0
					? block.mimeType
					: inferMimeTypeFromDataUri(block.data);
			if (!mimeType) continue;

			const data = stripDataUriPrefix(block.data);
			const imageKey = `${mimeType}\0${createHash("sha1").update(data).digest("hex")}`;
			if (seenImageKeys.has(imageKey)) continue;
			seenImageKeys.add(imageKey);

			imageBlocks.push({
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data,
				},
			});
		}
	}

	return imageBlocks;
}

/** Build the SDK query prompt, wrapping image blocks into an async iterable user message when present. */
export function buildSdkQueryPrompt(
	context: Context,
	textPrompt: string = buildPromptFromContext(context),
): string | AsyncIterable<SDKInputUserMessage> {
	const imageBlocks = extractImageBlocksFromContext(context);
	if (imageBlocks.length === 0) {
		return textPrompt;
	}

	const content: SDKInputUserContentBlock[] = [...imageBlocks];
	if (textPrompt) {
		content.push({ type: "text", text: textPrompt });
	}

	const sdkMessage: SDKInputUserMessage = {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	};

	return {
		async *[Symbol.asyncIterator]() {
			yield sdkMessage;
		},
	};
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/** Build a minimal error `AssistantMessage` with the given model ID and error text. */
function makeErrorMessage(model: string, errorMsg: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `Claude Code error: ${errorMsg}` }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: errorMsg,
		timestamp: Date.now(),
	};
}

export interface WorkflowMcpReadinessProgressState {
	contentIndex?: number;
}

export function buildWorkflowMcpReadinessProgressMessage(input: {
	unitType: string;
	workflowServerName: string;
	stage: "preflight" | "retry";
	attempt?: number;
	delayMs?: number;
}): string {
	const { unitType, workflowServerName, stage } = input;
	if (stage === "preflight") {
		return `Starting ${workflowServerName} MCP for ${unitType}; waiting for workflow tools to register...`;
	}

	const attempt = input.attempt === undefined ? "" : ` attempt ${input.attempt}`;
	const delay = input.delayMs === undefined ? "" : ` Retrying in ${formatReadinessDelay(input.delayMs)}.`;
	return `Still waiting for ${workflowServerName} MCP tools for ${unitType}${attempt}.${delay}`;
}

function formatReadinessDelay(delayMs: number): string {
	if (delayMs < 1_000) return `${delayMs}ms`;
	const seconds = delayMs / 1_000;
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

export function pushWorkflowMcpReadinessProgressEvent(input: {
	stream: Pick<AssistantMessageEventStream, "push">;
	partial: AssistantMessage;
	state: WorkflowMcpReadinessProgressState;
	message: string;
}): void {
	const { stream, partial, state, message } = input;
	if (!message) return;

	let contentIndex = state.contentIndex;
	const existing = contentIndex === undefined ? undefined : partial.content[contentIndex];
	if (contentIndex === undefined || existing?.type !== "text") {
		contentIndex = partial.content.length;
		state.contentIndex = contentIndex;
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex });
	}

	const block = partial.content[contentIndex];
	if (block.type !== "text") return;

	const delta = block.text.length === 0 ? message : `\n${message}`;
	block.text += delta;
	stream.push({ type: "text_delta", contentIndex, delta });
}

function emitConcurrentClaudeCodeProcessWarning(input: {
	cwd: string;
	stream: Pick<AssistantMessageEventStream, "push">;
	partial: AssistantMessage;
	uiContext: ExtensionUIContext | undefined;
	findProcesses: (cwd: string) => ConcurrentClaudeCodeProcess[];
}): void {
	let resolvedCwd: string;
	try {
		resolvedCwd = realpathSync(input.cwd);
	} catch {
		resolvedCwd = input.cwd;
	}
	if (warnedConcurrentClaudeCodeCwds.has(resolvedCwd)) return;

	const processes = input.findProcesses(input.cwd);
	if (processes.length === 0) return;

	warnedConcurrentClaudeCodeCwds.add(resolvedCwd);
	const message = buildConcurrentClaudeCodeProcessWarning(resolvedCwd, processes);
	pushWorkflowMcpReadinessProgressEvent({
		stream: input.stream,
		partial: input.partial,
		state: {},
		message,
	});
	input.uiContext?.notify(message, "warning");
}

export function isClaudeCodeAbortErrorMessage(message: string | undefined | null): boolean {
	if (!message) return false;
	return /\b(?:claude code process aborted by user|request aborted by user|process aborted by user|aborterror)\b/i.test(message);
}

function isBareClaudeCodeAbortErrorMessage(message: string | undefined | null): boolean {
	if (!message) return false;
	const normalized = message.trim().replace(/\s+/g, " ").toLowerCase();
	return normalized === "claude code process aborted by user"
		|| normalized === "request aborted by user"
		|| normalized === "process aborted by user";
}

export function resolveClaudeCodeAbortedMessageText(errorMsg: string, lastTextContent: string): string {
	const trimmedError = errorMsg.trim();
	if (trimmedError && !isBareClaudeCodeAbortErrorMessage(trimmedError)) {
		return trimmedError;
	}
	return lastTextContent;
}

/**
 * Generator exhaustion without a terminal result means the SDK stream was
 * interrupted mid-turn. Surface it as an error so downstream recovery logic
 * can classify and retry it instead of treating it as a clean completion.
 */
export function makeStreamExhaustedErrorMessage(model: string, lastTextContent: string): AssistantMessage {
	const errorMsg = "stream_exhausted_without_result";
	const message = makeErrorMessage(model, errorMsg);
	if (lastTextContent) {
		message.content = [{ type: "text", text: lastTextContent }];
	}
	return message;
}

/** Extract the string labels from an array of SDK elicitation option objects, filtering out blank entries. */
function readElicitationChoices(options: SdkElicitationRequestOption[] | undefined): string[] {
	if (!Array.isArray(options)) return [];
	return options
		.map((option) => (typeof option?.const === "string" ? option.const : typeof option?.title === "string" ? option.title : ""))
		.filter((option): option is string => option.length > 0);
}

let cachedHeadlessAnswersPath: string | undefined;
let cachedHeadlessAnswers: HeadlessAnswersFile | null | undefined;

function loadHeadlessAnswers(env: NodeJS.ProcessEnv = process.env): HeadlessAnswersFile | null {
	const filePath = env.GSD_HEADLESS_ANSWERS_PATH?.trim();
	if (!filePath) return null;
	if (cachedHeadlessAnswersPath === filePath) return cachedHeadlessAnswers ?? null;

	cachedHeadlessAnswersPath = filePath;
	cachedHeadlessAnswers = null;
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		cachedHeadlessAnswers = parsed as HeadlessAnswersFile;
		return cachedHeadlessAnswers;
	} catch {
		return null;
	}
}

function normalizeHeadlessQuestionId(id: string): string {
	return id.trim().toLowerCase().replace(/[-\s]+/g, "_").replace(/_confirm$/, "");
}

function findHeadlessAnswer(
	answers: Record<string, string | string[]> | undefined,
	questionId: string,
): string | string[] | undefined {
	if (!answers) return undefined;
	const normalizedQuestionId = normalizeHeadlessQuestionId(questionId);

	for (const [key, answer] of Object.entries(answers)) {
		if (normalizeHeadlessQuestionId(key) === normalizedQuestionId) return answer;
	}

	for (const [key, answer] of Object.entries(answers)) {
		const normalizedKey = normalizeHeadlessQuestionId(key);
		if (normalizedQuestionId.startsWith(`${normalizedKey}_`) || normalizedKey.startsWith(`${normalizedQuestionId}_`)) {
			return answer;
		}
	}

	return undefined;
}

function answerValueForQuestion(
	question: ParsedElicitationQuestion,
	answers: HeadlessAnswersFile,
): string | string[] | undefined {
	const explicit = findHeadlessAnswer(answers.questions, question.id);
	if (explicit !== undefined) return explicit;

	const strategy = answers.defaults?.strategy ?? "first_option";
	if (strategy === "cancel") return undefined;
	return question.allowMultiple ? [question.options[0]?.label ?? ""] : question.options[0]?.label;
}

function answerElicitationFromHeadlessAnswers(
	questions: ParsedElicitationQuestion[],
	answers: HeadlessAnswersFile | null,
): SdkElicitationResult | null {
	if (!answers) return null;
	if (answers.defaults?.strategy === "cancel" && !answers.questions) return { action: "cancel" };

	const content: Record<string, string | string[]> = {};
	for (const question of questions) {
		const rawAnswer = answerValueForQuestion(question, answers);
		if (rawAnswer === undefined) return { action: "cancel" };

		const labels = new Set(question.options.map((option) => option.label));
		if (question.allowMultiple) {
			const selected = (Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer]).filter((value) => labels.has(value));
			if (selected.length > 0) {
				content[question.id] = selected;
				continue;
			}
			if ((answers.defaults?.strategy ?? "first_option") === "cancel") return { action: "cancel" };
			content[question.id] = [question.options[0]?.label ?? ""];
			continue;
		}

		const selected = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
		if (typeof selected === "string" && labels.has(selected)) {
			content[question.id] = selected;
			continue;
		}
		if ((answers.defaults?.strategy ?? "first_option") === "cancel") return { action: "cancel" };
		content[question.id] = question.options[0]?.label ?? "";
	}

	return { action: "accept", content };
}

/** Parse an SDK elicitation request into structured multiple-choice questions, or null if the schema is unsupported. */
export function parseAskUserQuestionsElicitation(
	request: Pick<SdkElicitationRequest, "mode" | "requestedSchema">,
): ParsedElicitationQuestion[] | null {
	if (request.mode && request.mode !== "form") return null;
	const properties = request.requestedSchema?.properties;
	if (!properties || typeof properties !== "object") return null;

	const questions: ParsedElicitationQuestion[] = [];

	for (const [fieldId, rawField] of Object.entries(properties)) {
		if (fieldId.endsWith("__note")) continue;
		if (!rawField || typeof rawField !== "object") return null;

		const header = typeof rawField.title === "string" && rawField.title.length > 0 ? rawField.title : fieldId;
		const question = typeof rawField.description === "string" ? rawField.description : "";

		if (rawField.type === "array") {
			const options = readElicitationChoices(rawField.items?.anyOf).map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				allowMultiple: true,
			});
			continue;
		}

		if (rawField.type === "string") {
			const noteFieldId = Object.prototype.hasOwnProperty.call(properties, `${fieldId}__note`)
				? `${fieldId}__note`
				: undefined;
			const options = readElicitationChoices(rawField.oneOf)
				.filter((label) => label !== OTHER_OPTION_LABEL)
				.map((label) => ({ label, description: "" }));
			if (options.length === 0) return null;
			questions.push({
				id: fieldId,
				header,
				question,
				options,
				noteFieldId,
			});
			continue;
		}

		return null;
	}

	return questions.length > 0 ? questions : null;
}

/** Return true if the elicitation field should be treated as sensitive and rendered as a secure/password input. */
function isSecureElicitationField(
	requestMessage: string,
	fieldId: string,
	field: SdkElicitationFieldSchema,
): boolean {
	if (field.format === "password") return true;
	if (field.writeOnly === true) return true;

	const rawField = field as Record<string, unknown>;
	if (rawField.sensitive === true || rawField["x-sensitive"] === true) return true;

	const haystack = [
		requestMessage,
		fieldId.replace(/[_-]+/g, " "),
		typeof field.title === "string" ? field.title : "",
		typeof field.description === "string" ? field.description : "",
	]
		.join(" ")
		.toLowerCase();

	return SENSITIVE_FIELD_PATTERN.test(haystack);
}

/** Parse an SDK elicitation request into free-text input field descriptors, or null if unsupported. */
export function parseTextInputElicitation(
	request: Pick<SdkElicitationRequest, "message" | "mode" | "requestedSchema">,
): ParsedTextInputField[] | null {
	if (request.mode && request.mode !== "form") return null;
	const schema = request.requestedSchema as
		| ({ properties?: Record<string, SdkElicitationFieldSchema>; keys?: Record<string, SdkElicitationFieldSchema> } & Record<string, unknown>)
		| undefined;
	const fieldsSource = schema?.properties && typeof schema.properties === "object"
		? schema.properties
		: schema?.keys && typeof schema.keys === "object"
			? schema.keys
			: undefined;
	if (!fieldsSource) return null;

	const requiredSet = new Set(
		Array.isArray(request.requestedSchema?.required)
			? request.requestedSchema.required.filter((value): value is string => typeof value === "string")
			: [],
	);

	const fields: ParsedTextInputField[] = [];
	for (const [fieldId, field] of Object.entries(fieldsSource)) {
		if (!field || typeof field !== "object") continue;
		if (field.type !== "string") continue;
		if (Array.isArray(field.oneOf) && field.oneOf.length > 0) continue;

		fields.push({
			id: fieldId,
			title: typeof field.title === "string" && field.title.length > 0 ? field.title : fieldId,
			description: typeof field.description === "string" ? field.description : "",
			required: requiredSet.has(fieldId),
			secure: isSecureElicitationField(request.message, fieldId, field),
		});
	}

	return fields.length > 0 ? fields : null;
}

/** Convert a TUI interview round result into the SDK elicitation content map. */
export function roundResultToElicitationContent(
	questions: ParsedElicitationQuestion[],
	result: RoundResult,
): Record<string, string | string[]> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const answer = result.answers[question.id];
		if (!answer) continue;

		if (question.allowMultiple) {
			const selected = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
			content[question.id] = selected;
			continue;
		}

		const selected = Array.isArray(answer.selected) ? answer.selected[0] ?? "" : answer.selected;
		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL && answer.notes.trim().length > 0) {
			content[question.noteFieldId] = answer.notes.trim();
		}
	}

	return content;
}

/** Build the dialog title string for a multiple-choice elicitation question, combining server name, header, and question text. */
function buildElicitationPromptTitle(request: SdkElicitationRequest, question: ParsedElicitationQuestion): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		question.header,
		question.question,
	].filter((part) => part && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Drive each multiple-choice elicitation question through the extension UI's `select` dialog, collecting answers into an SDK result. */
async function promptElicitationWithDialogs(
	request: SdkElicitationRequest,
	questions: ParsedElicitationQuestion[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const question of questions) {
		const title = buildElicitationPromptTitle(request, question);

		if (question.allowMultiple) {
			const selected = await ui.select(title, question.options.map((option) => option.label), {
				allowMultiple: true,
				signal,
			});
			if (Array.isArray(selected)) {
				if (selected.length === 0) return { action: "cancel" };
				content[question.id] = selected;
				continue;
			}
			if (typeof selected === "string" && selected.length > 0) {
				content[question.id] = [selected];
				continue;
			}
			return { action: "cancel" };
		}

		const selected = await ui.select(title, [...question.options.map((option) => option.label), OTHER_OPTION_LABEL], { signal });
		if (typeof selected !== "string" || selected.length === 0) {
			return { action: "cancel" };
		}

		content[question.id] = selected;
		if (question.noteFieldId && selected === OTHER_OPTION_LABEL) {
			const note = await ui.input(`${question.header} note`, "Explain your answer", { signal });
			if (note === undefined) return { action: "cancel" };
			if (note.trim().length > 0) {
				content[question.noteFieldId] = note.trim();
			}
		}
	}

	return { action: "accept", content };
}

/** Build the dialog title string for a free-text input field, combining server name, field title, and description. */
function buildTextInputPromptTitle(request: SdkElicitationRequest, field: ParsedTextInputField): string {
	const parts = [
		request.serverName ? `[${request.serverName}]` : "",
		field.title,
		field.description,
	].filter((part) => typeof part === "string" && part.trim().length > 0);
	return parts.join("\n\n");
}

/** Derive a placeholder hint for a free-text input field from its description, falling back to "Required" or "Leave empty to skip". */
function buildTextInputPlaceholder(field: ParsedTextInputField): string | undefined {
	const desc = field.description.trim();
	if (!desc) return field.required ? "Required" : "Leave empty to skip";

	const formatLine = desc
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => /^format:/i.test(line));

	if (!formatLine) return field.required ? "Required" : "Leave empty to skip";
	const hint = formatLine.replace(/^format:\s*/i, "").trim();
	return hint.length > 0 ? hint : field.required ? "Required" : "Leave empty to skip";
}

/** Collect each free-text input field via the extension UI's `input` dialog, returning the filled SDK elicitation result. */
async function promptTextInputElicitation(
	request: SdkElicitationRequest,
	fields: ParsedTextInputField[],
	ui: ExtensionUIContext,
	signal: AbortSignal,
): Promise<SdkElicitationResult> {
	const content: Record<string, string | string[]> = {};

	for (const field of fields) {
		const value = await ui.input(
			buildTextInputPromptTitle(request, field),
			buildTextInputPlaceholder(field),
			{ signal, ...(field.secure ? { secure: true } : {}) },
		);
		if (value === undefined) {
			return { action: "cancel" };
		}
		content[field.id] = value;
	}

	return { action: "accept", content };
}

// ---------------------------------------------------------------------------
// canUseTool handler
// ---------------------------------------------------------------------------

/** Options passed by the SDK to the canUseTool callback. */
interface CanUseToolOptions {
	signal: AbortSignal;
	suggestions?: Array<Record<string, unknown>>;
	blockedPath?: string;
	decisionReason?: string;
	title?: string;
	displayName?: string;
	description?: string;
	toolUseID: string;
	agentID?: string;
}

/** Result returned by the canUseTool callback to the SDK. */
type CanUseToolPermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: Array<Record<string, unknown>>; toolUseID?: string }
	| { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };

/**
 * Known CLI tools where the subcommand verb changes the risk profile.
 * Value = number of subcommand tokens (beyond the executable) to capture
 * in the "Always Allow" permission pattern.
 *
 * `git push` and `git log` are very different → depth 1 → `Bash(git push:*)`
 * `gh pr create` and `gh pr list` differ at depth 2 → `Bash(gh pr create:*)`
 * `ping` is always safe → not listed → `Bash(ping:*)`
 */
const SUBCOMMAND_DEPTH: Record<string, number> = {
	git: 1,
	gh: 2,
	npm: 1,
	npx: 1,
	yarn: 1,
	pnpm: 1,
	docker: 1,
	kubectl: 1,
	aws: 2,
	az: 2,
	gcloud: 2,
	cargo: 1,
	pip: 1,
	pip3: 1,
	brew: 1,
	terraform: 1,
	helm: 1,
	dotnet: 1,
};

/** Command wrappers to skip when extracting the base executable. */
const CMD_PASSTHROUGH = new Set(["sudo", "env", "command"]);

/**
 * Build a smart permission pattern for Bash "Always Allow".
 *
 * Simple commands → `Bash(ping:*)` (any args are fine)
 * Subcommand-sensitive CLIs → `Bash(git push:*)` (verb is captured, args wildcarded)
 */
export function buildBashPermissionPattern(command: string): string {
	// When the command is a chain like "cd /foo && gh pr list", extract the
	// last segment — `cd` is just setup, the meaningful operation is what follows.
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	// Skip leading `cd` (directory setup) and trailing error suppressors
	// like `|| true`, `|| :`, `|| echo ...`.  The meaningful command is
	// the first segment that is *neither* of those.
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		// Strip suppressors, then strip cd prefixes; take the *last* remaining
		// segment — that's the meaningful command.
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	// Skip sudo/env wrappers and leading VAR=val assignments
	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return "Bash(*)";

	// Strip path and .exe from executable name
	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
	const depth = SUBCOMMAND_DEPTH[base];

	if (depth !== undefined) {
		// Capture base + N subcommand tokens: "gh pr list" → Bash(gh pr list:*)
		const significant = [base, ...tokens.slice(1, 1 + depth)].join(" ");
		return `Bash(${significant}:*)`;
	}

	// Simple command — any args are fine: "ping" → Bash(ping:*)
	return `Bash(${base}:*)`;
}

/**
 * Build the list of granularity options presented after a user chooses
 * "Always Allow" for a Bash command.
 *
 * Rather than assuming the user wants the default smart pattern, the UI
 * shows every meaningful prefix so the user explicitly picks the scope:
 *
 *   "gh pr list --limit 5" → [
 *     "Bash(gh:*)",         // allow any gh command
 *     "Bash(gh pr:*)",      // allow any gh pr subcommand
 *     "Bash(gh pr list:*)", // allow just this verb
 *   ]
 *
 * Flags (tokens starting with `-`) terminate the subcommand chain — they
 * are call-site arguments, not stable verbs. Subcommand depth is capped
 * at 3 to keep the menu short (max 4 options).
 *
 * Returns a single-entry list when there is no meaningful subcommand to
 * choose from (e.g. `ls -la`). Callers can skip the second dialog in
 * that case.
 */
export function buildBashPermissionPatternOptions(command: string): string[] {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
	const SETUP_RE = /^\s*cd\s/;
	const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
	let meaningful: string | undefined;
	if (segments.length > 1) {
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s));
		const core = trimmed.filter(s => !SETUP_RE.test(s));
		meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
	}
	meaningful = meaningful || segments[0] || command;
	const rawTokens = meaningful.trim().split(/\s+/);

	let idx = 0;
	while (idx < rawTokens.length) {
		if (CMD_PASSTHROUGH.has(rawTokens[idx])) { idx++; continue; }
		if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) { idx++; continue; }
		break;
	}
	const tokens = rawTokens.slice(idx).filter(Boolean);
	if (tokens.length === 0) return ["Bash(*)"];

	const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");

	// Collect up to 3 subcommand tokens, stopping at the first flag.
	const subTokens: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("-")) break;
		subTokens.push(t);
		if (subTokens.length >= 3) break;
	}

	const patterns: string[] = [`Bash(${base}:*)`];
	for (let i = 1; i <= subTokens.length; i++) {
		patterns.push(`Bash(${[base, ...subTokens.slice(0, i)].join(" ")}:*)`);
	}
	return patterns;
}

/**
 * Read Bash allow-rule patterns from project and user settings files.
 *
 * Returns the ruleContent portion (e.g. `"gh pr list:*"`) for each
 * `Bash(...)` entry found in `permissions.allow`.
 */
function readBashAllowRulesFromSettings(): string[] {
	const rules: string[] = [];
	const paths = [
		join(process.cwd(), ".claude", "settings.local.json"),
		join(process.cwd(), ".claude", "settings.json"),
	];
	try {
		paths.push(join(homedir(), ".claude", "settings.json"));
	} catch {
		// homedir() can throw on some platforms
	}
	for (const settingsPath of paths) {
		try {
			if (!existsSync(settingsPath)) continue;
			const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
			const allow = raw?.permissions?.allow;
			if (!Array.isArray(allow)) continue;
			for (const entry of allow) {
				if (typeof entry !== "string") continue;
				const m = /^Bash\((.+)\)$/.exec(entry);
				if (m) rules.push(m[1]);
			}
		} catch {
			// Ignore malformed settings files
		}
	}
	return rules;
}

/**
 * Check if a Bash compound command matches saved allow rules after
 * extracting the meaningful segment.
 *
 * The SDK's built-in matcher refuses to match prefix rules against
 * compound commands (e.g. `cd /path && gh pr list`). Claude Code
 * routinely prepends `cd <cwd> &&` to commands, causing saved rules
 * to never match on re-invocation. This function strips safe leading
 * segments (only `cd` commands) and checks the remaining operation
 * against saved rules.
 *
 * For compound commands, returns true only when all leading segments
 * are `cd` commands and the final segment matches a saved rule.
 * For simple (single-segment) commands, checks directly against saved
 * rules — this covers the case where a rule was added mid-session and
 * the SDK's in-memory cache is stale.
 */
export function bashCommandMatchesSavedRules(command: string): boolean {
	const segments = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
	if (segments.length === 0) return false;

	let meaningful: string;
	if (segments.length === 1) {
		meaningful = segments[0].trim();
	} else {
		// Strip trailing error suppressors (|| true, || :, || echo ...)
		// and leading cd segments.  The first remaining segment is the
		// meaningful command.  All other non-cd, non-suppressor segments
		// must be absent — otherwise we can't safely auto-approve.
		const SETUP_RE = /^cd\s/;
		const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
		const trimmed = segments.filter(s => !SUPPRESSOR_RE.test(s.trim()));
		const core = trimmed.filter(s => !SETUP_RE.test(s.trim()));
		if (core.length !== 1) return false; // ambiguous — multiple real commands
		meaningful = core[0].trim();
	}
	if (!meaningful) return false;

	const rules = readBashAllowRulesFromSettings();
	if (rules.length === 0) return false;

	for (const rule of rules) {
		const prefixMatch = /^(.+):\*$/.exec(rule);
		if (prefixMatch) {
			const prefix = prefixMatch[1];
			if (meaningful === prefix || meaningful.startsWith(prefix + " ")) {
				return true;
			}
			continue;
		}
		// Exact match
		if (meaningful === rule) return true;
	}

	return false;
}

/** Format the tool input into a human-readable summary for the permission prompt. */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
	// Bash — show the command
	if (input.command && typeof input.command === "string") {
		const cmd = input.command.length > 300 ? input.command.slice(0, 300) + "…" : input.command;
		return cmd;
	}
	// File-oriented tools — show path
	if (input.file_path && typeof input.file_path === "string") {
		return `${toolName}: ${input.file_path}`;
	}
	// Generic fallback — compact JSON, truncated
	const json = JSON.stringify(input);
	if (json.length <= 200) return json;
	return json.slice(0, 200) + "…";
}

/**
 * Create a canUseTool handler that routes SDK permission requests through the
 * extension UI's select dialog, or auto-approves when no UI is available.
 *
 * Presents three options:
 * - **Allow** — approve this one invocation
 * - **Always Allow** — approve and pass `suggestions` back as `updatedPermissions`
 *   so the SDK remembers the choice for the rest of the session
 * - **Deny** — reject the invocation
 *
 * Follows the same pattern as {@link createClaudeCodeElicitationHandler}:
 * takes an optional UI context and returns the callback or undefined.
 *
 * When UI is unavailable (headless / auto-mode sub-agents), returns a handler
 * that always approves — replacing the old GSD_AUTO_MODE → bypassPermissions
 * workaround.
 */
export function createClaudeCodeCanUseToolHandler(
	ui: ExtensionUIContext | undefined,
): ((toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<CanUseToolPermissionResult>) | undefined {
	if (!ui) return undefined;

	return async (toolName, _input, options) => {
		// Abort early if the signal is already fired
		if (options.signal.aborted) {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}

		// For Bash compound commands (e.g. "cd /path && gh pr list"),
		// check if the meaningful operation matches a saved allow rule.
		// The SDK's built-in matcher rejects prefix rules for compound
		// commands, but cd-prefixed commands are routine and the actual
		// operation is already approved.
		if (toolName === "Bash" && typeof _input.command === "string") {
			if (bashCommandMatchesSavedRules(_input.command)) {
				return { behavior: "allow", updatedInput: _input, toolUseID: options.toolUseID };
			}
		}

		const inputSummary = formatToolInput(toolName, _input);
		const title = options.title || `Allow Claude Code to use: ${toolName}?`;
		const body = [
			options.description,
			inputSummary,
		].filter(Boolean).join("\n");

		// The 2nd menu (level picker) lets the user choose the exact pattern,
		// so the 1st menu just shows "Always Allow" without a command suffix.
		const alwaysAllowLabel = "Always Allow";

		try {
			const choice = await ui.select(
				`${title}\n${body}`,
				["Allow", alwaysAllowLabel, "Deny"],
				{ signal: options.signal },
			);

			if (options.signal.aborted) {
				return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
			}

			if (choice === alwaysAllowLabel) {
				// Pass the SDK's own suggestions back as updatedPermissions so
				// it knows how to persist them (PermissionUpdate[] shape).
				// For Bash, patch the ruleContent with the user-chosen
				// granularity pattern (e.g. "gh", "gh pr", "gh pr list") so
				// the saved rule matches the scope the user actually wants.
				let perms = options.suggestions;
				let notifyLabel: string | undefined;
				if (toolName === "Bash" && typeof _input.command === "string") {
					// Present every meaningful prefix so the user picks the
					// scope explicitly rather than getting a blanket match.
					const patternOptions = buildBashPermissionPatternOptions(_input.command);
					let chosenPattern: string;
					if (patternOptions.length <= 1) {
						// No subcommand choice to make (e.g. "ls -la") — use
						// the single available pattern directly.
						chosenPattern = patternOptions[0] ?? buildBashPermissionPattern(_input.command);
					} else {
						const levelChoiceRaw = await ui.select(
							"Save permission at which level?",
							patternOptions,
							{ signal: options.signal },
						);
						if (options.signal.aborted) {
							return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
						}
						const levelChoice = Array.isArray(levelChoiceRaw) ? levelChoiceRaw[0] : levelChoiceRaw;
						if (!levelChoice || !patternOptions.includes(levelChoice)) {
							// User dismissed the level picker — cancel the
							// tool use. Falling back to a one-time allow
							// here would leave the spawned agent running
							// with no clear signal that the user bailed.
							return {
								behavior: "deny",
								message: "User cancelled permission selection",
								toolUseID: options.toolUseID,
							};
						}
						chosenPattern = levelChoice;
					}
					notifyLabel = chosenPattern;
					// Extract the ruleContent portion from "Bash(gh pr list:*)" → "gh pr list:*"
					const ruleContent = chosenPattern.replace(/^Bash\(/, "").replace(/\)$/, "");
					if (perms && Array.isArray(perms) && perms.length > 0) {
						// Clone suggestions and patch ruleContent on any Bash addRules entry
						perms = perms.map((s: any) => {
							if (s.type === "addRules" && Array.isArray(s.rules)) {
								return {
									...s,
									rules: s.rules.map((r: any) =>
										r.toolName === "Bash" ? { ...r, ruleContent } : r,
									),
								};
							}
							return s;
						});
					} else {
						// No suggestions from SDK — build a proper PermissionUpdate
						perms = [{
							type: "addRules",
							rules: [{ toolName: "Bash", ruleContent }],
							behavior: "allow",
							destination: "localSettings",
						}];
					}
				} else if (!perms || (Array.isArray(perms) && perms.length === 0)) {
					// Non-Bash tool with no SDK-supplied suggestions. Without a
					// fallback rule the SDK would return `behavior: "allow"`
					// with no `updatedPermissions`, so "Always Allow" silently
					// fails to persist for tools whose input varies per call
					// (e.g. AskUserQuestion with different `questions` payloads).
					// A bare `{ toolName }` rule matches any input.
					perms = [{
						type: "addRules",
						rules: [{ toolName }],
						behavior: "allow",
						destination: "localSettings",
					}];
					notifyLabel = toolName;
				}
				// Notify with the resolved pattern (label already previewed it)
				if (notifyLabel) {
					ui.notify(`Saved: ${notifyLabel}`, "info");
				}
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
					...(perms ? { updatedPermissions: perms } : {}),
				};
			}

			if (choice === "Allow") {
				return {
					behavior: "allow",
					updatedInput: _input,
					toolUseID: options.toolUseID,
				};
			}

			return { behavior: "deny", message: "User denied", toolUseID: options.toolUseID };
		} catch {
			return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
		}
	};
}

// ---------------------------------------------------------------------------
// Elicitation handler
// ---------------------------------------------------------------------------

/**
 * Create an SDK elicitation handler that routes requests through the extension UI dialogs, or undefined if no UI is available.
 *
 * For structured (AskUserQuestion) elicitations, the interview round's result
 * disambiguates two cases that must not be conflated: an `undefined` result
 * means the custom UI is unavailable, so we fall back to the simpler `select`
 * dialogs; an empty-answers result means the user dismissed the question, which
 * is treated as a clean cancel. Falling back to dialogs on dismissal would
 * re-ask the same questions (the duplicate-question bug).
 */
/**
 * Monotonic counter so concurrent/sequential elicitations resolved within the
 * same millisecond get distinct synthetic in-flight-tool ids (the `cc-elicit-*`
 * namespace never collides with real MCP toolCallIds).
 */
let _elicitationSeq = 0;
function nextElicitationSeq(): number {
	_elicitationSeq = (_elicitationSeq + 1) % Number.MAX_SAFE_INTEGER;
	return _elicitationSeq;
}

export function createClaudeCodeElicitationHandler(
	ui: ExtensionUIContext | undefined,
): ((request: SdkElicitationRequest, options: { signal: AbortSignal }) => Promise<SdkElicitationResult>) | undefined {
	if (!ui) return undefined;

	return async (request, { signal }) => {
		if (request.mode === "url") {
			return { action: "decline" };
		}

		const questions = parseAskUserQuestionsElicitation(request);
		if (questions) {
			const headlessAnswer = answerElicitationFromHeadlessAnswers(questions, loadHeadlessAnswers());
			if (headlessAnswer) return headlessAnswer;

			// The SDK elicitation blocks waiting for human input, but it is not an
			// MCP tool dispatch, so markToolStart/markToolEnd are never called for
			// it. Without this the soft/context/idle/hard watchdogs see zero
			// in-flight tools and re-dispatch (and ultimately abort) the agent
			// turn hosting this elicitation, tearing the question down (#2676 /
			// claude-code-cli self-cancel loop). Bracketing the human wait with
			// the s.active-gated interactive-tool guard makes it visible to
			// hasInteractiveToolInFlight()/getInFlightToolCount() so those
			// watchdogs exempt it. No-op outside auto-mode (wrapper self-gates).
			//
			// markInteractiveElicitationStart/End is a SEPARATE, ungated signal that
			// is observable in FOREGROUND (where the s.active-gated markToolStart is a
			// no-op). The foreground approval-gate pause path (register-hooks
			// message_update) consults isInteractiveElicitationInFlight() and bails so
			// it does not tear down the very elicitation that IS the human boundary
			// (#cc-elicitation-self-cancel). It clears in the finally on every exit.
			const elicId = "cc-elicit-" + ((request as { id?: string | number }).id ?? `${Date.now()}-${nextElicitationSeq()}`);
			const formAbortController = new AbortController();
			let expiryNoticeShown = false;
			const abortExpiredForm = (): void => {
				if (formAbortController.signal.aborted) return;
				formAbortController.abort();
				if (!expiryNoticeShown) {
					expiryNoticeShown = true;
					ui.notify(ELICITATION_EXPIRED_NOTICE, "warning");
				}
			};
			const forwardSdkAbort = (): void => {
				if (!formAbortController.signal.aborted) formAbortController.abort();
			};
			if (signal.aborted) {
				forwardSdkAbort();
			} else {
				signal.addEventListener("abort", forwardSdkAbort, { once: true });
			}
			const expiryTimer = setTimeout(abortExpiredForm, CLAUDE_CODE_INTERVIEW_FORM_TIMEOUT_MS);
			markInteractiveElicitationStart();
			markToolStart(elicId, "ask_user_questions");
			activeAskUserQuestionElicitationTimeoutAborters.add(abortExpiredForm);
			try {
				const interviewResult = await showInterviewRound(
					questions,
					{ signal: formAbortController.signal, overlay: true },
					{ ui } as any,
				).catch(() => undefined);
				if (interviewResult === undefined) {
					// `await` so the dialog human-wait stays inside try/finally and the
					// in-flight guard is held until the dialog resolves. Without it,
					// `finally` runs the moment the promise is created and the fallback
					// wait runs with zero in-flight tools — reintroducing the
					// self-cancel on this path (Bugbot #1c00624d).
					return await promptElicitationWithDialogs(request, questions, ui, formAbortController.signal);
				}
				if (Object.keys(interviewResult.answers).length === 0) {
					// A system/host teardown (compaction, session_switch, true
					// interrupt) that aborted the signal mid-wait sets `interrupted`.
					// Surface that as a non-affirmative `decline` so it is not
					// laundered into a clean user-declined `cancel` the model re-asks
					// against. A genuine user dismissal leaves `interrupted` falsy and
					// keeps the prior `cancel` semantics.
					return interviewResult.interrupted ? { action: "decline" } : { action: "cancel" };
				}
				return {
					action: "accept",
					content: roundResultToElicitationContent(questions, interviewResult),
				};
			} finally {
				clearTimeout(expiryTimer);
				signal.removeEventListener("abort", forwardSdkAbort);
				activeAskUserQuestionElicitationTimeoutAborters.delete(abortExpiredForm);
				markToolEnd(elicId);
				markInteractiveElicitationEnd();
			}
		}

		const textFields = parseTextInputElicitation(request);
		if (textFields) {
			const elicId = "cc-elicit-" + ((request as { id?: string | number }).id ?? `${Date.now()}-${nextElicitationSeq()}`);
			markToolStart(elicId, "secure_env_collect");
			try {
				return await promptTextInputElicitation(request, textFields, ui, signal);
			} finally {
				markToolEnd(elicId);
			}
		}

		return { action: "decline" };
	};
}

/**
 * Aborted by the caller's AbortSignal — distinct from exhaustion. GSD's
 * agent loop keys off `stopReason === "aborted"` to treat this as a clean
 * user cancel instead of a retry-eligible provider failure.
 */
export function makeAbortedMessage(model: string, lastTextContent: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: lastTextContent
			? [{ type: "text", text: lastTextContent }]
			: [{ type: "text", text: "Claude Code stream aborted by caller" }],
		api: "anthropic-messages",
		provider: "claude-code",
		model,
		usage: { ...ZERO_USAGE },
		stopReason: "aborted",
		timestamp: Date.now(),
	};
	return message;
}

// ---------------------------------------------------------------------------
// SDK options builder
// ---------------------------------------------------------------------------

/**
 * Resolve the Claude Code permission mode for the current run.
 *
 * Defaults to `acceptEdits`, which auto-approves file reads/edits but
 * surfaces a permission dialog for dangerous operations (e.g. general Bash,
 * Agent, WebFetch). This prevents tools outside the allowlist from being
 * silently denied — the SDK emits an `extension_ui_request` event so the
 * user sees a prompt instead of a silent refusal that Claude Code mistakes
 * for user rejection (#4383).
 *
 * Set `GSD_CLAUDE_CODE_PERMISSION_MODE` to `bypassPermissions` to restore
 * the old always-approve behaviour, or to `default` / `plan` for stricter
 * modes.
 *
 * When `GSD_HEADLESS=1` is set (auto-mode / non-interactive runs), the
 * default flips to `bypassPermissions` because there is no UI to approve
 * permission dialogs — `acceptEdits` would hang verification commands like
 * `npx tsc --noEmit` or `npx vitest run` indefinitely (#4657). Explicit
 * overrides still win, so users can opt back into `acceptEdits` in headless.
 */
export async function resolveClaudePermissionMode(
	env: NodeJS.ProcessEnv = process.env,
): Promise<"bypassPermissions" | "acceptEdits" | "default" | "plan"> {
	const override = env.GSD_CLAUDE_CODE_PERMISSION_MODE?.trim();
	if (override === "bypassPermissions" || override === "acceptEdits" || override === "default" || override === "plan") {
		return override;
	}
	if (env.GSD_HEADLESS === "1") {
		console.warn(
			"[claude-code-cli] Headless mode detected (GSD_HEADLESS=1): defaulting permissionMode to 'bypassPermissions' so verification Bash commands can run. Set GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits to opt out.",
		);
		return "bypassPermissions";
	}
	return "bypassPermissions";
}

// NOTE: These helpers intentionally mirror @gsd/pi-ai anthropic-shared
// behavior so this extension remains typecheck-stable even when the published
// @gsd/pi-ai barrel lags behind monorepo source exports.
/** Return true for model IDs that support the adaptive thinking API (Opus 4.6/4.7/4.8/5, Fable 5, Sonnet 4.6/4.7, Haiku 4.5). */
function modelSupportsAdaptiveThinking(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6")
		|| modelId.includes("opus-4.6")
		|| modelId.includes("opus-4-7")
		|| modelId.includes("opus-4.7")
		|| modelId.includes("opus-4-8")
		|| modelId.includes("opus-4.8")
		|| modelId.includes("opus-5")
		|| modelId.includes("opus.5")
		|| modelId.includes("fable-5")
		|| modelId.includes("fable.5")
		|| modelId.includes("sonnet-4-6")
		|| modelId.includes("sonnet-4.6")
		|| modelId.includes("sonnet-4-7")
		|| modelId.includes("sonnet-4.7")
		|| modelId.includes("haiku-4-5")
		|| modelId.includes("haiku-4.5")
	);
}

/** Map a GSD thinking level to the Anthropic effort value, clamping xhigh to max for models that lack native xhigh support. */
function mapThinkingLevelToAnthropicEffort(level: ThinkingLevel | undefined, modelId: string): "low" | "medium" | "high" | "xhigh" | "max" {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			if (
				modelId.includes("opus-4-7")
				|| modelId.includes("opus-4.7")
				|| modelId.includes("opus-4-8")
				|| modelId.includes("opus-4.8")
				|| modelId.includes("opus-5")
				|| modelId.includes("opus.5")
				|| modelId.includes("fable-5")
				|| modelId.includes("fable.5")
			) return "xhigh";
			if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
			return "high";
		default:
			return "high";
	}
}

function parseAllowedMcpToolName(toolName: string): { server: string; tool: string } | undefined {
	const match = /^mcp__(.+)__(\*|[^*]+)$/.exec(toolName);
	return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : undefined;
}

function browserMcpServerNameFromAllowedTools(allowedTools: unknown): string | undefined {
	if (!Array.isArray(allowedTools)) return undefined;
	for (const toolName of allowedTools) {
		if (typeof toolName !== "string") continue;
		const parsed = parseAllowedMcpToolName(toolName);
		if (!parsed) continue;
		if (parsed.server === "gsd-browser" || hasBrowserContractPrefix(parsed.tool)) {
			return parsed.server;
		}
	}
	return undefined;
}

function workflowMcpServerNameFromAllowedTools(allowedTools: unknown): string | undefined {
	if (!Array.isArray(allowedTools)) return undefined;
	const browserServerName = browserMcpServerNameFromAllowedTools(allowedTools);
	for (const toolName of allowedTools) {
		if (typeof toolName !== "string") continue;
		const parsed = parseAllowedMcpToolName(toolName);
		if (!parsed || parsed.server === browserServerName || hasBrowserContractPrefix(parsed.tool)) continue;
		return parsed.server;
	}
	return undefined;
}

function workflowQuestionToolAvailableFromAllowedTools(
	allowedTools: unknown,
	workflowMcpServerName: string | undefined,
	gsdPhase: string | undefined,
): boolean | undefined {
	if (!workflowMcpServerName || !gsdPhase) return undefined;
	return Array.isArray(allowedTools)
		&& allowedTools.includes(`mcp__${workflowMcpServerName}__ask_user_questions`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function resolveWorkflowMcpPreflightServerConfig(
	mcpServers: unknown,
	workflowServerName: string | undefined,
): Record<string, unknown> | undefined {
	if (!workflowServerName || !isRecord(mcpServers)) return undefined;
	const workflowServerConfig = mcpServers[workflowServerName];
	return isRecord(workflowServerConfig) ? workflowServerConfig : undefined;
}

function cloneSdkMcpServerConfig(config: unknown): Record<string, unknown> | undefined {
	if (!isRecord(config)) return undefined;
	const cloned: Record<string, unknown> = {};
	for (const key of ["type", "command", "cwd", "url"] as const) {
		if (typeof config[key] === "string") cloned[key] = config[key];
	}
	if (Array.isArray(config.args)) {
		cloned.args = config.args.filter((arg): arg is string => typeof arg === "string");
	}
	if (isStringRecord(config.env)) cloned.env = { ...config.env };
	if (isStringRecord(config.headers)) cloned.headers = { ...config.headers };
	if (isRecord(config.oauth)) cloned.oauth = { ...config.oauth };
	return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function resolveProjectMcpServerConfig(
	projectRoot: string,
	serverName: string | undefined,
	fallbackServers?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!serverName) return undefined;
	const projectServer = discoverMcpServers(projectRoot).find((server) => server.name === serverName);
	return cloneSdkMcpServerConfig(projectServer?.config) ?? cloneSdkMcpServerConfig(fallbackServers?.[serverName]);
}

function resolveProjectMcpServerConfigs(
	projectRoot: string,
	serverNames: readonly (string | undefined)[],
	fallbackServers?: Record<string, unknown>,
): Record<string, Record<string, unknown>> | undefined {
	const resolved: Record<string, Record<string, unknown>> = {};
	for (const serverName of serverNames) {
		const serverConfig = resolveProjectMcpServerConfig(projectRoot, serverName, fallbackServers);
		if (serverName && serverConfig) resolved[serverName] = serverConfig;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveExactWorkflowMcpToolsForPhase(
	gsdPhase: string | undefined,
	workflowServerName: string | undefined,
	workflowExplicitlyBlocked: boolean,
): string[] {
	if (!gsdPhase || !workflowServerName || workflowExplicitlyBlocked) return [];
	const requestedTools = gsdPhase === "run-uat"
		? [...RUN_UAT_WORKFLOW_TOOL_NAMES]
		: [
				...(getUnitToolSurfaceContract(gsdPhase)?.allowedGsdTools ?? []),
				...getRequiredWorkflowToolsForAutoUnit(gsdPhase),
			];
	const requestedToolNames = [...new Set(
		requestedTools.filter((toolName) => toolName.startsWith("gsd_") || toolName === "ask_user_questions"),
	)];
	if (requestedToolNames.length === 0) return [];
	return resolveToolPresentationPlan({
		phase: gsdPhase,
		surface: "claude-code-sdk",
		workflowMcpServerName: workflowServerName,
		requestedToolNames,
	}).presentedToolNames;
}

function resolveClaudeNativeToolsForPhase(gsdPhase: string | undefined): string[] {
	const standardClaudeTools = [
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Bash",
		"Agent",
		"WebFetch",
		"WebSearch",
	];
	if (!gsdPhase) return standardClaudeTools;
	if (gsdPhase === "run-uat" || gsdPhase === "complete-slice") {
		return [...RUN_UAT_CLAUDE_NATIVE_TOOL_NAMES];
	}
	return standardClaudeTools;
}

export function autoInitClaudeCodeWorkflowMcp(cwd: string): void {
	const projectRoot = resolveWorkflowMcpProjectRoot(cwd);
	try {
		ensureProjectWorkflowMcpConfig(projectRoot);
	} catch (err) {
		if (process.env.GSD_DEBUG === "1") {
			console.warn(
				`[claude-code] workflow MCP auto-init failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

export function resolveClaudeCodeToolSurfaceReadinessError(input: {
	unitType: string | undefined;
	workflowServerName: string | undefined;
	observation: LiveToolSurfaceObservation;
	projectRoot?: string | undefined;
	allowPendingToolSearchHydration?: boolean | undefined;
}): Promise<string | null> {
	const error = getToolSurfaceReadinessError(input);
	if (
		error
		&& input.allowPendingToolSearchHydration
		&& input.workflowServerName
		&& input.observation.mcpServers.some(
			(server) => server.name === input.workflowServerName && server.status === "pending",
		)
	) {
		return Promise.resolve(null);
	}
	return Promise.resolve(error);
}

export { awaitWorkflowMcpToolRegistration } from "../gsd/tool-surface-readiness.js";

const TOOL_SURFACE_READINESS_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000] as const;

export function shouldRetryClaudeCodeToolSurfaceReadiness(error: string | null): boolean {
	if (!error) return false;
	return error.includes(TOOL_SURFACE_NOT_READY) && !/\bterminal\b/i.test(error);
}

export function resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(
	error: string | null,
	attempt: number,
	preflightVerified = false,
): number | null {
	if (!shouldRetryClaudeCodeToolSurfaceReadiness(error)) return null;
	const delays = preflightVerified
		? POST_PREFLIGHT_READINESS_RETRY_DELAYS_MS
		: TOOL_SURFACE_READINESS_RETRY_DELAYS_MS;
	return delays[attempt] ?? null;
}

function makeAbortError(): Error {
	const error = new Error("AbortError: The operation was aborted");
	error.name = "AbortError";
	return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(makeAbortError());

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(makeAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** CLI print-mode drain kills leftover background Agent tasks after this many ms. */
export const CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";
/** `0` waits indefinitely. Operators override by setting the env var. */
const DEFAULT_CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0";
const CLAUDE_CODE_PRINT_WIND_DOWN_RE =
	/Background tasks still running after|print wind-down|CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS/i;

/** `"0"` disables the CLI's 600s post-result background-task kill. */
function withClaudeCodePrintBgWaitCeiling(
	sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...sourceEnv };
	if (!env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV]?.trim()) {
		env[CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS_ENV] = DEFAULT_CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
	}
	return env;
}

/** Surface print wind-down / termination lines the SDK otherwise discards. */
function logClaudeCodeSdkStderr(data: unknown): void {
	const text = String(data);
	if (!CLAUDE_CODE_PRINT_WIND_DOWN_RE.test(text)) return;
	console.warn(`[claude-code] ${text.trimEnd()}`);
}

/**
 * Build the options object passed to the Claude Agent SDK's `query()` call.
 *
 * Extracted for testability — callers can verify session persistence,
 * beta flags, and other configuration without mocking the full SDK.
 *
 * `permissionMode` / `allowDangerouslySkipPermissions` are resolved through
 * {@link resolveClaudePermissionMode} so interactive runs don't silently
 * bypass the SDK's permission gate. Callers that want the old always-bypass
 * behaviour pass `permissionMode: "bypassPermissions"` explicitly.
 *
 * Long-lived sessions default `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` to `"0"`
 * unless already set, and attach an stderr sink for print wind-down warnings.
 */
export function buildSdkOptions(
	modelId: string,
	prompt: string,
	overrides?: { permissionMode?: "bypassPermissions" | "acceptEdits" | "default" | "plan" },
	extraOptions: Record<string, unknown> & { reasoning?: ThinkingLevel; gsdPhase?: string } = {},
): Record<string, unknown> {
	const { reasoning, cwd, gsdPhase, env: extraEnv, stderr: extraStderr, ...sdkExtraOptions } = extraOptions;
	const sdkCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : process.cwd();
	// Claude Code runs in the milestone worktree for file/shell work, but workflow MCP
	// config (.mcp.json) and server discovery live at the project root.
	const projectRoot = resolveWorkflowMcpProjectRoot(sdkCwd);
	const defaultMcpServers: {
		servers: Record<string, unknown>;
		workflowServerName: string | undefined;
		browserServerName: string | undefined;
	} = (() => {
		try {
			return buildProjectGsdMcpServers(projectRoot);
		} catch {
			const workflowServers = buildWorkflowMcpServers(projectRoot) ?? {};
			const workflowServerName = Object.keys(workflowServers)[0];
			return { servers: workflowServers, workflowServerName, browserServerName: undefined };
		}
	})();
	const permissionMode = overrides?.permissionMode ?? "bypassPermissions";

	const preferences = loadProjectGSDPreferences(projectRoot);
	const mcpConfig = preferences?.preferences.claude_code_mcp;

	// Always discover project MCPs — needed for both duplicate detection and filtering.
	const discovered = discoverMcpServerNames(projectRoot);
	const injectedWorkflowServerName = defaultMcpServers.workflowServerName;
	const injectedBrowserServerName = defaultMcpServers.browserServerName;
	const projectWorkflowServerName = discoverWorkflowMcpServerName(projectRoot);
	const projectBrowserServerName = discoverBrowserMcpServerName(projectRoot);
	const workflowServerName = projectWorkflowServerName ?? injectedWorkflowServerName;
	const browserServerName = projectBrowserServerName ?? injectedBrowserServerName;

	// Non-strict (non-phase) sessions load ~/.claude/settings.json via settingSources
	// including "user". If the user declared the same server names there, injecting them
	// again via mcpServers causes duplicate registration and leaves MCP tools unavailable.
	// Strict (gsdPhase) sessions set settingSources=[] so user settings are not loaded.
	const userDiscovered = !gsdPhase ? discoverUserMcpServerNames() : [];
	const allDiscovered = discovered.length > 0 || userDiscovered.length > 0
		? [...discovered, ...userDiscovered]
		: discovered;

	// If a default GSD MCP server is already declared in project config or in the user's
	// ~/.claude/settings.json (when that file will be loaded), do not inject it again via
	// mcpServers. Passing the same server name from two sources causes a duplicate
	// registration conflict that prevents the MCP server from loading (tools become unavailable).
	const workflowAlreadyInProject = projectWorkflowServerName !== undefined
		|| (injectedWorkflowServerName !== undefined && allDiscovered.includes(injectedWorkflowServerName));
	const browserAlreadyInProject = projectBrowserServerName !== undefined
		|| (injectedBrowserServerName !== undefined && allDiscovered.includes(injectedBrowserServerName));
	const mcpServersToInject = { ...defaultMcpServers.servers };
	if (workflowAlreadyInProject && injectedWorkflowServerName) delete mcpServersToInject[injectedWorkflowServerName];
	if (browserAlreadyInProject && injectedBrowserServerName) delete mcpServersToInject[injectedBrowserServerName];
	let filteredMcpServers: Record<string, unknown> | undefined =
		Object.keys(mcpServersToInject).length > 0 ? mcpServersToInject : undefined;
	let extraDisallowedTools: string[] = [];
	let workflowExplicitlyBlocked = false;
	let browserExplicitlyBlocked = false;

	if (mcpConfig) {
		const filterServerNames = [
			...discovered,
			...(workflowServerName ? [workflowServerName] : []),
			...(browserServerName ? [browserServerName] : []),
		];
		extraDisallowedTools = computeMcpDisallowedTools(modelId, mcpConfig, filterServerNames, workflowServerName);
		if (workflowServerName && extraDisallowedTools.includes(`mcp__${workflowServerName}__*`)) {
			workflowExplicitlyBlocked = true;
		}
		if (browserServerName && extraDisallowedTools.includes(`mcp__${browserServerName}__*`)) {
			browserExplicitlyBlocked = true;
		}
		if (filteredMcpServers) {
			for (const blockedPattern of extraDisallowedTools) {
				const match = /^mcp__(.+)__\*$/.exec(blockedPattern);
				if (match?.[1]) delete filteredMcpServers[match[1]];
			}
			if (Object.keys(filteredMcpServers).length === 0) filteredMcpServers = undefined;
		}
	}

	// Globally unblock the tools GSD expects Claude Code to run. When the
	// workflow MCP server is available, prefer its `ask_user_questions` tool over
	// Claude Code's native `AskUserQuestion`; the MCP path carries stable IDs and
	// routes responses through the GSD elicitation bridge.
	// Opt back into gated mode with GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits.
	// Include GSD-managed MCP patterns in allowedTools whether the server is
	// injected or declared in project config, but not if blocked by user prefs.
	const workflowMcpTools = !workflowExplicitlyBlocked && workflowServerName
		? [`mcp__${workflowServerName}__*`]
		: [];
	const browserMcpTools = !browserExplicitlyBlocked && browserServerName
		? [`mcp__${browserServerName}__*`]
		: [];
	const phaseUsesBrowserMcp = !gsdPhase || gsdPhase === "run-uat";
	const allowedBrowserMcpTools = phaseUsesBrowserMcp ? browserMcpTools : [];
	const inlinePhaseMcpServers = gsdPhase
		? resolveProjectMcpServerConfigs(
				projectRoot,
				[
					workflowExplicitlyBlocked ? undefined : workflowServerName,
					phaseUsesBrowserMcp && !browserExplicitlyBlocked ? browserServerName : undefined,
				],
				defaultMcpServers.servers,
			)
		: undefined;
	const sdkMcpServers = inlinePhaseMcpServers ?? filteredMcpServers;
	const strictMcpConfig = !!inlinePhaseMcpServers;
	// Strict phase configs inline the exact MCP servers GSD needs. Loading
	// Claude Code settings at the same time can duplicate those servers and
	// leave allowed mcp__... tools with no registered backing tool.
	const settingSources = strictMcpConfig ? [] : ["user", "project", "local"];
	const exactWorkflowMcpTools = resolveExactWorkflowMcpToolsForPhase(
		gsdPhase,
		workflowServerName,
		workflowExplicitlyBlocked,
	);
	const questionToolSurface = resolveWorkflowQuestionToolSurface({
		workflowServerName,
		workflowExplicitlyBlocked,
		workflowMcpTools,
		exactWorkflowMcpTools,
		env: process.env,
	});
	const runUatDisallowedTools = gsdPhase === "run-uat" && workflowServerName
		? [
				...RUN_UAT_FORBIDDEN_TOOL_NAMES.filter((toolName) => !toolName.startsWith("mcp__")),
				"WebFetch",
				"Agent",
				`mcp__${workflowServerName}__gsd_exec`,
				`mcp__${workflowServerName}__gsd_summary_save`,
				`mcp__${workflowServerName}__gsd_save_gate_result`,
			]
		: [];
	const allowToolSearchForWorkflowMcp = workflowMcpTools.length > 0 || exactWorkflowMcpTools.length > 0;
	const disallowedTools: string[] = [...new Set([
		...(allowToolSearchForWorkflowMcp ? [] : ["ToolSearch"]),
		...(gsdPhase ? ["Skill"] : []),
		...(workflowMcpTools.length > 0 || exactWorkflowMcpTools.length > 0 ? ["AskUserQuestion"] : []),
		...questionToolSurface.disallowedTools,
		...runUatDisallowedTools,
		...extraDisallowedTools,
	])];
	const nativeTools = resolveClaudeNativeToolsForPhase(gsdPhase);
	const allowedTools = gsdPhase === "run-uat"
		? [
				...nativeTools,
				...(exactWorkflowMcpTools.length > 0 ? exactWorkflowMcpTools : []),
				...allowedBrowserMcpTools,
			]
		: [
				...nativeTools,
				...exactWorkflowMcpTools,
				...(!gsdPhase && workflowMcpTools.length > 0 ? workflowMcpTools : []),
				...(workflowMcpTools.length === 0 && exactWorkflowMcpTools.length === 0 ? ["AskUserQuestion"] : []),
				...allowedBrowserMcpTools,
			];
	const supportsAdaptive = modelSupportsAdaptiveThinking(modelId);
	const effort =
		reasoning && supportsAdaptive
			? mapThinkingLevelToAnthropicEffort(reasoning, modelId)
			: undefined;

	// Bug B: SDK requires thinking:{type:"adaptive"} alongside effort for adaptive thinking to activate.
	// Bug C: SDK requires thinking:{type:"disabled"} to actually stop adaptive thinking when reasoning is off;
	//        omitting the field leaves the SDK in its adaptive default (or persisted session state).
	const thinkingConfig = supportsAdaptive
		? effort
			? { thinking: { type: "adaptive" } }
			: { thinking: { type: "disabled" } }
		: undefined;

	return {
		pathToClaudeCodeExecutable: getClaudePath(),
		model: modelId,
		includePartialMessages: true,
		persistSession: true,
		cwd: sdkCwd,
		permissionMode,
		allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
		settingSources,
		systemPrompt: { type: "preset", preset: "claude_code" },
		disallowedTools,
		...(allowedTools.length > 0 ? { allowedTools } : {}),
		...(sdkMcpServers ? { mcpServers: sdkMcpServers } : {}),
		...(strictMcpConfig ? { strictMcpConfig: true } : {}),
		betas: (
			modelId.includes("sonnet")
			|| modelId.includes("opus-4-7")
			|| modelId.includes("opus-4.7")
			|| modelId.includes("opus-4-8")
			|| modelId.includes("opus-4.8")
			|| modelId.includes("fable-5")
			|| modelId.includes("fable.5")
		) ? ["context-1m-2025-08-07"] : [],
		...(thinkingConfig ?? {}),
		...(effort ? { effort } : {}),
		...sdkExtraOptions,
		env: withClaudeCodePrintBgWaitCeiling(
			isRecord(extraEnv) ? { ...process.env, ...extraEnv as NodeJS.ProcessEnv } : process.env,
		),
		stderr: typeof extraStderr === "function" ? extraStderr : logClaudeCodeSdkStderr,
	};
}

// ---------------------------------------------------------------------------
// streamSimple implementation
// ---------------------------------------------------------------------------

let capturedClaudeCodeUIContext: ExtensionUIContext | undefined;

/**
 * Capture the active extension UI context from `before_provider_request`. Core
 * invokes `streamSimple` with a plain `SimpleStreamOptions` (no
 * `extensionUIContext`), so without this the elicitation handler is never wired
 * and `ask_user_questions` immediately returns cancelled. See index.ts, which
 * registers the hook that calls this.
 */
export function setClaudeCodeUIContext(ui: ExtensionUIContext | undefined): void {
	capturedClaudeCodeUIContext = ui;
}

/**
 * GSD streamSimple function that delegates to the Claude Agent SDK.
 *
 * Emits AssistantMessageEvent deltas for real-time TUI rendering
 * (thinking, text, tool calls). The final AssistantMessage preserves
 * SDK-executed tool-call blocks for Agent Core's `externalToolExecution`
 * path, which renders the results without dispatching the tools locally.
 */
export function streamViaClaudeCode(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantStream();

	void pumpSdkMessages(model, context, options, stream);

	return stream;
}

interface SdkAttemptMessageState {
	builder: PartialMessageBuilder | null;
	intermediateToolBlocks: AssistantMessage["content"];
	intermediateTextBlocks: AssistantMessage["content"];
	toolResultsById: Map<string, ExternalToolResultPayload>;
	toolCompletionTargetsById: Map<string, { partial: AssistantMessage; contentIndex: number }>;
	emittedExternalToolResultIds: Set<string>;
}

function createSdkAttemptMessageState(): SdkAttemptMessageState {
	return {
		builder: null,
		intermediateToolBlocks: [],
		intermediateTextBlocks: [],
		toolResultsById: new Map<string, ExternalToolResultPayload>(),
		toolCompletionTargetsById: new Map<string, { partial: AssistantMessage; contentIndex: number }>(),
		emittedExternalToolResultIds: new Set<string>(),
	};
}

function beginClaudeCodeMilestoneStatusObservation(
	projectRoot: string,
): string | null {
	let contextError: "unavailable" | undefined;
	let guidedActive = false;
	let uok: ReturnType<typeof resolveUokFlags> | undefined;
	try {
		const guided = getGuidedUnitContext(projectRoot) ?? getGuidedUnitContext();
		guidedActive = Boolean(
			guided && resolveWorkflowMcpProjectRoot(guided.basePath) === projectRoot,
		);
		const preferences = loadEffectiveGSDPreferences(projectRoot)?.preferences;
		uok = resolveUokFlags(preferences);
	} catch {
		contextError = "unavailable";
	}
	const autoActive = autoSession.active && [autoSession.originalBasePath, autoSession.basePath]
		.some((candidate) => candidate && resolveWorkflowMcpProjectRoot(candidate) === projectRoot);

	return beginMilestoneStatusObservationTurn(projectRoot, {
		mode: classifyMilestoneStatusRuntimeMode({
			autoActive,
			activeEngineId: autoActive ? autoSession.activeEngineId : null,
			uokEnabled: uok?.enabled,
			uokLegacyFallback: uok?.legacyFallback,
			guidedActive,
		}),
		sourceRevision: MILESTONE_STATUS_OBSERVATION_PENDING_SOURCE_REVISION,
		...(autoActive && autoSession.currentTraceId ? { traceId: autoSession.currentTraceId } : {}),
		...(autoActive && autoSession.currentTurnId ? { turnId: autoSession.currentTurnId } : {}),
		...(contextError ? { contextError } : {}),
	});
}

function injectMilestoneStatusObservationToken(
	sdkOptions: Record<string, unknown>,
	workflowServerName: string | undefined,
	token: string | null,
): void {
	const childEnv = withClaudeCodePrintBgWaitCeiling(
		isRecord(sdkOptions.env) ? sdkOptions.env as NodeJS.ProcessEnv : process.env,
	);
	delete childEnv[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
	if (token) childEnv[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = token;
	sdkOptions.env = childEnv;

	if (!workflowServerName || !isRecord(sdkOptions.mcpServers)) return;
	const workflowServer = sdkOptions.mcpServers[workflowServerName];
	if (!isRecord(workflowServer) || typeof workflowServer.command !== "string") return;
	const serverEnv = { ...(isStringRecord(workflowServer.env) ? workflowServer.env : {}) };
	delete serverEnv[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV];
	if (token) serverEnv[MILESTONE_STATUS_OBSERVATION_TOKEN_ENV] = token;
	sdkOptions.mcpServers = {
		...sdkOptions.mcpServers,
		[workflowServerName]: {
			...workflowServer,
			env: serverEnv,
		},
	};
}

/** Async pump that drives the Claude Agent SDK's async-iterable message stream and pushes events into `stream`. */
async function pumpSdkMessages(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const modelId = model.id;
	/** Track the last text content seen across all assistant turns for the final message. */
	let lastTextContent = "";
	let lastThinkingContent = "";
	let milestoneStatusObservationRoot: string | undefined;
	let milestoneStatusObservationToken: string | null = null;
	const clearMilestoneStatusObservation = (): void => {
		if (!milestoneStatusObservationRoot || !milestoneStatusObservationToken) return;
		const cleared = clearMilestoneStatusObservationTurn(
			milestoneStatusObservationRoot,
			milestoneStatusObservationToken,
		);
		if (cleared) {
			milestoneStatusObservationRoot = undefined;
			milestoneStatusObservationToken = null;
		}
	};

	try {
		const permissionMode = await resolveClaudePermissionMode();
		const claudeOptions = options as ClaudeCodeStreamOptions | undefined;
		const uiContext = claudeOptions?.extensionUIContext ?? capturedClaudeCodeUIContext;
		const onExternalToolCall = claudeOptions?.onExternalToolCall;
		const onExternalToolResult = claudeOptions?.onExternalToolResult;
		const sdkQueryForTest = claudeOptions?._sdkQueryForTest;
		const query = sdkQueryForTest ?? (
			// Dynamic import — the SDK is an optional dependency.
			(await import(/* webpackIgnore: true */ "@anthropic-ai/claude-agent-sdk")) as {
				query: (args: {
					prompt: string | AsyncIterable<unknown>;
					options?: Record<string, unknown>;
				}) => AsyncIterable<SDKMessage>;
			}
		).query;
		const cwd = resolveClaudeCodeCwd(options);
		const projectRoot = resolveWorkflowMcpProjectRoot(cwd);
		autoInitClaudeCodeWorkflowMcp(cwd);
		const gsdPhase = resolveGsdPhaseForSdk(context, projectRoot);
		const canUseToolHandler = createClaudeCodeCanUseToolHandler(uiContext);
		// When no UI is available (headless / auto-mode), auto-approve all
		// tool requests. This replaces the old bypassPermissions workaround.
		const canUseToolFallback = canUseToolHandler
			?? (async (_toolName: string, _input: Record<string, unknown>, opts: CanUseToolOptions): Promise<CanUseToolPermissionResult> =>
				({ behavior: "allow", toolUseID: opts.toolUseID }));
		const sdkOpts = buildSdkOptions(
			modelId,
			"",
			{ permissionMode },
			{
				cwd,
				gsdPhase,
				reasoning: options?.reasoning,
				canUseTool: canUseToolFallback,
				...(uiContext
					? {
							onElicitation: createClaudeCodeElicitationHandler(uiContext),
						}
					: {}),
			},
		);
		const workflowMcpServerName = workflowMcpServerNameFromAllowedTools(sdkOpts.allowedTools);
		const allowedTools = Array.isArray(sdkOpts.allowedTools) ? sdkOpts.allowedTools : [];
		const milestoneStatusAvailable = workflowMcpServerName && allowedTools.some((tool) =>
			tool === `mcp__${workflowMcpServerName}__gsd_milestone_status`
			|| tool === `mcp__${workflowMcpServerName}__*`
		);
		if (milestoneStatusAvailable) {
			milestoneStatusObservationRoot = projectRoot;
			milestoneStatusObservationToken = beginClaudeCodeMilestoneStatusObservation(
				projectRoot,
			);
		}
		injectMilestoneStatusObservationToken(
			sdkOpts,
			workflowMcpServerName,
			milestoneStatusObservationToken,
		);
		const allowPendingToolSearchHydration =
			Boolean(workflowMcpServerName && gsdPhase)
			&& !(sdkOpts.disallowedTools as string[] | undefined)?.includes("ToolSearch");
		const prompt = buildPromptFromContext(context, {
			workflowMcpServerName,
			browserMcpServerName: browserMcpServerNameFromAllowedTools(sdkOpts.allowedTools),
			questionToolAvailable: workflowQuestionToolAvailableFromAllowedTools(
				sdkOpts.allowedTools,
				workflowMcpServerName,
				gsdPhase,
			),
		});
		const queryPrompt = buildSdkQueryPrompt(context, prompt);

		// Emit start with an empty partial
		const initialPartial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "claude-code",
			model: modelId,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: initialPartial });
		const findConcurrentClaudeCodeProcessesForCwd =
			claudeOptions?._findConcurrentClaudeCodeProcessesForTest
			?? (sdkQueryForTest ? undefined : findConcurrentClaudeCodeProcesses);
		if (findConcurrentClaudeCodeProcessesForCwd) {
			emitConcurrentClaudeCodeProcessWarning({
				cwd,
				stream,
				partial: initialPartial,
				uiContext,
				findProcesses: findConcurrentClaudeCodeProcessesForCwd,
			});
		}
		const readinessProgressState: WorkflowMcpReadinessProgressState = {};

		const trackWorkflowMcpSdk = Boolean(workflowMcpServerName && gsdPhase);
		if (trackWorkflowMcpSdk) beginWorkflowMcpSdkSession();
		try {
			let workflowMcpPreflightVerified = false;
			const shouldRunWorkflowMcpPreflight =
				workflowMcpServerName && gsdPhase && !claudeOptions?._skipWorkflowMcpPreflightForTest;
			if (shouldRunWorkflowMcpPreflight) {
				try {
					const progressMessage = buildWorkflowMcpReadinessProgressMessage({
						unitType: gsdPhase,
						workflowServerName: workflowMcpServerName,
						stage: "preflight",
					});
					pushWorkflowMcpReadinessProgressEvent({
						stream,
						partial: initialPartial,
						state: readinessProgressState,
						message: progressMessage,
					});
					uiContext?.setStatus?.("gsd-step", progressMessage);
					const preflightError = await awaitWorkflowMcpToolRegistration({
						unitType: gsdPhase,
						workflowServerName: workflowMcpServerName,
						projectRoot,
						workflowServerConfig: resolveWorkflowMcpPreflightServerConfig(
							sdkOpts.mcpServers,
							workflowMcpServerName,
						),
						signal: options?.signal,
					});
					if (preflightError) {
						clearMilestoneStatusObservation();
						stream.push({
							type: "error",
							reason: "error",
							error: makeErrorMessage(modelId, preflightError),
						});
						return;
					}
					workflowMcpPreflightVerified = true;
				} finally {
					uiContext?.setStatus?.("gsd-step", "");
				}
				if (workflowMcpPreflightVerified) {
					await delay(POST_PREFLIGHT_SDK_SETTLE_MS, options?.signal);
				}
			}

			sdkAttemptLoop:
			for (let readinessAttempt = 0; ; readinessAttempt++) {
				let {
					builder,
					intermediateToolBlocks,
					intermediateTextBlocks,
					toolResultsById,
					toolCompletionTargetsById,
					emittedExternalToolResultIds,
				} = createSdkAttemptMessageState();
				const controller = new AbortController();
				const forwardAbort = (): void => controller.abort();
				if (options?.signal) {
					options.signal.addEventListener("abort", forwardAbort, { once: true });
				}

				const queryResult = query({
					prompt: queryPrompt,
					options: {
						...sdkOpts,
						abortController: controller,
					},
				});

				try {
					for await (const msg of queryResult as AsyncIterable<SDKMessage>) {
					if (options?.signal?.aborted) {
						// User-initiated cancel — emit an aborted error so the agent
						// loop classifies this as a deliberate stop, not a transient
						// provider failure that should be retried.
						clearMilestoneStatusObservation();
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeAbortedMessage(modelId, lastTextContent),
						});
						return;
					}

					switch (msg.type) {
						// -- Init --
						case "system": {
							// Tool Surface Readiness gate: the init message is the first (and
							// only) point where the session reports its live tool surface and
							// MCP server statuses. If the workflow server failed or has not
							// registered this Unit's required tools, abort before the first
							// model turn with a transient, recovery-classifiable error
							// (tool-unavailable → retry) instead of letting the model hit
							// "No such tool available" mid-Unit and improvise around it.
							const init = msg as unknown as {
								subtype?: string;
								tools?: string[];
								mcp_servers?: { name: string; status: string }[];
							};
							if (init.subtype === "init") {
								const readinessError = await resolveClaudeCodeToolSurfaceReadinessError({
									unitType: gsdPhase,
									workflowServerName: workflowMcpServerName,
									projectRoot,
									observation: { tools: init.tools ?? [], mcpServers: init.mcp_servers ?? [] },
									allowPendingToolSearchHydration,
								});
								if (readinessError) {
									const retryDelayMs = resolveClaudeCodeToolSurfaceReadinessRetryDelayMs(
										readinessError,
										readinessAttempt,
										workflowMcpPreflightVerified,
									);
									if (retryDelayMs !== null && !options?.signal?.aborted) {
										controller.abort();
										const progressMessage = buildWorkflowMcpReadinessProgressMessage({
											unitType: gsdPhase ?? "workflow unit",
											workflowServerName: workflowMcpServerName ?? "workflow",
											stage: "retry",
											attempt: readinessAttempt + 1,
											delayMs: retryDelayMs,
										});
										pushWorkflowMcpReadinessProgressEvent({
											stream,
											partial: initialPartial,
											state: readinessProgressState,
											message: progressMessage,
										});
										uiContext?.setStatus?.("gsd-step", progressMessage);
										await delay(retryDelayMs, options?.signal);
										uiContext?.setStatus?.("gsd-step", "");
										continue sdkAttemptLoop;
									}
									controller.abort();
									clearMilestoneStatusObservation();
									stream.push({
										type: "error",
										reason: "error",
										error: makeErrorMessage(modelId, readinessError),
									});
									return;
								}
							}
							break;
						}

						// -- Streaming partial messages --
						case "stream_event": {
							const partial = msg as SDKPartialAssistantMessage;

							const event = partial.event;

							const result = handleClaudeCodePartialStreamEvent(builder, event, modelId);
							builder = result.builder;
							const assistantEvent = result.assistantEvent;
							if (assistantEvent) {
								stream.push(assistantEvent);
								if (assistantEvent.type === "toolcall_start" && builder) {
									const toolBlock = builder.message.content[assistantEvent.contentIndex];
									if (toolBlock?.type === "toolCall") {
										try {
											await onExternalToolCall?.(toolBlock);
										} catch (error) {
											console.warn("[claude-code] onExternalToolCall callback failed:", error);
										}
									}
								}
							}
							break;
						}

						// -- Complete assistant message (non-streaming fallback) --
						case "assistant": {
							const sdkAssistant = msg as SDKAssistantMessage;

							// Capture text content from complete messages
							for (const block of sdkAssistant.message.content) {
								if (block.type === "text") {
									lastTextContent = block.text;
								} else if (block.type === "thinking") {
									lastThinkingContent = block.thinking;
								}
							}
							break;
						}

						// -- User message (synthetic tool result — signals turn boundary) --
						case "user": {
							// Capture content from the completed turn before resetting
							if (builder) {
								for (const [contentIndex, block] of builder.message.content.entries()) {
									if (block.type === "text" && block.text) {
										lastTextContent = block.text;
										// Accumulate completed prose in order — a multi-question
										// turn commits [prose][elicitation] segments across several
										// synthetic-user boundaries, and overwriting a single
										// scalar would drop every explanation but the last.
										intermediateTextBlocks.push({ type: "text", text: block.text });
									} else if (block.type === "thinking" && block.thinking) {
										lastThinkingContent = block.thinking;
										intermediateTextBlocks.push({ type: "thinking", thinking: block.thinking });
									} else if (block.type === "toolCall" || block.type === "serverToolUse") {
										// Collect tool blocks for externalToolExecution rendering
										intermediateToolBlocks.push(block);
										toolCompletionTargetsById.set(block.id, {
											partial: builder.message,
											contentIndex,
										});
									}
								}
							}

							// Extract tool results from the SDK's synthetic user message
							// and attach to corresponding tool call blocks immediately.
							for (const { toolUseId, result } of extractToolResultsFromSdkUserMessage(msg as SDKUserMessage)) {
								toolResultsById.set(toolUseId, result);
							}
							attachExternalResultsToToolBlocks(intermediateToolBlocks, toolResultsById);

							// Push a synthetic toolcall_end for each tool call from this turn
							// so the TUI can render tool results in real-time during the SDK
							// session instead of waiting until the entire session completes.
							for (const block of intermediateToolBlocks) {
								if (block.type !== "toolCall" && block.type !== "serverToolUse") continue;
								if (emittedExternalToolResultIds.has(block.id)) continue;
								const target = toolCompletionTargetsById.get(block.id);
								if (!target) continue;

								const extResult = (block as ToolCallWithExternalResult).externalResult;
								if (!extResult) continue;
								const suppressDuplicateUnavailable = shouldSuppressDuplicateToolUnavailableBlock(
									block,
									target.partial.content,
								);
								// Push synthetic completion events with result attached so the
								// chat-controller can update pending ToolExecutionComponents.
								if (block.type === "toolCall") {
									if (isAskUserQuestionsTimedOutResult(block, extResult)) {
										abortActiveAskUserQuestionElicitationsForTimeout();
									}
									if (suppressDuplicateUnavailable) {
										delete (block as ToolCallWithExternalResult).externalResult;
										stream.push({
											type: "toolcall_end",
											contentIndex: target.contentIndex,
											toolCall: block,

										});
										(block as ToolCallWithExternalResult).externalResult = extResult;
										emittedExternalToolResultIds.add(block.id);
										continue;
									}
									try {
										await onExternalToolResult?.({
											toolCall: block,
											result: extResult,
										});
									} catch (error) {
										console.warn("[claude-code] onExternalToolResult callback failed:", error);
									}
									stream.push({
										type: "toolcall_end",
										contentIndex: target.contentIndex,
										toolCall: block,

									});
									emittedExternalToolResultIds.add(block.id);
								} else if (block.type === "serverToolUse") {
									const toolCall = serverToolUseToToolCallLike(block);
									if (isAskUserQuestionsTimedOutResult(toolCall, extResult)) {
										abortActiveAskUserQuestionElicitationsForTimeout();
									}
									try {
										await onExternalToolResult?.({
											toolCall,
											result: extResult,
										});
									} catch (error) {
										console.warn("[claude-code] onExternalToolResult callback failed:", error);
									}
									stream.push({
										type: "server_tool_use",
										contentIndex: target.contentIndex,

									});
									emittedExternalToolResultIds.add(block.id);
								}
							}

							builder = null;
							break;
						}

						// -- Result (terminal) --
						case "result": {
							const result = msg as SDKResultMessage;
							const finalContent = buildFinalAssistantContent({
								intermediateToolBlocks,
								intermediateTextBlocks,
								pendingContent: builder?.message.content,
								toolResultsById,
								lastThinkingContent,
								lastTextContent,
								fallbackResultText:
									result.subtype === "success" && result.result ? result.result : undefined,
							});

							const finalMessage: AssistantMessage = {
								role: "assistant",
								content: finalContent,
								api: "anthropic-messages",
								provider: "claude-code",
								model: modelId,
								usage: mapUsage(result.usage, result.total_cost_usd),
								stopReason: result.is_error ? "error" : "stop",
								timestamp: Date.now(),
							};

							clearMilestoneStatusObservation();
							if (result.is_error) {
								finalMessage.errorMessage = getResultErrorMessage(result);
								stream.push({ type: "error", reason: "error", error: finalMessage });
							} else {
								stream.push({ type: "done", reason: "stop", message: finalMessage });
							}
							return;
						}

						default:
							break;
					}
				}
				} finally {
					options?.signal?.removeEventListener("abort", forwardAbort);
				}

				// The SDK stream ended without a terminal `result` message and
				// without a readiness retry (the only restart path, via
				// `continue sdkAttemptLoop`). Break out so the post-loop
				// exhaustion handler emits a transient stream-exhausted error,
				// instead of silently starting another SDK session and looping
				// forever.
				break sdkAttemptLoop;
			}
		} finally {
			if (trackWorkflowMcpSdk) endWorkflowMcpSdkSession();
		}

		// Generator exhaustion without a terminal result is a stream interruption,
		// not a successful completion. Emitting an error lets GSD classify it as a
		// transient provider failure instead of advancing auto-mode state.
		const fallback = makeStreamExhaustedErrorMessage(modelId, lastTextContent);
		clearMilestoneStatusObservation();
		stream.push({ type: "error", reason: "error", error: fallback });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		if (options?.signal?.aborted || isClaudeCodeAbortErrorMessage(errorMsg)) {
			const abortedText = resolveClaudeCodeAbortedMessageText(errorMsg, lastTextContent);
			clearMilestoneStatusObservation();
			stream.push({
				type: "error",
				reason: "aborted",
				error: makeAbortedMessage(modelId, abortedText),
			});
			return;
		}
		clearMilestoneStatusObservation();
		stream.push({
			type: "error",
			reason: "error",
			error: makeErrorMessage(modelId, errorMsg),
		});
	} finally {
		clearMilestoneStatusObservation();
	}
}
