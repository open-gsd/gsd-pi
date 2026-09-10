import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = new URL("../../../../../", import.meta.url);

// Fresh worktrees often run focused tests before workspace packages are built.
// Node then surfaces a bare ERR_MODULE_NOT_FOUND for the missing dist output.
// These helpers attribute that failure to the workspace package and name the
// exact build command that fixes it.

function isWorkspacePackageLink(pkgDir) {
  // Workspace links point at packages/<name>; registry installs live under
  // some node_modules directory. Only the former get the build hint.
  try {
    return !realpathSync(pkgDir).split(sep).includes('node_modules');
  } catch {
    return false;
  }
}

function exportsFileTarget(exportsMap, subpath) {
  if (exportsMap == null || Array.isArray(exportsMap)) return null;
  let entry;
  let capture = null;
  if (typeof exportsMap === 'string') {
    if (subpath !== '') return null;
    entry = exportsMap;
  } else {
    const key = subpath === '' ? '.' : `./${subpath}`;
    if (Object.hasOwn(exportsMap, key)) {
      entry = exportsMap[key];
    } else {
      // Single-star pattern fallback (e.g. "./*": "./dist/*.js").
      for (const [pattern, value] of Object.entries(exportsMap)) {
        const star = pattern.indexOf('*');
        if (!pattern.startsWith('./') || star === -1) continue;
        const prefix = pattern.slice(2, star);
        const suffix = pattern.slice(star + 1);
        if (
          subpath.startsWith(prefix) &&
          subpath.endsWith(suffix) &&
          subpath.length >= prefix.length + suffix.length
        ) {
          entry = value;
          capture = subpath.slice(prefix.length, subpath.length - suffix.length);
          break;
        }
      }
      if (entry === undefined) return null;
    }
  }

  // Pick the ESM-relevant condition; "types"-only entries resolve to nothing.
  const toFileTarget = (node) => {
    if (typeof node === 'string') return capture === null ? node : node.replaceAll('*', capture);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = toFileTarget(item);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      for (const condition of ['import', 'node', 'default']) {
        if (condition in node) {
          const found = toFileTarget(node[condition]);
          if (found) return found;
        }
      }
    }
    return null;
  };

  const target = toFileTarget(entry);
  return target !== null && target.startsWith('./') ? target.slice(2) : null;
}

