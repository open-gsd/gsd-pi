import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@gsd/pi-coding-agent'
import {
  GSD_WORKFLOW_CONTEXT, GSD_DELEGATION_CONTEXT,
  readWorkflowContext, readDelegationContext,
  type GsdWorkflowContext, type GsdDelegationContext,
} from './resources/extensions/shared/gsd-session-metadata.js'

export const CMUX_VAULT_TIMEOUT_MS = 1000
export const CMUX_VAULT_MAX_PENDING_SESSIONS = 64
// cmux's Unix socket convention is independent of the client's temporary directory.
export const CMUX_VAULT_DEFAULT_SOCKET_PATH = '/tmp/cmux.sock'

export type CmuxVaultTransport = (args: string[]) => Promise<unknown>

/** The public CLI quotes trailing argv itself; never pass a shell command. */
export const runCmuxVaultCommand: CmuxVaultTransport = (args) => new Promise((resolve, reject) => {
  execFile('cmux', ['--json', '--id-format', 'both', ...args], {
    timeout: CMUX_VAULT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    windowsHide: true,
  }, (error, stdout) => {
    if (error) return reject(error)
    try {
      resolve(JSON.parse(stdout))
    } catch (error) {
      reject(error)
    }
  })
})

export interface CmuxVaultClearRequest {
  workspace_id: string
  surface_id: string
  checkpoint_id: string
  source: 'agent-hook'
  expected_updated_at: number
}

/** The CLI lacks a timestamp-guarded clear; use the documented socket RPC. */
export function clearCmuxVaultBinding(socketPath: string, params: CmuxVaultClearRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(socketPath)
    let output = ''
    let settled = false
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(new Error('cmux clear timeout')), CMUX_VAULT_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('error', error => finish(error))
    socket.on('close', () => finish(new Error('cmux closed without a response')))
    socket.on('connect', () => socket.write(JSON.stringify({
      id, method: 'surface.resume.clear', params,
    }) + '\n'))
    socket.on('data', chunk => {
      output += chunk
      if (Buffer.byteLength(output) > 64 * 1024) return finish(new Error('cmux response too large'))
      const newline = output.indexOf('\n')
      if (newline < 0) return
      try {
        const response = JSON.parse(output.slice(0, newline))
        if (response?.id !== id || response?.ok !== true || !response.result) {
          return finish(new Error('invalid cmux clear response'))
        }
        finish(undefined, response.result)
      } catch {
        finish(new Error('invalid cmux clear JSON'))
      }
    })
  })
}

interface VaultModeEntry {
  type: string
  id?: string
  parentId?: string | null
  customType?: string
  data?: unknown
  message?: { role: string; customType?: string }
}

export interface CmuxVaultSession {
  getSessionId(): string
  getSessionFile(): string | undefined
  getCwd(): string
  getBranch?(): readonly VaultModeEntry[]
  getLeafEntry?(): VaultModeEntry | undefined
  getEntry?(id: string): VaultModeEntry | undefined
  getHeader?(): { parentSession?: string } | null
}

export type CmuxVaultMode = 'chat' | 'auto' | 'quick' | 'debug'

function* modeEntries(manager: CmuxVaultSession): Iterable<VaultModeEntry> {
  if (!manager.getLeafEntry || !manager.getEntry) {
    yield* Array.from(manager.getBranch?.() ?? []).reverse()
    return
  }
  // Walk tags directly instead of constructing getBranch()'s full transcript
  // array with repeated unshift operations on long conversations.
  const seen = new Set<string>()
  let entry = manager.getLeafEntry()
  while (entry) {
    if (entry.id) {
      if (seen.has(entry.id)) break
      seen.add(entry.id)
    }
    yield entry
    entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
  }
}

/** Classify runtime message tags only, never prompts, titles, tool data or artifacts. */
export function cmuxVaultModes(manager: CmuxVaultSession): CmuxVaultMode[] {
  return sessionContext(manager).modes
}

interface VaultSessionContext {
  modes: CmuxVaultMode[]
  workflow?: GsdWorkflowContext
  delegations: GsdDelegationContext[]
  parentPath?: string
}

