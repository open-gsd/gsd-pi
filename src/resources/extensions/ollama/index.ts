// gsd-pi — Ollama Extension: First-class local LLM support
/**
 * Ollama Extension
 *
 * Auto-detects a running Ollama instance, discovers locally pulled models,
 * and registers them as a first-class provider. No configuration required —
 * if Ollama is running, models appear automatically.
 *
 * Features:
 * - Auto-discovery of local models via /api/tags
 * - Capability detection (vision, reasoning, context window)
 * - /ollama slash commands for model management
 * - ollama_manage tool for LLM-driven model operations
 * - Zero-cost model registration (local inference)
 *
 * Respects OLLAMA_HOST env var for non-default endpoints.
 */

import { importExtensionModule, type ExtensionAPI } from "@gsd/pi-coding-agent";
import * as client from "./ollama-client.js";
import { discoverModels } from "./ollama-discovery.js";
import { registerOllamaCommands } from "./ollama-commands.js";
import { streamOllamaChat } from "./ollama-chat-provider.js";
import { stalePriceSnapshotMessage } from "./cloud-prices.js";

/**
 * Observers for cost-reporting drift, fired by probeAndRegister so hosts
 * can surface them through their own channels (TUI notify, worker stderr).
 */
export interface ProbeHooks {
	/** Fires once per cloud-routed model that has no price entry. */
	onUnpricedCloudModel?: (name: string) => void;
}

/** Cost-drift notices already emitted in this process (one-time per notice). */
const emittedCostNotices = new Set<string>();

/** Cloud models already reported as unpriced (one-time per model, not per render). */
const emittedUnpricedModels = new Set<string>();

/**
 * Emit a cost-drift notice through the channel the session mode provides:
 * TUI notify interactively, stderr in headless workers (the same forensics
 * channel `.gsd/parallel/*.stderr.log` is collected from). One-time per
 * notice per process — session switches and auto-mode session resets must
 * not spam it.
 */
function emitCostNotice(
	notice: string,
	ctx: { hasUI?: boolean; ui?: { notify?: (message: string, type?: "warning" | "info" | "error" | "success") => void } },
): void {
	if (emittedCostNotices.has(notice)) return;
	emittedCostNotices.add(notice);
	if (ctx.hasUI) {
		ctx.ui?.notify?.(notice, "warning");
	} else {
		process.stderr.write(`${notice}\n`);
	}
}

let toolsPromise: Promise<void> | null = null;

async function registerOllamaTools(pi: ExtensionAPI): Promise<void> {
	if (!toolsPromise) {
		toolsPromise = (async () => {
			const { registerOllamaTool } = await importExtensionModule<
				typeof import("./ollama-tool.js")
			>(import.meta.url, "./ollama-tool.js");
			registerOllamaTool(pi);
		})().catch((error) => {
			toolsPromise = null;
			throw error;
		});
	}
	return toolsPromise;
}

/** Track whether we've registered models so we can clean up on shutdown */
let providerRegistered = false;

/**
 * Probe Ollama and register discovered models.
 * Safe to call multiple times — re-discovers and re-registers.
 *
 * Exported for tests (see ollama-auth-mode.test.ts, ollama-status-indicator.test.ts)
 * so a fake HTTP endpoint can drive the registration/unregistration paths.
 * Production callers always go through the session_start handler below.
 */
export async function probeAndRegister(pi: ExtensionAPI, hooks?: ProbeHooks): Promise<boolean> {
	const running = await client.isRunning();
	if (!running) {
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		return false;
	}

	const models = await discoverModels();
	if (models.length === 0) {
		// No local models means there's nothing usable to register in GSD.
		// Keep the footer/status clean instead of advertising Ollama availability.
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		return false;
	}

	for (const model of models) {
		if (model.unpricedCloud) hooks?.onUnpricedCloudModel?.(model.id);
	}

	const baseUrl = client.getOllamaHost();

	// Use authMode "apiKey" (#3440). Local Ollama ignores the Authorization header,
	// so the "ollama" fallback is harmless. For cloud endpoints (OLLAMA_HOST pointing
	// to ollama.com or a remote instance), OLLAMA_API_KEY is picked up here.
	pi.registerProvider("ollama", {
		authMode: "apiKey",
		apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
		baseUrl,
		api: "ollama-chat",
		streamSimple: streamOllamaChat,
		isReady: () => true,
		models: models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			providerOptions: (m.ollamaOptions ?? {}) as Record<string, unknown>,
		})),
	});

	providerRegistered = true;
	return true;
}

