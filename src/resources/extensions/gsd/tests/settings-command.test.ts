/**
 * /gsd settings command behavior tests.
 *
 * Regression coverage for issue #2249: settings must not depend on unshipped
 * pkg/README.md, pkg/docs, or pkg/examples paths from PI_PACKAGE_DIR.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleSettings } from "../commands-gsd-core.ts";
import { getPreferencesReferencePath } from "../prompt-loader.ts";

function createMockPi() {
  const sent: Array<{ customType?: string; content: string }> = [];
  return {
    sent,
    sendMessage(message: { customType?: string; content: string }) {
      sent.push(message);
    },
  };
}

function createMockCtx() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    modelRegistry: {
      getAvailable: () => [],
    },
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

function createMinimalPublishedPkgLayout(): string {
  const pkgDir = mkdtempSync(join(tmpdir(), "gsd-settings-pkg-"));
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@opengsd/gsd-pi", version: "1.19.0" }));
  return pkgDir;
}

test("handleSettings embeds effective config and points at shipped preferences reference", async () => {
  const pi = createMockPi();
  const ctx = createMockCtx();

  await handleSettings("", ctx as any, pi as any);

  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0]?.customType, "gsd-settings");

  const content = pi.sent[0]?.content ?? "";
  assert.match(content, /GSD Configuration/);
  assert.match(content, /SOURCES/);
  assert.match(content, /do not search for or read package docs under `pkg\/README\.md`/);
  assert.ok(content.includes(getPreferencesReferencePath()));
});

test("handleSettings completes when PI_PACKAGE_DIR is minimal published pkg layout", async () => {
  const pkgDir = createMinimalPublishedPkgLayout();
  const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

  process.env.PI_PACKAGE_DIR = pkgDir;
  try {
    assert.equal(existsSync(join(pkgDir, "README.md")), false);
    assert.equal(existsSync(join(pkgDir, "docs")), false);
    assert.equal(existsSync(join(pkgDir, "examples")), false);

    const pi = createMockPi();
    const ctx = createMockCtx();

    await handleSettings("", ctx as any, pi as any);

    assert.equal(pi.sent.length, 1);
    assert.match(pi.sent[0]?.content ?? "", /GSD Configuration/);
    assert.equal(ctx.notifications.some((n) => n.level === "error"), false);
  } finally {
    if (originalPiPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiPackageDir;
    }
    rmSync(pkgDir, { recursive: true, force: true });
  }
});
