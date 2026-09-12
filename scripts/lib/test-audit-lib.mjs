/**
 * Shared test inventory / runner classification for audit scripts.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { getLinkablePackages } = require('./workspace-manifest.cjs');

export const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js|cjs)$/;
export const SRC_RE = /\.(?:ts|tsx|mjs|js)$/;
// `worktrees` covers the checkouts that nest inside the repo (.worktrees/,
// .claude/worktrees/, .gsd-worktrees/): their copies of every test file are
// not this checkout's tests, and counting them buries the audit in tens of
// thousands of phantom "unwired" entries locally.
export const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-test', '.cache', 'templates',
  'worktrees', '.worktrees', '.gsd-worktrees',
]);

export const UNIT_EXTENSION_GLOBS = new Set([
  'gsd',
  'shared',
  'subagent',
  'claude-code-cli',
  'cursor-cli',
  'github-sync',
  'universal-config',
  'visual-brief',
  'voice',
  'mcp-client',
  'remote-questions',
]);

export const INTEGRATION_EXTENSION_GLOBS = new Set([
  'async-jobs',
  'ollama',
  'browser-tools',
  'mac-tools',
  'search-the-web',
  'bg-shell',
  'slash-commands',
]);

export const SOURCE_ROOTS = ['src', 'packages', 'scripts', 'web', 'vscode-extension', 'integrations'];

// Archived material is kept for provenance only: nothing imports it and no
// runner executes it, so it must not register as live test or source surface.
export const ARCHIVED_PATH_PREFIXES = ['scripts/archive/'];

export const AUXILIARY_TEST_SCRIPTS = new Set([
  'test:browser-tools',
  'test:secret-scan',
  'test:smoke',
  'test:marketplace',
  'test:live',
  'test:live-regression',
  'test:native',
  'test:e2e',
  'test:e2e:docker',
  'test:e2e:windows-smoke',
]);

export const NPM_TEST_RUNNERS = new Set(['unit', 'integration', 'integration-or-browser-tools', 'packages', 'e2e']);

export const VERIFY_FAST_RUNNERS = new Set([...NPM_TEST_RUNNERS, 'scripts-fast-gates']);

export function normalize(path) {
  return path.replaceAll('\\', '/');
}

export function walk(dir, cb, skip = SKIP_DIRS) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb, skip);
    else cb(full);
  }
}

export function isArchivedPath(path) {
  const p = normalize(path);
  return ARCHIVED_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function collectTestFiles(root) {
  const files = [];
  walk(root, (full) => {
    if (!TEST_RE.test(full)) return;
    const rel = normalize(relative(root, full));
    if (isArchivedPath(rel)) return;
    files.push(rel);
  });
  return files.sort();
}

export function classifyRunner(testPath) {
  if (testPath.startsWith('tests/e2e/')) return 'e2e';
  if (testPath.startsWith('tests/smoke/') || testPath.startsWith('tests/live')) return 'release-pipeline';
  if (testPath.startsWith('scripts/__tests__/')) return 'scripts-fast-gates';
  if (testPath.startsWith('web/') || testPath.startsWith('vscode-extension/')) {
    return 'ui-sparse-manual';
  }
  if (testPath.startsWith('packages/')) return 'packages';
  // Host integrations (integrations/<host>) run their own test script in their
  // own workflow (hermes-integration.yml, openclaw-integration.yml), not in a
  // root npm lane.
  if (testPath.startsWith('integrations/')) return 'integrations';

  if (testPath.startsWith('src/resources/extensions/')) {
    const ext = testPath.split('/')[3];
    if (ext === 'gsd' && testPath.includes('/integration/')) return 'integration';
    if (INTEGRATION_EXTENSION_GLOBS.has(ext)) return 'integration';
    if (UNIT_EXTENSION_GLOBS.has(ext)) return 'unit';
    return 'unwired';
  }

  if (testPath.startsWith('src/tests/integration/')) return 'integration';
  if (testPath.startsWith('src/tests/')) return 'unit';
  return 'unknown';
}

export function isReachableTest(runner) {
  return VERIFY_FAST_RUNNERS.has(runner) || runner === 'release-pipeline' || runner === 'ui-sparse-manual' || runner === 'integrations';
}

export function isInNpmTest(runner) {
  return NPM_TEST_RUNNERS.has(runner);
}

export function candidateTestsForSource(path) {
  const normalized = normalize(path);
  const dir = dirname(normalized);
  const extless = basename(normalized).replace(/\.(?:ts|tsx|mjs|js)$/, '');
  const candidates = new Set([
    `${dir}/tests/${extless}.test.ts`,
    `${dir}/tests/${extless}.test.mjs`,
    `${dir}/${extless}.test.ts`,
    `${dir}/${extless}.test.mjs`,
    `src/tests/${extless}.test.ts`,
    `src/tests/${extless}.test.mjs`,
  ]);
  if (normalized.startsWith('src/resources/extensions/')) {
    const ext = normalized.split('/')[3];
    candidates.add(`src/resources/extensions/${ext}/tests/${extless}.test.ts`);
    candidates.add(`src/resources/extensions/${ext}/tests/${extless}.test.mjs`);
  }
  if (normalized.startsWith('packages/')) {
    const parts = normalized.split('/');
    const pkgDir = `${parts[0]}/${parts[1]}`;
    candidates.add(`${pkgDir}/src/${extless}.test.ts`);
    candidates.add(`${pkgDir}/test/${extless}.test.ts`);
    candidates.add(`${pkgDir}/tests/${extless}.test.ts`);
  }
  return [...candidates];
}

export function classifyArea(sourcePath) {
  const p = normalize(sourcePath);
  if (p.startsWith('src/resources/extensions/')) return `ext:${p.split('/')[3]}`;
  if (p.startsWith('packages/')) return `pkg:${p.split('/')[1]}`;
  if (p.startsWith('src/')) return `src:${p.split('/')[1]}`;
  if (p.startsWith('web/')) return 'web';
  if (p.startsWith('scripts/')) return 'scripts';
  if (p.startsWith('vscode-extension/')) return 'vscode';
  return 'other';
}

const CRITICAL_PATTERNS = [
  /auth|oauth|secret|token|credential/i,
  /session|compaction|sdk|rpc/i,
  /ssrf|blocked|allowlist|url-utils/i,
  /bash|shell|exec/i,
  /dispatch|worktree|db-writer/i,
];

const HIGH_PATTERNS = [
  /loader|cli|headless|onboarding/i,
  /provider|model|tool/i,
  /process-manager|readiness|search-the-web|bg-shell/i,
];

export function classifyRisk(sourcePath, status) {
  if (status === 'covered' || status === 'indirect') return 'low';
  const base = basename(sourcePath);
  if (CRITICAL_PATTERNS.some((re) => re.test(sourcePath) || re.test(base))) return 'critical';
  if (HIGH_PATTERNS.some((re) => re.test(sourcePath) || re.test(base))) return 'high';
  if (sourcePath.endsWith('/index.ts') || sourcePath.endsWith('.d.ts')) return 'low';
  if (sourcePath.startsWith('web/')) return 'medium';
  return 'medium';
}

export function isSourceFile(path) {
  const p = normalize(path);
  return SRC_RE.test(p) && !p.endsWith('.d.ts') && !TEST_RE.test(p);
}

export function collectSourceFiles(root, roots = SOURCE_ROOTS) {
  const files = [];
  for (const area of roots) {
    const dir = join(root, area);
    if (!existsSync(dir)) continue;
    walk(dir, (full) => {
      const rel = normalize(relative(root, full));
      if (!isSourceFile(rel)) return;
      if (isArchivedPath(rel)) return;
      if (rel.includes('/tests/') && !rel.startsWith('packages/')) return;
      if (rel.includes('/integration/') && rel.startsWith('src/')) return;
      files.push(rel);
    });
  }
  return files.sort();
}

export function buildTestIndex(allTests) {
  const byPath = new Set(allTests);
  const stemToTests = new Map();
  const suiteCoverageTests = new Map();
  for (const testPath of allTests) {
    const stem = basename(testPath).replace(/\.(?:test|spec)\.(?:ts|tsx|mjs|js|cjs)$/, '');
    if (!stemToTests.has(stem)) stemToTests.set(stem, []);
    stemToTests.get(stem).push(testPath);
    for (const key of testSuiteCoverageKeys(testPath)) {
      if (!suiteCoverageTests.has(key)) suiteCoverageTests.set(key, testPath);
    }
  }
  return { byPath, stemToTests, suiteCoverageTests };
}

export function resolveSourceTestMapping(sourcePath, testIndex) {
  const candidates = candidateTestsForSource(sourcePath).filter((c) => testIndex.byPath.has(c));
  const stem = basename(sourcePath).replace(/\.(?:ts|tsx|mjs|js)$/, '');
  const stemMatches = (testIndex.stemToTests.get(stem) ?? []).filter((t) => {
    if (sourcePath.startsWith('packages/')) {
      const pkg = sourcePath.split('/')[1];
      return t.startsWith(`packages/${pkg}/`);
    }
    if (sourcePath.startsWith('integrations/')) {
      const host = sourcePath.split('/')[1];
      return t.startsWith(`integrations/${host}/`);
    }
    if (sourcePath.startsWith('src/resources/extensions/')) {
      const ext = sourcePath.split('/')[3];
      return t.includes(`/extensions/${ext}/`) || t.startsWith('src/tests/');
    }
    if (sourcePath.startsWith('src/')) {
      return t.startsWith('src/tests/') || t.startsWith('src/resources/');
    }
    return true;
  });

  const testFiles = [...new Set([...candidates, ...stemMatches])].sort();
  if (testFiles.length === 0) {
    const suiteTests = sourceSuiteCoverageKeys(sourcePath)
      .map((key) => testIndex.suiteCoverageTests.get(key))
      .filter(Boolean);
    if (suiteTests.length === 0) {
      return { testFiles: [], runner: 'none', inNpmTest: false, status: 'untested' };
    }
    return buildCoveredMapping([...new Set(suiteTests)].sort(), 'indirect');
  }

  return buildCoveredMapping(testFiles, candidates.length > 0 ? 'covered' : 'indirect');
}

export function buildCoveredMapping(testFiles, status) {
  const runners = [...new Set(testFiles.map(classifyRunner))];
  const primaryRunner = runners.includes('unit')
    ? 'unit'
    : runners.includes('packages')
      ? 'packages'
      : runners.includes('integration')
        ? 'integration'
        : runners[0];

  const wiredRunners = testFiles.map(classifyRunner);
  const inNpmTest = wiredRunners.some(isInNpmTest);
  const hasUnwired = wiredRunners.some((r) => r === 'unwired');

  return {
    testFiles,
    runner: hasUnwired ? 'unwired' : primaryRunner,
    inNpmTest,
    status: hasUnwired ? 'unwired' : status,
  };
}

export function sourceSuiteCoverageKeys(sourcePath) {
  const p = normalize(sourcePath);
  if (p.startsWith('packages/')) {
    return [`pkg:${p.split('/')[1]}`];
  }
  if (p.startsWith('integrations/')) {
    return [`integration:${p.split('/')[1]}`];
  }
  if (p.startsWith('src/resources/extensions/')) {
    const ext = p.split('/')[3];
    const keys = [`root:src`];
    if (ext && !SRC_RE.test(ext)) keys.unshift(`ext:${ext}`);
    return keys;
  }
  if (p.startsWith('src/')) return ['root:src'];
  if (p.startsWith('scripts/')) return ['root:scripts'];
  if (p.startsWith('web/')) return ['root:web'];
  if (p.startsWith('vscode-extension/')) return ['root:vscode'];
  return [];
}

export function testSuiteCoverageKeys(testPath) {
  const runner = classifyRunner(testPath);
  if (!isReachableTest(runner)) return [];
  if (testPath.startsWith('packages/')) {
    return [`pkg:${testPath.split('/')[1]}`];
  }
  if (testPath.startsWith('integrations/')) {
    return [`integration:${testPath.split('/')[1]}`];
  }
  if (testPath.startsWith('src/resources/extensions/')) {
    return [`ext:${testPath.split('/')[3]}`, 'root:src'];
  }
  if (testPath.startsWith('src/tests/')) return ['root:src'];
  if (testPath.startsWith('scripts/__tests__/')) return ['root:scripts'];
  if (testPath.startsWith('web/')) return ['root:web'];
  if (testPath.startsWith('vscode-extension/')) return ['root:vscode'];
  return [];
}

export function loadPackageScripts(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
}

export function buildMatrix(root) {
  const allTests = collectTestFiles(root);
  const testIndex = buildTestIndex(allTests);
  const sources = collectSourceFiles(root);
  const rows = sources.map((path) => {
    const mapping = resolveSourceTestMapping(path, testIndex);
    const status = mapping.status;
    return {
      path,
      area: classifyArea(path),
      testFiles: mapping.testFiles,
      runner: mapping.runner,
      inNpmTest: mapping.inNpmTest,
      status,
      risk: classifyRisk(path, status),
    };
  });

  const summary = {
    totalSourceFiles: rows.length,
    covered: rows.filter((r) => r.status === 'covered').length,
    indirect: rows.filter((r) => r.status === 'indirect').length,
    untested: rows.filter((r) => r.status === 'untested').length,
    unwired: rows.filter((r) => r.status === 'unwired').length,
    criticalUntested: rows.filter((r) => r.status === 'untested' && r.risk === 'critical').length,
    highUntested: rows.filter((r) => r.status === 'untested' && r.risk === 'high').length,
  };

  const unwiredTests = allTests.filter((t) => classifyRunner(t) === 'unwired');
  const unreachableTests = allTests.filter((t) => !isReachableTest(classifyRunner(t)) && classifyRunner(t) !== 'unknown');

  return {
    generatedAt: new Date().toISOString(),
    summary,
    rows,
    unwiredTests,
    unreachableTests,
    allTests,
  };
}

export function strictMatrixFailures(matrix) {
  const failures = [];
  if (matrix.summary.untested > 0) {
    failures.push(`${matrix.summary.untested} untested source file(s)`);
  }
  if (matrix.summary.criticalUntested > 0) {
    failures.push(`${matrix.summary.criticalUntested} critical untested source file(s)`);
  }
  if (matrix.summary.highUntested > 0) {
    failures.push(`${matrix.summary.highUntested} high untested source file(s)`);
  }
  if (matrix.summary.unwired > 0) {
    failures.push(`${matrix.summary.unwired} source file(s) mapped only to unwired tests`);
  }
  if (matrix.unwiredTests.length > 0) {
    failures.push(`${matrix.unwiredTests.length} unwired test file(s)`);
  }
  if (matrix.unreachableTests.length > 0) {
    failures.push(`${matrix.unreachableTests.length} unreachable test file(s)`);
  }
  const p0Extensions = ['search-the-web', 'bg-shell'];
  for (const ext of p0Extensions) {
    const extRows = matrix.rows.filter((r) => r.area === `ext:${ext}`);
    if (extRows.length > 0 && extRows.every((r) => r.status === 'untested')) {
      failures.push(`P0 extension ${ext} has no tests`);
    }
  }
  return failures;
}

export function strictUnwiredFailures(allTests) {
  return allTests.filter((t) => {
    const runner = classifyRunner(t);
    return runner === 'unwired' || runner === 'unknown';
  });
}

export function auditExtensionsFromTests(extRoot, allTests) {
  const rows = [];
  if (!existsSync(extRoot)) return rows;
  for (const entry of readdirSync(extRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    let sources = 0;
    let tests = 0;
    walk(join(extRoot, name), (full) => {
      const rel = basename(full);
      if (TEST_RE.test(rel)) tests++;
      else if (SRC_RE.test(rel) && !rel.endsWith('.d.ts')) sources++;
    });
    if (sources === 0) continue;
    const extensionTests = allTests.filter(
      (t) => t.includes(`/extensions/${name}/`) || t === `src/resources/extensions/${name}.test.ts`,
    );
    const runners = [...new Set(extensionTests.map(classifyRunner))];
    const wired = extensionTests.some((t) => isInNpmTest(classifyRunner(t)));
    rows.push({
      name,
      sources,
      tests,
      wired,
      runners,
      inUnitGlob: UNIT_EXTENSION_GLOBS.has(name),
    });
  }
  return rows.sort((a, b) => a.tests - b.tests || b.sources - a.sources);
}

export function auditPackagesFromRoot(root, getLinkablePackagesFn) {
  return getLinkablePackagesFn().map((pkg) => {
    let srcCount = 0;
    let testCount = 0;
    walk(join(pkg.path, 'src'), (full) => {
      const rel = basename(full);
      if (TEST_RE.test(rel)) testCount++;
      else if (SRC_RE.test(rel) && !rel.endsWith('.d.ts')) srcCount++;
    });
    for (const sub of ['test', 'tests']) {
      const dir = join(pkg.path, sub);
      if (!existsSync(dir)) continue;
      walk(dir, (full) => {
        if (TEST_RE.test(full)) testCount++;
      });
    }
    return {
      package: pkg.packageName,
      dir: pkg.dir,
      srcCount,
      testCount,
      ratio: srcCount === 0 ? null : testCount / srcCount,
    };
  });
}
