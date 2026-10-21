// Project/App: gsd-pi
// File Purpose: Regression coverage for the public npm package identity.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const { resolveEngineOptionalDependencyVersion } = require(
	join(projectRoot, "scripts/lib/version-sync.cjs"),
) as { resolveEngineOptionalDependencyVersion: (version: string) => string };

function assertEngineDependency(engineSpec: string, nativeVersion: string, name: string): void {
	// Dev/next releases deliberately depend on the published stable engine.
	const engineVersion = resolveEngineOptionalDependencyVersion(nativeVersion);
	assert.ok(
		engineSpec.startsWith(">=") || engineSpec === engineVersion,
		`${name} optional dependency should be a range (>=…) or pinned to resolved engine version ${engineVersion}, got ${engineSpec}`,
	);
}

function readPackageJson(path: string): {
	name?: string;
	version?: string;
	optionalDependencies?: Record<string, string>;
} {
	return JSON.parse(readFileSync(join(projectRoot, path), "utf8"));
}

test("published npm package names use the @opengsd scope", () => {
	const rootPackage = readPackageJson("package.json");
	assert.equal(rootPackage.name, "@opengsd/gsd-pi");

	const platforms = [
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64-gnu",
		"linux-x64-gnu",
		"win32-x64-msvc",
	];

	for (const platform of platforms) {
		const nativePackage = readPackageJson(`native/npm/${platform}/package.json`);
		const expectedName = `@opengsd/engine-${platform}`;
		assert.equal(nativePackage.name, expectedName);
		const engineSpec = rootPackage.optionalDependencies?.[expectedName];
		assert.ok(
			engineSpec,
			`root package must install the ${expectedName} native optional dependency`,
		);
		assert.ok(nativePackage.version, `${expectedName} must declare its version`);
		assertEngineDependency(engineSpec, nativePackage.version, expectedName);
	}
});

test("native dependency identity honors stable, dev, and next release pins", () => {
	const name = "@opengsd/engine-darwin-arm64";
	for (const version of ["1.2.3", "1.2.3-dev.abc123", "1.2.3-next.abc123"]) {
		assert.doesNotThrow(() => assertEngineDependency("1.2.3", version, name));
		assert.doesNotThrow(() => assertEngineDependency(">=1.2.3", version, name));
		assert.throws(() => assertEngineDependency("1.2.4", version, name));
		if (version !== "1.2.3") {
			assert.throws(() => assertEngineDependency(version, version, name));
		}
	}
});
