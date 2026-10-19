import type { DefaultResourceLoader as DefaultResourceLoaderType } from '@gsd/pi-coding-agent'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver } from './update-check.js'
import { discoverExtensionEntryPaths, mergeExtensionEntryPaths } from './extension-discovery.js'
import { loadRegistry, readManifestFromEntryPath, isExtensionEnabled, ensureRegistryEntries } from './extension-registry.js'
import { resolveBundledResourcesDirFromPackageRoot } from './bundled-resource-path.js'

type PiCodingAgentModule = typeof import('@gsd/pi-coding-agent')

let piCodingAgentModulePromise: Promise<PiCodingAgentModule> | undefined

function loadPiCodingAgentModule(): Promise<PiCodingAgentModule> {
  return (piCodingAgentModulePromise ??= import('@gsd/pi-coding-agent'))
}

// Resolve resources directory — prefer dist/resources/ (stable, set at build time)
// over src/resources/ (live working tree, changes with git branch).
//
// Why this matters: with `npm link`, src/resources/ points into the gsd-pi repo's
// working tree. Switching branches there changes src/resources/ for ALL projects
// that use gsd — causing stale/broken extensions to be synced to ~/.gsd/agent/.
// dist/resources/ is populated by the build step (`npm run copy-resources`) and
// reflects the built state, not the currently checked-out branch.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let resourcesDir = resolveBundledResourcesDirFromPackageRoot(packageRoot)
let bundledExtensionsDir = join(resourcesDir, 'extensions')
const resourceVersionManifestName = 'managed-resources.json'
const resourceFingerprintFileName = '.managed-resources-content-hash'
const gsdBrowserSkillName = 'gsd-browser'
const requireFromResourceLoader = createRequire(import.meta.url)
const gsdBrowserSkillReferenceDirs = ['docs', 'scripts', 'gsd-browser-skill']
let gsdBrowserPackageSkillPathForTests: string | null | undefined
let afterResourceSyncForTests: (() => void) | undefined

interface ManagedResourceManifest {
  gsdVersion: string
  packageName?: string
  syncedAt?: number
  /** Content fingerprint of bundled resources — detects same-version content changes. */
  contentHash?: string
  /**
   * Root-level files installed in extensions/ by this GSD version.
   * Used on the next upgrade to detect and prune files that were removed or
   * moved into a subdirectory, preventing orphaned non-extension files from
   * causing extension load errors.
   */
  installedExtensionRootFiles?: string[]
  /**
   * Subdirectory extension names installed in extensions/ by this GSD version.
   * Used on the next upgrade to detect and prune subdirectory extensions that
   * were removed from the bundle.
   */
  installedExtensionDirs?: string[]
}

export { discoverExtensionEntryPaths } from './extension-discovery.js'

export function getExtensionKey(entryPath: string, extensionsDir: string): string {
  const relPath = relative(extensionsDir, entryPath)
  return relPath.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, '')
}

function stripSemverBuildMetadata(version: string): string {
  return version.trim().replace(/^v/, '').split(/[+-]/, 1)[0] || '0.0.0'
}

function getManagedResourceManifestPath(agentDir: string): string {
  return join(agentDir, resourceVersionManifestName)
}

function getBundledGsdVersion(): string {
  // Prefer GSD_VERSION env var (set once by loader.ts) to avoid re-reading package.json
  if (process.env.GSD_VERSION && process.env.GSD_VERSION !== '0.0.0') {
    return process.env.GSD_VERSION
  }
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'))
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function getBundledPackageName(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'))
    return typeof pkg?.name === 'string' ? pkg.name : '@opengsd/gsd-pi'
  } catch {
    return '@opengsd/gsd-pi'
  }
}

function writeManagedResourceManifest(agentDir: string, contentHash: string): void {
  // Record root-level files and subdirectory extension names currently in the
  // bundled extensions source so that future upgrades can detect and prune any
  // that get removed or moved.
  let installedExtensionRootFiles: string[] = []
  let installedExtensionDirs: string[] = []
  try {
    if (existsSync(bundledExtensionsDir)) {
      const entries = readdirSync(bundledExtensionsDir, { withFileTypes: true })
      installedExtensionRootFiles = entries
        .filter(e => e.isFile())
        .map(e => e.name)
      installedExtensionDirs = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          // Track directories that are actual extensions — identified by an
          // index.js/index.ts entry point OR an extension-manifest.json (e.g.
          // remote-questions which uses mod.ts instead of index.ts).
          const dirPath = join(bundledExtensionsDir, e.name)
          return existsSync(join(dirPath, 'index.js'))
            || existsSync(join(dirPath, 'index.ts'))
            || existsSync(join(dirPath, 'extension-manifest.json'))
        })
        .map(e => e.name)
    }
  } catch { /* non-fatal */ }

  const manifest: ManagedResourceManifest = {
    gsdVersion: getBundledGsdVersion(),
    packageName: getBundledPackageName(),
    syncedAt: Date.now(),
    contentHash,
    installedExtensionRootFiles,
    installedExtensionDirs,
  }
  writeFileSync(getManagedResourceManifestPath(agentDir), JSON.stringify(manifest))
}

