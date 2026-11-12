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

export function buildNativeFixturePackage(sourceRoot = checkout) {
  const require = createRequire(join(sourceRoot, 'package.json'));
  const compiler = realpathSync(require.resolve('typescript/bin/tsc'));
  const modules = realpathSync(join(sourceRoot, 'node_modules'));
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'w067-kernel-package-'));
  try {
    copyFileSync(join(sourceRoot, 'package.json'), join(root, 'package.json'));
    // The only symlink in the fixture points to dependencies, not checkout code/dist.
    symlinkSync(modules, join(root, 'node_modules'), 'dir');
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