function sessionContext(manager: CmuxVaultSession): VaultSessionContext {
  const modes = new Set<CmuxVaultMode>()
  const delegations = new Map<string, GsdDelegationContext>()
  const sessionId = manager.getSessionId()
  let workflow: GsdWorkflowContext | undefined
  for (const entry of modeEntries(manager)) {
    const tag = entry.type === 'custom_message' ? entry.customType
      : entry.type === 'message' && entry.message?.role === 'custom' ? entry.message.customType : undefined
    const mode = tag === 'gsd-auto' ? 'auto'
      : tag === 'gsd-quick-task' ? 'quick'
      : tag === 'gsd-debug-start' || tag === 'gsd-debug-continue' || tag === 'gsd-debug-diagnose' ? 'debug'
      : entry.type === 'message' && entry.message?.role === 'user' ? 'chat' : undefined
    if (mode) modes.add(mode)
    if (entry.type === 'custom' && entry.customType === GSD_WORKFLOW_CONTEXT && !workflow) {
      const context = readWorkflowContext(entry.data)
      if (context?.originSessionId === sessionId) workflow = context
    }
    if (entry.type === 'custom' && entry.customType === GSD_DELEGATION_CONTEXT && delegations.size < 64) {
      const context = readDelegationContext(entry.data)
      if (context?.originSessionId === sessionId && !delegations.has(context.id)) delegations.set(context.id, context)
    }
  }
  const parent = manager.getHeader?.()?.parentSession
  return {
    modes: (['chat', 'auto', 'quick', 'debug'] as const).filter(mode => modes.has(mode)),
    workflow, delegations: [...delegations.values()],
    parentPath: typeof parent === 'string' && isAbsolute(parent) ? parent : undefined,
  }
}

function vaultTitle(context: VaultSessionContext): string {
  const labels = { chat: 'Chat', auto: 'Auto', quick: 'Quick', debug: 'Debug' }
  let title = context.modes.length ? `GSD — ${context.modes.map(mode => labels[mode]).join(' / ')}` : 'GSD'
  if (context.workflow) {
    const { milestoneId, sliceId, taskId } = context.workflow
    title += ` · ${[milestoneId, sliceId, taskId].filter(Boolean).join('/')}`
  }
  if (context.delegations.length) {
    const kinds = [...new Set(context.delegations.map(item => item.mode))].sort().join('/')
    title += ` · Subagents ×${context.delegations.reduce((sum, item) => sum + item.count, 0)} (${kinds})`
  }
  return title
}

interface VaultIdentity extends VaultSessionContext {
  id: string
  path: string
  cwd: string
}

export interface CmuxVaultOptions {
  home: string
  launcher: string[]
  env?: NodeJS.ProcessEnv
  pid?: number
  transport?: CmuxVaultTransport
  clearBinding?: (params: CmuxVaultClearRequest) => Promise<unknown>
  extensionPaths?: () => string[]
  getPreferences?: (cwd: string) => Promise<{ enabled?: boolean; vault?: boolean } | undefined>
}

interface VaultBinding {
  path: string
  cwd: string
  updatedAt: number
  workspace: string
  surface: string
}

function resumeResult(value: unknown): { result: Record<string, unknown>, binding: Record<string, unknown> | null } {
  if (!value || typeof value !== 'object') throw new Error('invalid cmux result')
  const result = value as Record<string, unknown>
  const binding = result.resume_binding
  if (binding !== null && (!binding || typeof binding !== 'object' || Array.isArray(binding))) {
    throw new Error('invalid cmux binding')
  }
  if (typeof result.workspace_id !== 'string' || typeof result.surface_id !== 'string') {
    throw new Error('missing cmux target identity')
  }
  return { result, binding: binding as Record<string, unknown> | null }
}

export function cmuxVaultEnabled(env: NodeJS.ProcessEnv, pid: number): boolean {
  return env.GSD_CMUX_VAULT_OWNER_PID === String(pid)
    && Boolean(env.CMUX_WORKSPACE_ID?.trim() && env.CMUX_SURFACE_ID?.trim())
    && env.GSD_CMUX_VAULT_EXTERNAL_BRIDGE !== '1'
}

export function cmuxVaultConfigured(
  env: NodeJS.ProcessEnv,
  preferences: { enabled?: boolean; vault?: boolean } | undefined,
): boolean {
  return preferences?.enabled === true && env.GSD_CMUX_VAULT !== '0'
    && (env.GSD_CMUX_VAULT === '1' || preferences.vault === true)
}

/** Recognize only the upstream managed Pi bridge, not arbitrary "cmux" filenames. */
export async function hasManagedCmuxBridge(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 256 * 1024) continue
      if ((await readFile(path, 'utf8')).includes('cmux-pi-session-extension-marker')) return true
    } catch { /* Inline factories and removed extensions are not managed files. */ }
  }
  return false
}

/**
 * One serial writer and one replaceable pending identity: slow cmux cannot
 * accumulate work or let an old session update overtake a session switch.
 */
