/**
 * System prompt docs-instruction regression tests.
 *
 * Regression coverage for issue #2809: the default system prompt must only
 * reference documentation paths that exist on disk, even when PI_PACKAGE_DIR
 * points at the minimal published pkg/ layout (dist/ + package.json only).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// NOTE: system-prompt.ts (via config.js) captures install-layout state at
// import time. Tests must import it dynamically AFTER arranging PI_PACKAGE_DIR
// so the module resolves against the fixture layout, not the checkout.

/** Extract the doc paths referenced by the "read the docs at ..." instruction. */
function parseReferencedDocPaths(prompt: string): string[] {
	const line = prompt.split("\n").find((l) => l.includes("When asked about pi internals"));
	if (!line) return [];
	const marker = "read the docs at ";
	const start = line.indexOf(marker);
	assert.ok(start !== -1, "docs instruction should list paths after 'read the docs at '");
	const end = line.indexOf("; follow cross-references", start);
	assert.ok(end !== -1, "docs instruction should end with '; follow cross-references'");
	return line
		.slice(start + marker.length, end)
		.split(", ")
		.flatMap((segment) =>
			segment.startsWith("and ")
				? [segment.slice(4)]
				: segment.includes(" and ")
					? segment.split(" and ")
					: [segment],
		)
		.filter((p) => p.length > 0);
}

/** Minimal published pkg/ layout: branding shim with no documentation. */
function createMinimalPublishedPkgLayout(): string {
	const pkgDir = mkdtempSync(join(tmpdir(), "gsd-system-prompt-pkg-"));
	mkdirSync(join(pkgDir, "dist"), { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({ name: "gsd-pi-fixture", version: "1.21.1", piConfig: { name: "gsd", configDir: ".gsd" } }),
	);
	return pkgDir;
}

describe("buildSystemPrompt docs instruction (#2809)", () => {
	test("only references documentation paths that exist on disk", async (t) => {
		const pkgDir = createMinimalPublishedPkgLayout();
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

		// Import after PI_PACKAGE_DIR is set so config.js resolves against the
		// shim layout, matching the published gsd install.
		const { buildSystemPrompt } = await import("./system-prompt.ts");

		const prompt = buildSystemPrompt({ cwd: process.cwd() });
		const referenced = parseReferencedDocPaths(prompt);

		assert.ok(referenced.length > 0, "docs instruction should reference at least one path when docs exist");
		for (const p of referenced) {
			assert.equal(existsSync(p), true, `docs instruction references nonexistent path: ${p}`);
		}
		const shimRoot = resolve(pkgDir);
		for (const p of referenced) {
			assert.equal(
				resolve(p).startsWith(shimRoot + sep),
				false,
				`docs instruction must not point into the pkg/ branding shim: ${p}`,
			);
		}
	});
});

describe("joinDocPaths", () => {
	test("formats one, two, and three doc paths", async () => {
		const { joinDocPaths } = await import("./system-prompt.ts");
		assert.equal(joinDocPaths(["/a/README.md"]), "/a/README.md");
		assert.equal(joinDocPaths(["/a/README.md", "/a/docs"]), "/a/README.md and /a/docs");
		assert.equal(
			joinDocPaths(["/a/README.md", "/a/docs", "/a/examples"]),
			"/a/README.md, /a/docs, and /a/examples",
		);
	});
});
