// Project/App: gsd-pi
// File Purpose: Shared native executor for minimal headless project initialization.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../db-workspace.js";
import { logError } from "../workflow-logger.js";

export async function executeProjectInit(params: { projectDir?: string }, cwd: string) {
	const basePath =
		typeof params.projectDir === "string" && params.projectDir
			? params.projectDir
			: cwd;
	const gsdDir = join(basePath, ".gsd");
	try {
		if (!existsSync(basePath) || !statSync(basePath).isDirectory()) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: project directory not found: ${basePath}`,
					},
				],
				details: {
					operation: "project_init",
					error: "project_dir_missing",
				} as any,
			};
		}
		if (!existsSync(gsdDir)) mkdirSync(gsdDir, { recursive: true });
		// openWorkflowDatabase fails while a global handle points at another
		// project — the documented pairing is close-then-open for ad-hoc switches.
		try { closeWorkflowDatabase(); } catch (error) {
			logError("tool", "gsd_project_init previous database close failed", { tool: "gsd_project_init", error: String(error) });
		}
		const opened = openWorkflowDatabase(basePath);
		if (!opened.ok) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error initializing GSD project state: ${opened.reason ?? "open failed"}`,
					},
				],
				details: {
					operation: "project_init",
					error: "db_open_failed",
					reason: opened.reason ?? "unknown",
				} as any,
			};
		}
		const result = {
			ok: true,
			created: opened.reason === "created-empty",
			projectDir: basePath,
			gsdDir,
			dbPath: opened.location.projectDb,
			gitRepo: existsSync(join(basePath, ".git")),
		};
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			details: {
				operation: "project_init",
				...result,
			} as any,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logError("tool", `gsd_project_init failed: ${msg}`, {
			tool: "gsd_project_init",
			error: String(err),
		});
		return {
			content: [
				{
					type: "text" as const,
					text: `Error initializing GSD project state: ${msg}`,
				},
			],
			details: {
				operation: "project_init",
				error: "query_error",
				message: msg,
			} as any,
		};
	}
}
