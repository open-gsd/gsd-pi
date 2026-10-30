/** Opt-in, process-lifetime model policy inherited by native GSD children. */
export function parseModelAllowlist(raw: string | undefined): readonly string[] | undefined {
	if (raw === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("GSD_MODEL_ALLOWLIST must be a nonempty JSON array of exact provider/model IDs");
	}
	if (!Array.isArray(value) || value.length === 0 || value.some((id) =>
		typeof id !== "string" || !/^[^/\s*]+\/[^\s*]+$/.test(id))) {
		throw new Error("GSD_MODEL_ALLOWLIST must be a nonempty JSON array of exact provider/model IDs");
	}
	return Object.freeze([...new Set(value as string[])].sort());
}

// Snapshot before extensions load. Later env/preference changes cannot weaken it.
const allowedModels = parseModelAllowlist(typeof process === "undefined" ? undefined : process.env.GSD_MODEL_ALLOWLIST);

export function getModelRequestPolicy(): readonly string[] | undefined {
	return allowedModels;
}

export function isModelRequestAllowed(model: { provider: string; id: string }): boolean {
	return allowedModels === undefined || allowedModels.includes(`${model.provider}/${model.id}`);
}

export function isModelProviderAllowed(provider: string): boolean {
	return allowedModels === undefined || allowedModels.some((id) => id.startsWith(`${provider}/`));
}

export function assertModelRequestAllowed(model: { provider: string; id: string }): void {
	if (!isModelRequestAllowed(model)) {
		throw new Error(`Model request policy forbids ${model.provider}/${model.id}`);
	}
}

/** Preserve the launch contract even if answer/env overlays or extensions change env. */
export function inheritModelRequestPolicy<T extends Record<string, string | undefined>>(env: T): T {
	return allowedModels === undefined ? { ...env } : { ...env, GSD_MODEL_ALLOWLIST: JSON.stringify(allowedModels) };
}

export function assertModelSelectionAllowed(selection: string | undefined): void {
	if (selection === undefined || allowedModels === undefined) return;
	if (!allowedModels.some((id) => id === selection || id.slice(id.indexOf("/") + 1) === selection)) {
		throw new Error(`Model request policy forbids override ${selection}`);
	}
}
