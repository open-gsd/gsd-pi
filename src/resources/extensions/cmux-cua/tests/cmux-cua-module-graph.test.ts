import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Criterion 19-P01 (portable, partial): a cold import of the CUA extension in a
// fresh child process must leave no files under its isolated HOME.
//
// What is measured: files and directories that remain under the isolated HOME
// after `index.ts` is imported in the child. Only this filesystem effect is
// observed. Process creation is NOT reliably observed by this test.
// Not covered: non-Mac startup (19-P01 second half), native desktop behaviour.

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(here, "../index.ts");

function listTree(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			out.push(path.relative(root, full));
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
	return out.sort();
}

describe("cmux CUA module graph cold import (criterion 19-P01, partial)", () => {
	test("cold import of index.ts leaves no files under its isolated HOME", () => {
		const sandbox = mkdtempSync(path.join(tmpdir(), "cmux-cua-graph-"));
		const home = path.join(sandbox, "home");
		mkdirSync(home, { recursive: true });
		try {
			const probe = `await import(${JSON.stringify(indexPath)});`;
			// Minimal, explicit child environment: no inherited NODE_OPTIONS or XDG paths.
			const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe], {
				env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TMPDIR: sandbox, XDG_CONFIG_HOME: home },
				encoding: "utf8",
				timeout: 60_000,
			});
			assert.equal(r.status, 0, `cold import failed: ${r.stderr}`);
			assert.deepEqual(listTree(home), [], "cold import left files under HOME");
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
