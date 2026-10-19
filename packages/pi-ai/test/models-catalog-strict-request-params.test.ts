import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELS } from "../src/models.generated.ts";

/**
 * #2500 / #2645 — the strict-surface compat flags are authored in the
 * generator and must land in BOTH generated artifacts. The JSON is consumed
 * by tooling, the TS module by `getModel()` at runtime; a mismatch silently
 * drops the request guards for real traffic (seen when a naive patch marked
 * the wrong entries).
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface CatalogCompat {
	strictRequestParams?: boolean;
	thinkingOffMode?: string;
	rejectsTemperature?: boolean;
	rejectsForcedToolChoice?: boolean;
}

function jsonCompatMap(): Map<string, CatalogCompat> {
	// Generated data file (JSON), not source — read as data for parity checking.
	const raw = JSON.parse(
		readFileSync(join(packageRoot, "src", "models.generated.json"), "utf8"),
	) as Record<string, Record<string, { id?: string; compat?: CatalogCompat }>>;
	const marked = new Map<string, CatalogCompat>();
	for (const [provider, models] of Object.entries(raw)) {
		for (const entry of Object.values(models)) {
			const compat = entry.compat ?? {};
			const isMarked =
				compat.strictRequestParams === true ||
				compat.thinkingOffMode !== undefined ||
				compat.rejectsTemperature === true ||
				compat.rejectsForcedToolChoice === true;
			if (isMarked) {
				// Key by provider:id — the same id can be marked differently per
				// provider (e.g. claude-fable-5.1 on cloudflare vs Copilot).
				marked.set(`${provider}:${entry.id ?? "unknown"}`, compat);
			}
		}
	}
	return marked;
}

function tsCompatMap(): Map<string, CatalogCompat> {
	const marked = new Map<string, CatalogCompat>();
	for (const [provider, models] of Object.entries(MODELS)) {
		for (const [key, entry] of Object.entries(models)) {
			const compat = (entry as { compat?: CatalogCompat }).compat ?? {};
			const isMarked =
				compat.strictRequestParams === true ||
				compat.thinkingOffMode !== undefined ||
				compat.rejectsTemperature === true ||
				compat.rejectsForcedToolChoice === true;
			if (isMarked) {
				marked.set(`${provider}:${(entry as { id?: string }).id ?? key}`, compat);
			}
		}
	}
	return marked;
}

describe("strict-surface catalog parity (#2500/#2645)", () => {
	it("marks the same compat in models.generated.json and models.generated.ts", () => {
		const fromJson = jsonCompatMap();
		const fromTs = tsCompatMap();

		expect(fromTs.size, "TS catalog must mark entries").toBeGreaterThan(0);
		expect([...fromJson.keys()].sort()).toEqual([...fromTs.keys()].sort());
		for (const [id, compat] of fromJson) {
			expect(fromTs.get(id)).toEqual(compat);
		}
	});
});

describe("strictRequestParams umbrella (#2500/#2645)", () => {
	it("only marks anthropic-messages / anthropic-vertex API models", () => {
		for (const models of Object.values(MODELS)) {
			for (const entry of Object.values(models) as Array<{ api: string; compat?: CatalogCompat }>) {
				if (entry.compat?.strictRequestParams === true) {
					expect(["anthropic-messages", "anthropic-vertex"]).toContain(entry.api);
				}
			}
		}
	});

	it("marks claude-sonnet-5-5 on the anthropic provider", () => {
		const entry = MODELS.anthropic?.["claude-sonnet-5-5"] as
			| { compat?: CatalogCompat }
			| undefined;
		expect(entry?.compat?.strictRequestParams).toBe(true);
	});

	it("marks Opus 5.5 and Fable 5.1 on the anthropic provider (#2645)", () => {
		for (const id of ["claude-opus-5-5", "claude-fable-5-1"]) {
			const entry = MODELS.anthropic?.[id] as { compat?: CatalogCompat } | undefined;
			expect(entry?.compat?.strictRequestParams, id).toBe(true);
		}
	});

	it("does NOT umbrella-mark Fable 5, which still accepts forced tool_choice (#2645)", () => {
		const entry = MODELS.anthropic?.["claude-fable-5"] as { compat?: CatalogCompat } | undefined;
		expect(entry?.compat?.strictRequestParams).toBeUndefined();
		expect(entry?.compat?.thinkingOffMode).toBe("between_tools");
		expect(entry?.compat?.rejectsTemperature).toBe(true);
	});

	it("marks the 5.5/5.1 relay entries on Copilot with both omitters (#2645)", () => {
		for (const id of ["claude-sonnet-5.5", "claude-opus-5.5", "claude-fable-5.1"]) {
			const entry = MODELS["github-copilot"]?.[id] as { compat?: CatalogCompat } | undefined;
			expect(entry?.compat?.rejectsTemperature, id).toBe(true);
			expect(entry?.compat?.rejectsForcedToolChoice, id).toBe(true);
		}
	});

	it("marks the Fable 5 relay entry with rejectsTemperature only (#2645)", () => {
		const entry = MODELS["github-copilot"]?.["claude-fable-5"] as { compat?: CatalogCompat } | undefined;
		expect(entry?.compat?.rejectsTemperature).toBe(true);
		expect(entry?.compat?.rejectsForcedToolChoice).toBeUndefined();
	});

	it("marks OpenRouter Claude 5.x relay entries (#2645)", () => {
		const entry = MODELS.openrouter?.["anthropic/claude-opus-5.5"] as { compat?: CatalogCompat } | undefined;
		expect(entry?.compat?.rejectsTemperature).toBe(true);
		expect(entry?.compat?.rejectsForcedToolChoice).toBe(true);
	});
});

describe("claude-haiku-5-5 catalog registration (#2701)", () => {
	it("marks Haiku 5.5 granular on the anthropic provider, never the umbrella", () => {
		const entry = MODELS.anthropic?.["claude-haiku-5-5"] as
			| { compat?: CatalogCompat & { forceAdaptiveThinking?: boolean } }
			| undefined;
		expect(entry?.compat?.strictRequestParams).toBeUndefined();
		expect(entry?.compat?.forceAdaptiveThinking).toBe(true);
		expect(entry?.compat?.rejectsTemperature).toBe(true);
		expect(entry?.compat?.rejectsForcedToolChoice).toBeUndefined();
	});

	it("registers Haiku 5.5 on the Anthropic-family providers with adaptive compat", () => {
		for (const [provider, id] of [
			["anthropic", "claude-haiku-5-5"],
			["anthropic-vertex", "claude-haiku-5-5"],
			["opencode", "claude-haiku-5-5"],
			["opencode-go", "claude-haiku-5-5"],
			["vercel-ai-gateway", "anthropic/claude-haiku-5.5"],
		] as const) {
			const entry = MODELS[provider]?.[id] as { compat?: CatalogCompat & { forceAdaptiveThinking?: boolean } } | undefined;
			expect(entry, `${provider}:${id}`).toBeDefined();
			expect(entry?.compat?.forceAdaptiveThinking, provider).toBe(true);
			expect(entry?.compat?.rejectsTemperature, provider).toBe(true);
			expect(entry?.compat?.strictRequestParams, provider).toBeUndefined();
		}
	});

	it("registers the Bedrock Haiku 5.5 profiles (base, US, global, EU, JP, AU)", () => {
		for (const id of [
			"anthropic.claude-haiku-5-5",
			"us.anthropic.claude-haiku-5-5",
			"global.anthropic.claude-haiku-5-5",
			"eu.anthropic.claude-haiku-5-5",
			"jp.anthropic.claude-haiku-5-5",
			"au.anthropic.claude-haiku-5-5",
		]) {
			const entry = MODELS["amazon-bedrock"]?.[id] as { contextWindow?: number; maxTokens?: number } | undefined;
			expect(entry, id).toBeDefined();
			expect(entry?.contextWindow, id).toBe(1_000_000);
			expect(entry?.maxTokens, id).toBe(128_000);
		}
	});

	it("registers the relay entries with temperature rejection only", () => {
		const copilot = MODELS["github-copilot"]?.["claude-haiku-5.5"] as { compat?: CatalogCompat } | undefined;
		expect(copilot?.compat?.rejectsTemperature).toBe(true);
		expect(copilot?.compat?.rejectsForcedToolChoice).toBeUndefined();
		const openrouter = MODELS.openrouter?.["anthropic/claude-haiku-5.5"] as { compat?: CatalogCompat } | undefined;
		expect(openrouter?.compat?.rejectsTemperature).toBe(true);
		expect(openrouter?.compat?.rejectsForcedToolChoice).toBeUndefined();
	});

	it("prices Haiku 5.5 from the models.dev data ($0.10/$0.50 base tier)", () => {
		const entry = MODELS.anthropic?.["claude-haiku-5-5"] as { cost?: { input?: number; output?: number } } | undefined;
		expect(entry?.cost?.input).toBe(0.1);
		expect(entry?.cost?.output).toBe(0.5);
	});
});