export function readManagedResourceVersion(agentDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), 'utf-8')) as ManagedResourceManifest
    if (!isCurrentPackageManifest(manifest)) return null
    return typeof manifest?.gsdVersion === 'string' ? manifest.gsdVersion : null
  } catch {
    return null
  }
}

function isCurrentPackageManifest(manifest: ManagedResourceManifest | null): boolean {
  return manifest?.packageName === getBundledPackageName()
}

function readManagedResourceManifest(agentDir: string): ManagedResourceManifest | null {
  try {
    return JSON.parse(readFileSync(getManagedResourceManifestPath(agentDir), 'utf-8')) as ManagedResourceManifest
  } catch {
    return null
  }
}

/**
 * Computes a content fingerprint of a resources directory (defaults to the
 * bundled resourcesDir).
 *
 * Walks all files under `rootDir` and hashes `${relativePath}:${sha256(contents)}`
 * for each one. Using the file *contents* — not size — is what distinguishes
 * this from the earlier implementation and closes #4787: a same-size edit
 * (e.g. swapping one word for another word of the same byte length) produces
 * a different file hash, bumps the aggregate fingerprint, and therefore
 * triggers a full resync in `initResources`. The old path+size approach
 * silently cached stale prompts across upgrades.
 *
 * Measured ~25-30ms on a 2025 laptop for the full shipped tree (~1500 files,
 * 17MB) — larger than early estimates but still well under the ~128ms
 * synchronous cpSync it gates at startup. Files are streamed via
 * `readFileSync` but bundled resources are small so this is fine.
 *
 * Exported for unit tests and for callers that want to check a different
 * directory (e.g. pre-install verification).
 */
export function computeResourceFingerprint(rootDir: string = resourcesDir): string {
  const entries: string[] = []
  collectFileEntries(rootDir, rootDir, entries)
  entries.sort()
  return createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16)
}

function resolveGsdBrowserPackageSkillPath(): string | null {
  if (gsdBrowserPackageSkillPathForTests !== undefined) {
    return gsdBrowserPackageSkillPathForTests
  }
  try {
    return requireFromResourceLoader.resolve('@opengsd/gsd-browser/SKILL.md')
  } catch {
    return null
  }
}

export function setGsdBrowserPackageSkillPathForTests(skillPath: string | null | undefined): void {
  gsdBrowserPackageSkillPathForTests = skillPath
}

/**
 * Points the resource loader at a temp bundle for tests, so the shipped-hash
 * scenario (#2106) can be reproduced without touching the real resources tree.
 * Pass undefined/null to restore the default resolution.
 */
export function setBundledResourcesDirForTests(dir: string | null | undefined): void {
  resourcesDir = dir ?? resolveBundledResourcesDirFromPackageRoot(packageRoot)
  bundledExtensionsDir = join(resourcesDir, 'extensions')
}

export function setAfterResourceSyncForTests(callback: (() => void) | undefined): void {
  afterResourceSyncForTests = callback
}

