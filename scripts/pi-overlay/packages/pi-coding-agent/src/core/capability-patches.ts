import type { Api, Model } from "@gsd/pi-ai";

/** GSD extension: provider-agnostic capability flags on models. */
export interface ModelCapabilities {
	supportsXhigh?: boolean;
	requiresToolCallId?: boolean;
	supportsServiceTier?: boolean;
	charsPerToken?: number;
}

type CapabilityPatch = { match: (m: Model<Api>) => boolean; caps: ModelCapabilities };

export const CAPABILITY_PATCHES: CapabilityPatch[] = [
	{
		match: (m) =>
			m.id.includes("gpt-5.2") ||
			m.id.includes("gpt-5.3") ||
			m.id.includes("gpt-5.4"),
		caps: { supportsXhigh: true, supportsServiceTier: true },
	},
	{
		match: (m) => m.id.includes("gpt-5.5") || m.id.includes("gpt-5.6"),
		caps: { supportsXhigh: true },
	},
	{
		match: (m) =>
			m.api === "anthropic-messages" &&
			(m.id.includes("opus-4-6") ||
				m.id.includes("opus-4.6") ||
				m.id.includes("opus-4-7") ||
				m.id.includes("opus-4.7") ||
				m.id.includes("opus-4-8") ||
				m.id.includes("opus-4.8") ||
				m.id.includes("opus-5") ||
				m.id.includes("opus.5") ||
				m.id.includes("fable-5") ||
				m.id.includes("fable.5")),
		caps: { supportsXhigh: true },
	},
];

/** Apply GSD capability patches after assembling a model list. */
export function applyCapabilityPatches<T extends Model<Api>>(models: T[]): T[] {
	return models.map((model) => {
		for (const patch of CAPABILITY_PATCHES) {
			if (patch.match(model)) {
				return {
					...model,
					capabilities: {
						...patch.caps,
						...(model as T & { capabilities?: Record<string, boolean> }).capabilities,
					},
				} as T;
			}
		}
		return model;
	});
}
