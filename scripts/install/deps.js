import { exec as execCb, spawnSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'fs'
import { arch, homedir, platform } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

export const RTK_VERSION = '0.33.1'
const RTK_REPO = 'rtk-ai/rtk'
const RTK_ENV = { ...process.env, RTK_TELEMETRY_DISABLED: '1' }

export function getManagedBinaryPath() {
  const managedBinDir = join(process.env.GSD_HOME || join(homedir(), '.gsd'), 'agent', 'bin')
  return {
    managedBinDir,
    managedBinaryPath: join(managedBinDir, platform() === 'win32' ? 'rtk.exe' : 'rtk'),
  }
}

function resolveAssetName() {
  const p = platform()
  const a = arch()
  if (p === 'darwin' && a === 'arm64') return 'rtk-aarch64-apple-darwin.tar.gz'
  if (p === 'darwin' && a === 'x64') return 'rtk-x86_64-apple-darwin.tar.gz'
  if (p === 'linux' && a === 'arm64') return 'rtk-aarch64-unknown-linux-gnu.tar.gz'
  if (p === 'linux' && a === 'x64') return 'rtk-x86_64-unknown-linux-musl.tar.gz'
  if (p === 'win32' && a === 'x64') return 'rtk-x86_64-pc-windows-msvc.zip'
  return null
}

function parseChecksums(text) {
  const checksums = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i)
    if (!match) continue
    checksums.set(match[2], match[1].toLowerCase())
  }
  return checksums
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

async function downloadToFile(url, destination) {
  const response = await fetch(url, { headers: { 'User-Agent': 'gsd-pi-installer' } })
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  if (!response.body) throw new Error('no response body')
  const output = createWriteStream(destination)
  await finished(Readable.fromWeb(response.body).pipe(output))
}

function findBinaryRecursively(rootDir, binaryName) {
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isFile() && entry.name === binaryName) return fullPath
      if (entry.isDirectory()) stack.push(fullPath)
    }
  }
  return null
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function extractZipArchive(archivePath, extractDir) {
  mkdirSync(extractDir, { recursive: true })

  if (platform() === 'win32') {
    const command = [
      'Expand-Archive',
      '-LiteralPath', quotePowerShellLiteral(archivePath),
      '-DestinationPath', quotePowerShellLiteral(extractDir),
      '-Force',
    ].join(' ')
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], {
      encoding: 'utf-8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr?.trim() || 'zip extraction failed')
    }
    return
  }

  return import('extract-zip').then(({ default: extractZip }) => extractZip(archivePath, { dir: extractDir }))
}