export class CmuxVaultBridge {
  private readonly options: CmuxVaultOptions
  private readonly env: NodeJS.ProcessEnv
  private readonly transport: CmuxVaultTransport
  private readonly target: string[]
  private pending: VaultIdentity | null | undefined
  private running: Promise<void> | undefined
  private binding: VaultBinding | undefined
  private stopped = false
  private injected: Promise<boolean> | undefined
  private lastIdentity: string | undefined
  private readonly snapshots = new Map<string, VaultIdentity>()

  constructor(options: CmuxVaultOptions) {
    this.options = options
    this.env = options.env ?? process.env
    this.transport = options.transport ?? runCmuxVaultCommand
    this.target = ['--workspace', this.env.CMUX_WORKSPACE_ID ?? '', '--surface', this.env.CMUX_SURFACE_ID ?? '']
  }

  update(manager: CmuxVaultSession, hasUI: boolean, refresh = false): void {
    if (this.stopped || !hasUI || !cmuxVaultEnabled(this.env, this.options.pid ?? process.pid)) return
    try {
      const path = manager.getSessionFile()
      const cwd = manager.getCwd()
      const id = manager.getSessionId()
      const context = sessionContext(manager)
      const key = JSON.stringify([id, path, cwd, context])
      if (!refresh && this.lastIdentity === key) return
      this.lastIdentity = key
      this.pending = path && isAbsolute(path) && isAbsolute(cwd) && id ? { id, path, cwd, ...context } : null
      if (this.pending) {
        this.snapshots.set(this.pending.path, this.pending)
        if (this.snapshots.size > CMUX_VAULT_MAX_PENDING_SESSIONS) {
          this.snapshots.delete(this.snapshots.keys().next().value!)
        }
      }
      this.start()
    } catch { /* Observability must never reject a core lifecycle event. */ }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (!cmuxVaultEnabled(this.env, this.options.pid ?? process.pid)) return
    this.pending = null
    this.start()
  }