function missingWorkspaceDistError(specifier, context) {
  if (
    specifier.startsWith('.') || specifier.startsWith('/') ||
    specifier.startsWith('#') || specifier.startsWith('node:') ||
    specifier.startsWith('file:')
  ) {
    return null;
  }
  if (!context?.parentURL?.startsWith('file:')) return null;
  const segments = specifier.split('/');
  const nameLength = segments[0].startsWith('@') ? 2 : 1;
  if (segments.length < nameLength) return null;
  const packageName = segments.slice(0, nameLength).join('/');
  const subpath = segments.slice(nameLength).join('/');

  // Find the nearest node_modules link for the package, mirroring Node's
  // resolution walk (covers nested links like packages/*/node_modules/@opengsd/*).
  const manifestRel = join('node_modules', ...packageName.split('/'), 'package.json');
  let dir = dirname(fileURLToPath(context.parentURL));
  let visited = null;
  let pkgDir = null;
  let manifest = null;
  while (dir !== visited) {
    visited = dir;
    const manifestPath = join(dir, manifestRel);
    if (!existsSync(manifestPath)) {
      dir = dirname(dir);
      continue;
    }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return null;
    }
    pkgDir = join(dir, 'node_modules', ...packageName.split('/'));
    break;
  }
  if (!manifest) return null;

  const target = exportsFileTarget(manifest.exports, subpath);
  if (!target) return null;
  if (!target.startsWith('dist/') && !target.includes('/dist/')) return null;
  if (isWorkspacePackageLink(pkgDir) && !existsSync(join(pkgDir, target))) {
    const name = typeof manifest.name === 'string' ? manifest.name : packageName;
    return new Error(
      `Workspace package "${name}" dist not found (missing ${target}). ` +
      `Build it first: pnpm --filter ${name} build`,
    );
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:')) {
    return { url: specifier, format: 'builtin', shortCircuit: true };
  }

  // 1. Redirect all workspace package bare imports to source.
  //    CI portability runs don't build any packages/ dist artifacts, so every
  //    @gsd/* specifier (including transitive ones pulled in by pi-coding-agent
  //    source itself) must resolve to the TypeScript source entrypoint.
  if (specifier === "../../packages/pi-coding-agent/src/index.js") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-coding-agent" || specifier === "@earendil-works/pi-coding-agent") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/pi-coding-agent/") || specifier.startsWith("@earendil-works/pi-coding-agent/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-coding-agent\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-coding-agent/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-ai/oauth" || specifier === "@gsd/pi-ai/oauth") {
    specifier = new URL("packages/pi-ai/src/utils/oauth/index.ts", ROOT).href;
  } else if (
    specifier === "@earendil-works/pi-ai" ||
    specifier === "@gsd/pi-ai" ||
    specifier === "@earendil-works/pi-ai/dist/index.js" ||
    specifier === "@gsd/pi-ai/dist/index.js"
  ) {
    specifier = new URL("packages/pi-ai/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-ai/") || specifier.startsWith("@gsd/pi-ai/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-ai\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-ai/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-tui" || specifier === "@gsd/pi-tui") {
    specifier = new URL("packages/pi-tui/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-tui/") || specifier.startsWith("@gsd/pi-tui/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-tui\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-tui/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-agent-core" || specifier === "@gsd/pi-agent-core") {
    specifier = new URL("packages/pi-agent-core/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-agent-core/") || specifier.startsWith("@gsd/pi-agent-core/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-agent-core\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-agent-core/src/${subpath}`, ROOT).href;
  } else if (specifier === "@gsd/agent-core") {
    specifier = new URL("packages/gsd-agent-core/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/agent-core/")) {
    const subpath = specifier.replace(/^@gsd\/agent-core\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/gsd-agent-core/src/${subpath}`, ROOT).href;
  } else if (specifier === "@opengsd/contracts" || specifier === "@opengsd/contracts/dist/index.js") {
    specifier = new URL("packages/contracts/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@opengsd/contracts/")) {
    const subpath = specifier.replace(/^@opengsd\/contracts\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/contracts/src/${subpath}`, ROOT).href;
  } else if (specifier === "@gsd/native") {
    specifier = new URL("packages/native/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/native/")) {
    // Sub-path imports like @gsd/native/fd, @gsd/native/text, etc.
    const subpath = specifier.slice("@gsd/native/".length);
    specifier = new URL(`packages/native/src/${subpath}/index.ts`, ROOT).href;
  }
  // 2. Broken/partial dist artifacts (e.g. jiti CJS) may still import ./foo.ts — map to src/.
  else if (
    context.parentURL &&
    context.parentURL.includes('/packages/') &&
    context.parentURL.includes('/dist/') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    (specifier.endsWith('.ts') || specifier.endsWith('.js'))
  ) {
    const srcParent = context.parentURL.replace(/\/dist\//, '/src/');
    const srcSpec = specifier.replace(/\.js$/, '.ts');
    specifier = new URL(srcSpec, srcParent).href;
  }
  // 3. Redirect packages/*/src/ relative .js → .ts for strip-types
  else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    if (
      context.parentURL &&
      context.parentURL.startsWith(ROOT.href) &&
      !context.parentURL.includes('/node_modules/') &&
      context.parentURL.includes('/src/')
    ) {
      if (specifier.includes('/dist/')) {
        specifier = specifier.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      } else {
        const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          specifier = candidate.href;
        }
      }
    }
  }
  // 4. Extensionless relative imports from web/ (Next.js convention).
  //    Transpiled .tsx files emit extensionless imports — try .ts then .tsx.
  else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !specifier.match(/\.\w+$/) &&
    context.parentURL &&
    context.parentURL.includes('/web/')
  ) {
    const baseUrl = new URL(specifier, context.parentURL);
    for (const ext of ['.ts', '.tsx']) {
      const candidate = fileURLToPath(baseUrl) + ext;
      if (existsSync(candidate)) {
        specifier = baseUrl.href + ext;
        break;
      }

    }
  }

  // Happy path: delegate untouched. Only when resolution fails do we check
  // whether a workspace package's dist output is missing, so the developer
  // sees the build command instead of a bare ERR_MODULE_NOT_FOUND.
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    throw missingWorkspaceDistError(specifier, context) ?? error;
  }
}

export function load(url, context, nextLoad) {
  if (url.startsWith('node:') || context.format === 'builtin') {
    return { format: 'builtin', source: '', shortCircuit: true };
  }

  // jiti/CJS may still enter through stale packages/*/dist/index.js — redirect to src.
  if (url.includes('/packages/pi-ai/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/pi-coding-agent/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/pi-agent-core/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/gsd-agent-core/dist/')) {
    url = url.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
  } else if (url.includes('/packages/pi-tui/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  }

  // Node's --experimental-strip-types handles plain .ts but not .tsx and not
  // all TypeScript syntax used by workspace packages (parameter properties,
  // decorators, etc.). Transpile all workspace package source files and .tsx
  // files through TypeScript's transpileModule to avoid those crashes.
  const shouldTranspileWithTypeScript =
    url.endsWith('.tsx') ||
    (url.endsWith('.ts') && url.includes('/packages/') && url.includes('/src/'));

  if (shouldTranspileWithTypeScript) {
    const ts = require('typescript');
    const source = readFileSync(fileURLToPath(url), 'utf-8');
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    });
    // Inject CJS-compatible globals (__dirname, __filename, require) so that
    // workspace packages compiled as ESM can still use them.  This avoids the
    // need for import.meta.url behind indirect invocation patterns that fail in
    // CJS and in dynamically-created scopes.
    // Only inject globals that the source file doesn't already declare itself.
    const preambleLines = [
      'import { fileURLToPath as __preamble_fUTP } from "node:url";',
      'import { dirname as __preamble_dn } from "node:path";',
      'import { createRequire as __preamble_cR } from "node:module";',
    ];
    if (!outputText.includes('const __filename') && !outputText.includes('let __filename')) {
      preambleLines.push('const __filename = __preamble_fUTP(import.meta.url);');
    }
    if (!outputText.includes('const __dirname') && !outputText.includes('let __dirname')) {
      preambleLines.push('const __dirname = __preamble_dn(__preamble_fUTP(import.meta.url));');
    }
    if (!outputText.includes('const require') && !outputText.includes('let require')) {
      preambleLines.push('const require = __preamble_cR(import.meta.url);');
    }
    return { format: 'module', source: preambleLines.join('\n') + '\n' + outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
