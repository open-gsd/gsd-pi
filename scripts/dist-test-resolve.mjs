/**
 * Minimal Node.js import hook for running tests from dist-test/.
 *
 * esbuild with bundle:false preserves import specifiers verbatim, so compiled
 * .js files still import '../foo.ts'. This hook redirects those to '.js' so
 * Node can find the compiled output.
 *
 * Also redirects @gsd bare imports to their compiled counterparts in dist-test.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire, registerHooks } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

const GIT_TEST_ENV_DIR = join(tmpdir(), `gsd-test-git-env-${process.pid}`);
mkdirSync(GIT_TEST_ENV_DIR, { recursive: true });
process.env.GIT_CONFIG_GLOBAL = join(GIT_TEST_ENV_DIR, 'global.gitconfig');
process.env.GIT_CONFIG_SYSTEM = join(GIT_TEST_ENV_DIR, 'system.gitconfig');
const gitTemplateDir = join(GIT_TEST_ENV_DIR, 'templates');
mkdirSync(join(gitTemplateDir, 'hooks'), { recursive: true });
mkdirSync(join(gitTemplateDir, 'info'), { recursive: true });
writeFileSync(join(gitTemplateDir, 'info', 'exclude'), '');
process.env.GIT_TEMPLATE_DIR = gitTemplateDir;

// Disposable project fixtures must not inherit a developer's global GSD
// preferences (for example git.isolation: worktree). A valid isolated file
// also prevents the legacy ~/.pi preferences fallback from leaking in.
if (!process.env.GSD_HOME) {
  const gsdTestHome = join(GIT_TEST_ENV_DIR, 'gsd-home');
  mkdirSync(gsdTestHome, { recursive: true });
  writeFileSync(join(gsdTestHome, 'PREFERENCES.md'), '---\nversion: 1\ngit:\n  isolation: none\n---\n');
  process.env.GSD_HOME = gsdTestHome;
}

// dist-test root — everything compiled lands here
const DIST_TEST = new URL('../dist-test/', import.meta.url).href;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ESM import hook: compiled .js mirrors for workspace packages (jiti uses alias map instead).
const WORKSPACE_ENTRIES = {
  'pi-coding-agent': new URL('../dist-test/packages/pi-coding-agent/src/index.js', import.meta.url).href,
  'pi-ai/oauth':     new URL('../dist-test/packages/pi-ai/src/utils/oauth/index.js', import.meta.url).href,
  'pi-ai':           new URL('../dist-test/packages/pi-ai/src/index.js', import.meta.url).href,
  'pi-agent-core':   new URL('../dist-test/packages/pi-agent-core/src/index.js', import.meta.url).href,
  'pi-tui':          new URL('../dist-test/packages/pi-tui/src/index.js', import.meta.url).href,
  'native':          new URL('../dist-test/packages/native/dist/index.js', import.meta.url).href,
  'agent-core':      new URL('../dist-test/packages/gsd-agent-core/dist/index.js', import.meta.url).href,
  'contracts':       new URL('../dist-test/packages/contracts/src/index.js', import.meta.url).href,
};

const WORKSPACE_SCOPES = ['@gsd', '@earendil-works', '@mariozechner', '@opengsd'];

const BUILT_PACKAGE_ENTRIES = {
  'pi-coding-agent': new URL('../packages/pi-coding-agent/dist/index.js', import.meta.url).href,
  'pi-ai/oauth':     new URL('../packages/pi-ai/dist/utils/oauth/index.js', import.meta.url).href,
  'pi-ai':           new URL('../packages/pi-ai/dist/index.js', import.meta.url).href,
  'pi-agent-core':   new URL('../packages/pi-agent-core/dist/index.js', import.meta.url).href,
  'pi-tui':          new URL('../packages/pi-tui/dist/index.js', import.meta.url).href,
  'native':          new URL('../packages/native/dist/index.js', import.meta.url).href,
  'agent-core':      new URL('../packages/gsd-agent-core/dist/index.js', import.meta.url).href,
  'contracts':       new URL('../packages/contracts/dist/index.js', import.meta.url).href,
};

const GSD_ALIASES = Object.fromEntries(
  Object.entries(WORKSPACE_ENTRIES).flatMap(([pkg, target]) =>
    WORKSPACE_SCOPES.map((scope) => [`${scope}/${pkg}`, target]),
  ),
);

function isJitiCjsParent(context) {
  const parent = context.parentURL ?? '';
  return parent.includes('/node_modules/@mariozechner/jiti/');
}

function shouldUseBuiltPackageDist(context) {
  const parent = context.parentURL ?? '';
  return (
    isJitiCjsParent(context) ||
    (parent.includes('/packages/') && parent.includes('/dist/') && !parent.includes('/dist-test/'))
  );
}

function workspaceEntry(pkg, context) {
  return shouldUseBuiltPackageDist(context) ? BUILT_PACKAGE_ENTRIES[pkg] : WORKSPACE_ENTRIES[pkg];
}

function toResolveSpecifier(target, context) {
  if (!target.startsWith('file://')) {
    return target;
  }
  const parent = context.parentURL ?? '';
  const needsFilesystemPath =
    isJitiCjsParent(context) ||
    parent.includes('/dist-test/') ||
    parent.includes('/dist/') ||
    parent.endsWith('.cjs');
  return needsFilesystemPath ? fileURLToPath(target) : target;
}

function forwardResolve(target, context, nextResolve) {
  return nextResolve(toResolveSpecifier(target, context), context);
}

function isNodeBuiltin(specifier) {
  const bare = specifier.replace(/^node:/, '');
  return builtinModules.includes(bare) || builtinModules.includes(`node:${bare}`);
}

function resolveFromSourcePackage(parentURL, specifier) {
  if (!parentURL?.includes('/dist-test/packages/')) {
    return null;
  }
  if (!specifier.startsWith('@')) {
    return null;
  }
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('file:')) {
    return null;
  }
  if (isNodeBuiltin(specifier)) {
    return null;
  }

  const parentPath = fileURLToPath(parentURL);
  const match = parentPath.match(/[/\\]dist-test[/\\]packages[/\\]([^/\\]+)[/\\]/);
  if (!match) {
    return null;
  }

  const pkgDir = join(REPO_ROOT, 'packages', match[1]);
  const pkgJson = join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) {
    return null;
  }

  try {
    const require = createRequire(pkgJson);
    const resolved = require.resolve(specifier);
    if (!isAbsolute(resolved)) {
      return null;
    }
    return pathToFileURL(resolved).href;
  } catch {
    return null;
  }
}

function resolveWorkspaceSubpath(specifier, context) {
  const useBuilt = shouldUseBuiltPackageDist(context);
  for (const scope of WORKSPACE_SCOPES) {
    if (specifier === `${scope}/pi-coding-agent`) {
      return workspaceEntry('pi-coding-agent', context);
    }
    if (specifier === `${scope}/pi-ai`) {
      return workspaceEntry('pi-ai', context);
    }
    if (specifier === `${scope}/pi-agent-core`) {
      return workspaceEntry('pi-agent-core', context);
    }
    if (specifier === `${scope}/pi-tui`) {
      return workspaceEntry('pi-tui', context);
    }
    if (specifier === `${scope}/native`) {
      return workspaceEntry('native', context);
    }
    if (specifier === `${scope}/agent-core`) {
      return workspaceEntry('agent-core', context);
    }
    if (specifier === `${scope}/contracts` || specifier === `${scope}/contracts/dist/index.js`) {
      return workspaceEntry('contracts', context);
    }
    const agentCorePrefix = `${scope}/agent-core/`;
    if (specifier.startsWith(agentCorePrefix)) {
      const subpath = rewriteTsSpecifierToJs(specifier.slice(agentCorePrefix.length));
      const base = useBuilt
        ? `../packages/gsd-agent-core/dist/${subpath}`
        : `../dist-test/packages/gsd-agent-core/dist/${subpath}`;
      return new URL(base, import.meta.url).href;
    }
    const piCodingPrefix = `${scope}/pi-coding-agent/`;
    if (specifier.startsWith(piCodingPrefix)) {
      const subpath = rewriteTsSpecifierToJs(specifier.slice(piCodingPrefix.length));
      const base = useBuilt
        ? `../packages/pi-coding-agent/dist/${subpath}`
        : `../dist-test/packages/pi-coding-agent/src/${subpath}`;
      return new URL(base, import.meta.url).href;
    }
    const nativePrefix = `${scope}/native/`;
    if (specifier.startsWith(nativePrefix)) {
      const subpath = specifier.slice(nativePrefix.length);
      const base = useBuilt
        ? `../packages/native/dist/${subpath}/index.js`
        : `../dist-test/packages/native/dist/${subpath}/index.js`;
      return new URL(base, import.meta.url).href;
    }
  }
  return null;
}

function repairMalformedWorkspacePath(specifier) {
  const match = specifier.match(/[/\\]pi-coding-agent[/\\](?:dist|src)[/\\]index\.(?:t|j)s[/\\](.+)$/);
  if (!match) {
    return null;
  }
  const subpath = rewriteTsSpecifierToJs(match[1]);
  const base = specifier.includes('/packages/pi-coding-agent/dist/')
    ? `../packages/pi-coding-agent/dist/${subpath}`
    : `../dist-test/packages/pi-coding-agent/src/${subpath}`;
  return new URL(base, import.meta.url).href;
}

function resolvePackageEntrySubpath(parentURL, specifier) {
  if (!parentURL) {
    return null;
  }
  if (specifier.startsWith('@') || specifier.startsWith('node:') || specifier.startsWith('file:') || isNodeBuiltin(specifier)) {
    return null;
  }
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.includes('/')) {
    return null;
  }

  const parentPath = fileURLToPath(parentURL);
  const match = parentPath.match(/[/\\](?:dist-test[/\\]packages|packages)[/\\]([^/\\]+)[/\\]src[/\\]index\.(?:t|j)s$/);
  if (!match) {
    return null;
  }

  const rel = specifier.startsWith('./') || specifier.startsWith('../') ? specifier : `./${specifier}`;
  if (!rel.startsWith('./') && !rel.startsWith('../')) {
    return null;
  }

  const subpath = rewriteTsSpecifierToJs(rel.replace(/^\.\//, ''));
  return new URL(`../dist-test/packages/${match[1]}/src/${subpath}`, import.meta.url).href;
}

export function resolve(specifier, context, nextResolve) {
  const malformedTarget = repairMalformedWorkspacePath(specifier);
  if (malformedTarget) {
    return forwardResolve(malformedTarget, context, nextResolve);
  }

  const sourcePackageTarget = resolveFromSourcePackage(context.parentURL, specifier);
  if (sourcePackageTarget) {
    return forwardResolve(sourcePackageTarget, context, nextResolve);
  }

  const subpathTarget = resolveWorkspaceSubpath(specifier, context);
  if (subpathTarget) {
    return forwardResolve(subpathTarget, context, nextResolve);
  }

  const entrySubpathTarget = resolvePackageEntrySubpath(context.parentURL, specifier);
  if (entrySubpathTarget) {
    return forwardResolve(entrySubpathTarget, context, nextResolve);
  }

  if (!isJitiCjsParent(context) && specifier in GSD_ALIASES) {
    return forwardResolve(GSD_ALIASES[specifier], context, nextResolve);
  }

  if (specifier.startsWith('file:') && specifier.startsWith(DIST_TEST) && isTsSpecifier(specifier)) {
    return nextResolve(rewriteTsSpecifierToJs(specifier), context);
  }

  if (
    isTsSpecifier(specifier) &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL &&
    context.parentURL.startsWith(DIST_TEST)
  ) {
    const jsSpecifier = rewriteTsSpecifierToJs(specifier);
    return nextResolve(jsSpecifier, context);
  }

  return nextResolve(specifier, context);
}

function isTsSpecifier(specifier) {
  const pathPart = specifier.split(/[?#]/, 1)[0];
  return pathPart.endsWith('.ts');
}

function rewriteTsSpecifierToJs(specifier) {
  return specifier.replace(/\.ts(?=([?#]|$))/, '.js');
}

registerHooks({ resolve });
