// Shared cost rounding for the generated catalog writers. The TypeScript
// writer (formatCost) and the JSON snapshot must emit identical values, so
// both go through roundCost; raw floats carry binary noise that would
// otherwise desynchronize the two outputs.

export function roundCost(value: number): number {
	if (!Number.isFinite(value)) {
		throw new Error("Model costs must be finite numbers.");
	}
	const rounded = Number(value.toFixed(12));
	return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatCost(value: number): string {
	return String(roundCost(value));
}
