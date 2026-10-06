// Project/App: gsd-pi
// File Purpose: Startup welcome screen rendering for the GSD terminal experience.

/**
 * GSD Welcome Screen
 *
 * Command-center layout: compact block logo, project
 * state, primary action, branch/workspace, and secondary hints.
 * Falls back to simple text on narrow terminals (<70 cols) or non-TTY.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { GSD_PI_BRAND, GSD_PI_LOGO } from './logo.js'
import { stripIdPrefix } from './resources/extensions/gsd/strip-id-prefix.js'

/** Project status shown in the header. */
export interface WelcomeProjectState {
  milestone?: string
  phase?: string
  slice?: string
  nextAction?: string
}

/**
 * The milestone row named by GSD_MILESTONE_LOCK, resolved once per process by
 * primeMilestoneLock(). Null means the lock is unset or could not be resolved
 * (no DB, unexpected schema, unknown id) — the STATE.md projection renders.
 * Undefined means not yet primed; the projection renders.
 */
let lockedMilestone: string | null | undefined

/**
 * Resolve GSD_MILESTONE_LOCK against .gsd/gsd.db so the header can announce
 * the milestone this process is actually bound to — the STATE.md projection
 * carries no writer identity, so it can lag the lock. When the lock resolves
 * it wins outright and the projection's slice/phase/next-action (which belong
 * to a different milestone) are suppressed. Fail-open by design: any error
 * leaves the projection-based rendering untouched. Never throws. The DB
 * engine is dynamic-imported so the welcome screen stays light when no lock
 * needs resolving (same pattern as register-shortcuts).
 */
export async function primeMilestoneLock(): Promise<void> {
  if (lockedMilestone !== undefined) return
  const lock = process.env.GSD_MILESTONE_LOCK?.trim()
  if (!lock) {
    lockedMilestone = null
    return
  }
  try {
    const { openIsolatedDatabase } = await import('./resources/extensions/gsd/db/engine.js')
    // Isolated read-only connection: never displaces the session's own DB handle,
    // and a missing file fails the open instead of creating one.
    const db = openIsolatedDatabase(join(process.cwd(), '.gsd', 'gsd.db'))
    if (!db) {
      lockedMilestone = null
      return
    }
    let resolved: string | null
    try {
      const row = db.prepare('SELECT id, title FROM milestones WHERE id = ?').get(lock)
      const id = typeof row?.id === 'string' ? row.id : undefined
      if (!id) {
        resolved = null
      } else {
        const title = typeof row?.title === 'string' ? stripIdPrefix(row.title, id) : ''
        resolved = title ? `${id}: ${title}` : id
      }
    } finally {
      // A throwing close propagates to the catch below, so the override is
      // only published after the connection was released cleanly.
      db.close()
    }
    lockedMilestone = resolved
  } catch {
    // Fail-open: a missing/corrupt DB, unexpected schema, unknown id, or any
    // other error renders the projection as before.
    lockedMilestone = null
  }
}

/** Test hook: forget a resolved lock so a later prime re-reads it. */
export function _resetMilestoneLockForTest(): void {
  lockedMilestone = undefined
}