export function validateRtkBinary(binaryPath) {
  const result = spawnSync(binaryPath, ['rewrite', 'git status'], {
    encoding: 'utf-8',
    env: RTK_ENV,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  return !result.error && result.status === 0 && (result.stdout || '').trim() === 'rtk git status'
}

export function isRtkInstalled() {
  const { managedBinaryPath } = getManagedBinaryPath()
  return existsSync(managedBinaryPath) && validateRtkBinary(managedBinaryPath)
}

export function isChromiumInstalled() {
  // Playwright does not expose a cheap local probe; treat skip env as "handled".
  if (
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === 'true'
  ) {
    return true
  }
  return false
}

function describeFetchError(err) {
  const base = err?.message || String(err)
  const cause = err?.cause
  if (!cause) return base
  const code = cause.code || cause.errno
  const causeMsg = cause.message || ''
  const detail = code ? `${code}${causeMsg && causeMsg !== code ? ` — ${causeMsg}` : ''}` : causeMsg
  return detail ? `${base} (${detail})` : base
}

function execCommand(command, opts = {}) {
  return new Promise((res) => {
    execCb(command, { timeout: 300_000, ...opts }, (error, stdout, stderr) => {
      res({ ok: !error, stdout: stdout || '', stderr: stderr || '', error })
    })
  })
}

/**
 * npm install -g --ignore-scripts leaves empty node_modules/* placeholders for
 * hoisted deps (openai, @anthropic-ai/sdk, …). Run npm install in packageRoot
 * to materialize the real packages without re-running lifecycle scripts.
 */
export async function repairPackageDependencies(packageRoot, { ui, quiet = false } = {}) {
  if (
    process.env.GSD_SKIP_DEP_REPAIR === '1' ||
    process.env.GSD_SKIP_DEP_REPAIR === 'true'
  ) {
    if (!quiet) {
      ui?.skip?.('Dependencies', 'skipped by GSD_SKIP_DEP_REPAIR')
    }
    return
  }

  const pkgJson = join(packageRoot, 'package.json')
  if (!existsSync(pkgJson)) return

  const stop = quiet ? undefined : ui?.start?.('Installing dependencies...')
  const result = await execCommand('npm install --ignore-scripts', { cwd: packageRoot })
  stop?.()

  if (!result.ok) {
    const output = (result.stderr + '\n' + result.stdout).trim()
    const meaningful = output.split('\n')
      .filter((line) => !line.includes('npm warn') && !line.includes('npm WARN') && line.trim())
      .slice(-3)
      .join('; ')
    ui?.warn?.('Dependencies', meaningful || 'npm install failed')
    // On the postinstall path `ui` is null, so the line above is a no-op and the
    // failure would be completely silent — the package then crashes on first run
    // with ERR_MODULE_NOT_FOUND. Always emit an unconditional warning to stderr
    // so an offline/proxy/cert failure is visible at install time.
    if (!ui) {
      console.warn(
        `[gsd] WARNING: failed to materialize runtime dependencies (${meaningful || 'npm install failed'}).\n` +
        `[gsd] The CLI may fail to start. Re-run with network access, or run \`npm install --ignore-scripts\` inside the gsd-pi package directory.`,
      )
    }
    return
  }

  if (!quiet) {
    ui?.step?.('Dependencies', 'installed')
  }
}

export function linkWorkspacePackages(packageRoot, ui) {
  const scriptPath = join(packageRoot, 'scripts', 'link-workspace-packages.cjs')
  if (!existsSync(scriptPath)) return

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })

    if (result.status === 0 && ui) {
      const stderr = (result.stderr || '').toString()
      const linked = stderr.match(/Linked (\d+)/)?.[1]
      const copied = stderr.match(/Copied (\d+)/)?.[1]
      if (linked || copied) {
        const parts = []
        if (linked) parts.push(`${linked} linked`)
        if (copied) parts.push(`${copied} copied`)
        ui.step('Workspace packages', parts.join(', '))
      } else {
        ui.step('Workspace packages', 'up to date')
      }
    }
  } catch { /* non-fatal */ }
}

export async function installChromium({ skip, ui, verifyOnly = false }) {
  if (skip) {
    ui?.skip('Chromium', 'skipped')
    return
  }

  if (verifyOnly && isChromiumInstalled()) {
    ui?.step('Chromium', 'up to date')
    return
  }

  const stop = ui?.start('Installing Chromium...')
  try {
    const result = await execCommand('npx playwright install chromium')
    stop?.()

    if (!result.ok) {
      const output = (result.stderr + '\n' + result.stdout).trim()
      const meaningful = output.split('\n')
        .filter(l => !l.includes('npm warn') && !l.includes('npm WARN') && l.trim())
        .slice(-3)
        .join('; ')
      ui?.warn('Chromium', meaningful || 'install failed — run npx playwright install chromium')
      return
    }

    ui?.step('Chromium installed', 'Playwright')
  } catch (err) {
    stop?.()
    ui?.warn('Chromium', err.message)
  }
}

