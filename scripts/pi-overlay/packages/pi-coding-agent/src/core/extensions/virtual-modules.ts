import * as bundledPiAgentCore from "@gsd/pi-agent-core";
import * as bundledPiAiModels from "@gsd/pi-ai/models";
import * as bundledPiAiOauth from "@gsd/pi-ai/oauth";
import * as bundledPiAiProviders from "@gsd/pi-ai/providers/all";
import * as bundledPiTui from "@gsd/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @gsd/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.js";
import * as bundledPiAiExtensionView from "./pi-ai-extension-view.js";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@gsd/pi-agent-core": bundledPiAgentCore,
	"@gsd/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and pi-ai's former TypeBox
	// re-exports keep working.
	"@gsd/pi-ai": bundledPiAiExtensionView,
	"@gsd/pi-ai/compat": bundledPiAiExtensionView,
	"@gsd/pi-ai/models": bundledPiAiModels,
	"@gsd/pi-ai/oauth": bundledPiAiOauth,
	"@gsd/pi-ai/providers/all": bundledPiAiProviders,
	"@gsd/pi-coding-agent": bundledPiCodingAgent,
};
