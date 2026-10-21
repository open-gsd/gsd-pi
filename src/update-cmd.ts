import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isModelsCatalog, isModelsCatalogOverlay, type ModelsCatalog } from '@gsd/pi-ai'
import { agentDir as defaultAgentDir } from './app-paths.js'
import { resolveModelsCatalogPath } from './models-resolver.js'
import { initResources } from './resource-loader.js'
import { buildClaudeRuntimeFloorAdvisory } from './resources/shared/claude-runtime-floor.js'
import { reconcileGsdBrowserPathAfterInstall } from './resources/shared/gsd-browser-path-sync.js'
import {
  compareSemver,
  fetchLatestVersionFromRegistry,
  GSD_BROWSER_PACKAGE_NAME,
  GSD_BROWSER_REGISTRY_URL,
  GSD_PI_PACKAGE_NAME,
  pickHigherVersion,
  resolveGsdBrowserPathVersion,
  resolveInstallCommand,
  resolveInstalledPackageVersion,
} from './update-check.js'

const NPM_PACKAGE = GSD_PI_PACKAGE_NAME

export const MODELS_CATALOG_URL =
  'https://raw.githubusercontent.com/open-gsd/gsd-pi/main/packages/pi-ai/src/models.generated.json'
const MODELS_CATALOG_FETCH_TIMEOUT_MS = 15000

interface RunUpdateOptions {
  agentDir?: string
  skillsDir?: string
  target?: string
  /** Positional args after the target (e.g. an unexpected value after `--models`) */
  extraArgs?: string[]
}

function formatCurrentVersion(version: string | null): string {
  return version ? `v${version}` : 'unknown'
}

function printClaudeRuntimeFloorAdvisory(agentDir: string): void {
  let advisory: string | null = null
  try {
    advisory = buildClaudeRuntimeFloorAdvisory({
      agentDir,
      cwd: process.cwd(),
    })
  } catch {
    return
  }
  if (advisory) {
    const yellow = '\x1b[33m'
    const reset = '\x1b[0m'
    process.stdout.write(`${yellow}${advisory}${reset}\n`)
  }
}

// ---------------------------------------------------------------------------
// `gsd update --models` — refresh the runtime model-catalog overlay
// ---------------------------------------------------------------------------

interface CatalogCounts {
  providers: number
  models: number
}

function countCatalogModels(catalog: ModelsCatalog): CatalogCounts {
  const providers = Object.keys(catalog)
  let models = 0
  for (const provider of providers) {
    models += Object.keys(catalog[provider]).length
  }
  return { providers: providers.length, models }
}

/** Best-effort read of an existing overlay for before/after counts. */
function readExistingCatalogCounts(catalogPath: string): CatalogCounts | null {
  try {
    if (!existsSync(catalogPath)) return null
    const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf-8'))
    if (!isModelsCatalogOverlay(parsed)) return null
    return countCatalogModels(parsed.models)
  } catch {
    // Missing/malformed overlay must never break the update command
    return null
  }
}

type CatalogFetchResult =
  | { ok: true; catalog: ModelsCatalog }
  | { ok: false; reason: 'network' | 'invalid' }
  | { ok: false; reason: 'http'; status: number; statusText: string }

async function fetchModelsCatalog(url: string, timeoutMs: number): Promise<CatalogFetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    // A non-2xx response reached the server; it is an HTTP error, not a
    // connectivity problem, so report the status instead of "check your network".
    if (!res.ok) return { ok: false, reason: 'http', status: res.status, statusText: res.statusText }

    const data: unknown = await res.json()
    return isModelsCatalog(data)
      ? { ok: true, catalog: data }
      : { ok: false, reason: 'invalid' }
  } catch (err) {
    // res.json() throws on malformed JSON — that is an invalid payload, not a network error
    const isJsonError = err instanceof SyntaxError
    return { ok: false, reason: isJsonError ? 'invalid' : 'network' }
  } finally {
    clearTimeout(timeout)
  }
}