export function collectGsdBrowserPackageSkillReferences(content: string): string[] {
  const refs = new Set<string>()
  const referencePattern = /`((?:\.\/)?(?:docs|scripts|gsd-browser-skill)\/[^`\s]+)`/g

  for (const match of content.matchAll(referencePattern)) {
    const ref = normalizeGsdBrowserPackageSkillReference(match[1])
    if (ref) refs.add(ref)
  }

  return [...refs].sort()
}

function normalizeGsdBrowserPackageSkillReference(ref: string | undefined): string | null {
  if (!ref) return null
  const normalized = ref
    .replace(/^\.\//, '')
    .replace(/[),.;:]+$/, '')

  if (normalized.includes('..') || normalized.startsWith('/')) return null
  if (!gsdBrowserSkillReferenceDirs.some(dir => normalized === dir || normalized.startsWith(`${dir}/`))) {
    return null
  }

  return normalized
}

function readGsdBrowserPackageSkillBundle(sourceSkillPath: string): Map<string, Buffer> {
  const skillContent = readFileSync(sourceSkillPath)
  const files = new Map<string, Buffer>([['SKILL.md', skillContent]])
  const supportRefs = collectGsdBrowserPackageSkillReferences(skillContent.toString('utf-8'))
  const sourceDir = dirname(sourceSkillPath)

  for (const relPath of supportRefs) {
    const sourcePath = join(sourceDir, relPath)
    if (existsSync(sourcePath)) {
      files.set(relPath, readFileSync(sourcePath))
    }
  }

  return files
}

export function hasStaleGsdBrowserPackageSkill(skillsDir: string): boolean {
  const targetDir = join(skillsDir, gsdBrowserSkillName)
  const sourceSkillPath = resolveGsdBrowserPackageSkillPath()

  // Package unresolvable. syncGsdBrowserPackageSkill is a no-op in this case
  // (it preserves any existing managed skill), so reporting "stale" here
  // would drive a full resource resync on every launch that the sync cannot
  // actually satisfy. Keep the existing managed skill in place until the
  // package becomes resolvable again or the manifest fingerprint changes.
  if (!sourceSkillPath) return false

  try {
    const sourceDir = dirname(sourceSkillPath)
    const skillContent = readFileSync(sourceSkillPath, 'utf-8')
    for (const [relPath, content] of readGsdBrowserPackageSkillBundle(sourceSkillPath)) {
      const targetPath = join(targetDir, relPath)
      if (!existsSync(targetPath) || !readFileSync(targetPath).equals(content)) {
        return true
      }
    }
    // Only flag SKILL.md references when sync can actually correct them.
    // The bundle loop above already covers "source has it, target missing".
    // A reference the package itself does not ship (source missing) is only
    // worth a resync if the target still has a stale copy that sync should
    // clean up; missing on both sides is the steady state when upstream
    // omits files referenced from SKILL.md and is not actionable here.
    for (const relPath of collectGsdBrowserPackageSkillReferences(skillContent)) {
      const sourcePath = join(sourceDir, relPath)
      const targetPath = join(targetDir, relPath)
      if (!existsSync(sourcePath) && existsSync(targetPath)) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

function syncGsdBrowserPackageSkill(skillsDir: string): void {
  const targetDir = join(skillsDir, gsdBrowserSkillName)
  const sourceSkillPath = resolveGsdBrowserPackageSkillPath()

  if (!sourceSkillPath) return

  makeTreeWritable(targetDir)
  rmSync(targetDir, { recursive: true, force: true })

  for (const [relPath, content] of readGsdBrowserPackageSkillBundle(sourceSkillPath)) {
    const targetPath = join(targetDir, relPath)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, content)
    if (relPath.startsWith('scripts/') && relPath.endsWith('.sh')) {
      chmodSync(targetPath, 0o755)
    }
  }
  makeTreeWritable(targetDir)
}

function collectFileEntries(dir: string, root: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === resourceFingerprintFileName) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFileEntries(fullPath, root, out)
    } else {
      // Normalize separators to match scripts/copy-resources.cjs and
      // scripts/watch-resources.js, so the live hash equals the shipped
      // precomputed hash on Windows too (#2106).
      const rel = relative(root, fullPath).replaceAll('\\', '/')
      // Hash the file contents — see function doc for #4787 rationale.
      let contentHash: string
      try {
        contentHash = createHash('sha256').update(readFileSync(fullPath)).digest('hex')
      } catch {
        // Unreadable file — fall back to a stable marker so the entry still
        // contributes to the aggregate hash and future reads will re-hash.
        contentHash = 'unreadable'
      }
      out.push(`${rel}:${contentHash}`)
    }
  }
}


export function getNewerManagedResourceVersion(agentDir: string, currentVersion: string): string | null {
  const manifest = readManagedResourceManifest(agentDir)
  if (!isCurrentPackageManifest(manifest)) {
    return null
  }
  const managedVersion = typeof manifest?.gsdVersion === 'string' ? manifest.gsdVersion : null
  if (!managedVersion) {
    return null
  }
  // Managed resources stamped from the same release line should remain usable
  // against local dev binaries like 2.78.1-dev.<sha>.
  return compareSemver(
    stripSemverBuildMetadata(managedVersion),
    stripSemverBuildMetadata(currentVersion),
  ) > 0 ? managedVersion : null
}

/**
 * Recursively makes all files and directories under dirPath owner-writable.
 *
 * Files copied from the Nix store inherit read-only modes (0444/0555).
 * Calling this before cpSync prevents overwrite failures on subsequent upgrades,
 * and calling it after ensures the next run can overwrite the copies too.
 *
 * Preserves existing permission bits (including executability) and only adds
 * owner-write (and for directories, owner-exec) without widening group/other
 * permissions.
 */
function makeTreeWritable(dirPath: string): void {
  if (!existsSync(dirPath)) return

  // Use lstatSync to avoid following symlinks into immutable filesystems
  // (e.g., Nix store on NixOS/nix-darwin). Symlinks don't carry their own
  // permissions and their targets may be read-only by design (#1298).
  const stats = lstatSync(dirPath)
  if (stats.isSymbolicLink()) return

  const isDir = stats.isDirectory()
  const currentMode = stats.mode & 0o777

  // Ensure owner-write; for directories also ensure owner-exec so they remain traversable.
  let newMode = currentMode | 0o200
  if (isDir) {
    newMode |= 0o100
  }

  if (newMode !== currentMode) {
    try {
      chmodSync(dirPath, newMode)
    } catch {
      // Non-fatal — may fail on read-only filesystems or insufficient permissions
    }
  }

  if (isDir) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name)
      makeTreeWritable(entryPath)
    }
  }
}

/**
 * Syncs a single bundled resource directory into the agent directory.
 *
 * 1. Makes the destination writable (handles Nix store read-only copies).
 * 2. Removes destination subdirs that exist in source to clear stale files,
 *    while preserving user-created directories.
 * 3. Copies source into destination.
 * 4. Makes the result writable for the next upgrade cycle.
 */
export function syncResourceDir(srcDir: string, destDir: string): void {
  makeTreeWritable(destDir)
  if (existsSync(srcDir)) {
    pruneStaleSiblingFiles(srcDir, destDir)
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const target = join(destDir, entry.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      }
    }
    try {
      cpSync(srcDir, destDir, { recursive: true, force: true })
    } catch {
      // Fallback for Windows paths with non-ASCII characters where cpSync
      // fails with the \\?\ extended-length prefix (#1178).
      copyDirRecursive(srcDir, destDir)
    }
    makeTreeWritable(destDir)
  }
}

function pruneStaleSiblingFiles(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) return

  const sourceFiles = new Set(
    readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  )

  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (sourceFiles.has(entry.name)) continue

    const sourceJsName = entry.name.replace(/\.ts$/, '.js')
    const sourceTsName = entry.name.replace(/\.js$/, '.ts')
    if (sourceFiles.has(sourceJsName) || sourceFiles.has(sourceTsName)) {
      rmSync(join(destDir, entry.name), { force: true })
    }
  }
}

/**
 * Recursive directory copy using copyFileSync — workaround for cpSync failures
 * on Windows paths containing non-ASCII characters (#1178).
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * Creates (or updates) a symlink at agentDir/node_modules pointing to GSD's
 * own node_modules directory.
 *
 * Native ESM `import()` ignores NODE_PATH — it resolves packages by walking
 * up the directory tree from the importing file. Extension files synced to
 * ~/.gsd/agent/extensions/ have no ancestor node_modules, so imports of
 * @gsd/* packages fail. The symlink makes Node's standard resolution find
 * them without requiring every call site to use jiti.
 *
 * Layout differences by install method:
 * - Source/monorepo: packageRoot/node_modules has everything -> simple symlink
 * - Global install (npm/bun/pnpm): merge the nearest ancestor node_modules
 *   with packageRoot/node_modules so both hoisted deps like yaml and
 *   package-local deps like @sinclair/typebox resolve (#3529, #3564).
 */
function ensureNodeModulesSymlink(agentDir: string): void {
  const agentNodeModules = join(agentDir, 'node_modules')
  const { internalNodeModules, hoistedNodeModules } = resolvePackageNodeModulesLayout(packageRoot)

  if (!hoistedNodeModules) {
    // Source/monorepo: internal node_modules has everything
    reconcileSymlink(agentNodeModules, internalNodeModules)
    return
  }

  // Global install: always merge hoisted + package-local node_modules.
  // npm often keeps runtime deps (e.g. @sinclair/typebox) package-local even when
  // @gsd/* scopes are hoisted — a hoisted-only symlink breaks extension imports.
  reconcileMergedNodeModules(agentNodeModules, hoistedNodeModules, internalNodeModules)
}

export function resolvePackageNodeModulesLayout(root: string): {
  internalNodeModules: string
  hoistedNodeModules: string | null
} {
  return {
    internalNodeModules: join(root, 'node_modules'),
    hoistedNodeModules: findNearestNodeModulesAncestor(root),
  }
}

export function findNearestNodeModulesAncestor(startPath: string): string | null {
  let current = resolve(startPath)
  while (true) {
    if (basename(current) === 'node_modules') return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Check if any GSD workspace scopes exist in internal but not in hoisted node_modules */
export function hasMissingWorkspaceScopes(hoisted: string, internal: string): boolean {
  if (!existsSync(internal)) return false
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.isDirectory() && isGsdWorkspaceScope(entry.name) &&
          !existsSync(join(hoisted, entry.name))) {
        return true
      }
    }
  } catch { /* non-fatal */ }
  return false
}

function isGsdWorkspaceScope(scope: string): boolean {
  return scope === '@gsd' || scope === '@gsd-build' || scope === '@opengsd'
}

/** Ensure a symlink at `link` points to `target`, fixing stale/wrong entries */
function reconcileSymlink(link: string, target: string): void {
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) {
      const existing = readlinkSync(link)
      if (existing === target && existsSync(link)) return  // correct and target exists
      unlinkSync(link)
    } else {
      // Real directory (or merged dir from previous pnpm fix) — remove it
      rmSync(link, { recursive: true, force: true })
    }
  } catch {
    // lstatSync throws if path doesn't exist — fine, we'll create below
  }

  try {
    symlinkSync(target, link, 'junction')
  } catch (err) {
    console.error(`[gsd] WARN: Failed to symlink ${link} → ${target}: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Create a real node_modules directory containing symlinks from both the
 * hoisted root (external deps) and internal root (@gsd/* workspace packages).
 * Used for pnpm global installs where @gsd/* isn't hoisted.
 */
export function reconcileMergedNodeModules(
  agentNodeModules: string,
  hoisted: string,
  internal: string,
): void {
  // Fast path: if already merged for this packageRoot + same directory contents, skip.
  // The fingerprint includes entry names from both roots so `pnpm add/remove` triggers rebuild.
  const marker = join(agentNodeModules, '.gsd-merged')
  const fingerprint = mergedFingerprint(hoisted, internal)
  try {
    if (existsSync(marker) && readFileSync(marker, 'utf-8').trim() === fingerprint) return
  } catch { /* rebuild */ }

  // Remove any existing symlink or stale merged directory
  try {
    const stat = lstatSync(agentNodeModules)
    if (stat.isSymbolicLink()) {
      unlinkSync(agentNodeModules)
    } else {
      rmSync(agentNodeModules, { recursive: true, force: true })
    }
  } catch { /* doesn't exist */ }

  mkdirSync(agentNodeModules, { recursive: true })

  let linkedCount = 0

  // Symlink entries from the hoisted node_modules (external deps)
  try {
    for (const entry of readdirSync(hoisted, { withFileTypes: true })) {
      // Skip the gsd-pi package itself and dotfiles
      if (entry.name === basename(packageRoot)) continue
      if (entry.name.startsWith('.')) continue
      try { symlinkSync(join(hoisted, entry.name), join(agentNodeModules, entry.name), 'junction'); linkedCount++ } catch { /* skip individual */ }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read hoisted node_modules at ${hoisted}: ${err instanceof Error ? err.message : err}`)
  }

  // Overlay internal node_modules entries that weren't hoisted.
  // This covers @gsd/* workspace packages AND optional deps like
  // @anthropic-ai/claude-agent-sdk that npm keeps internal.
  try {
    for (const entry of readdirSync(internal, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const link = join(agentNodeModules, entry.name)
      // Replace hoisted symlink with internal version (internal takes precedence)
      try { lstatSync(link); unlinkSync(link) } catch { /* didn't exist — will create below */ }
      try { symlinkSync(join(internal, entry.name), link, 'junction'); linkedCount++ } catch { /* skip individual */ }
    }
  } catch (err) {
    console.error(`[gsd] WARN: Failed to read internal node_modules at ${internal}: ${err instanceof Error ? err.message : err}`)
  }

  // Only stamp marker if we actually linked something — avoids caching a broken state
  if (linkedCount > 0) {
    try { writeFileSync(marker, fingerprint) } catch { /* non-fatal */ }
  }
}

/** Build a cache fingerprint from packageRoot + sorted entry names of both directories */
export function mergedFingerprint(hoisted: string, internal: string): string {
  try {
    const h = readdirSync(hoisted).sort().join(',')
    const i = readdirSync(internal).sort().join(',')
    return `${packageRoot}\n${h}\n${i}`
  } catch {
    return packageRoot  // fallback: at least invalidate on version change
  }
}

/**
 * Prune root-level extension files that were installed by a previous GSD version
 * but have since been removed or relocated to a subdirectory.
 *
 * Two strategies:
 * 1. Manifest-based (preferred): the manifest records which root files were installed
 *    last time; any that are no longer in the current bundle are deleted.
 * 2. Known-stale fallback: for upgrades from versions before manifest tracking,
 *    explicitly delete files known to have been moved (e.g. env-utils.js → gsd/).
 */
function pruneRemovedBundledExtensions(
  manifest: ManagedResourceManifest | null,
  agentDir: string,
): void {
  const extensionsDir = join(agentDir, 'extensions')
  if (!existsSync(extensionsDir)) return

  // Current bundled root-level files (what the new version provides)
  const currentSourceFiles = new Set<string>()
  // Current bundled subdirectory extensions
  const currentSourceDirs = new Set<string>()
  try {
    if (existsSync(bundledExtensionsDir)) {
      for (const e of readdirSync(bundledExtensionsDir, { withFileTypes: true })) {
        if (e.isFile()) currentSourceFiles.add(e.name)
        if (e.isDirectory()) currentSourceDirs.add(e.name)
      }
    }
  } catch { /* non-fatal */ }

  const removeFileIfStale = (fileName: string) => {
    if (currentSourceFiles.has(fileName)) return  // still in bundle, not stale
    const stale = join(extensionsDir, fileName)
    try { if (existsSync(stale)) rmSync(stale, { force: true }) } catch { /* non-fatal */ }
  }

  const removeDirIfStale = (dirName: string) => {
    if (currentSourceDirs.has(dirName)) return  // still in bundle, not stale
    const stale = join(extensionsDir, dirName)
    try { if (existsSync(stale)) rmSync(stale, { recursive: true, force: true }) } catch { /* non-fatal */ }
  }

  if (manifest?.installedExtensionRootFiles) {
    // Manifest-based: remove previously-installed root files that are no longer bundled
    for (const prevFile of manifest.installedExtensionRootFiles) {
      removeFileIfStale(prevFile)
    }
  }

  if (manifest?.installedExtensionDirs) {
    // Manifest-based: remove previously-installed subdirectory extensions that are no longer bundled.
    // Do not sweep unknown directories — those are user-created (#1853).
    for (const prevDir of manifest.installedExtensionDirs) {
      removeDirIfStale(prevDir)
    }
  }

  // Always remove known stale files regardless of manifest state.
  // These were installed by pre-manifest versions so they may not appear in
  // installedExtensionRootFiles even when a manifest exists.
  // env-utils.js was moved from extensions/ root → gsd/ in v2.39.x (#1634)
  removeFileIfStale('env-utils.js')
}

/**
 * Initializes managed resources under agentDir (~/.gsd/agent/).
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (overwrite when version changes)
 * - shared/     → ~/.gsd/agent/shared/       (overwrite when version changes)
 * - agents/     → ~/.gsd/agent/agents/        (overwrite when version changes)
 * - skills/     → ~/.gsd/agent/skills/        (overwrite when version changes)
 * - gsd-browser skill → ~/.gsd/agent/skills/gsd-browser/ from @opengsd/gsd-browser
 * - GSD-WORKFLOW.md → ~/.gsd/agent/GSD-WORKFLOW.md (fallback for env var miss)
 *
 * Skips the full copy when the managed-resources.json version and content
 * fingerprint match the current install, avoiding ~128ms of synchronous cpSync
 * on steady-state startup.
 * After `npm update -g @opengsd/gsd-pi`, versions will differ and the copy
 * runs once to land the new resources.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string, skillsDir: string = join(agentDir, 'skills')): void {
  mkdirSync(agentDir, { recursive: true })

  const currentVersion = getBundledGsdVersion()
  const manifest = readManagedResourceManifest(agentDir)
  const extensionsDir = join(agentDir, 'extensions')
  const usingManagedSkillsDir = resolve(skillsDir) === resolve(join(agentDir, 'skills'))

  // Always prune root-level extension files that were removed from the bundle.
  // This is cheap (a few existence checks + at most one rmSync) and must run
  // unconditionally so that stale files left by a previous version are cleaned
  // up even when the version/hash match causes the full sync to be skipped.
  pruneRemovedBundledExtensions(manifest, agentDir)
  pruneStaleSiblingFiles(bundledExtensionsDir, extensionsDir)

  // Ensure ~/.gsd/agent/node_modules symlinks to GSD's node_modules on EVERY
  // launch, not just during resource syncs. A stale/broken symlink makes ALL
  // extensions fail to resolve @gsd/* packages, rendering GSD non-functional.
  ensureNodeModulesSymlink(agentDir)

  // Reclaim exact bundled skill copies from ~/.agents/skills/ on every launch
  // so existing installs are cleaned up even when the managed-resource manifest
  // is current. Ambiguous/user-modified copies are left untouched.
  if (usingManagedSkillsDir) {
    cleanupBundledSkillsFromEcosystemDir()
  }

  // Skip the full copy when both version AND content fingerprint match.
  // Version-only checks miss same-version content changes (npm link dev workflow,
  // hotfixes within a release). The hash must be computed LIVE against the
  // bundled tree (#2106): the shipped precomputed file is immutable after
  // install, so comparing against it can never detect same-version edits.
  const currentHash = computeResourceFingerprint()
  if (manifest && isCurrentPackageManifest(manifest) && manifest.gsdVersion === currentVersion) {
    // Version matches — check content fingerprint for same-version staleness.
    if (manifest.contentHash && manifest.contentHash === currentHash
      && !hasMissingBundledResourceFiles(extensionsDir, bundledExtensionsDir)) {
      return
    }
  }

  // Sync bundled resources — overwrite so updates land on next launch.

  syncResourceDir(bundledExtensionsDir, join(agentDir, 'extensions'))
  syncResourceDir(join(resourcesDir, 'shared'), join(agentDir, 'shared'))
  syncResourceDir(join(resourcesDir, 'agents'), join(agentDir, 'agents'))
  syncResourceDir(join(resourcesDir, 'skills'), skillsDir)
  syncGsdBrowserPackageSkill(skillsDir)

  // Sync GSD-WORKFLOW.md to agentDir as a fallback for when GSD_WORKFLOW_PATH
  // env var is not set (e.g. fork/dev builds, alternative entry points).
  const workflowSrc = join(resourcesDir, 'GSD-WORKFLOW.md')
  if (existsSync(workflowSrc)) {
    try { copyFileSync(workflowSrc, join(agentDir, 'GSD-WORKFLOW.md')) } catch { /* non-fatal */ }
  }

  // Ensure all newly copied files are owner-writable so the next run can
  // overwrite them (covers extensions, agents, and skills in one walk).
  makeTreeWritable(agentDir)

  afterResourceSyncForTests?.()
  // ABA note: a concurrent mutation of the bundled tree during the copy window that reverts before the next launch can leave one stale installed file undetected; snapshot-copy semantics are out of scope for this convenience sync.
  writeManagedResourceManifest(agentDir, currentHash)
  ensureRegistryEntries(join(agentDir, 'extensions'))
}

// ─── Bundled Skill Ecosystem Cleanup ─────────────────────────────────────────────

function cleanupBundledSkillsFromEcosystemDir(): void {
  const bundledSkillsDir = join(resourcesDir, 'skills')
  const ecosystemDir = join(homedir(), '.agents', 'skills')
  if (!existsSync(bundledSkillsDir) || !existsSync(ecosystemDir)) return

  for (const entry of readdirSync(bundledSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const bundledSkillDir = join(bundledSkillsDir, entry.name)
    const targetPath = join(ecosystemDir, entry.name)
    if (!existsSync(targetPath)) continue

    try {
      if (lstatSync(targetPath).isSymbolicLink()) continue
      // Only reclaim byte-exact bundled copies; anything else in the shared
      // ecosystem dir is user-owned and must never be deleted (#2286).
      if (!isExactDirectoryCopy(targetPath, bundledSkillDir)) {
        console.error(`[gsd] WARN: Left user-owned skill in place: ${targetPath} (only exact unmodified bundled skill copies are reclaimed from ${ecosystemDir})`)
        continue
      }
      makeTreeWritable(targetPath)
      rmSync(targetPath, { recursive: true, force: true })
    } catch {
      // Non-fatal: never let cleanup of the shared ecosystem dir block startup.
    }
  }
}

/**
 * True only when candidateDir has the same relative file set as referenceDir
 * with byte-identical file contents. Entry types are checked with lstat
 * semantics (Dirents), so symlinks on either side are never followed and
 * non-regular entries (FIFOs, sockets, devices) are rejected before any read —
 * reading a FIFO would block forever. Any read error or type mismatch counts
 * as NOT an exact copy: deletion is never allowed on uncertainty.
 */
function isExactDirectoryCopy(candidateDir: string, referenceDir: string): boolean {
  try {
    const candidateEntries = readdirSync(candidateDir, { withFileTypes: true })
    const referenceEntries = readdirSync(referenceDir, { withFileTypes: true })
    if (candidateEntries.length !== referenceEntries.length) return false

    const referenceEntriesByName = new Map(referenceEntries.map((entry) => [entry.name, entry]))
    for (const candidateEntry of candidateEntries) {
      const referenceEntry = referenceEntriesByName.get(candidateEntry.name)
      if (!referenceEntry) return false
      if (candidateEntry.isSymbolicLink() || referenceEntry.isSymbolicLink()) return false
      if (candidateEntry.isDirectory() !== referenceEntry.isDirectory()) return false

      const candidatePath = join(candidateDir, candidateEntry.name)
      const referencePath = join(referenceDir, referenceEntry.name)
      if (candidateEntry.isDirectory()) {
        if (!isExactDirectoryCopy(candidatePath, referencePath)) return false
        continue
      }
      if (!candidateEntry.isFile() || !referenceEntry.isFile()) return false
      if (!readFileSync(candidatePath).equals(readFileSync(referencePath))) return false
    }
    return true
  } catch {
    return false
  }
}

export function hasStaleCompiledExtensionSiblings(extensionsDir: string, sourceDir: string = bundledExtensionsDir): boolean {
  if (!existsSync(extensionsDir)) return false
  const sourceFiles = collectRelativeFiles(sourceDir)
  const installedFiles = collectRelativeFiles(extensionsDir)

  for (const relPath of installedFiles) {
    if (!relPath.endsWith('.ts') && !relPath.endsWith('.js')) continue
    if (sourceFiles.has(relPath)) continue

    const bundledSibling = relPath.endsWith('.ts')
      ? relPath.replace(/\.ts$/, '.js')
      : relPath.replace(/\.js$/, '.ts')

    if (sourceFiles.has(bundledSibling)) return true
  }

  return false
}

export function hasMissingBundledResourceFiles(destDir: string, sourceDir: string): boolean {
  const sourceFiles = collectRelativeFiles(sourceDir)
  if (sourceFiles.size === 0) return false

  const installedFiles = collectRelativeFiles(destDir)
  for (const relPath of sourceFiles) {
    if (!installedFiles.has(relPath)) return true
  }
  return false
}

function collectRelativeFiles(rootDir: string): Set<string> {
  const files = new Set<string>()
  if (!existsSync(rootDir)) return files

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
        continue
      }
      files.add(relative(rootDir, entryPath).replaceAll('\\', '/'))
    }
  }

  visit(rootDir)
  return files
}

/**
 * Constructs a DefaultResourceLoader that loads extensions from
 * ~/.gsd/agent/extensions/ (GSD's default) only.
 */
// Cache bundled extension keys at module load — avoids re-scanning the extensions
// directory in buildResourceLoader() (already scanned by loader.ts for env var).
let _bundledExtensionKeys: Set<string> | null = null
function getBundledExtensionKeys(): Set<string> {
  if (!_bundledExtensionKeys) {
    _bundledExtensionKeys = new Set(
      discoverExtensionEntryPaths(bundledExtensionsDir).map((entryPath) => getExtensionKey(entryPath, bundledExtensionsDir)),
    )
  }
  return _bundledExtensionKeys
}

/**
 * The suppression subset of the loader's constructor options that --bare sets.
 * Derived from the real option type so a key typo (or an upstream rename) fails
 * typecheck instead of silently degrading --bare to a no-op.
 */
type BareResourceLoaderOptions = Partial<
  Pick<
    ConstructorParameters<typeof DefaultResourceLoaderType>[0],
    'noSkills' | 'noPromptTemplates' | 'noThemes' | 'noContextFiles'
  >
>

/**
 * Resource-loader options for --bare mode: skip user skills, prompt templates,
 * themes, and the CLAUDE.md/AGENTS.md ancestor walk. Single source of truth so
 * the print-mode and interactive loader construction sites cannot drift.
 */
export function bareResourceLoaderOptions(bare: boolean | undefined): BareResourceLoaderOptions {
  return bare
    ? { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }
    : {}
}

interface BuildResourceLoaderOptions {
  additionalExtensionPaths?: string[]
  /** --bare: minimal context (see bareResourceLoaderOptions) */
  bare?: boolean
}

export async function buildResourceLoader(
  agentDir: string,
  options: BuildResourceLoaderOptions = {},
): Promise<DefaultResourceLoaderType> {
  const { DefaultResourceLoader } = await loadPiCodingAgentModule()
  const { sortExtensionPaths } = await import('./extension-sort.js')
  const registry = loadRegistry()
  const bundledKeys = getBundledExtensionKeys()
  const additionalExtensionPaths = [
    ...(options.additionalExtensionPaths ?? []),
  ]

  return new DefaultResourceLoader({
    agentDir,
    cwd: process.cwd(),
    additionalExtensionPaths,
    bundledExtensionKeys: bundledKeys,
    ...bareResourceLoaderOptions(options.bare),
    extensionPathsTransform: (paths: string[]) => {
      // 1. Add slash-command-installed extensions, with installed versions
      // taking precedence over bundled extensions that declare the same ID.
      const mergedPaths = mergeExtensionEntryPaths(paths, join(dirname(agentDir), 'extensions'))

      // 2. Filter community extensions through the GSD registry
      const filteredPaths = mergedPaths.filter((entryPath) => {
        const manifest = readManifestFromEntryPath(entryPath)
        if (!manifest) return true // no manifest = always load
        return isExtensionEnabled(registry, manifest.id)
      })

      // 3. Sort in topological dependency order
      const { sortedPaths, warnings } = sortExtensionPaths(filteredPaths)

      return {
        paths: sortedPaths,
        diagnostics: warnings.map((w: { message: string }) => w.message),
      }
    },
  } as ConstructorParameters<typeof DefaultResourceLoader>[0])
}
