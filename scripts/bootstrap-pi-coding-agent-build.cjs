#!/usr/bin/env node
/**
 * Bootstrap pi-coding-agent build before agent-core dist exists.
 * Temporarily copies GSD module implementations into pi-coding-agent shims,
 * builds pi-coding-agent, then restores thin re-export shims.
 */
"use strict";

const {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = join(__dirname, "..");
const PI_CORE = join(ROOT, "packages/pi-coding-agent/src/core");
const AGENT_CORE = join(ROOT, "packages/gsd-agent-core/src");
const BACKUP = join(ROOT, ".cache/pi-shim-backup");

const SHIMS = [
	"keybindings.ts",
	"fallback-resolver.ts",
	"blob-store.ts",
	"artifact-manager.ts",
	"lifecycle-hooks.ts",
	// system-prompt stays on the v1.6.1 coding-agent implementation (Normalized*
	// APIs). gsd-agent-core still owns joinDocPaths/buildSystemPrompt for host
	// paths; do not overwrite the pin file during bootstrap.
	"extension-session-types.ts",
];

function restoreImports(content, file) {
	let c = content;
	if (file === "keybindings.ts") {
		c = c.replace(
			'import { getAgentDir } from "@gsd/pi-coding-agent/config.js";',
			'import { getAgentDir } from "../config.js";',
		);
	}
	if (file === "fallback-resolver.ts") {
		c = c.replaceAll("@gsd/pi-coding-agent/core/", "./");
	}
	if (file === "lifecycle-hooks.ts") {
		c = c
			.replaceAll("@gsd/pi-coding-agent/core/", "./")
			.replace("@gsd/pi-coding-agent/utils/git.js", "../utils/git.js");
	}
	if (file === "system-prompt.ts") {
		c = c.replaceAll("@gsd/pi-coding-agent/", "../");
	}
	if (file === "extension-session-types.ts") {
		return readFileSync(join(PI_CORE, file), "utf8");
	}
	return c;
}

function restoreStaleBackup({
	piCore = PI_CORE,
	backupDir = BACKUP,
	shims = SHIMS,
} = {}) {
	if (!existsSync(backupDir)) return false;

	console.warn(
		"[bootstrap] Found stale .cache/pi-shim-backup from an interrupted run; restoring original shims before building.",
	);

	for (const file of shims) {
		const backupPath = join(backupDir, file);
		if (!existsSync(backupPath)) continue;
		const shimPath = join(piCore, file);
		mkdirSync(dirname(shimPath), { recursive: true });
		writeFileSync(shimPath, readFileSync(backupPath, "utf8"));
	}

	rmSync(backupDir, { recursive: true, force: true });
	return true;
}

function writeBackupAtomically(backupDir, file, content) {
	const backupPath = join(backupDir, file);
	const temporaryPath = `${backupPath}.tmp`;
	writeFileSync(temporaryPath, content);
	renameSync(temporaryPath, backupPath);
}

function prepareBackup({
	piCore = PI_CORE,
	backupDir = BACKUP,
	shims = SHIMS,
} = {}) {
	restoreStaleBackup({ piCore, backupDir, shims });
	rmSync(backupDir, { recursive: true, force: true });
	mkdirSync(backupDir, { recursive: true });

	for (const file of shims) {
		const shimPath = join(piCore, file);
		writeBackupAtomically(backupDir, file, readFileSync(shimPath, "utf8"));
	}
}

if (require.main === module) {
	prepareBackup();

	for (const file of SHIMS) {
		const shimPath = join(PI_CORE, file);
		if (file === "extension-session-types.ts") {
			writeFileSync(
				shimPath,
				`/** bootstrap stub */\nexport class AgentSession {}\nexport type AgentSessionEvent = { type: string };\nexport function parseSkillBlock() { return null; }\n`,
			);
			continue;
		}
		const srcPath = join(AGENT_CORE, file);
		if (!existsSync(srcPath)) continue;
		const content = restoreImports(readFileSync(srcPath, "utf8"), file);
		writeFileSync(shimPath, content);
	}

	try {
		execSync("pnpm --filter @gsd/pi-coding-agent run build", {
			cwd: ROOT,
			stdio: "inherit",
		});
	} finally {
		for (const file of SHIMS) {
			writeFileSync(
				join(PI_CORE, file),
				readFileSync(join(BACKUP, file), "utf8"),
			);
		}
		rmSync(BACKUP, { recursive: true, force: true });
	}

	process.stderr.write("bootstrap-pi-coding-agent-build: done\n");
}

module.exports = {
	prepareBackup,
	restoreStaleBackup,
};