export default function ollama(pi: ExtensionAPI) {
	// Register slash commands immediately (they check Ollama availability themselves)
	registerOllamaCommands(pi);

	pi.on("session_start", async (_event, ctx) => {
		// Register tool (deferred to avoid blocking startup)
		if (ctx.hasUI) {
			void registerOllamaTools(pi).catch((error) => {
				ctx.ui.notify(
					`Ollama tool failed to load: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		} else {
			await registerOllamaTools(pi);
		}

		// In headless/auto mode, await the probe so the fallback resolver can
		// see Ollama before the first LLM call (#3531 race condition).
		// In interactive mode, keep it async for fast startup.
		// Surface probe failures under GSD_DEBUG so users can diagnose silent
		// "Ollama is missing from /model" reports without patching dist/. The
		// probe still soft-fails (registration is best-effort) — we just stop
		// dropping the error on the floor. See #4982.
		const debugOllama = (where: string, error: unknown): void => {
			if (process.env.GSD_DEBUG) {
				const msg = error instanceof Error ? error.message : String(error);
				process.stderr.write(`[ollama] ${where} probe failed: ${msg}\n`);
			}
		};

		// Collect cost-reporting drift from the probe and surface it through
		// the mode's channel: a $0 nobody can distinguish from "local and
		// free" is the twin of the zero-cost bug the price table fixes.
		const unpricedCloud: string[] = [];
		const hooks: ProbeHooks = {
			onUnpricedCloudModel: (name) => {
				unpricedCloud.push(name);
			},
		};
		const emitCostDriftNotices = (): void => {
			// Report each unpriced cloud model exactly once per process —
			// re-probes in a different /api/tags order or as a superset must
			// not re-notice already-reported models. Sorted so the rendered
			// key is order-stable.
			const freshUnpriced = unpricedCloud.filter((name) => !emittedUnpricedModels.has(name));
			if (freshUnpriced.length > 0) {
				for (const name of freshUnpriced) emittedUnpricedModels.add(name);
				emitCostNotice(
					`[ollama] no price entry for cloud model(s) ${[...freshUnpriced].sort().join(", ")} — reporting $0; report it at github.com/open-gsd/gsd-pi/issues so it can be priced`,
					ctx,
				);
			}
			const stale = stalePriceSnapshotMessage();
			if (stale) emitCostNotice(stale, ctx);
		};

		const safeEmitCostDriftNotices = (): void => {
			try {
				emitCostDriftNotices();
			} catch (error) {
				// A notice is advisory: a display-layer throw must never be
				// mistaken for a registration failure (which would clear the
				// footer status a successful probe just set).
				debugOllama("cost-notice", error);
			}
		};

		if (!ctx.hasUI) {
			try {
				// Notices only when ollama is actually usable — a user with no
				// daemon or an empty catalog must not receive price-drift
				// noise at every boot.
				if (await probeAndRegister(pi, hooks)) safeEmitCostDriftNotices();
			} catch (error) {
				debugOllama("headless", error);
			}
		} else {
			probeAndRegister(pi, hooks)
				.then((found) => {
					ctx.ui.setStatus("ollama", found ? "Ollama" : undefined);
					if (found) safeEmitCostDriftNotices();
				})
				.catch((error) => {
					ctx.ui.setStatus("ollama", undefined);
					debugOllama("interactive", error);
				});
		}
	});

	pi.on("session_shutdown", async () => {
		if (providerRegistered) {
			pi.unregisterProvider("ollama");
			providerRegistered = false;
		}
		toolsPromise = null;
	});
}
