// gsd-pi - Legacy gsd-core skill guard for the Claude Code provider
/**
 * Interactive claude-code runs load the user's Claude settings (settingSources
 * includes "user"), so legacy gsd-core v1 skills installed under
 * `~/.claude/skills/` are announced to the model and callable. Those skills
 * operate on the separate `.planning/` world and bypass the DB-authoritative
 * workflow MCP that owns planning under gsd-pi (issue #2369).
 *
 * #1395 excluded such skills from the pi skill catalog; this module applies the
 * same ownership criterion to the claude-code Skill tool surface via a default
 * PreToolUse hook. Only skills owned by an `@opengsd/gsd-core` package root or
 * listed in its `gsd-file-manifest.json` are denied — independently authored
 * `gsd-*` skills and non-gsd skills keep working. Auto-mode runs already
 * disallow the Skill tool entirely (gsdPhase set) and never register the hook.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const GSD_CORE_PACKAGE_NAME = "@opengsd/gsd-core";
const GSD_CORE_MANIFEST_NAME = "gsd-file-manifest.json";

/**
 * Setting this env var to "0"/"false"/"off" disables the guard. It is a safety
 * hatch, not a supported configuration: legacy gsd-core skills bypass gsd-pi's
 * workflow tracking.
 */
export const CLAUDE_CODE_LEGACY_SKILL_FILTER_ENV = "GSD_CLAUDE_CODE_LEGACY_SKILL_FILTER";

function isDisabledEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off";
}

export function isLegacySkillGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isDisabledEnvValue(env[CLAUDE_CODE_LEGACY_SKILL_FILTER_ENV]);
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Mirrors #1395: `"package"` for a gsd-core package checkout, or the set of
 * installer-manifest file paths, or `null` when the root is unrelated. */
type GsdCoreRoot = "package" | Set<string> | null;

function readGsdCoreRoot(root: string): GsdCoreRoot {
	try {
		const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { name?: string };
		if (packageJson.name === GSD_CORE_PACKAGE_NAME) return "package";
	} catch {}
	try {
		const manifest = JSON.parse(readFileSync(join(root, GSD_CORE_MANIFEST_NAME), "utf-8")) as {
			files?: Record<string, unknown>;
		};
		return new Set(Object.keys(manifest.files ?? {}).map(toPosixPath));
	} catch {}
	return null;
}

/**
 * #1395 ownership criterion: a skill file belongs to legacy gsd-core when its
 * owning root (`<root>/skills/<name>/SKILL.md` → `<root>`) is an
 * `@opengsd/gsd-core` package checkout or lists the file in
 * `gsd-file-manifest.json`. Symlinked installs resolve through realpath.
 */
function isLegacyGsdCoreSkillFile(skillFilePath: string): boolean {
	for (const filePath of new Set([resolve(skillFilePath), realpathSafe(skillFilePath)])) {
		const skillsDir = dirname(dirname(filePath));
		if (basename(skillsDir) !== "skills") continue;
		const root = dirname(skillsDir);
		const gsdCoreRoot = readGsdCoreRoot(root);
		if (gsdCoreRoot === "package") return true;
		if (gsdCoreRoot instanceof Set && gsdCoreRoot.has(toPosixPath(relative(root, filePath)))) return true;
	}
	return false;
}

/** Skill directories the Claude CLI discovers for the "user"/"project" setting sources. */
function candidateSkillFiles(skillName: string, projectRoot: string): string[] {
	return [
		join(projectRoot, ".claude", "skills", skillName, "SKILL.md"),
		join(homedir(), ".claude", "skills", skillName, "SKILL.md"),
	].filter((filePath) => existsSync(filePath));
}

interface LegacySkillDenial {
	permissionDecision: "deny";
	permissionDecisionReason: string;
}

function resolveLegacyGsdCoreSkillDenial(input: {
	skillName: string;
	projectRoot: string;
	workflowServerName?: string;
}): LegacySkillDenial | undefined {
	const { skillName, projectRoot, workflowServerName } = input;
	// #1395 deliberately preserves independently authored `gsd-*` skills, so the
	// bare prefix is only a prefilter — denial still requires gsd-core ownership.
	if (!skillName.startsWith("gsd-")) return undefined;
	for (const filePath of candidateSkillFiles(skillName, projectRoot)) {
		if (!isLegacyGsdCoreSkillFile(filePath)) continue;
		const redirect = workflowServerName
			? `Use the gsd-pi workflow MCP tools instead (mcp__${workflowServerName}__gsd_*).`
			: "Use the gsd-pi workflow MCP tools instead.";
		return {
			permissionDecision: "deny",
			permissionDecisionReason: `Skill "${skillName}" belongs to the legacy gsd-core v1 toolkit, whose .planning/ workflow bypasses gsd-pi's DB-authoritative tracking. ${redirect}`,
		};
	}
	return undefined;
}

interface PreToolUseHookInput {
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: unknown;
}

interface PreToolUseHookResult {
	hookSpecificOutput?: {
		hookEventName: "PreToolUse";
		permissionDecision?: "allow" | "deny" | "ask";
		permissionDecisionReason?: string;
	};
}

/**
 * Default PreToolUse hook (matcher: "Skill") denying legacy gsd-core skills in
 * interactive runs. Fails open: any internal error allows the call, so the
 * guard can never wedge a tool invocation.
 */
export function createLegacySkillGuardHook(input: {
	projectRoot: string;
	workflowServerName?: string;
}): (hookInput: PreToolUseHookInput) => Promise<PreToolUseHookResult> {
	return async (hookInput) => {
		try {
			if (hookInput?.hook_event_name !== "PreToolUse" || hookInput.tool_name !== "Skill") return {};
			const skillName = (hookInput.tool_input as { skill?: unknown } | null | undefined)?.skill;
			if (typeof skillName !== "string" || skillName.length === 0) return {};
			const denial = resolveLegacyGsdCoreSkillDenial({
				skillName,
				projectRoot: input.projectRoot,
				workflowServerName: input.workflowServerName,
			});
			if (!denial) return {};
			return { hookSpecificOutput: { hookEventName: "PreToolUse", ...denial } };
		} catch {
			return {};
		}
	};
}
