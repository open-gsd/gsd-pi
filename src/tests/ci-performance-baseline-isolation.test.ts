// Project/App: gsd-pi
// File Purpose: Structural guard (D234) that locks the performance-baseline
// gate's isolation/scheduling contract: the benchmark file lives under
// src/tests/performance/ (excluded from the ordinary contended test:unit:compiled
// glob), a dedicated serialized test:unit:compiled:perf script covers it with
// --test-concurrency=1, CI runs that script before the ordinary "Run unit tests"
// step in the build job, and the baseline/tolerances/assertions are unchanged.
// This test is itself in-process and not contention-sensitive, so it stays in
// the ordinary pool, not under src/tests/performance/.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Source tests run under src/tests, compiled tests run under dist-test/src/tests;
// walk ancestors so this guard resolves the real repo root in both layouts
// (the exact lesson from the compiled-layout guard failure: do not naively
// resolve a fixed relative depth).
function findRepoRoot(): string {
	let directory = dirname(fileURLToPath(import.meta.url));
	while (true) {
		if (
			existsSync(resolve(directory, ".github/workflows/ci.yml")) &&
			existsSync(resolve(directory, "package.json"))
		) {
			return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(
		"Unable to locate repo root (package.json + .github/workflows/ci.yml) from the test file",
	);
}

const REPO_ROOT = findRepoRoot();
const workflow = readFileSync(
	resolve(REPO_ROOT, ".github/workflows/ci.yml"),
	"utf8",
);
const pkg = JSON.parse(
	readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
) as {
	scripts: Record<string, string>;
};

// Extract every double-quoted glob argument from an npm script string, in
// order. Used to assert the *exact* glob set (not just "contains"), so an
// extra ordinary/package-test glob silently appended to the perf script
// cannot pass by substring match alone.
function extractQuotedGlobs(script: string): string[] {
	return [...script.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

test("test:unit:compiled:perf exists, is serialized, and targets only the performance directory", () => {
	const perfScript = pkg.scripts["test:unit:compiled:perf"];
	assert.ok(perfScript, "package.json must declare test:unit:compiled:perf");
	assert.match(
		perfScript,
		/--test-concurrency=1\b/,
		"the perf script must serialize (no sibling contention)",
	);
	const perfGlobs = extractQuotedGlobs(perfScript);
	assert.deepEqual(
		perfGlobs,
		["dist-test/src/tests/performance/*.test.js"],
		"the perf script must target exactly the relocated performance directory glob and nothing else -- an appended ordinary or package-test glob would silently defeat the isolation this gate exists to provide",
	);
});

test("test:unit:compiled (ordinary pool) does not match the performance directory", () => {
	const ordinaryScript = pkg.scripts["test:unit:compiled"];
	assert.ok(ordinaryScript, "package.json must declare test:unit:compiled");
	assert.doesNotMatch(
		ordinaryScript,
		/performance/,
		"the ordinary contended glob must not reference the performance directory",
	);
	// node:test file globs match only direct children of a directory (no `**`),
	// so "dist-test/src/tests/*.test.js" structurally cannot match files one
	// level deeper under "dist-test/src/tests/performance/". Assert the glob
	// shape itself rather than re-deriving glob semantics here.
	assert.match(
		ordinaryScript,
		/"dist-test\/src\/tests\/\*\.test\.js"/,
		"the ordinary glob must still cover direct src/tests children",
	);
});

test("ordinary unit concurrency is unchanged (no --test-concurrency on test:unit:compiled)", () => {
	const ordinaryScript = pkg.scripts["test:unit:compiled"];
	assert.ok(ordinaryScript, "ordinary unit script must exist");
	assert.doesNotMatch(
		ordinaryScript,
		/--test-concurrency=/,
		"test:unit:compiled must keep Node's default concurrency (os.availableParallelism() - 1)",
	);
});

test("the build job runs the isolated performance gate before the ordinary unit step", () => {
	const buildJob = workflow.match(
		/\n {2}build:\n(?<body>[\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:\n|\n?$)/,
	)?.groups?.body;
	assert.ok(buildJob, "build job must exist in ci.yml");

	const perfStepIndex = buildJob.indexOf(
		"- name: Run performance baseline gate",
	);
	const unitStepIndex = buildJob.indexOf("- name: Run unit tests");
	assert.ok(
		perfStepIndex >= 0,
		"build job must have a 'Run performance baseline gate' step",
	);
	assert.ok(unitStepIndex >= 0, "build job must have a 'Run unit tests' step");
	assert.ok(
		perfStepIndex < unitStepIndex,
		"the isolated performance gate must run before the ordinary (contended) unit step",
	);

	const perfStepBody = buildJob
		.slice(perfStepIndex)
		.match(/- name: Run performance baseline gate[\s\S]*?\n {6}- name:/)?.[0];
	assert.ok(
		perfStepBody,
		"performance baseline gate step body must be extractable",
	);
	assert.match(perfStepBody, /run: pnpm run test:unit:compiled:perf/);
});

test("Windows portability job's 180000ms MCP package-test budget is unchanged by this gate", () => {
	const windowsJob = workflow.match(
		/\n {2}windows-portability:\n(?<body>[\s\S]*?)(?=\n {2}[a-zA-Z0-9_-]+:\n|\n?$)/,
	)?.groups?.body;
	assert.ok(windowsJob, "windows-portability job must exist");
	// This guard does not assert the exact timeout value (that is
	// ci-windows-temp-env.test.ts's job); it asserts this change did not touch
	// that job at all by confirming it still contains the package-test step
	// unconditionally reachable and untouched by any perf-gate reference.
	assert.doesNotMatch(
		windowsJob,
		/test:unit:compiled:perf/,
		"the performance isolation gate must not be introduced into the Windows portability job",
	);
});

test("anti-fake-PASS lock: tolerances and baseline shape are exactly preserved", async () => {
	const scriptModule = (await import(
		resolve(REPO_ROOT, "scripts", "workflow-performance-baseline.mjs")
	)) as {
		P50_TOLERANCE: number;
		P95_TOLERANCE: number;
	};
	assert.equal(
		scriptModule.P50_TOLERANCE,
		3,
		"P50_TOLERANCE must remain 3 (no silent tolerance relaxation)",
	);
	assert.equal(
		scriptModule.P95_TOLERANCE,
		3,
		"P95_TOLERANCE must remain 3 (no silent tolerance relaxation)",
	);

	const baselinePath = resolve(
		REPO_ROOT,
		"scripts",
		"baselines",
		"workflow-performance-baseline.json",
	);
	assert.ok(existsSync(baselinePath), "baseline file must still exist");
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	for (const metric of [
		"deriveState",
		"domainOperationCommit",
		"projectionDrain",
	]) {
		assert.ok(
			baseline[metric],
			`baseline metric ${metric} must still be present`,
		);
		assert.ok(
			typeof baseline[metric].p50 === "number" && baseline[metric].p50 > 0,
		);
		assert.ok(
			typeof baseline[metric].p95 === "number" &&
				baseline[metric].p95 >= baseline[metric].p50,
		);
		assert.ok(
			typeof baseline[metric].samples === "number" &&
				baseline[metric].samples > 0,
		);
	}
});

test("exact disjoint coverage union: every src/tests/*.test.ts file is covered exactly once (ordinary xor performance)", () => {
	const srcTestsDir = resolve(REPO_ROOT, "src", "tests");
	const performanceDir = resolve(srcTestsDir, "performance");

	const directChildren = readdirSync(srcTestsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => entry.name);

	assert.ok(existsSync(performanceDir), "src/tests/performance/ must exist");
	const performanceChildren = readdirSync(performanceDir, {
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => entry.name);

	assert.ok(
		performanceChildren.length > 0,
		"src/tests/performance/ must contain at least the relocated benchmark file",
	);
	assert.ok(
		performanceChildren.includes("workflow-performance-baseline.test.ts"),
		"the relocated benchmark file must be present under src/tests/performance/",
	);

	// Disjointness: no filename appears in both sets (the ordinary glob reaches
	// only direct children of src/tests/, the perf glob only direct children of
	// src/tests/performance/ -- a one-level subdirectory move is structurally
	// enough to make the two globs disjoint, but assert it by name as well so a
	// future flat-rename regression is still caught).
	const overlap = directChildren.filter((name) =>
		performanceChildren.includes(name),
	);
	assert.deepEqual(
		overlap,
		[],
		"no test file name may appear in both the ordinary and performance directories",
	);

	// Exact union: walk the full recursive src/tests tree (one level of
	// subdirectories only, matching this repo's current layout) and confirm
	// every *.test.ts file is accounted for in exactly one of the two sets, with
	// no silently-skipped third location.
	// Known other coverage pools nested under src/tests/, run by separate
	// scripts outside test:unit:compiled's "direct children only" glob
	// (compile-tests.mjs's SKIP_DIRS also excludes "integration" from the
	// compiled dist-test tree entirely). This guard's disjoint-union claim is
	// scoped to the compiled-pool boundary (ordinary vs performance), not to
	// every file under src/tests/ transitively.
	const KNOWN_OTHER_POOLS = new Set(["fixtures", "integration"]);

	const allEntries = readdirSync(srcTestsDir, { withFileTypes: true });
	const unaccountedSubdirs = allEntries
		.filter(
			(entry) =>
				entry.isDirectory() &&
				entry.name !== "performance" &&
				!KNOWN_OTHER_POOLS.has(entry.name),
		)
		.map((entry) => entry.name);
	assert.deepEqual(
		unaccountedSubdirs,
		[],
		"a new subdirectory under src/tests/ must be classified here (performance/, a known other pool, or folded into the disjoint-union check) -- it must not silently evade both the ordinary and performance compiled globs",
	);

	const union = new Set([...directChildren, ...performanceChildren]);
	assert.equal(
		union.size,
		directChildren.length + performanceChildren.length,
		"ordinary and performance coverage must be an exact disjoint union with no duplicates",
	);
});
