#!/usr/bin/env node
/**
 * apply-gsd-pi-package-json.cjs — merge GSD workspace metadata with upstream v0.75.5 deps.
 */
'use strict'

const { readFileSync, writeFileSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')

const GSD_BASE = {
  'pi-agent-core': {
    name: '@gsd/pi-agent-core',
    description: 'General-purpose agent core (vendored from earendil-works/pi)',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-ai': {
    name: '@gsd/pi-ai',
    description: 'Unified LLM API (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './models': { types: './dist/models.d.ts', import: './dist/models.js' },
      './session-resources': { types: './dist/session-resources.d.ts', import: './dist/session-resources.js' },
      './compat': { types: './dist/compat.d.ts', import: './dist/compat.js' },
      './providers/*': { types: './dist/providers/*.d.ts', import: './dist/providers/*.js' },
      './api/*': { types: './dist/api/*.d.ts', import: './dist/api/*.js' },
      './utils/*': { types: './dist/utils/*.d.ts', import: './dist/utils/*.js' },
      './oauth': { types: './dist/oauth.d.ts', import: './dist/oauth.js' },
      './bedrock-provider': { types: './dist/bedrock-provider.d.ts', import: './dist/bedrock-provider.js' },
      './bun-oauth': { types: './dist/bun-oauth.d.ts', import: './dist/bun-oauth.js' },
      './lazy-bedrock-provider': {
        types: './dist/lazy-bedrock-provider.d.ts',
        import: './dist/lazy-bedrock-provider.js',
      },
      './lazy-oauth': { types: './dist/lazy-oauth.d.ts', import: './dist/lazy-oauth.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-tui': {
    name: '@gsd/pi-tui',
    description: 'Terminal UI library (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-coding-agent': {
    name: '@gsd/pi-coding-agent',
    description: 'Coding agent CLI (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './*': { types: './dist/*.d.ts', import: './dist/*' },
      './hooks': { types: './dist/core/hooks/index.d.ts', import: './dist/core/hooks/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false && pnpm run copy-assets',
    extraScripts: {
      'copy-assets':
        "node -e \"const {cpSync,mkdirSync,existsSync,readdirSync}=require('fs');const {join}=require('path');const src=join('src','theme');const dest=join('dist','theme');mkdirSync(dest,{recursive:true});if(existsSync(src))for(const f of readdirSync(src))if(f.endsWith('.json'))cpSync(join(src,f),join(dest,f));\"",
    },
    piConfig: { name: 'gsd', configDir: '.gsd' },
  },
  'pi-schema': {
    name: '@gsd/pi-schema',
    description: 'JSON Schema validation (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './formats': { types: './dist/formats/index.d.ts', import: './dist/formats/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-telemetry': {
    name: '@gsd/pi-telemetry',
    description: 'Telemetry helpers (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './render': { types: './dist/render.d.ts', import: './dist/render.js' },
      './testing': { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-mcp': {
    name: '@gsd/pi-mcp',
    description: 'MCP helpers (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './oauth': { types: './dist/oauth/index.d.ts', import: './dist/oauth/index.js' },
      './testing': { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
  'pi-codemode': {
    name: '@gsd/pi-codemode',
    description: 'Codemode helpers (vendored from earendil-works/pi)',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './declarations': { types: './dist/declarations.d.ts', import: './dist/declarations.js' },
      './source': { types: './dist/source.d.ts', import: './dist/source.js' },
      './portable': { types: './dist/portable.d.ts', import: './dist/portable.js' },
      './cloudflare': { types: './dist/cloudflare.d.ts', import: './dist/cloudflare.js' },
      './worker': { types: './dist/runtime/worker.d.ts', import: './dist/runtime/worker.js' },
    },
    build: 'node ../../scripts/clean-package-dist.cjs && tsc -p tsconfig.json --incremental false',
  },
}

const UPSTREAM_MAP = {
  'pi-agent-core': 'packages/agent',
  'pi-ai': 'packages/ai',
  'pi-tui': 'packages/tui',
  'pi-coding-agent': 'packages/coding-agent',
  'pi-schema': 'packages/schema',
  'pi-telemetry': 'packages/telemetry',
  'pi-mcp': 'packages/mcp',
  'pi-codemode': 'packages/codemode',
}

for (const dir of Object.keys(GSD_BASE)) {
  const pkgPath = join(ROOT, 'packages', dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  const upstreamPath = join(ROOT, '.cache/pi-upstream', UPSTREAM_MAP[dir], 'package.json')
  const upstream = existsSync(upstreamPath)
    ? JSON.parse(readFileSync(upstreamPath, 'utf8'))
    : JSON.parse(readFileSync(pkgPath, 'utf8'))
  const base = GSD_BASE[dir]
  let headPkg = {}
  try {
    const { execSync } = require('child_process')
    headPkg = JSON.parse(
      execSync(`git show HEAD:packages/${dir}/package.json`, { cwd: ROOT, encoding: 'utf8' }),
    )
  } catch {
    /* no HEAD baseline */
  }
  const headDeps = headPkg.dependencies || {}

  const merged = {
    name: base.name,
    version: '1.0.2',
    description: base.description,
    type: 'module',
    gsd: { linkable: true, scope: '@gsd', name: dir },
    ...(base.piConfig ? { piConfig: base.piConfig } : {}),
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: base.exports,
    scripts: {
      build: base.build,
      ...(base.extraScripts || {}),
    },
    dependencies: {
      ...upstream.dependencies,
      // GSD-only additions (do not override upstream vendor versions)
      ...(headDeps['@gsd/native'] ? { '@gsd/native': headDeps['@gsd/native'] } : {}),
    },
    devDependencies: {
      ...(upstream.devDependencies || {}),
    },
    optionalDependencies: upstream.optionalDependencies,
  }

  if (dir === 'pi-coding-agent') {
    delete merged.dependencies['@opengsd/contracts']
    // Host seam: interactive UI + session live outside the vendored package.
    merged.dependencies['@gsd/agent-modes'] = 'workspace:*'
    merged.dependencies['@gsd/agent-core'] = 'workspace:*'
  }

  for (const key of Object.keys(merged.dependencies || {})) {
    if (key.startsWith('@earendil-works/')) {
      const local = key.replace('@earendil-works/', '@gsd/')
      merged.dependencies[local] = 'workspace:*'
      delete merged.dependencies[key]
    }
    if (key.startsWith('@gsd/pi-')) {
      merged.dependencies[key] = 'workspace:*'
    }
  }

  // GSD loader/extensions use @sinclair/typebox; upstream v0.75.5 uses unscoped `typebox`.
  merged.dependencies['@sinclair/typebox'] = '^0.34.41'

  writeFileSync(pkgPath, JSON.stringify(merged, null, 2) + '\n')
  process.stderr.write(`apply-gsd-pi-package-json: ${dir}\n`)
}
