#!/usr/bin/env node
/**
 * Copy an external sync destination into packages/pi-*, preserving each package's
 * workspace tsconfig.json and re-applying GSD package.json export shaping.
 *
 * Usage:
 *   node scripts/install-pi-engine-from-dest.cjs --dest /absolute/path/outside/repo
 */
'use strict'

const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { execFileSync } = require('child_process')
const { isAbsolute, join, relative, resolve } = require('path')

const ROOT = join(__dirname, '..')
const PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui', 'pi-coding-agent', 'pi-schema', 'pi-telemetry', 'pi-mcp', 'pi-codemode']

function parseArgs(argv) {
  const opts = { dest: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dest' && argv[i + 1]) opts.dest = argv[++i]
  }
  return opts
}

function isOutsideRepo(dest) {
  if (!isAbsolute(dest)) return false
  const rel = relative(ROOT, resolve(dest))
  return rel.startsWith('..') || isAbsolute(rel)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.dest || !isOutsideRepo(opts.dest)) {
    process.stderr.write('--dest must be an absolute path outside the repo\n')
    process.exit(1)
  }
  const destRoot = resolve(opts.dest)
  for (const dir of PACKAGES) {
    const from = join(destRoot, 'packages', dir)
    const to = join(ROOT, 'packages', dir)
    if (!existsSync(from)) {
      process.stderr.write(`Missing ${from}\n`)
      process.exit(1)
    }
    const tsconfig = existsSync(join(to, 'tsconfig.json'))
      ? readFileSync(join(to, 'tsconfig.json'), 'utf8')
      : null
    const savedPkg = existsSync(join(to, 'package.json'))
      ? JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'))
      : null
    rmSync(to, { recursive: true, force: true })
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    if (tsconfig) writeFileSync(join(to, 'tsconfig.json'), tsconfig)
    if (savedPkg?.gsd) {
      const pkgPath = join(to, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      pkg.gsd = savedPkg.gsd
      if (savedPkg.piConfig) pkg.piConfig = savedPkg.piConfig
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    }
  }
  execFileSync(process.execPath, [join(__dirname, 'apply-gsd-pi-package-json.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  execFileSync(process.execPath, [join(__dirname, 'normalize-pi-imports.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  process.stderr.write(`Installed Pi packages from ${destRoot}\n`)
}

if (require.main === module) main()

module.exports = { parseArgs, isOutsideRepo }
