import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.github/workflows/ci.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

function windowsPackageTestStep(): string {
	const job = workflow.match(
		/ {2}windows-portability:\n(?<body>[\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:\n|\n?$)/,
	)?.groups?.body;
	assert.ok(job, "windows-portability job must exist");
	assert.match(job, /runs-on:\s*\$\{\{\s*github\.repository_owner/);

	const step = job.match(
		/ {6}- name: Run package tests\n(?<body>[\s\S]*?)(?=\n {6}- name:|\n?$)/,
	)?.groups?.body;
	assert.ok(step, "Windows Run package tests step must exist");
	return step;
}

test("Windows package tests keep temp overrides step-local", () => {
	const step = windowsPackageTestStep();

	for (const variable of ["TEMP", "TMP", "TMPDIR"]) {
		assert.match(
			step,
			new RegExp(`^\\s+${variable}: \\$\\{\\{ runner\\.temp \\}\\}$`, "m"),
			`${variable} must point to runner.temp in the Windows package-test step`,
		);
	}

	assert.match(step, /GSD_NATIVE_PREFER_LOCAL: '1'/);
	assert.match(step, /run: pnpm run test:packages/);
	assert.doesNotMatch(
		workflow,
		/^env:\n(?: {2}.*\n)* {2}(?:TEMP|TMP|TMPDIR): \$\{\{ runner\.temp \}\}/m,
		"temp overrides must not become a cross-job or cross-OS environment",
	);
});
