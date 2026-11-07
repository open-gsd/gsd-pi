import fs from "node:fs";
import path from "node:path";
import type { SubagentRunRecord } from "./run-store.js";

/**
 * Pure, read-only scan of persisted subagent run records (#2936).
 *
 * Deliberately NOT built on SubagentRunStore.list()/get(): those hide missing or
 * corrupt records behind [] / null. This scanner never creates the directory,
 * never writes, never probes PIDs, and never revalidates status. Persisted
 * `running` is reported as stored, not as proof of a live process.
 */

export type RunScanGap = "store-missing" | "store-unreadable" | "invalid-record" | "bounded-scan";

export type SubagentRunScan =
	| {
			schemaVersion: 1;
			readAt: string;
			availability: "available";
			completeness: "complete" | "partial";
			basis: "persisted";
			items: readonly SubagentRunSummary[];
			gaps: readonly RunScanGap[];
	  }
	| {
			schemaVersion: 1;
			readAt: string;
			availability: "unavailable";
			completeness: "unknown";
			reason: RunScanGap;
	  };

export interface SubagentRunSummary {
	runId: string;
	mode: string;
	status: string;
	startedAt: string;
	updatedAt: string;
	children: readonly { index: number; agent: string; status: string }[];
}

const MAX_FILES = 200;

export function scanPersistedSubagentRuns(baseDir: string, readAt: string): SubagentRunScan {
	if (!fs.existsSync(baseDir)) {
		return { schemaVersion: 1, readAt, availability: "unavailable", completeness: "unknown", reason: "store-missing" };
	}
	let names: string[];
	try {
		names = fs.readdirSync(baseDir).filter((n) => n.endsWith(".json"));
	} catch {
		return { schemaVersion: 1, readAt, availability: "unavailable", completeness: "unknown", reason: "store-unreadable" };
	}

	const gaps: RunScanGap[] = [];
	if (names.length > MAX_FILES) {
		gaps.push("bounded-scan");
		names = names.slice(0, MAX_FILES);
	}

	const items: SubagentRunSummary[] = [];
	for (const name of names) {
		const summary = readRecord(path.join(baseDir, name));
		if (summary) items.push(summary);
		else gaps.push("invalid-record");
	}

	return {
		schemaVersion: 1,
		readAt,
		availability: "available",
		completeness: gaps.length > 0 ? "partial" : "complete",
		basis: "persisted",
		items,
		gaps,
	};
}

function readRecord(filePath: string): SubagentRunSummary | null {
	let parsed: Partial<SubagentRunRecord>;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SubagentRunRecord>;
	} catch {
		return null;
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof parsed.runId !== "string" ||
		typeof parsed.mode !== "string" ||
		typeof parsed.status !== "string" ||
		typeof parsed.startedAt !== "string" ||
		typeof parsed.updatedAt !== "string" ||
		!Array.isArray(parsed.children)
	) {
		return null;
	}
	// Every child must carry its required fields. A malformed child rejects the
	// whole record as invalid, so no fabricated defaults enter the inventory.
	const children: { index: number; agent: string; status: string }[] = [];
	for (const c of parsed.children as unknown[]) {
		if (!c || typeof c !== "object") return null;
		const child = c as Record<string, unknown>;
		if (typeof child.index !== "number" || typeof child.agent !== "string" || typeof child.status !== "string") {
			return null;
		}
		children.push({ index: child.index, agent: child.agent, status: child.status });
	}
	return {
		runId: parsed.runId,
		mode: parsed.mode,
		status: parsed.status,
		startedAt: parsed.startedAt,
		updatedAt: parsed.updatedAt,
		children,
	};
}
