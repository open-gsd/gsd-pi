import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { CURSOR_AGENT_PROVIDER_ID } from "./bridged-tools.js";
import { CURSOR_AGENT_MODELS, resolveCursorAgentModels, type CursorAgentModel } from "./models.js";
import {
	isCursorAgentReady,
	primeCursorAgentReadiness,
	readCursorAgentListModels,
	settleCursorAgentBinaryPresent,
	settleCursorAgentReadiness,
} from "./readiness.js";
import { streamViaCursorAgent } from "./stream-adapter.js";

const PROVIDER_ID = CURSOR_AGENT_PROVIDER_ID;

function registerCursorProvider(pi: ExtensionAPI, models: CursorAgentModel[]): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Cursor Agent",
		authMode: "externalCli",
		api: "cursor-stream-json",
		baseUrl: "local://cursor-agent",
		isReady: isCursorAgentReady,
		settleReadiness: settleCursorAgentReadiness,
		streamSimple: streamViaCursorAgent,
		models,
	});
}

export async function probeAndRegisterCursorModels(
	pi: ExtensionAPI,
	readList: () => Promise<string | null> | string | null = readCursorAgentListModels,
	isPresent: () => Promise<boolean> | boolean = settleCursorAgentBinaryPresent,
): Promise<CursorAgentModel[]> {
	try {
		if (process.env.GSD_CURSOR_DISABLE === "1") return CURSOR_AGENT_MODELS;
		if (!(await isPresent())) return CURSOR_AGENT_MODELS;
		const models = resolveCursorAgentModels(await readList());
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

	// isReady() only reads a cache; start the first CLI probe now so the
	// answer is usually there before anything asks.
	primeCursorAgentReadiness();

	registerCursorProvider(pi, CURSOR_AGENT_MODELS);

	pi.on("session_start", (_event, ctx) => {
		if (process.env.GSD_CURSOR_DISABLE === "1") return;
		// Headless/CI: keep the offline fallback. Never wait on cursor-agent
		// --list-models (15s timeout) on the default path.
		if (!ctx.hasUI || process.env.GSD_NON_INTERACTIVE === "1") return;
		// Runs on async child processes in the background; any failure keeps
		// the fallback catalog.
		void probeAndRegisterCursorModels(pi);
	});
}
