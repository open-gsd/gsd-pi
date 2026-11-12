import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { buildNativeFixturePackage } from '../build-native-fixture-package.mjs';

const modules = realpathSync(new URL('../../node_modules', import.meta.url));

function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-builder-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'resources', 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  symlinkSync(modules, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'src', 'bootstrap.ts'), 'import { value } from "./resources/value.ts"; console.log(value);');
  writeFileSync(join(root, 'src', 'resources', 'value.ts'), 'export const value: number = 42;');
  writeFileSync(join(root, 'src', 'resources', 'value.js'), 'throw new Error("stale output");');
  writeFileSync(join(root, 'src', 'resources', 'data.json'), '{"fixture":true}');
  writeFileSync(join(root, 'src', 'resources', 'tests', 'hidden.ts'), 'invalid syntax');
  writeFileSync(join(root, 'src', 'resources', 'hidden.test.ts'), 'invalid syntax');
  return root;
}

function manifest(root, dir = root) {
  return Object.fromEntries(readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    if (lstatSync(path).isSymbolicLink()) return [];
    if (lstatSync(path).isDirectory()) return Object.entries(manifest(root, path));
    return [[relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')]];
  }));
}

test('builder emits isolated, repeatable checkout code and resources without stale dist or test dependencies', t => {
  const source = sourceFixture(t);
  const before = manifest(source);
  const packages = [];
  t.after(() => packages.forEach(root => rmSync(root, { recursive: true, force: true })));
  for (let n = 0; n < 2; n++) {
    const root = buildNativeFixturePackage(source);
    packages.push(root);
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.match(root.split('/').at(-1), /^w067-kernel-package-/);
    assert.ok(lstatSync(join(root, 'node_modules')).isSymbolicLink());
    assert.equal(realpathSync(join(root, 'node_modules')), modules);
    assert.ok(!lstatSync(join(root, 'dist')).isSymbolicLink());
    assert.equal(existsSync(join(root, 'dist', 'resources', 'tests')), false);
    assert.equal(existsSync(join(root, 'dist', 'resources', 'hidden.test.js')), false);
    assert.equal(readFileSync(join(root, 'dist', 'resources', 'data.json'), 'utf8'), '{"fixture":true}');
    const result = spawnSync(process.execPath, [join(root, 'dist', 'bootstrap.js')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '42');
  }
  assert.deepEqual(manifest(packages[0]), manifest(packages[1]));
  assert.deepEqual(manifest(source), before, 'source must remain immutable');
});

test('builder treats skill templates as resources, not TypeScript programs', t => {
  const source = sourceFixture(t);
  mkdirSync(join(source, 'src', 'resources', 'skills', 'example'), { recursive: true });
  writeFileSync(join(source, 'src', 'resources', 'skills', 'example', 'template.ts'), 'interface {{TemplateName}} {}');
  const root = buildNativeFixturePackage(source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readFileSync(join(root, 'dist', 'resources', 'skills', 'example', 'template.ts'), 'utf8'), 'interface {{TemplateName}} {}');
  assert.equal(existsSync(join(root, 'dist', 'resources', 'skills', 'example', 'template.js')), false);
});

test('builder links the dependency root, not the pnpm compiler package node_modules', t => {
  const source = sourceFixture(t);
  rmSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'node_modules'));
  symlinkSync(join(modules, 'typescript'), join(source, 'node_modules', 'typescript'), 'dir');
  const root = buildNativeFixturePackage(source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(realpathSync(join(root, 'node_modules')), realpathSync(join(source, 'node_modules')));
});

test('builder rejects source symlinks and removes partial packages', t => {
  const source = sourceFixture(t);
  symlinkSync(join(source, 'src', 'bootstrap.ts'), join(source, 'src', 'linked.ts'));
  // Use a private temp parent: other CI jobs may be building fixtures concurrently.
  const temp = join(source, 'temp');
  mkdirSync(temp);
  const builder = new URL('../build-native-fixture-package.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { buildNativeFixturePackage } from ${JSON.stringify(builder)}; buildNativeFixturePackage(process.argv[1]);`, source], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain symlinks/);
  assert.deepEqual(readdirSync(temp), []);
});

test('builder requires emitted bootstrap and cleans up failures', t => {
  const source = sourceFixture(t);
  rmSync(join(source, 'src', 'bootstrap.ts'));
  assert.throws(() => buildNativeFixturePackage(source), /did not produce dist\/bootstrap.js/);
});

