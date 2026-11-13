#!/usr/bin/env node
// Fixture automation only: emit this checkout into tmpdir, never an installed package.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirs = new Set(['tests', '__tests__', 'node_modules', '.git', 'web']);
const excludedFile = /(?:\.(?:test|spec)\.[^.]+$|^\.DS_Store$)/;


function linkExternalDependencies(source, target) {
  // The workspace root is the directory that owns the node_modules being linked. A
  // dependency whose real path lives under that root's packages/ tree is a workspace
  // link: it executes workspace code outside the fixture, so it is never linked.
  const workspaceRoot = realpathSync(join(source, '..'));
  const workspacePackages = join(workspaceRoot, 'packages') + '/';
  mkdirSync(target, { recursive: true });
  const linkEntry = (from, to) => {
    let real;
    try { real = realpathSync(from); } catch { return; } // dangling link: not a usable dependency
    if (real.startsWith(workspacePackages)) return;
    symlinkSync(real, to, 'dir');
  };
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      mkdirSync(join(target, entry.name), { recursive: true });
      for (const scoped of readdirSync(join(source, entry.name), { withFileTypes: true })) {
        linkEntry(join(source, entry.name, scoped.name), join(target, entry.name, scoped.name));
      }
      continue;
    }
    linkEntry(join(source, entry.name), join(target, entry.name));
  }
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

// Platform engine addon: resolved from a published prebuilt package (plain file) rather
// than compiled here. Copied, never linked, so fixture code cannot reach shared installs.
function copyNativeEnginePackage(target, modules) {
  const platformTag = `${process.platform}-${process.arch}`;
  const packageName = `@opengsd/engine-${platformTag}`;
  const candidates = [];
  // The dependency root's real path owns the pnpm store; derive it, do not guess a sibling path.
  const pnpmStore = join(realpathSync(modules), '.pnpm');
  // A dependency root without a pnpm store has no published addon; the hard error below still applies.
  const storeEntries = existsSync(pnpmStore) ? readdirSync(pnpmStore) : [];
  for (const entry of storeEntries) {
    if (entry.startsWith(`@opengsd+engine-${platformTag}@`)) {
      candidates.push(join(pnpmStore, entry, 'node_modules', packageName));
    }
  }
  const source = candidates.find(dir => existsSync(join(dir, 'gsd_engine.node')));
  if (!source) throw new Error(`No prebuilt ${packageName} addon found; native fixture cannot be isolated`);
  const dest = join(target, '@opengsd', `engine-${platformTag}`);
  // The dependency pass may have linked this exact entry into the shared store. Remove any
  // existing link first, so the copy below is always a real directory we own.
  if (existsSync(dest) || lstatExists(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(source, 'package.json'), join(dest, 'package.json'));
  copyFileSync(join(source, 'gsd_engine.node'), join(dest, 'gsd_engine.node'));
}

// @gsd/native source is copied as a real fixture-owned package. Its own imports
// (native.ts loader) resolve to the copied addon above, never to the checkout.
function copyWorkspaceNative(target, sourceRoot) {
  const pkgSrc = join(sourceRoot, 'packages', 'native');
  const dest = join(target, '@gsd', 'native');
  if (!existsSync(join(pkgSrc, 'package.json'))) return; // stub roots (tests) have no workspace package
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(pkgSrc, 'package.json'), join(dest, 'package.json'));
  const copyTree = (dir, out) => {
    mkdirSync(out, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || /\.test\.[^.]+$/.test(entry.name)) continue;
      const from = join(dir, entry.name);
      if (lstatSync(from).isSymbolicLink()) throw new Error(`@gsd/native source must not contain symlinks: ${from}`);
      if (entry.isDirectory()) copyTree(from, join(out, entry.name));
      else copyFileSync(from, join(out, entry.name));
    }
  };
  copyTree(join(pkgSrc, 'src'), join(dest, 'src'));
  // Compile @gsd/native to the fixture-owned dist/ with the checkout's own TypeScript,
  // so the engine's dist/ import paths resolve inside the fixture (never a shared build).
  // Self-contained config inside the fixture copy: no extends, no checkout tsconfig.
  writeFileSync(join(dest, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: false,
      skipLibCheck: true, types: ['node'], rootDir: 'src', outDir: 'dist', declaration: false,
      esModuleInterop: true, allowImportingTsExtensions: false,
      // Resolve @types from the fixture's own dependency directory only (never the checkout).
      typeRoots: [join(target, '@types')],
    },
    include: ['src'],
  }, null, 2));
  const tscPath = join(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscPath, '-p', join(dest, 'tsconfig.json')], {
    cwd: dest, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
  });
  // Fail closed: a half-compiled @gsd/native must never be packaged as if it were complete.
  if (result.status !== 0 || result.error) {
    throw new Error(`@gsd/native fixture compile failed (${result.status ?? 'no status'}): ${result.error?.message ?? ''}${result.stdout}${result.stderr}`);
  }
}

