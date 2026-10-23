// Real public-entry regressions for cancellation followed by a rejected startup await.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function findRepositoryTestRoot(startPath: string): string {
  let root = startPath;
  // Compiled tests contain their own scripts/package.json copies. Loading that
  // copied hook makes its URL-relative aliases resolve dist-test/dist-test/;
  // both the import hook and child cwd must use the workspace root.
  while (!existsSync(join(root, "pnpm-workspace.yaml")) ||
    !existsSync(join(root, "scripts", "dist-test-resolve.mjs"))) {
    const parent = dirname(root);
    assert.notEqual(parent, root, "repository test resolver must exist");
    root = parent;
  }
  return root;
}

test("compiled fixtures use the repository root, not copied dist-test scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-startup-fixture-root-"));
  try {
    const compiledRoot = join(root, "dist-test");
    for (const directory of [root, compiledRoot]) {
      mkdirSync(join(directory, "scripts"), { recursive: true });
      writeFileSync(join(directory, "scripts", "dist-test-resolve.mjs"), "");
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    }
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    assert.equal(findRepositoryTestRoot(join(compiledRoot, "src", "tests")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [mode, title] of [
  ["resume", "resume startup cannot continue after a cancelled awaited operation rejects"],
  ["fresh", "fresh startup cannot continue after a cancelled awaited operation rejects"],
  ["deferred", "stop cancels a guided idle fallback after its original public startup finishes"],
  ["deferred-normal", "an uncancelled guided idle fallback still launches after its original public startup finishes"],
] as const) {
  test(title, { timeout: 75_000 }, () => {
    const source = import.meta.url.endsWith(".ts");
    const fixture = new URL(`./helpers/auto-startup-rejection.fixture.${source ? "ts" : "js"}`, import.meta.url);
    const root = findRepositoryTestRoot(dirname(fileURLToPath(import.meta.url)));
    const output = execFileSync(process.execPath, [
      "--experimental-test-module-mocks", "--import",
      source ? "tsx" : join(root, "scripts", "dist-test-resolve.mjs"),
      fileURLToPath(fixture), mode,
    ], { cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    assert.match(output, /"passed":true/, "isolated fixture must complete all cancellation assertions");
  });
}
