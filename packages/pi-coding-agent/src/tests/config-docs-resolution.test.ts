/**
 * Regression coverage for issue #2809: getReadmePath/getDocsPath/getExamplesPath
 * must resolve bundled SDK documentation independently of PI_PACKAGE_DIR.
 *
 * PI_PACKAGE_DIR is a branding/config override — gsd-pi sets it to a pkg/
 * shim directory (piConfig + theme assets only, no README.md/docs/examples;
 * see scripts/sync-pkg-version.cjs). Before the fix, getPackageDir() honored
 * PI_PACKAGE_DIR unconditionally, so the documentation getters resolved to
 * nonexistent pkg/README.md, pkg/docs, pkg/examples paths that the system
 * prompt then injected verbatim, producing ENOENT reads.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";

test("documentation path resolution ignores PI_PACKAGE_DIR branding override", async (t) => {
	const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
	let tempDir: string | undefined;

	t.after(() => {
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	await t.test(
		"getReadmePath/getDocsPath/getExamplesPath resolve to the real package root, not a minimal branding pkg/ dir",
		() => {
			// Simulate gsd-pi's branding shim: a pkg/ dir with package.json but no
			// README.md, docs/, or examples/ (see scripts/sync-pkg-version.cjs).
			tempDir = mkdtempSync(join(tmpdir(), "pi-docs-path-pkg-"));
			mkdirSync(join(tempDir, "dist"), { recursive: true });
			writeFileSync(
				join(tempDir, "package.json"),
				JSON.stringify({ name: "gsd-pi-branding-shim", version: "1.22.0", piConfig: { name: "gsd", configDir: ".gsd" } }),
			);
			process.env.PI_PACKAGE_DIR = tempDir;

			const readmePath = getReadmePath();
			const docsPath = getDocsPath();
			const examplesPath = getExamplesPath();

			// None of the resolved paths should point inside the branding shim —
			// that directory deliberately does not ship these assets.
			assert.equal(readmePath.startsWith(tempDir), false);
			assert.equal(docsPath.startsWith(tempDir), false);
			assert.equal(examplesPath.startsWith(tempDir), false);

			assert.equal(readmePath.endsWith(join("README.md")), true);
			assert.equal(docsPath.endsWith(join("docs")), true);
			assert.equal(examplesPath.endsWith(join("examples")), true);
		},
	);

	await t.test("getReadmePath/getDocsPath/getExamplesPath are unaffected when PI_PACKAGE_DIR is unset", () => {
		delete process.env.PI_PACKAGE_DIR;

		assert.doesNotThrow(() => getReadmePath());
		assert.doesNotThrow(() => getDocsPath());
		assert.doesNotThrow(() => getExamplesPath());
	});
});
