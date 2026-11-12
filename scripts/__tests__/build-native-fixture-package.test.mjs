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
    const root = buildNativeFixturePackage(source, { engineAddon: false });
    packages.push(root);
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.match(root.split('/').at(-1), /^w067-kernel-package-/);
    // Fixture-owned dependency directory: a real directory with per-dependency links.
    assert.ok(lstatSync(join(root, 'node_modules')).isDirectory());
    assert.ok(lstatSync(join(root, 'node_modules', 'typescript')).isSymbolicLink());
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
  const root = buildNativeFixturePackage(source, { engineAddon: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(readFileSync(join(root, 'dist', 'resources', 'skills', 'example', 'template.ts'), 'utf8'), 'interface {{TemplateName}} {}');
  assert.equal(existsSync(join(root, 'dist', 'resources', 'skills', 'example', 'template.js')), false);
});

test('fixture never links workspace packages back into the checkout', t => {
  const source = sourceFixture(t);
  rmSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'packages', 'native'), { recursive: true });
  mkdirSync(join(source, 'node_modules', '@gsd'), { recursive: true });
  symlinkSync(join(source, 'packages', 'native'), join(source, 'node_modules', '@gsd', 'native'), 'dir');
  symlinkSync(join(modules, 'typescript'), join(source, 'node_modules', 'typescript'), 'dir');
  const root = buildNativeFixturePackage(source, { engineAddon: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(existsSync(join(root, 'node_modules', '@gsd', 'native')), false, 'workspace link must not enter the fixture');
  assert.ok(existsSync(join(root, 'node_modules', 'typescript')), 'external dependency must still be linked');
});

test('builder links the dependency root, not the pnpm compiler package node_modules', t => {
  const source = sourceFixture(t);
  rmSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'node_modules'));
  symlinkSync(join(modules, 'typescript'), join(source, 'node_modules', 'typescript'), 'dir');
  const root = buildNativeFixturePackage(source, { engineAddon: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The fixture links the external dependency's real package directory, not the source's link path.
  assert.equal(realpathSync(join(root, 'node_modules', 'typescript')), realpathSync(join(modules, 'typescript')));
});

test('builder rejects source symlinks and removes partial packages', { skip: process.platform !== 'darwin' ? 'engine addon is a darwin prebuilt' : false }, t => {
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
  assert.throws(() => buildNativeFixturePackage(source, { engineAddon: false }), /did not produce dist\/bootstrap.js/);
});


test('builder ships the engine addon and compiled @gsd/native as fixture-owned copies, never links', { skip: process.platform !== 'darwin' ? 'engine addon is a darwin prebuilt' : false }, t => {
  const root = buildNativeFixturePackage();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const addon = join(root, 'node_modules', '@opengsd', `engine-${process.platform}-${process.arch}`, 'gsd_engine.node');
  assert.ok(existsSync(addon), 'engine addon must be copied into the fixture');
  assert.ok(!lstatSync(addon).isSymbolicLink(), 'addon must be a real file, not a link');
  const native = join(root, 'node_modules', '@gsd', 'native', 'dist', 'file-identity', 'index.js');
  assert.ok(existsSync(native), 'compiled @gsd/native must exist inside the fixture');
  assert.ok(!lstatSync(join(root, 'node_modules', '@gsd', 'native')).isSymbolicLink(), '@gsd/native must be a fixture-owned directory');
});

test('builder fails hard when no prebuilt engine addon exists', t => {
  const source = sourceFixture(t);
  // Replace the shared dependency link with an empty root: no pnpm store, so no addon.
  rmSync(join(source, 'node_modules'));
  mkdirSync(join(source, 'node_modules'));
  // Keep the compiler so the failure is the missing addon, not a missing typescript.
  symlinkSync(join(modules, 'typescript'), join(source, 'node_modules', 'typescript'), 'dir');
  assert.throws(
    () => buildNativeFixturePackage(source),
    /No prebuilt @opengsd\/engine-.* addon found/,
  );
});
