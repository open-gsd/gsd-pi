/**
 * Skill directory taxonomy.
 *
 * Single source of truth for which filesystem directories contain skills and
 * what role each one plays. Three callers consume this:
 *
 *   - PackageManager (`./package-manager.js`) — builds the model-visible
 *     `<available_skills>` catalog. Filters to the non-Claude kinds and
 *     applies its own PathMetadata + collision precedence.
 *   - skill-discovery (`src/resources/extensions/gsd/skill-discovery.ts`) —
 *     detects skills installed mid-session by scanning disk. Uses all kinds.
 *   - preferences-skills (`src/resources/extensions/gsd/preferences-skills.ts`)
 *     — resolves bare skill names referenced in GSD preferences. Uses all
 *     kinds, mapped to a `user-skill` / `project-skill` method.
 *
 * Enumeration order is precedence order (project → ancestor-project → user);
 * first match wins for collision resolution. Only `agents-project` walks
 * ancestors up to the git repo root, matching the catalog's historical
 * behavior.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";

export type SkillDirKind =
	| "gsd-project" // <cwd>/.gsd/skills           (no ancestor walk)
	| "agents-project" // <cwd>/.agents/skills        (WALKS ancestors to git root)
	| "claude-project" // <cwd>/.claude/skills        (no walk)
	| "gsd-user" // ~/.gsd/agent/skills
	| "agents-user" // ~/.agents/skills
	| "claude-user"; // ~/.claude/skills

export interface SkillDirectoryEntry {
	/** Absolute path to the skills directory (the dir containing skill subdirs). */
	path: string;
	kind: SkillDirKind;
	scope: "user" | "project";
	/**
	 * The configuration root that owns this skills dir — the `.gsd` / `.agents`
	 * / `.claude` parent. PackageManager uses this as `PathMetadata.baseDir`.
	 */
	baseDir: string;
}

/**
 * Find the nearest enclosing directory containing a `.git` entry.
 * Returns `null` if none is found before the filesystem root.
 */
export function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/**
 * Collect `<dir>/.agents/skills` for `startDir` and every ancestor up to (and
 * including) the git repo root. Order is nearest-first. If no git root is
 * found, walks all the way to the filesystem root.
 */
export function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

export interface GetSkillDirectoriesOptions {
	cwd: string;
	/** Value of `gsdHome()` from the caller — the `~/.gsd` directory. */
	gsdHome: string;
}

/**
 * Return all known skill directories in precedence order. First match wins
 * for collision resolution.
 *
 * Three-tier precedence:
 *   1. Project kinds (`gsd-project`, `agents-project`) — native project dirs
 *      override everything below.
 *   2. Bundled GSD (`gsd-user`, i.e. ~/.gsd/agent/skills/) — protects
 *      auto-mode dependencies (`handoff`, `decompose-into-slices`, etc.) from
 *      being shadowed by same-named Claude skills.
 *   3. Foreign/Claude kinds (`claude-project`, `agents-user`, `claude-user`).
 *
 * The `agents-project` kind is expanded into one entry per ancestor directory
 * (nearest first, up to the git root), mirroring the catalog's historical
 * ancestor walk.
 */
export function getSkillDirectories({ cwd, gsdHome }: GetSkillDirectoriesOptions): SkillDirectoryEntry[] {
	const resolvedCwd = resolve(cwd);
	const entries: SkillDirectoryEntry[] = [];

	// Tier 1 — project scope (overrides everything below).

	// 1. <cwd>/.gsd/skills
	const gsdProjectSkills = join(resolvedCwd, CONFIG_DIR_NAME, "skills");
	entries.push({
		path: gsdProjectSkills,
		kind: "gsd-project",
		scope: "project",
		baseDir: dirname(gsdProjectSkills),
	});

	// 2. <dir>/.agents/skills for cwd and each ancestor up to git root (nearest first)
	for (const agentsSkillsDir of collectAncestorAgentsSkillDirs(resolvedCwd)) {
		entries.push({
			path: agentsSkillsDir,
			kind: "agents-project",
			scope: "project",
			baseDir: dirname(agentsSkillsDir),
		});
	}

	// Tier 2 — bundled GSD (wins over Claude kinds on name collision).

	// 3. ~/.gsd/agent/skills
	const gsdUserSkills = join(gsdHome, "agent", "skills");
	entries.push({
		path: gsdUserSkills,
		kind: "gsd-user",
		scope: "user",
		baseDir: dirname(gsdUserSkills),
	});

	// Tier 3 — foreign / Claude kinds.

	// 4. <cwd>/.claude/skills
	const claudeProjectSkills = join(resolvedCwd, ".claude", "skills");
	entries.push({
		path: claudeProjectSkills,
		kind: "claude-project",
		scope: "project",
		baseDir: dirname(claudeProjectSkills),
	});

	// 5. ~/.agents/skills
	const agentsUserSkills = join(homedir(), ".agents", "skills");
	entries.push({
		path: agentsUserSkills,
		kind: "agents-user",
		scope: "user",
		baseDir: dirname(agentsUserSkills),
	});

	// 6. ~/.claude/skills
	const claudeUserSkills = join(homedir(), ".claude", "skills");
	entries.push({
		path: claudeUserSkills,
		kind: "claude-user",
		scope: "user",
		baseDir: dirname(claudeUserSkills),
	});

	return entries;
}