  /** Test seam; lifecycle handlers deliberately do not await transport work. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  private start(): void {
    if (this.running) return
    this.running = this.drain().catch(() => {}).finally(() => {
      this.running = undefined
      if (this.pending !== undefined) this.start()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const identity = this.pending
      this.pending = undefined
      try {
        if (!identity) {
          await this.clear()
          continue
        }
        if (!cmuxVaultConfigured(this.env, await this.options.getPreferences?.(identity.cwd))) {
          this.snapshots.clear()
          await this.clear()
          continue
        }
        this.injected ??= hasManagedCmuxBridge(this.options.extensionPaths?.() ?? [])
        if (await this.injected) continue
        // A fresh session may have a path before its first assistant is persisted.
        // Do not advertise a file that cannot yet be opened.
        const persisted = await stat(identity.path).then(info => info.isFile(), () => false)
        if (!persisted) {
          await this.clear()
          continue
        }
        await this.publish(identity)
      } catch { /* Missing CLI, old protocol, stale socket and I/O failures are optional. */ }
    }
  }

  private async clear(): Promise<void> {
    if (!this.binding) return
    const params: CmuxVaultClearRequest = {
      workspace_id: this.binding.workspace,
      surface_id: this.binding.surface,
      checkpoint_id: this.binding.path,
      source: 'agent-hook',
      expected_updated_at: this.binding.updatedAt,
    }
    const result = await (this.options.clearBinding
      ? this.options.clearBinding(params)
      : clearCmuxVaultBinding(this.env.CMUX_SOCKET_PATH ?? CMUX_VAULT_DEFAULT_SOCKET_PATH, params))
    if (!result || typeof result !== 'object' || typeof (result as { cleared?: unknown }).cleared !== 'boolean') {
      throw new Error('invalid cmux clear result')
    }
    if ((result as { cleared: boolean }).cleared) await this.feed('SessionEnd', this.binding)
    this.binding = undefined
  }

  private async publish(identity: VaultIdentity): Promise<void> {
    const argv = ['env', `GSD_HOME=${this.options.home}`, ...this.options.launcher, '--session', identity.path]
    const observed = resumeResult(await this.transport(['surface', 'resume', 'show', ...this.target]))
    if (observed.binding) {
      const previous = observed.binding
      if (previous.kind !== 'gsd' || previous.source !== 'agent-hook') return
      if (this.binding) {
        if (previous.checkpoint_id !== this.binding.path || previous.updated_at !== this.binding.updatedAt) return
      } else {
        // A relaunch may adopt its own exact binding, never another agent/session.
        const launch = previous.launch_command as { arguments?: unknown } | null
        if (previous.checkpoint_id !== identity.path || JSON.stringify(launch?.arguments) !== JSON.stringify(argv)) return
      }
    }
    const { result, binding } = resumeResult(await this.transport([
      'surface', 'resume', 'set', ...this.target,
      '--name', vaultTitle(identity), '--kind', 'gsd', '--checkpoint-id', identity.path,
      '--source', 'agent-hook', '--cwd', identity.cwd, '--',
      ...argv,
    ]))
    const launch = binding?.launch_command as { arguments?: unknown } | null
    if (binding?.kind !== 'gsd' || binding.source !== 'agent-hook'
      || binding.checkpoint_id !== identity.path || binding.cwd !== identity.cwd
      || binding.auto_resume !== false || typeof binding.updated_at !== 'number'
      || !Number.isFinite(binding.updated_at)
      || JSON.stringify(launch?.arguments) !== JSON.stringify(argv)) {
      throw new Error('cmux did not accept the requested manual GSD binding')
    }
    const previousBinding = this.binding
    this.binding = {
      path: identity.path, updatedAt: binding.updated_at,
      cwd: identity.cwd,
      workspace: result.workspace_id as string, surface: result.surface_id as string,
    }
    // Surface updates may coalesce across auto's rapid session handoffs. Keep
    // the latest metadata per native file, not just the latest surface target.
    const snapshots = new Map(this.snapshots)
    if (!snapshots.has(identity.path)) snapshots.set(identity.path, identity)
    this.snapshots.clear()
    for (const snapshot of snapshots.values()) {
      try {
        if (!cmuxVaultConfigured(this.env, await this.options.getPreferences?.(snapshot.cwd))) continue
        if (!await stat(snapshot.path).then(info => info.isFile(), () => false)) continue
        await this.writeMetadata(snapshot)
      } catch { /* One failed metadata write must not discard other observed sessions. */ }
    }
    if (previousBinding && previousBinding.path !== identity.path) await this.feed('SessionEnd', previousBinding)
    await this.feed('SessionStart', this.binding)
  }

  private async writeMetadata(identity: VaultIdentity): Promise<void> {
    const directory = join(this.options.home, 'cmux', 'vault')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(identity.path).digest('hex')
    const destination = join(directory, `${key}.jsonl`)
    const temporary = join(directory, `.${key}.${randomUUID()}.tmp`)
    try {
      // Vault's generic JSONL index uses sessionId as the native identity. For
      // custom agents it does not canonicalize a UUID to a session-file path.
      await writeFile(temporary, JSON.stringify({
        sessionId: identity.path,
        gsdSessionId: identity.id,
        cwd: identity.cwd,
        title: vaultTitle(identity),
        gsdModes: identity.modes,
        ...(identity.workflow ? { gsdWorkflow: identity.workflow } : {}),
        ...(identity.delegations.length ? { gsdDelegations: identity.delegations } : {}),
        ...(identity.parentPath ? { gsdParentSessionId: identity.parentPath } : {}),
      }) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  private async feed(event: 'SessionStart' | 'SessionEnd', binding: VaultBinding): Promise<void> {
    // Generic Feed ingress accepts custom sources. Omitting transcript_path
    // prevents its transcript resolver from reading the native GSD session.
    try {
      await this.transport(['rpc', 'feed.push', JSON.stringify({
        event: {
          session_id: binding.path, hook_event_name: event, _source: 'gsd',
          workspace_id: binding.workspace, surface_id: binding.surface,
          cwd: binding.cwd, _ppid: this.options.pid ?? process.pid,
        },
        wait_timeout_seconds: 0,
      })])
    } catch { /* Older cmux may index metadata without supporting active presence. */ }
  }
}

export function createCmuxVaultExtension(options: CmuxVaultOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const bridge = new CmuxVaultBridge(options)
    // session_start also follows new/switch/resume/fork. Listening to the legacy
    // session_switch as well would notify twice for the same transition.
    pi.on('session_start', (_event, ctx: ExtensionContext) => bridge.update(ctx.sessionManager, ctx.hasUI))
    pi.on('session_tree', (_event, ctx: ExtensionContext) => bridge.update(ctx.sessionManager, ctx.hasUI, true))
    // Auto may create the next unit's session inside agent_end. Capture the
    // persisted branch before that handoff, without inspecting event content.
    pi.on('turn_end', (_event, ctx: ExtensionContext) => bridge.update(ctx.sessionManager, ctx.hasUI, true))
    pi.on('agent_end', (_event, ctx: ExtensionContext) => bridge.update(ctx.sessionManager, ctx.hasUI, true))
    pi.on('session_shutdown', async () => {
      bridge.stop()
      await bridge.idle()
    })
  }
}
