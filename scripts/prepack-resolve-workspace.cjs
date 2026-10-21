#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');

const {
  INTERNAL_PACKAGE_NAMES,
  RELEASE_WORKSPACE_PACKAGE_DIRS,
} = require('./lib/version-sync.cjs');

const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');
const STANDALONE_WEB_PACKAGE_JSON = path.join(ROOT, 'dist', 'web', 'standalone', 'package.json');
const TARGET_PACKAGE_JSONS = [
  ROOT_PACKAGE_JSON,
  STANDALONE_WEB_PACKAGE_JSON,
  ...RELEASE_WORKSPACE_PACKAGE_DIRS.map((dir) => path.join(ROOT, dir, 'package.json')),
];
const DROP_INTERNAL_DEPS_PACKAGE_JSONS = new Set([
  ROOT_PACKAGE_JSON,
  STANDALONE_WEB_PACKAGE_JSON,
]);

// Recover from a backup left behind by a previous prepack that was hard-killed
// before postpack could restore (SIGKILL skips the EXIT trap). The manifests on
// disk are in the mutated (^version / dropped-deps) state; restore the canonical
// workspace:* originals from the leftover backup BEFORE doing any new work, so we
// never re-resolve already-resolved manifests or — worse — delete the only copy
// of the originals further down when nothing appears to need resolving.
function restoreFromBackupDir(currentDir, relativeDir = '') {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const sourcePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      restoreFromBackupDir(sourcePath, relPath);
      continue;
    }
    const targetPath = path.join(ROOT, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function recoverStaleBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  console.warn('[prepack] Found a stale .prepack-backup from an interrupted run; restoring originals before resolving.');
  restoreFromBackupDir(BACKUP_DIR);
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function usesWorkspaceProtocol(pkg) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range === 'workspace:*' || range === '*') return true;
    }
  }
  return false;
}

function resolvePackageJson(filePath) {
  if (!fs.existsSync(filePath)) return false;

  const pkg = readJson(filePath);
  if (!usesWorkspaceProtocol(pkg)) return false;

  const version = pkg.version;
  const dropInternalDeps = DROP_INTERNAL_DEPS_PACKAGE_JSONS.has(filePath);
  const relPath = path.relative(ROOT, filePath);
  const backupPath = path.join(BACKUP_DIR, relPath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);

  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const [dep, range] of Object.entries(pkg[field])) {
      if (!INTERNAL_PACKAGE_NAMES.has(dep)) continue;
      if (range !== 'workspace:*' && range !== '*') continue;
      if (dropInternalDeps) {
        // The published root no longer bundles workspace packages. Internal @gsd/@opengsd
        // packages are NOT on the public registry — they ship inside this tarball under
        // packages/*/dist and are symlinked into node_modules at postinstall by
        // link-workspace-packages.cjs. The staged Next standalone package.json is also
        // packed under dist/web/standalone and is scanned by npm during global install.
        // Leaving internal workspace ranges in either manifest makes npm fail before
        // postinstall can repair links. Drop them; runtime resolution goes through the
        // root package and generated standalone server bundle.
        delete pkg[field][dep];
        changed = true;
      } else {
        // Workspace package manifests ship as files (never npm-installed), so their
        // internal ranges are informational only. Pin to ^version for a clean tarball.
        const resolved = `^${version}`;
        if (pkg[field][dep] !== resolved) {
          pkg[field][dep] = resolved;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeJson(filePath, pkg);
    console.log(
      dropInternalDeps
        ? `[prepack] Removed internal workspace deps from ${relPath} (shipped via files + postinstall link)`
        : `[prepack] Resolved workspace:* internal deps in ${relPath} to ^${version}`,
    );
  }
  return changed;
}

recoverStaleBackup();

let resolvedAny = false;
for (const filePath of TARGET_PACKAGE_JSONS) {
  if (resolvePackageJson(filePath)) {
    resolvedAny = true;
  }
}

if (!resolvedAny && fs.existsSync(BACKUP_DIR)) {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}