function readGsdState(dbState: WelcomeProjectState | undefined): WelcomeProjectState | undefined {
  // A resolved lock is the authority for what this session is bound to.
  if (lockedMilestone) return { milestone: lockedMilestone }
  // The caller read the database: STATE.md is not consulted.
  if (dbState) return dbState
  try {
    const raw = readFileSync(join(process.cwd(), '.gsd', 'STATE.md'), 'utf-8')
    const state: WelcomeProjectState = {}
    const milestone = raw.match(/^\*\*Active Milestone:\*\*\s*(.+)$/m)
    const activeMilestone = milestone?.[1].trim()
    if (activeMilestone && activeMilestone !== 'None') state.milestone = activeMilestone
    const slice = raw.match(/^\*\*Active Slice:\*\*\s*(.+)$/m)
    const activeSlice = slice?.[1].trim()
    if (activeSlice && activeSlice !== 'None') state.slice = activeSlice
    const phase = raw.match(/^\*\*Phase:\*\*\s*(.+)$/m)
    if (phase) state.phase = phase[1].trim()
    // Accept both template shapes: inline "**Next Action:** ..." and the
    // "## Next Action\n<line>" heading format. Prefer the inline match.
    const nextInline = raw.match(/^\*\*Next Action:\*\*\s*(.+)$/m)
    const nextHeading = raw.match(/^##\s*Next Action\s*\n+([^\n]+)/m)
    const nextMatch = nextInline ?? nextHeading
    if (nextMatch) state.nextAction = nextMatch[1].trim()
    return state
  } catch {
    return undefined
  }
}

function countMcpServers(): number {
  const configPaths = [
    join(process.cwd(), '.mcp.json'),
    join(process.cwd(), '.gsd', 'mcp.json'),
  ]
  const seen = new Set<string>()
  for (const p of configPaths) {
    try {
      const raw = readFileSync(p, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const servers = (data.mcpServers ?? data.servers) as
        | Record<string, unknown>
        | undefined
      if (!servers || typeof servers !== 'object') continue
      for (const name of Object.keys(servers)) seen.add(name)
    } catch {
      // missing or malformed config — ignore
    }
  }
  return seen.size
}

export interface WelcomeScreenOptions {
  version: string
  modelName?: string
  provider?: string
  remoteChannel?: string
  width?: number
  /**
   * Project status the caller read from the database. When set, the header
   * shows it and does not read STATE.md. Leave unset only when the database
   * is missing or cannot be opened.
   */
  state?: WelcomeProjectState
}

function getShortCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
}

/** Visible length — strips ANSI escape codes before measuring. */
function visLen(s: string): number {
  return stripAnsi(s).length
}

/** Right-pad a string to the given visible width. */
function rpad(s: string, w: number): string {
  const clamped = clampVisible(s, w)
  return clamped + ' '.repeat(Math.max(0, w - visLen(clamped)))
}

function rightAlign(left: string, right: string, width: number): string {
  if (!right) return clampVisible(left, width)
  const gap = Math.max(1, width - visLen(left) - visLen(right))
  return clampVisible(left + ' '.repeat(gap) + right, width)
}

/** Clamp rendered terminal output by visible columns. Falls back to plain text only when truncating. */
function clampVisible(s: string, w: number): string {
  if (w <= 0) return ''
  if (visLen(s) <= w) return s
  const plain = stripAnsi(s)
  return plain.slice(0, Math.max(0, w - 1)) + '…'
}

export function buildWelcomeScreenLines(opts: WelcomeScreenOptions): string[] {
  const { version, remoteChannel } = opts
  const shortCwd = getShortCwd()
  const termWidth = Math.max(1, (opts.width ?? process.stderr.columns ?? 80) - 1)

  // Narrow terminal fallback
  if (termWidth < 70) {
    return ['', `  Git Ship Done v${version}`, `  ${shortCwd}`, '']
  }

  const toolParts: string[] = []
  if (process.env.BRAVE_API_KEY)      toolParts.push('Brave ✓')
  if (process.env.BRAVE_ANSWERS_KEY)  toolParts.push('Answers ✓')
  if (process.env.JINA_API_KEY)       toolParts.push('Jina ✓')
  if (process.env.TAVILY_API_KEY)     toolParts.push('Tavily ✓')
  if (process.env.CONTEXT7_API_KEY)   toolParts.push('Context7 ✓')
  if (remoteChannel)                  toolParts.push(`${remoteChannel.charAt(0).toUpperCase() + remoteChannel.slice(1)} ✓`)

  const innerWidth = Math.max(1, termWidth - 2)
  const logoWidth = Math.max(...GSD_PI_LOGO.map((line) => visLen(line)))
  // Plain spaces, not a `│` divider — a vertical bar would be dragged into
  // every copied logo row.
  const divider = '   '
  const panelWidth = innerWidth - logoWidth - visLen(divider)
  if (panelWidth < 34) {
    return ['', `  Git Ship Done v${version}`, `  ${shortCwd}`, '']
  }

  // "Welcome back" context lines — GSD state if available, else hint.
  // Intentionally avoids data already shown in the footer (model, provider,
  // pwd, branch).
  const state = readGsdState(opts.state)
  let projectText = 'No active GSD project'
  let commandText = '/gsd start'
  let modeText = 'manual'
  if (state?.milestone) {
    const statusParts = [state.milestone, state.phase, state.slice].filter(Boolean)
    projectText = statusParts.join(' · ')
    const maxActionWidth = Math.max(10, panelWidth - 30)
    commandText = state.nextAction ? clampVisible(state.nextAction, maxActionWidth) : '/gsd next'
    modeText = state.phase ?? 'active'
  }

  const mcpCount = countMcpServers()
  const mcpText = toolParts.length > 0
    ? toolParts.join('  ·  ')
    : mcpCount > 0
      ? `${mcpCount} server${mcpCount === 1 ? '' : 's'} configured`
      : 'none configured'

  const label = (s: string) => chalk.dim(s)
  const value = (s: string) => chalk.hex('#dce4f2')(s)
  const accent = (s: string) => chalk.hex('#8db7ff')(s)
  const panelRows = [
    rightAlign(`${accent(GSD_PI_BRAND)} ${chalk.bold(value('Project Console'))}`, chalk.dim(`v${version}`), panelWidth),
    rightAlign(`${label('Project')} ${value(projectText)}`, `${label('Command')} ${accent(commandText)}`, panelWidth),
    rightAlign(`${label('Workspace')} ${value(shortCwd)}`, `${label('Mode')} ${value(modeText)}`, panelWidth),
    rightAlign(`${label('MCP')} ${chalk.dim(mcpText)}`, `${label('Status')} ${value(state?.milestone ? 'active' : 'idle')}`, panelWidth),
    rightAlign(`${label('Next')} ${accent('/gsd to begin')}`, `${label('Setup')} ${accent('/gsd start')}`, panelWidth),
    rightAlign(chalk.dim('/gsd templates'), chalk.dim('/gsd help'), panelWidth),
  ]

  // ── Render ──────────────────────────────────────────────────────────────────
  // No outer box: logo + panel are indented, with a single closing rule. Every
  // content line is plain text, so terminal selection copies cleanly.
  const out: string[] = ['']
  for (let i = 0; i < GSD_PI_LOGO.length; i++) {
    const logo = rpad(chalk.hex('#a7ba78')(GSD_PI_LOGO[i]), logoWidth)
    out.push('  ' + clampVisible(`${logo}${divider}${panelRows[i] ?? ''}`, termWidth - 2))
  }
  out.push(chalk.hex('#a7ba78')('─'.repeat(Math.max(0, termWidth))))
  out.push('')

  return out.map((line) => clampVisible(line, termWidth))
}

export function printWelcomeScreen(opts: WelcomeScreenOptions): void {
  if (!process.stderr.isTTY) return
  process.stderr.write(buildWelcomeScreenLines(opts).join('\n') + '\n')
}