export function buildNativeFixturePackage(sourceRoot = checkout, { engineAddon = true } = {}) {
  const require = createRequire(join(sourceRoot, 'package.json'));
  const compiler = realpathSync(require.resolve('typescript/bin/tsc'));
  const modules = realpathSync(join(sourceRoot, 'node_modules'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'w067-kernel-package-'));
  try {
    copyFileSync(join(sourceRoot, 'package.json'), join(root, 'package.json'));
    // Fixture-owned dependency directory: link ONLY external dependencies. Workspace
    // links (for example @gsd/* -> ../../packages/*) point back into the checkout and
    // would execute workspace code outside the fixture, so they are excluded.
    linkExternalDependencies(modules, join(root, 'node_modules'));
    // The native engine addon is a prebuilt plain file, not workspace source. Copy it
    // as a fixture-owned @opengsd/engine-<platform> package so the loader resolves it
    // through its normal fallback without touching the checkout or a shared install.
    if (engineAddon) copyNativeEnginePackage(join(root, 'node_modules'), modules);
    // @gsd/native TypeScript (file-identity, ps, ...) is imported by the copied engine.
    // Emit it into a fixture-owned @gsd/native package so its imports resolve in-fixture.
    copyWorkspaceNative(join(root, 'node_modules'), sourceRoot);
    const files = [];
    function copySources(dir) {
      for (const entry of readdirSync(join(sourceRoot, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (excludedDirs.has(entry.name) || excludedFile.test(entry.name)) continue;
        const path = join(dir, entry.name);
        if (lstatSync(join(sourceRoot, path)).isSymbolicLink()) {
          throw new Error(`Fixture source must not contain symlinks: ${path}`);
        }
        if (entry.isDirectory()) {
          copySources(path);
          continue;
        }
        mkdirSync(dirname(join(root, path)), { recursive: true });
        copyFileSync(join(sourceRoot, path), join(root, path));
        const resourceOnly = path.startsWith(join('src', 'resources', 'skills') + '/')
          || path.startsWith(join('src', 'resources', 'agents') + '/');
        if (!resourceOnly && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
          files.push(path);
        } else {
          // Match copy-resources.cjs: emitted JS wins over stale source siblings.
          if (entry.name.endsWith('.js') && ['.ts', '.tsx'].some(ext => existsSync(join(sourceRoot, dir, entry.name.slice(0, -3) + ext)))) continue;
          const dest = join(root, 'dist', relative('src', path));
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(join(sourceRoot, path), dest);
        }
      }
    }
    copySources('src');
    writeFileSync(join(root, 'tsconfig.fixture.json'), JSON.stringify({
      compilerOptions: {
        noCheck: true, noResolve: true, target: 'ES2022', module: 'NodeNext',
        moduleResolution: 'NodeNext', jsx: 'react-jsx', rootDir: 'src', outDir: 'dist',
        rewriteRelativeImportExtensions: true,
      },
      files,
    }, null, 2));
    const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.fixture.json'], {
      cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`Fixture emit failed (${result.status}): ${result.error?.message ?? ''}\n${result.stdout}${result.stderr}`);
    }
    if (!existsSync(join(root, 'dist', 'bootstrap.js'))) throw new Error('Fixture emit did not produce dist/bootstrap.js');
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildNativeFixturePackage());
}
