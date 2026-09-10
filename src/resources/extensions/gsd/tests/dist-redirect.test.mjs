import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from './dist-redirect.mjs';

// Mirrors how workspace packages are linked in a real checkout: the package
// lives outside node_modules and is symlinked into node_modules/<scope>/<name>,
// so the resolver's node_modules walk finds the fixture like a workspace link.
function fixturePackage(root, name, manifest, { withDist = false } = {}) {
  const pkgDir = join(root, 'packages', name.replace('@opengsd/', ''));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest));
  if (withDist) {
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};\n');
  }
  const linkDir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(join(linkDir, '..'), { recursive: true });
  symlinkSync(pkgDir, linkDir, 'dir');
  const parent = join(root, 'parent.mjs');
  writeFileSync(parent, 'export {};\n');
  return { parentURL: pathToFileURL(parent).href };
}

// Stands in for Node's default resolver, which throws the bare
// ERR_MODULE_NOT_FOUND seen in fresh worktrees with unbuilt packages.
const throwingNext = (specifier, context) => {
  const error = new Error(`Cannot find module '${specifier}' imported from ${context.parentURL}`);
  error.code = 'ERR_MODULE_NOT_FOUND';
  throw error;
};

test('resolve fails loud with the build command when a workspace dist entry is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-dist-redirect-'));
  try {
    const context = fixturePackage(root, '@opengsd/fake-unbuilt-pkg', {
      name: '@opengsd/fake-unbuilt-pkg',
      exports: {
        '.': { import: './dist/index.js' },
        './readers/graph': { import: './dist/readers/graph.js' },
      },
    });

    assert.throws(
      () => resolve('@opengsd/fake-unbuilt-pkg/readers/graph', context, throwingNext),
      /Workspace package "@opengsd\/fake-unbuilt-pkg" dist not found \(missing dist\/readers\/graph\.js\)\. Build it first: pnpm --filter @opengsd\/fake-unbuilt-pkg build/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolve delegates untouched when the workspace dist entry exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-dist-redirect-'));
  try {
    const context = fixturePackage(root, '@opengsd/fake-built-pkg', {
      name: '@opengsd/fake-built-pkg',
      exports: { '.': { import: './dist/index.js' } },
    }, { withDist: true });

    const sentinel = { url: 'file:///sentinel', format: 'module', shortCircuit: true };
    const next = () => sentinel;
    assert.equal(resolve('@opengsd/fake-built-pkg', context, next), sentinel);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolve rethrows the original error for packages without a workspace link', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsd-dist-redirect-'));
  try {
    const parent = join(root, 'parent.mjs');
    writeFileSync(parent, 'export {};\n');
    const context = { parentURL: pathToFileURL(parent).href };

    assert.throws(
      () => resolve('@opengsd/never-linked-pkg', context, throwingNext),
      (error) => error.code === 'ERR_MODULE_NOT_FOUND' &&
        error.message.includes("Cannot find module '@opengsd/never-linked-pkg'"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
