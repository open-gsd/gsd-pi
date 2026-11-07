import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@gsd/pi-coding-agent'
import {
  GSD_AUTO_MODE, GSD_WORKFLOW_CONTEXT, GSD_DELEGATION_CONTEXT,
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
  provider?: string
  modelId?: string
  message?: { role: string; customType?: string; provider?: string; model?: string; modelId?: string }
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

interface VaultModel {
  provider: string
  modelId: string
}

interface VaultSessionContext {
  modes: CmuxVaultMode[]
  models: VaultModel[]
  workflow?: GsdWorkflowContext
  delegations: GsdDelegationContext[]
  parentPath?: string
}

function vaultModelPart(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= 128 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined
}

function sessionContext(manager: CmuxVaultSession): VaultSessionContext {
  const modes = new Set<CmuxVaultMode>()
  const models = new Map<string, VaultModel>()
  const delegations = new Map<string, GsdDelegationContext>()
  const sessionId = manager.getSessionId()
  let workflow: GsdWorkflowContext | undefined
  for (const entry of modeEntries(manager)) {
    const tag = entry.type === 'custom_message' ? entry.customType
      : entry.type === 'message' && entry.message?.role === 'custom' ? entry.message.customType
      : entry.type === 'custom' ? entry.customType : undefined
    const modelProvider = entry.type === 'model_change' ? entry.provider
      : entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message.provider : undefined
    const modelId = entry.type === 'model_change' ? entry.modelId
      : entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message.model ?? entry.message.modelId : undefined
    const provider = vaultModelPart(modelProvider)
    const model = vaultModelPart(modelId)
    if (provider && model) models.set(`${provider}\0${model}`, { provider, modelId: model })
    const mode = tag === GSD_AUTO_MODE ? 'auto'
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
    models: [...models.values()],
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
  if (context.models.length) {
    const labels = context.models.slice(0, 2).map(model => `${model.provider}:${model.modelId}`)
    if (context.models.length > labels.length) labels.push(`+${context.models.length - labels.length} more`)
    title += ` · ${labels.join(' + ')}`
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
  getPreferences?: (cwd: string) => Promise<{ enabled?: boolean; vault?: boolean; resume?: boolean } | undefined>
}

interface VaultBinding {
  path: string
  cwd: string
  updatedAt: number
  workspace: string
  surface: string
  vaultEnabled: boolean
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

export function cmuxSurfaceOwnerEnabled(env: NodeJS.ProcessEnv, pid: number): boolean {
  return env.GSD_CMUX_VAULT_OWNER_PID === String(pid)
    && Boolean(env.CMUX_WORKSPACE_ID?.trim() && env.CMUX_SURFACE_ID?.trim())
}

export function cmuxVaultEnabled(env: NodeJS.ProcessEnv, pid: number): boolean {
  return cmuxSurfaceOwnerEnabled(env, pid) && env.GSD_CMUX_VAULT_EXTERNAL_BRIDGE !== '1'
}

export function cmuxVaultConfigured(
  env: NodeJS.ProcessEnv,
  preferences: { enabled?: boolean; vault?: boolean } | undefined,
): boolean {
  return preferences?.enabled === true && env.GSD_CMUX_VAULT !== '0'
    && (env.GSD_CMUX_VAULT === '1' || preferences.vault === true)
}

export function cmuxResumeConfigured(
  env: NodeJS.ProcessEnv,
  preferences: { enabled?: boolean; resume?: boolean } | undefined,
): boolean {
  return preferences?.enabled === true && env.GSD_CMUX_RESUME !== '0'
    && (env.GSD_CMUX_RESUME === '1' || preferences.resume === true)
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
  private shutdownRequested = false
  private running: Promise<void> | undefined
  private binding: VaultBinding | undefined
  private stopped = false
  // Set only by stop() (shutdown). A null identity from update() means an unsaved
  // session and must still clear its binding; shutdown must keep the durable one.
  private injected: Promise<boolean> | undefined
  private lastIdentity: string | undefined
  private blockedAutoResumeIdentity: string | undefined
  private unsafeAutoResumeIdentity: string | undefined
  private readonly snapshots = new Map<string, VaultIdentity>()

  constructor(options: CmuxVaultOptions) {
    this.options = options
    this.env = options.env ?? process.env
    this.transport = options.transport ?? runCmuxVaultCommand
    this.target = ['--workspace', this.env.CMUX_WORKSPACE_ID ?? '', '--surface', this.env.CMUX_SURFACE_ID ?? '']
  }

  update(manager: CmuxVaultSession, hasUI: boolean, refresh = false): void {
    if (this.stopped || !hasUI || !cmuxSurfaceOwnerEnabled(this.env, this.options.pid ?? process.pid)) return
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
    if (!cmuxSurfaceOwnerEnabled(this.env, this.options.pid ?? process.pid)) return
    // Shutdown is recorded separately so it never overwrites an invalidation that
    // is already queued in `pending`. drain() handles that invalidation first, then
    // ends presence once.
    this.shutdownRequested = true
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
      // Restart for shutdown too: stop() can land after drain() exits but before this
      // callback runs, and that shutdown must still be drained (it sends SessionEnd).
      if (this.pending !== undefined || this.shutdownRequested) this.start()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined || this.shutdownRequested) {
      if (this.pending === undefined) {
        // No queued invalidation left: finish shutdown once. It ends live presence
        // and keeps the durable exact-resume binding for cmux restore / Reopen Closed.
        this.shutdownRequested = false
        await this.endPresence()
        continue
      }
      const identity = this.pending
      this.pending = undefined
      try {
        if (!identity) {
          // Unsaved session: end presence and clear, since there is no file to resume.
          await this.endPresence()
          await this.clear()
          continue
        }
        const preferences = await this.options.getPreferences?.(identity.cwd)
        this.injected ??= hasManagedCmuxBridge(this.options.extensionPaths?.() ?? [])
        const vaultEnabled = cmuxVaultEnabled(this.env, this.options.pid ?? process.pid)
          && cmuxVaultConfigured(this.env, preferences) && !await this.injected
        const resumeEnabled = cmuxResumeConfigured(this.env, preferences)
        const identityKey = JSON.stringify([identity.id, identity.path, identity.cwd])
        if (resumeEnabled) {
          this.blockedAutoResumeIdentity = undefined
          this.unsafeAutoResumeIdentity = undefined
        }
        if (!vaultEnabled) await this.endPresence()
        // Retry only on a later lifecycle update, not by re-registering an unsafe
        // automatic binding or spinning until a guarded clear succeeds.
        if (!resumeEnabled && this.unsafeAutoResumeIdentity && !await this.clearAutomaticBinding()) continue
        if (!vaultEnabled && !resumeEnabled) {
          this.snapshots.clear()
          if (this.binding) await this.clear()
          else if (this.blockedAutoResumeIdentity !== identityKey) await this.clearPersistedAutomaticBinding(identity)
          continue
        }
        if (!resumeEnabled && this.blockedAutoResumeIdentity === identityKey) continue
        // A fresh session may have a path before its first assistant is persisted.
        // Do not advertise a file that cannot yet be opened.
        const persisted = await stat(identity.path).then(info => info.isFile(), () => false)
        if (!persisted) {
          await this.clear()
          continue
        }
        await this.publish(identity, vaultEnabled, resumeEnabled)
      } catch { /* Missing CLI, old protocol, stale socket and I/O failures are optional. */ }
    }
  }

  private async clear(): Promise<boolean> {
    if (!this.binding) return true
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
    const cleared = (result as { cleared: boolean }).cleared
    if (cleared) {
      await this.endPresence()
      this.binding = undefined
    } else {
      this.lastIdentity = undefined
    }
    return cleared
  }

  private async endPresence(binding = this.binding): Promise<void> {
    if (!binding?.vaultEnabled) return
    binding.vaultEnabled = false
    await this.feed('SessionEnd', binding)
  }

  private launchArguments(identity: VaultIdentity): string[] {
    return [
      'env', `GSD_HOME=${this.options.home}`, ...this.options.launcher,
      '--resume-exact', identity.path, identity.id,
    ]
  }

  private matchesIdentity(
    identity: VaultIdentity, result: Record<string, unknown>, binding: Record<string, unknown> | null,
  ): boolean {
    const launch = binding?.launch_command as { arguments?: unknown } | null
    return binding?.kind === 'gsd' && binding.source === 'agent-hook'
      && binding.checkpoint_id === identity.path && binding.cwd === identity.cwd
      && typeof binding.updated_at === 'number' && Number.isFinite(binding.updated_at)
      && typeof result.workspace_id === 'string' && typeof result.surface_id === 'string'
      && JSON.stringify(launch?.arguments) === JSON.stringify(this.launchArguments(identity))
  }

  private async clearPersistedAutomaticBinding(identity: VaultIdentity): Promise<void> {
    const { result, binding } = resumeResult(await this.transport(['surface', 'resume', 'show', ...this.target]))
    // No local ownership: adopt only this exact launch identity and generation.
    // A disabled bridge must not claim manual, foreign or other-session bindings.
    if (!binding || binding.auto_resume !== true || !this.matchesIdentity(identity, result, binding)) return
    this.binding = {
      path: identity.path, updatedAt: binding.updated_at as number, cwd: identity.cwd,
      workspace: result.workspace_id as string, surface: result.surface_id as string, vaultEnabled: false,
    }
    this.unsafeAutoResumeIdentity = JSON.stringify([identity.id, identity.path, identity.cwd])
    await this.clearAutomaticBinding()
  }

  private async clearAutomaticBinding(): Promise<boolean> {
    await this.endPresence()
    let cleared: boolean
    try {
      cleared = await this.clear()
    } catch (error) {
      this.lastIdentity = undefined
      console.warn('[gsd/cmux] Automatic restore is disabled, but clearing the GSD binding failed; a later lifecycle update will retry.')
      throw error
    }
    if (!cleared) {
      console.warn('[gsd/cmux] Automatic restore is disabled, but cmux changed the GSD binding before it could be cleared.')
      return false
    }
    this.blockedAutoResumeIdentity = this.unsafeAutoResumeIdentity
    this.unsafeAutoResumeIdentity = undefined
    console.warn('[gsd/cmux] Cleared a cmux automatic-restore binding because cmux.resume is disabled; enable it with /gsd cmux resume on to retain it.')
    return true
  }

  private async publish(identity: VaultIdentity, vaultEnabled: boolean, resumeEnabled: boolean): Promise<void> {
    const argv = this.launchArguments(identity)
    const name = vaultEnabled ? vaultTitle(identity) : 'GSD session'
    const observed = resumeResult(await this.transport(['surface', 'resume', 'show', ...this.target]))
    if (observed.binding) {
      const previous = observed.binding
      if (previous.kind !== 'gsd' || previous.source !== 'agent-hook') return
      if (this.binding) {
        if (previous.checkpoint_id !== this.binding.path || previous.updated_at !== this.binding.updatedAt) return
      } else {
        // A relaunch may adopt its own exact binding, never another agent/session.
        const launch = previous.launch_command as { arguments?: unknown } | null
        // Only this exact session may adopt a relaunch's binding. A predecessor's
        // binding is never taken over: a live owner cannot be distinguished from an
        // ended one from the session file alone (see #3014 handoff note).
        const ownExact = previous.checkpoint_id === identity.path
          && JSON.stringify(launch?.arguments) === JSON.stringify(argv)
        if (!ownExact) return
      }
    }
    const { result, binding } = resumeResult(await this.transport([
      'surface', 'resume', 'set', ...this.target,
      '--name', name, '--kind', 'gsd', '--checkpoint-id', identity.path,
      '--source', 'agent-hook', '--cwd', identity.cwd, '--',
      ...argv,
    ]))
    const bindingMatchesRequest = this.matchesIdentity(identity, result, binding)
    if (binding && bindingMatchesRequest && binding.auto_resume === true && !resumeEnabled) {
      await this.endPresence()
      this.binding = {
        path: identity.path, updatedAt: binding.updated_at as number, cwd: identity.cwd,
        workspace: result.workspace_id as string, surface: result.surface_id as string, vaultEnabled: false,
      }
      this.unsafeAutoResumeIdentity = JSON.stringify([identity.id, identity.path, identity.cwd])
      if (!await this.clearAutomaticBinding()) {
        throw new Error('cmux changed the GSD binding before the disabled auto-resume binding could be cleared')
      }
      throw new Error('cmux marked GSD restore automatic while cmux.resume is disabled; binding cleared')
    }
    // cmux owns the trusted-prefix decision. GSD never approves a command or
    // requests auto-resume; this field only reports cmux's effective policy.
    if (!binding || !bindingMatchesRequest || typeof binding.auto_resume !== 'boolean') {
      throw new Error('cmux did not accept the requested GSD session binding')
    }
    const previousBinding = this.binding
    const currentBinding: VaultBinding = {
      path: identity.path, updatedAt: binding.updated_at as number,
      cwd: identity.cwd,
      workspace: result.workspace_id as string, surface: result.surface_id as string,
      vaultEnabled,
    }
    this.binding = currentBinding
    // Surface updates may coalesce across auto's rapid session handoffs. Keep
    // the latest metadata per native file, not just the latest surface target.
    const snapshots = new Map(this.snapshots)
    if (!snapshots.has(identity.path)) snapshots.set(identity.path, identity)
    this.snapshots.clear()
    for (const snapshot of snapshots.values()) {
      try {
        if (await this.injected || !cmuxVaultEnabled(this.env, this.options.pid ?? process.pid)
          || !cmuxVaultConfigured(this.env, await this.options.getPreferences?.(snapshot.cwd))) continue
        if (!await stat(snapshot.path).then(info => info.isFile(), () => false)) continue
        await this.writeMetadata(snapshot)
      } catch { /* One failed metadata write must not discard other observed sessions. */ }
    }
    if (previousBinding && (previousBinding.path !== identity.path || !vaultEnabled)) {
      await this.endPresence(previousBinding)
    }
    if (vaultEnabled) await this.feed('SessionStart', currentBinding)
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
        gsdModels: identity.models,
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
    // A model selection is persisted before this event; refresh so Vault metadata stays current while idle.
    pi.on('model_select', (_event, ctx: ExtensionContext) => bridge.update(ctx.sessionManager, ctx.hasUI, true))
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
