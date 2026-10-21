// gsd-pi + Subagent launch contract and child process safety helpers.

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@gsd/pi-coding-agent";
import { shellEscape } from "../cmux/index.js";
import type { AgentConfig } from "./agents.js";

export const SUBAGENT_CHILD_ENV_VAR = "GSD_SUBAGENT_CHILD";
export const SUBAGENT_CHILD_ENV_VALUE = "1";
export const SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR = "GSD_RUNTIME_CONTRACT_ROOT";

export type SubagentContextMode = "fresh" | "fork";

export type SubagentSessionArgs =
	| { mode: "fresh" }
	| { mode: "fork"; sessionFile: string; sessionDir?: string };

export interface SubagentParentSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir(): string;
}

export interface SubagentLaunchInput {
	agent: AgentConfig;
	task: string;
	tmpPromptPath: string | null;
	modelOverride?: string;
	/** Reasoning effort override forwarded as `--thinking` (ADR-026 / #508). */
	thinkingOverride?: string;
	contextMode?: SubagentContextMode;
	parentSessionManager?: SubagentParentSessionManager;
	session?: SubagentSessionArgs;
	cwd?: string;
	defaultCwd: string;
	projectRoot?: string;
	projectRootSourceCwd?: string;
}

export interface SubagentLaunchPlan {
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	session: SubagentSessionArgs;
}

export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SUBAGENT_CHILD_ENV_VAR] === SUBAGENT_CHILD_ENV_VALUE;
}

export function buildSubagentProcessEnv(
	env: NodeJS.ProcessEnv = process.env,
	runtimeContractRoot?: string,
): NodeJS.ProcessEnv {
	const childEnv: NodeJS.ProcessEnv = {
		...env,
		[SUBAGENT_CHILD_ENV_VAR]: SUBAGENT_CHILD_ENV_VALUE,
	};
	if (runtimeContractRoot) childEnv[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR] = path.resolve(runtimeContractRoot);
	else delete childEnv[SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR];
	return childEnv;
}

export function buildShellEnvAssignments(env: NodeJS.ProcessEnv = process.env): string[] {
	return [SUBAGENT_CHILD_ENV_VAR, SUBAGENT_RUNTIME_CONTRACT_ROOT_ENV_VAR]
		.flatMap((name) => env[name] ? [`${name}=${shellEscape(env[name])}`] : []);
}

function isWithin(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function resolveExistingPath(candidate: string): string | undefined {
	try {
		return fs.realpathSync.native(path.resolve(candidate));
	} catch {
		return undefined;
	}
}

export function resolveSubagentProjectRoot(defaultCwd: string, sourceCwd: string): string | undefined {
	const parent = resolveExistingPath(defaultCwd);
	const source = resolveExistingPath(sourceCwd);
	if (!parent || !source) return undefined;
	return isWithin(parent, source) ? parent : source;
}

export function buildSubagentProcessArgs(
	agent: AgentConfig,
	task: string,
	tmpPromptPath: string | null,
	modelOverride?: string,
	thinkingOverride?: string,
	session: SubagentSessionArgs = { mode: "fresh" },
): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	if (session.mode === "fork") {
		args.push("--session", session.sessionFile);
		if (session.sessionDir) args.push("--session-dir", session.sessionDir);
	} else {
		args.push("--no-session");
	}
	const effectiveModel = modelOverride ?? agent.model;
	if (effectiveModel) args.push("--model", effectiveModel);
	// Reasoning effort travels with the model (ADR-026 / #508). The child CLI
	// validates `--thinking` and clamps to the resolved model at dispatch.
	const effectiveThinking = thinkingOverride ?? agent.thinking;
	if (effectiveThinking) args.push("--thinking", effectiveThinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
	args.push(`Task: ${task}`);
	return args;
}

export function resolveSubagentSessionArgs(
	contextMode: SubagentContextMode = "fresh",
	parentSessionManager?: SubagentParentSessionManager,
): SubagentSessionArgs {
	if (contextMode === "fresh") return { mode: "fresh" };

	if (!parentSessionManager) {
		throw new Error("Forked subagent context requires a parent session manager.");
	}

	const parentSessionFile = parentSessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session file; current session is in-memory.");
	}
	if (!fs.existsSync(parentSessionFile)) {
		throw new Error(`Forked subagent context could not read parent session file: ${parentSessionFile}`);
	}

	const leafId = parentSessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a parent session leaf to branch from.");
	}

	const sessionDir = parentSessionManager.getSessionDir?.();
	const parentSession = SessionManager.open(parentSessionFile, sessionDir);
	const childSessionFile = parentSession.createBranchedSession(leafId);
	if (!childSessionFile) {
		throw new Error("Forked subagent context could not create a branched child session.");
	}

	return {
		mode: "fork",
		sessionFile: childSessionFile,
		...(sessionDir ? { sessionDir: path.resolve(sessionDir) } : {}),
	};
}

export function createSubagentLaunchPlan(input: SubagentLaunchInput): SubagentLaunchPlan {
	const session = input.session ?? resolveSubagentSessionArgs(input.contextMode ?? "fresh", input.parentSessionManager);
	const requestedCwd = path.resolve(input.cwd ?? input.defaultCwd);
	const resolvedCwd = resolveExistingPath(requestedCwd);
	const cwd = resolvedCwd ?? requestedCwd;
	const defaultCwd = resolveExistingPath(input.defaultCwd);
	const candidateProjectRoot = input.projectRoot
		? resolveExistingPath(input.projectRoot)
		: defaultCwd;
	const authoritySourceCwd = resolveExistingPath(input.projectRootSourceCwd ?? requestedCwd);
	const projectRoot = resolvedCwd && candidateProjectRoot && authoritySourceCwd
		&& isWithin(candidateProjectRoot, authoritySourceCwd)
		? candidateProjectRoot
		: undefined;
	return {
		args: buildSubagentProcessArgs(
			input.agent,
			input.task,
			input.tmpPromptPath,
			input.modelOverride,
			input.thinkingOverride,
			session,
		),
		env: buildSubagentProcessEnv(process.env, projectRoot),
		cwd,
		session,
	};
}
