// @gsd/pi-coding-agent + config-doc-paths.test — regression coverage for
// #2809. README.md, docs/, examples/, and CHANGELOG.md must resolve from this
// package's own root even when PI_PACKAGE_DIR points at the minimal published
// pkg/ branding layout (dist/ + package.json only, no documentation).
// Branding (piConfig name/configDir) and theme/export-template assets must
// keep following PI_PACKAGE_DIR.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this test's location to the nearest package.json — mirrors
 * config.ts getSelfPackageDir(), so the expectation holds in both the source
 * tree and the compiled dist-test mirror.
 */
function expectedSelfPackageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (dirname(dir) !== dir) {
		if (existsSync(join(dir, "package.json"))) return dir;
		dir = dirname(dir);
	}
	return dir;
}

test("doc paths resolve from the package root, independent of PI_PACKAGE_DIR branding shim", async (t) => {
	const pkgDir = mkdtempSync(join(tmpdir(), "pi-config-doc-paths-"));
	mkdirSync(join(pkgDir, "dist"), { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name: "gsd-pi-fixture",
			version: "1.21.1",
			piConfig: { name: "gsd", configDir: ".gsd" },
		}),
	);
	const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = pkgDir;
	t.after(() => {
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		rmSync(pkgDir, { recursive: true, force: true });
	});

	// Import after PI_PACKAGE_DIR is set so config.ts resolves against the
	// shim layout, matching the published gsd install.
	const { getReadmePath, getDocsPath, getExamplesPath, getChangelogPath, getThemesDir, APP_NAME, VERSION } =
		await import("../config.js");

	const selfRoot = resolve(expectedSelfPackageRoot());
	const shimRoot = resolve(pkgDir);

	// Documentation anchors at the real package root, never the shim.
	for (const [name, path, fileName] of [
		["getReadmePath", getReadmePath(), "README.md"],
		["getDocsPath", getDocsPath(), "docs"],
		["getExamplesPath", getExamplesPath(), "examples"],
		["getChangelogPath", getChangelogPath(), "CHANGELOG.md"],
	] as const) {
		assert.equal(resolve(path), join(selfRoot, fileName), `${name} must anchor at the package root`);
		assert.equal(
			resolve(path).startsWith(shimRoot + sep),
			false,
			`${name} must not resolve into the pkg/ branding shim: ${path}`,
		);
	}

	// Branding still follows PI_PACKAGE_DIR.
	assert.equal(APP_NAME, "gsd");
	assert.equal(VERSION, "1.21.1");
	assert.equal(
		getThemesDir().startsWith(shimRoot + sep),
		true,
		"themes must still resolve from the PI_PACKAGE_DIR branding root",
	);
});