export async function installRtk({ skip, ui, verifyOnly = false }) {
  if (skip) {
    ui?.skip('RTK', 'disabled')
    return
  }

  const assetName = resolveAssetName()
  if (!assetName) {
    ui?.skip('RTK', `unsupported platform ${platform()}-${arch()}`)
    return
  }

  const { managedBinDir, managedBinaryPath } = getManagedBinaryPath()

  if (verifyOnly && isRtkInstalled()) {
    ui?.step('RTK', `v${RTK_VERSION} up to date`)
    return
  }

  if (existsSync(managedBinaryPath) && validateRtkBinary(managedBinaryPath)) {
    ui?.step('RTK', `v${RTK_VERSION} up to date`)
    return
  }

  const stop = ui?.start('Installing RTK...')
  const tempRoot = join(managedBinDir, `.rtk-install-${randomUUID().slice(0, 8)}`)
  const archivePath = join(tempRoot, assetName)
  const extractDir = join(tempRoot, 'extract')
  const releaseBase = `https://github.com/${RTK_REPO}/releases/download/v${RTK_VERSION}`

  mkdirSync(tempRoot, { recursive: true })
  mkdirSync(managedBinDir, { recursive: true })

  try {
    const checksumsResponse = await fetch(`${releaseBase}/checksums.txt`, {
      headers: { 'User-Agent': 'gsd-pi-installer' },
    })
    if (!checksumsResponse.ok) throw new Error(`checksums fetch failed (${checksumsResponse.status})`)

    const checksums = parseChecksums(await checksumsResponse.text())
    const expectedSha = checksums.get(assetName)
    if (!expectedSha) throw new Error(`missing checksum for ${assetName}`)

    await downloadToFile(`${releaseBase}/${assetName}`, archivePath)
    const actualSha = sha256File(archivePath)
    if (actualSha !== expectedSha) throw new Error('checksum mismatch')

    mkdirSync(extractDir, { recursive: true })
    if (assetName.endsWith('.zip')) {
      await extractZipArchive(archivePath, extractDir)
    } else {
      const extractResult = spawnSync('tar', ['xzf', archivePath, '-C', extractDir], {
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (extractResult.error || extractResult.status !== 0) {
        throw new Error(extractResult.error?.message || 'tar extraction failed')
      }
    }

    const extractedBinary = findBinaryRecursively(extractDir, platform() === 'win32' ? 'rtk.exe' : 'rtk')
    if (!extractedBinary) throw new Error('binary not found in archive')

    copyFileSync(extractedBinary, managedBinaryPath)
    if (platform() !== 'win32') chmodSync(managedBinaryPath, 0o755)

    if (!validateRtkBinary(managedBinaryPath)) {
      rmSync(managedBinaryPath, { force: true })
      throw new Error('binary validation failed')
    }

    stop?.()
    ui?.step('RTK installed', `v${RTK_VERSION}`)
  } catch (err) {
    stop?.()
    ui?.warn('RTK', describeFetchError(err))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

export async function runPostinstallDeps(packageRoot, { skipChromium, skipRtk, quiet = true }) {
  const ui = quiet ? null : createPlainUi()
  await repairPackageDependencies(packageRoot, { ui, quiet })
  linkWorkspacePackages(packageRoot, ui)
  await installChromium({ skip: skipChromium, ui })
  await installRtk({ skip: skipRtk, ui })
}

export async function runInteractiveDeps(packageRoot, {
  skipChromium,
  skipRtk,
  ui,
  verifyOnly = false,
  promptChromium,
  promptRtk,
}) {
  await repairPackageDependencies(packageRoot, { ui, quiet: false })
  linkWorkspacePackages(packageRoot, ui)

  let installChromiumFlag = skipChromium
  if (!skipChromium && promptChromium) {
    installChromiumFlag = !(await promptChromium())
  }

  let installRtkFlag = skipRtk
  if (!skipRtk && promptRtk) {
    installRtkFlag = !(await promptRtk())
  }

  await installChromium({ skip: installChromiumFlag, ui, verifyOnly: verifyOnly && !installChromiumFlag })
  await installRtk({ skip: installRtkFlag, ui, verifyOnly: verifyOnly && !installRtkFlag })
}

/** Plain stdout UI for postinstall when not quiet. */
export function createPlainUi() {
  const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR
  const c = supportsColor
    ? { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m' }
    : { cyan: '', green: '', yellow: '', dim: '', reset: '' }

  return {
    step(label, detail) {
      const detailStr = detail ? ` ${c.dim}${detail}${c.reset}` : ''
      process.stdout.write(`  ${c.green}✓${c.reset} ${label}${detailStr}\n`)
    },
    skip(label, reason) {
      process.stdout.write(`  ${c.dim}–${c.reset} ${label} ${c.dim}(${reason})${c.reset}\n`)
    },
    warn(label, detail) {
      const detailStr = detail ? `: ${detail}` : ''
      process.stdout.write(`  ${c.yellow}⚠${c.reset} ${label}${detailStr}\n`)
    },
    start(label) {
      if (!process.stdout.isTTY) {
        process.stdout.write(`  … ${label}\n`)
        return () => {}
      }
      const frames = ['◐', '◓', '◑', '◒']
      let frame = 0
      process.stdout.write(`  ${c.cyan}${frames[0]}${c.reset} ${label}`)
      const interval = setInterval(() => {
        frame = (frame + 1) % frames.length
        process.stdout.write(`\r  ${c.cyan}${frames[frame]}${c.reset} ${label}`)
      }, 100)
      return () => {
        clearInterval(interval)
        if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K')
      }
    },
  }
}

export function createClackUi(p) {
  return {
    step(label, detail) {
      p.log.success(detail ? `${label} ${detail}` : label)
    },
    skip(label, reason) {
      p.log.info(`${label} (${reason})`)
    },
    warn(label, detail) {
      p.log.warn(detail ? `${label}: ${detail}` : label)
    },
    start(label) {
      const s = p.spinner()
      s.start(label)
      return () => s.stop()
    },
  }
}
