import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";

/**
 * #2500 — `strictRequestParams` is authored in the generator and must land in
 * BOTH generated artifacts. The JSON is consumed by tooling, the TS module by
 * `getModel()` at runtime; a mismatch silently drops the request guards for
 * real traffic (seen when a naive patch marked the wrong entries).
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsonMarked(): Set<string> {
	const raw = JSON.parse(readFileSync(join(packageRoot, "src/models.generated.json"), "utf8")) as Record<
		string,
		Record<string, { id?: string; compat?: { strictRequestParams?: boolean } }>
	>;
	const marked = new Set<string>();
	for (const models of Object.values(raw)) {
		for (const entry of Object.values(models)) {
			if (entry.compat?.strictRequestParams === true) {
				marked.add(entry.id ?? "unknown");
			}
		}
	}
	return marked;
}

function tsMarked(): Set<string> {
	const marked = new Set<string>();
	for (const models of Object.values(MODELS)) {
		for (const [key, entry] of Object.entries(models)) {
			if ((entry as { compat?: { strictRequestParams?: boolean } }).compat?.strictRequestParams === true) {
				marked.add((entry as { id?: string }).id ?? key);
			}
		}
	}
	return marked;
}

describe("strictRequestParams catalog parity (#2500)", () => {
	it("marks the same entries in models.generated.json and models.generated.ts", () => {
		const fromJson = jsonMarked();
		const fromTs = tsMarked();

		expect(fromTs.size, "TS catalog must mark entries").toBeGreaterThan(0);
		expect([...fromJson].sort()).toEqual([...fromTs].sort());
	});

	it("only marks anthropic-messages / anthropic-vertex API models", () => {
		for (const models of Object.values(MODELS)) {
			for (const entry of Object.values(models) as Array<{ api: string; compat?: { strictRequestParams?: boolean } }>) {
				if (entry.compat?.strictRequestParams === true) {
					expect(["anthropic-messages", "anthropic-vertex"]).toContain(entry.api);
				}
			}
		}
	});

	it("marks claude-sonnet-5-5 on the anthropic provider", () => {
		const entry = MODELS.anthropic?.["claude-sonnet-5-5"] as
			| { compat?: { strictRequestParams?: boolean } }
			| undefined;
		expect(entry?.compat?.strictRequestParams).toBe(true);
	});
});