function failModelsUpdate(message: string): never {
  const yellow = '\x1b[33m'
  const reset = '\x1b[0m'
  process.stderr.write(`${yellow}${message}${reset}\n`)
  process.exit(1)
}

async function runModelsUpdate(agentDirOverride?: string): Promise<void> {
  const bold = '\x1b[1m'
  const dim = '\x1b[2m'
  const green = '\x1b[32m'
  const reset = '\x1b[0m'

  const catalogPath = agentDirOverride
    ? join(agentDirOverride, 'models-catalog.json')
    : resolveModelsCatalogPath()

  process.stdout.write(`${dim}Fetching model catalog...${reset}\n`)
  process.stdout.write(`${dim}Source:${reset} ${MODELS_CATALOG_URL}\n`)

  const result = await fetchModelsCatalog(MODELS_CATALOG_URL, MODELS_CATALOG_FETCH_TIMEOUT_MS)
  if (!result.ok) {
    // Never clobber an existing overlay on failure — return before any write
    if (result.reason === 'invalid') {
      failModelsUpdate('Fetched model catalog is invalid: expected a provider → model map. Existing catalog left unchanged.')
    }
    if (result.reason === 'http') {
      const statusText = result.statusText ? ` ${result.statusText}` : ''
      failModelsUpdate(`Failed to fetch model catalog: server responded with HTTP ${result.status}${statusText}. Existing catalog left unchanged.`)
    }
    failModelsUpdate('Failed to fetch model catalog. Check your network connection. Existing catalog left unchanged.')
  }

  const before = readExistingCatalogCounts(catalogPath)
  const after = countCatalogModels(result.catalog)

  const overlay = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    source: MODELS_CATALOG_URL,
    models: result.catalog,
  }

  // Atomic write: temp file in the same directory, then rename
  const tmpPath = `${catalogPath}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(catalogPath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(overlay, null, 2) + '\n')
    renameSync(tmpPath, catalogPath)
  } catch (err) {
    rmSync(tmpPath, { force: true })
    const detail = err instanceof Error ? err.message : String(err)
    failModelsUpdate(`Failed to write model catalog: ${detail}. Existing catalog left unchanged.`)
  }

  if (before) {
    process.stdout.write(
      `${dim}Previous catalog:${reset} ${before.providers} providers, ${before.models} models\n`,
    )
  }
  process.stdout.write(
    `${green}${bold}Updated model catalog:${reset} ${after.providers} providers, ${after.models} models\n`,
  )
  process.stdout.write(`${dim}Saved to${reset} ${catalogPath}\n`)
}

async function runBrowserUpdate(): Promise<void> {
  const bundled = resolveInstalledPackageVersion(GSD_BROWSER_PACKAGE_NAME)
  const current = pickHigherVersion(bundled, resolveGsdBrowserPathVersion())
  const bold = '\x1b[1m'
  const dim = '\x1b[2m'
  const green = '\x1b[32m'
  const yellow = '\x1b[33m'
  const reset = '\x1b[0m'

  process.stdout.write(`${dim}Current gsd-browser version:${reset} ${formatCurrentVersion(current)}\n`)
  process.stdout.write(`${dim}Checking npm registry...${reset}\n`)

  const latest = await fetchLatestVersionFromRegistry(GSD_BROWSER_REGISTRY_URL)
  if (!latest) {
    process.stderr.write(`${yellow}Failed to reach npm registry.${reset}\n`)
    process.exit(1)
  }

  process.stdout.write(`${dim}Latest gsd-browser version:${reset}  v${latest}\n`)

  if (current && compareSemver(latest, current) <= 0) {
    process.stdout.write(`${green}gsd-browser is already up to date.${reset}\n`)
    return
  }

  process.stdout.write(`${dim}Updating gsd-browser:${reset} ${formatCurrentVersion(current)} → ${bold}v${latest}${reset}\n`)

  const installCmd = resolveInstallCommand(`${GSD_BROWSER_PACKAGE_NAME}@latest`)
  try {
    execSync(installCmd, {
      stdio: 'inherit',
    })
    process.stdout.write(`\n${green}${bold}Updated gsd-browser to v${latest}${reset}\n`)

    let reconcile: ReturnType<typeof reconcileGsdBrowserPathAfterInstall> | null = null
    try {
      reconcile = reconcileGsdBrowserPathAfterInstall({
        latestVersion: latest,
        compareSemver,
        resolvePathVersion: resolveGsdBrowserPathVersion,
      })
    } catch {
      // Reconciliation is best-effort: the install above already succeeded,
      // so a reconcile failure must not flip the result to "Update failed".
      reconcile = null
    }
    if (reconcile?.action === 'synced' && reconcile.message) {
      process.stdout.write(`${green}${reconcile.message}${reset}\n`)
    }

    const newPathVersion = resolveGsdBrowserPathVersion()
    if (!newPathVersion || compareSemver(newPathVersion, latest) < 0) {
      const guidance = reconcile?.message
        ?? `${dim}Ensure the npm global bin directory is on your PATH so MCP automation uses the updated binary.${reset}`
      process.stdout.write(`${yellow}Note:${reset} ${guidance}\n`)
    }
  } catch {
    process.stderr.write(`\n${yellow}gsd-browser update failed. Try manually: ${installCmd}${reset}\n`)
    process.exit(1)
  }
}

export async function runUpdate(options: RunUpdateOptions = {}): Promise<void> {
  if (options.target === 'browser' || options.target === 'gsd-browser') {
    await runBrowserUpdate()
    return
  }
  if (options.target === '--models') {
    if (options.extraArgs && options.extraArgs.length > 0) {
      process.stderr.write(`gsd update --models does not take a value: ${options.extraArgs.join(' ')}\n`)
      process.stderr.write('Usage: gsd update [browser] [--models]\n')
      process.exit(1)
    }
    await runModelsUpdate(options.agentDir)
    return
  }
  if (options.target) {
    process.stderr.write(`Unknown update target: ${options.target}\n`)
    process.stderr.write('Usage: gsd update [browser] [--models]\n')
    process.exit(1)
  }

  const current = process.env.GSD_VERSION || '0.0.0'
  const bold = '\x1b[1m'
  const dim = '\x1b[2m'
  const green = '\x1b[32m'
  const yellow = '\x1b[33m'
  const reset = '\x1b[0m'

  process.stdout.write(`${dim}Current version:${reset} v${current}\n`)
  process.stdout.write(`${dim}Checking npm registry...${reset}\n`)

  const latest = await fetchLatestVersionFromRegistry()
  if (!latest) {
    process.stderr.write(`${yellow}Failed to reach npm registry.${reset}\n`)
    process.exit(1)
  }

  process.stdout.write(`${dim}Latest version:${reset}  v${latest}\n`)

  if (compareSemver(latest, current) <= 0) {
    process.stdout.write(`${green}Already up to date.${reset}\n`)
    initResources(options.agentDir ?? defaultAgentDir, options.skillsDir)
    printClaudeRuntimeFloorAdvisory(options.agentDir ?? defaultAgentDir)
    return
  }

  process.stdout.write(`${dim}Updating:${reset} v${current} → ${bold}v${latest}${reset}\n`)

  const installCmd = resolveInstallCommand(`${NPM_PACKAGE}@latest`)
  try {
    execSync(installCmd, {
      stdio: 'inherit',
    })
    process.stdout.write(`\n${green}${bold}Updated to v${latest}${reset}\n`)
    printClaudeRuntimeFloorAdvisory(options.agentDir ?? defaultAgentDir)
  } catch {
    process.stderr.write(`\n${yellow}Update failed. Try manually: ${installCmd}${reset}\n`)
    process.exit(1)
  }
}
