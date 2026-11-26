#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const catalogDir = process.argv[2];
if (!catalogDir) {
	throw new Error("catalog directory is required");
}

const jsonPath = join(catalogDir, "models.generated.json");
let providerCounts;

if (existsSync(jsonPath)) {
	const catalog = JSON.parse(readFileSync(jsonPath, "utf8"));
	providerCounts = Object.fromEntries(
		Object.entries(catalog).map(([provider, models]) => [provider, Object.keys(models).length]),
	);
} else {
	const lines = readFileSync(join(catalogDir, "models.generated.ts"), "utf8").split("\n");
	const jsonString = '"(?:\\\\.|[^"\\\\])*"';
	const providerLine = new RegExp(`^\\t(${jsonString}): \\{$`);
	const modelLine = new RegExp(`^\\t\\t${jsonString}: \\{$`);
	providerCounts = {};
	let currentProvider;

	for (const line of lines) {
		const providerMatch = providerLine.exec(line);
		if (providerMatch) {
			currentProvider = JSON.parse(providerMatch[1]);
			providerCounts[currentProvider] = 0;
		} else if (currentProvider && modelLine.test(line)) {
			providerCounts[currentProvider] += 1;
		}
	}
}

const providers = Object.keys(providerCounts).length;
const models = Object.values(providerCounts).reduce((count, providerModels) => count + providerModels, 0);
console.log(`providers=${providers}`);
console.log(`models=${models}`);
console.log(`provider_counts=${JSON.stringify(providerCounts)}`);
