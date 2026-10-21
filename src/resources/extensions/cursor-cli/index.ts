import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { CURSOR_AGENT_MODELS, resolveCursorAgentModels, type CursorAgentModel } from "./models.js";
import { isCursorAgentBinaryPresent, isCursorAgentReady, readCursorAgentListModels } from "./readiness.js";
import { streamViaCursorAgent } from "./stream-adapter.js";

const PROVIDER_ID = "cursor-agent";

function registerCursorProvider(pi: ExtensionAPI, models: CursorAgentModel[]): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Cursor Agent",
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorAgentReady,
		streamSimple: streamViaCursorAgent,
		models,
	});
}

export function probeAndRegisterCursorModels(
	pi: ExtensionAPI,
	readList: () => string | null = readCursorAgentListModels,
	isPresent: () => boolean = isCursorAgentBinaryPresent,
): CursorAgentModel[] {
	try {
		if (process.env.GSD_CURSOR_DISABLE === "1") return CURSOR_AGENT_MODELS;
		if (!isPresent()) return CURSOR_AGENT_MODELS;
		const models = resolveCursorAgentModels(readList());
		try {
			pi.unregisterProvider(PROVIDER_ID);
		} catch {
			// First registration has nothing to replace.
		}
		registerCursorProvider(pi, models);
		return models;
	} catch {
		return CURSOR_AGENT_MODELS;
	}
}

export default function cursorCli(pi: ExtensionAPI): void {
	if (process.env.GSD_CURSOR_DISABLE === "1") return;

	registerCursorProvider(pi, CURSOR_AGENT_MODELS);

	pi.on("session_start", (_event, ctx) => {
		if (process.env.GSD_CURSOR_DISABLE === "1") return;
		// Headless/CI: keep the offline fallback. Never await cursor-agent
		// --list-models (15s execFileSync timeout) on the default path.
		if (!ctx.hasUI || process.env.GSD_NON_INTERACTIVE === "1") return;
		setImmediate(() => {
			try {
				if (!isCursorAgentBinaryPresent()) return;
				probeAndRegisterCursorModels(pi);
			} catch {
				// keep fallback catalog
			}
		});
	});
}
