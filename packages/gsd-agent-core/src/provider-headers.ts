import type { ProviderHeaders } from "@gsd/pi-ai";

export function toRecordHeaders(headers?: ProviderHeaders): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value != null) {
			out[key] = value;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}