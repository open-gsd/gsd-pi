// gsd-pi — Headless Migrate entrypoint
/**
 * Headless Migrate — `gsd headless migrate`
 *
 * Non-interactive form of the `/gsd migrate` slash command, with no RPC child.
 * A v1 project has no .gsd/ yet, so the headless dispatcher runs this before
 * its .gsd/ check. The first run prints the Import Preview and its hash; a run
 * with `--preview=<hash>` applies that Preview. Output goes to stderr, as for
 * `gsd headless recover`.
 *
 * Exit codes:
 *   0 — the Preview was printed, or the approved migration was applied
 *   1 — the command reported an error; nothing more was applied
 */

import { createJiti } from '@mariozechner/jiti'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })
const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })

function extensionModule(...segments: string[]): string {
  if (!useAgentDir) return resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))
  const requested = join(agentExtensionsDir, ...segments)
  if (existsSync(requested)) return requested
  const jsPath = requested.replace(/\.ts$/, '.js')
  return existsSync(jsPath) ? jsPath : requested
}

export interface MigrateResult {
  exitCode: number
}

/**
 * Run `/gsd migrate` with the given arguments: `--preview=<hash>` and
 * `--forward-choice=<token>` flags, and an optional source path (default: the
 * current directory).
 */
export async function handleMigrate(args: readonly string[] = []): Promise<MigrateResult> {
  let command: { handleMigrate(args: string, ctx: unknown, pi: unknown): Promise<void> }
  let workspace: { closeWorkflowDatabase(): void }
  try {
    command = await jiti.import(extensionModule('migrate', 'command.ts'), {}) as typeof command
    workspace = await jiti.import(extensionModule('db-workspace.ts'), {}) as typeof workspace
  } catch (err) {
    process.stderr.write(`[headless] migrate: failed to load extension modules: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 1 }
  }

  const source = args.filter((arg) => !arg.startsWith('--')).join(' ')
  const commandArgs = [...args.filter((arg) => arg.startsWith('--')), ...(source ? [`"${source}"`] : [])].join(' ')
  let failed = false
  // No interactive menu: the command prints the Preview or applies the approved one.
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, kind: string): void {
        if (kind === 'error') failed = true
        process.stderr.write(`${message.replaceAll('/gsd migrate', 'gsd headless migrate')}\n`)
      },
    },
  }
  try {
    await command.handleMigrate(commandArgs, ctx, {})
  } finally {
    workspace.closeWorkflowDatabase()
  }
  return { exitCode: failed ? 1 : 0 }
}
