#!/usr/bin/env node

const [beforeJson, afterJson] = process.argv.slice(2);
if (!beforeJson || !afterJson) {
	throw new Error("before and after provider counts are required");
}

const before = JSON.parse(beforeJson);
const after = JSON.parse(afterJson);
const drops = Object.entries(before)
	.filter(([, beforeCount]) => beforeCount > 0)
	.map(([provider, beforeCount]) => [provider, beforeCount, after[provider] ?? 0])
	.filter(([, beforeCount, afterCount]) => afterCount * 2 < beforeCount)
	.sort(([left], [right]) => left.localeCompare(right));

console.log(`suspicious=${drops.length > 0}`);
console.log(`providers=${drops.map(([provider, beforeCount, afterCount]) => `${provider} (${beforeCount} to ${afterCount})`).join(", ")}`);
