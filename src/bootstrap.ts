#!/usr/bin/env node
// GSD Bootstrap
//
// Bin entry for the CLI. Installs made with --ignore-scripts never run the
// postinstall link step (scripts/link-workspace-packages.cjs), so compiled
// dist code that statically imports @gsd/* would fail with
// ERR_MODULE_NOT_FOUND on first invocation (#2061). This entry restores the
// @gsd/* resolution links in-process (best effort) and then starts the real
// loader. When the links already exist — the normal install — this is two
// existsSync calls before handing off.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(distDir, "..");

/**
 * Recreate node_modules/@gsd/* links for the workspace packages shipped under
 * packages/. Mirrors scripts/link-workspace-packages.cjs (symlink, with a
 * directory-copy fallback for Windows without symlink privileges) but is
 * dependency-free and safe to run on every start: existing links and real
 * directories are left untouched, and any failure is reported without
 * throwing so the loader can start (and fail with its own, clearer error)
 * when repair is genuinely impossible.
 */
export interface EnsureWorkspaceLinksOptions {
  /**
   * Override for the symlink primitive. Tests inject a throwing or recording
   * implementation: the native symlink path aborts on some macOS + Node
   * combinations when invoked repeatedly in one process, so tests exercise
   * the directory-copy fallback deterministically instead.
   */
  symlinkImpl?: typeof symlinkSync;
  /**
   * Override for the copy primitive. Node 26's fs.cpSync aborts with an
   * uncaught std::filesystem::equivalent error on macOS when copying a
   * workspace package onto its node_modules path (#2061 validation), so
   * tests inject a plain-recursive-copy implementation.
   */
  cpSyncImpl?: typeof cpSync;
}

export function ensureWorkspaceLinks(
  root: string = packageRoot,
  options: EnsureWorkspaceLinksOptions = {},
): { repaired: string[]; failed: string[] } {
  const repaired: string[] = [];
  const failed: string[] = [];
  const packagesDir = join(root, "packages");
  const scopeDir = join(root, "node_modules", "@gsd");
  if (!existsSync(packagesDir)) return { repaired, failed };

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;

    let packageName: string | undefined;
    try {
      packageName = JSON.parse(readFileSync(manifestPath, "utf8")).name;
    } catch {
      continue;
    }
    if (typeof packageName !== "string" || !packageName.startsWith("@gsd/")) continue;

    const target = join(scopeDir, packageName.slice("@gsd/".length));
    if (existsSync(target)) {
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(target);
          const intended = join(packagesDir, entry.name);
          const resolvedLink = resolve(dirname(target), linkTarget);
          if (resolvedLink === intended) continue; // already correctly linked
          rmSync(target, { force: true }); // wrong target: relink
        } else if (stat.isDirectory()) {
          continue; // real directory (copied fallback) — already resolvable
        } else {
          rmSync(target, { force: true }); // a file: replace
        }
      } catch {
        continue; // unreadable — leave it alone
      }
    }

    try {
      mkdirSync(scopeDir, { recursive: true });
      (options.symlinkImpl ?? symlinkSync)(join(packagesDir, entry.name), target, "junction");
      repaired.push(packageName);
    } catch {
      try {
        mkdirSync(scopeDir, { recursive: true });
        (options.cpSyncImpl ?? cpSync)(join(packagesDir, entry.name), target, { recursive: true });
        repaired.push(packageName);
      } catch (err) {
        failed.push(`${packageName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { repaired, failed };
}

// Compare real paths: macOS /tmp is a symlink to /private/tmp, and global
// installs may resolve through prefix symlinks — a raw path compare silently
// skips the bootstrap on such setups.
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly && process.argv.slice(2).some(arg =>
  arg === "coordination-maintenance" || arg.startsWith("coordination-maintenance=") ||
  arg === "--coordination-maintenance" || arg.startsWith("--coordination-maintenance="),
)) {
  // Native maintenance must branch before link repair AND the ordinary loader.
  // Even malformed/misplaced command tokens cannot fall back to a session.
  try {
    const { runCoordinationMaintenanceCli } = await import("./coordination-maintenance-cli.js");
    process.exitCode = await runCoordinationMaintenanceCli(process.argv.slice(2));
  } catch {
    process.stdout.write('{"requestId":null,"result":{"status":"refused","code":"maintenance-unavailable"}}\n');
    process.exitCode = 1;
  }
} else if (invokedDirectly) {
  const { repaired, failed } = ensureWorkspaceLinks(packageRoot);
  if (failed.length > 0) {
    console.error(
      "GSD could not repair its internal package links (this happens when installs skip lifecycle scripts).",
    );
    for (const failure of failed) console.error(`  - ${failure}`);
    console.error(
      "Run: node " + JSON.stringify(join(packageRoot, "scripts", "link-workspace-packages.cjs")) + " from the install directory, or reinstall without --ignore-scripts.",
    );
    process.exit(1);
  }
  if (repaired.length > 0) {
    console.error(`GSD repaired ${repaired.length} internal package link(s) on first run.`);
  }
  await import("./loader.js");
}
