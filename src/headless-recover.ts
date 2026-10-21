// gsd-pi — Headless Recover entrypoint
/**
 * Headless Recover — `gsd headless recover`
 *
 * Non-interactive parallel of the `/gsd recover` slash command. Prints one
 * sealed markdown Preview, then applies it through the verified Import
 * Application boundary only after exact hash approval.
 *
 * Output: `gsd-recover: recovered <N>M/<N>S/<N>T hierarchy\n` to stderr on
 * successful assessment or completed action — the same marker emitted by
 * handleRecover (commands-maintenance.ts), so callers can distinguish that
 * path from a silent no-op.
 *
 * Exit codes:
 *   0 — assessment or the requested recovery action completed
 *   1 — Preview approval or Forward Repair choices are required, or setup/action failed
 */

import { createJiti } from '@mariozechner/jiti'
import { fileURLToPath } from 'node:url'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'
import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const jiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false })

const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })
const gsdExtensionPath = (...segments: string[]) =>
  useAgentDir
    ? resolveAgentExtensionModule(agentExtensionsDir, segments)
    : resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))

function resolveAgentExtensionModule(agentDir: string, segments: string[]): string {
  const requested = join(agentDir, ...segments)
  if (existsSync(requested)) return requested
  if (segments.length === 1 && segments[0].endsWith('.ts')) {
    const jsPath = join(agentDir, segments[0].replace(/\.ts$/, '.js'))
    if (existsSync(jsPath)) return jsPath
  }
  return requested
}

function recoveryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}

async function loadExtensionModules() {
  const workspaceModule = await jiti.import(gsdExtensionPath('db-workspace.ts'), {}) as any
  const actionModule = await jiti.import(gsdExtensionPath('legacy-import-recovery-action.ts'), {}) as any
  const choiceTokenModule = await jiti.import(gsdExtensionPath('legacy-import-forward-repair-choice-token.ts'), {}) as any
  const openWorkflowDatabase = workspaceModule.openWorkflowDatabase
  const closeWorkflowDatabase = workspaceModule.closeWorkflowDatabase
  const prepareVerifiedRecoverApplication = workspaceModule.prepareVerifiedRecoverApplication
  const applyPreparedVerifiedRecoverApplication = workspaceModule.applyPreparedVerifiedRecoverApplication
  const loadRetainedVerifiedRecoverApplication = workspaceModule.loadRetainedVerifiedRecoverApplication
  const loadVerifiedRecoverApplication = workspaceModule.loadVerifiedRecoverApplication
  const executeLegacyImportRecoveryAction = actionModule.executeLegacyImportRecoveryAction
  const parseLegacyImportRecoveryAction = actionModule.parseLegacyImportRecoveryAction
  const formatLegacyImportForwardRepairChoice = choiceTokenModule.formatLegacyImportForwardRepairChoice
  const parseLegacyImportForwardRepairChoices = choiceTokenModule.parseLegacyImportForwardRepairChoices
  if (typeof openWorkflowDatabase !== 'function') {
    throw new Error('selected GSD extensions do not support workflow database recovery; synchronize the extension bundle')
  }
  if (typeof closeWorkflowDatabase !== 'function') {
    throw new Error('selected GSD extensions do not support workflow database closeout; synchronize the extension bundle')
  }
  if (typeof prepareVerifiedRecoverApplication !== 'function'
    || typeof applyPreparedVerifiedRecoverApplication !== 'function'
    || typeof loadRetainedVerifiedRecoverApplication !== 'function') {
    throw new Error('selected GSD extensions do not support verified Import Application recovery; synchronize the extension bundle')
  }
  if (typeof loadVerifiedRecoverApplication !== 'function') {
    throw new Error('selected GSD extensions do not support retained Import Application recovery; synchronize the extension bundle')
  }
  if (typeof executeLegacyImportRecoveryAction !== 'function') {
    throw new Error('selected GSD extensions do not support executable recovery actions; synchronize the extension bundle')
  }
  if (typeof parseLegacyImportRecoveryAction !== 'function') {
    throw new Error('selected GSD extensions do not support recovery action parsing; synchronize the extension bundle')
  }
  if (typeof formatLegacyImportForwardRepairChoice !== 'function'
    || typeof parseLegacyImportForwardRepairChoices !== 'function') {
    throw new Error('selected GSD extensions do not support recovery choice tokens; synchronize the extension bundle')
  }
  return {
    openWorkflowDatabase: openWorkflowDatabase as (basePath: string) => { ok: boolean; reason?: string; error?: Error },
    closeWorkflowDatabase: closeWorkflowDatabase as () => void,
    prepareVerifiedRecoverApplication: prepareVerifiedRecoverApplication as PrepareVerifiedRecoverApplication,
    applyPreparedVerifiedRecoverApplication: applyPreparedVerifiedRecoverApplication as ApplyPreparedVerifiedRecoverApplication,
    loadRetainedVerifiedRecoverApplication: loadRetainedVerifiedRecoverApplication as () => VerifiedRecoverApplicationResult | null,
    loadVerifiedRecoverApplication: loadVerifiedRecoverApplication as (operationId: string) => VerifiedRecoverApplicationResult,
    executeLegacyImportRecoveryAction: executeLegacyImportRecoveryAction as ExecuteLegacyImportRecoveryAction,
    parseLegacyImportRecoveryAction: parseLegacyImportRecoveryAction as ParseLegacyImportRecoveryAction,
    formatLegacyImportForwardRepairChoice: formatLegacyImportForwardRepairChoice as FormatLegacyImportForwardRepairChoice,
    parseLegacyImportForwardRepairChoices: parseLegacyImportForwardRepairChoices as ParseLegacyImportForwardRepairChoices,
  }
}

export interface RecoverResult {
  exitCode: number
}

interface VerifiedRecoverApplicationResult {
  receipt: { operationId: string; applicationIdentityHash: string }
  backup: { backup_ref: string; [key: string]: unknown }
  counts: { milestones: number; slices: number; tasks: number }
}

interface PreparedVerifiedRecoverApplication {
  preview: { preview_hash: string }
  authorizationText: string
}

interface RecoveryAssessment {
  decision: string
  evidenceHash: string
  reasonCode: string
  recommendation: { recommendationText: string }
}

type PrepareVerifiedRecoverApplication = (
  basePath: string,
) => PreparedVerifiedRecoverApplication | Promise<PreparedVerifiedRecoverApplication>

type ApplyPreparedVerifiedRecoverApplication = (
  prepared: PreparedVerifiedRecoverApplication,
  approvedPreviewHash: string,
) => VerifiedRecoverApplicationResult | Promise<VerifiedRecoverApplicationResult>

type ExecuteLegacyImportRecoveryAction = (
  application: VerifiedRecoverApplicationResult,
  action: 'assess' | 'restore' | 'forward-repair',
  choices?: readonly {
    instructionIndex: number
    targetKind: string
    targetKey: string
    reviewHash: string
    decision: 'preserve-later' | 'restore-backup'
  }[], consent?: { consentSchemaVersion: 1; decision: 'proceed'; destructiveDatabaseRestore: true; evidenceHash: string },
) => {
  status: 'assessed' | 'restored' | 'forward-repaired' | 'choice-required'
  assessment?: RecoveryAssessment
  result?: { status: string }
  choices?: readonly {
    instructionIndex: number
    targetKind: string
    targetKey: string
    reasonCode: string
    reviewHash: string
    currentValueJson: string
    proposedMutationJson: string
    recommendedDecision: 'preserve-later'
    recommendationRationale: string
  }[]
}

type ParseLegacyImportRecoveryAction = (
  flags: readonly string[],
) => 'assess' | 'restore' | 'forward-repair'

type ForwardRepairChoice = NonNullable<Parameters<ExecuteLegacyImportRecoveryAction>[2]>[number]

type FormatLegacyImportForwardRepairChoice = (
  choice: Omit<ForwardRepairChoice, 'decision'>,
  decision: ForwardRepairChoice['decision'],
) => string

type ParseLegacyImportForwardRepairChoices = (args: string) => ForwardRepairChoice[]

export async function handleRecover(
  basePath: string,
  args: readonly string[] = [],
): Promise<RecoverResult> {
  const gsdDir = join(basePath, '.gsd')
  if (!existsSync(gsdDir)) {
    process.stderr.write(`[headless] recover: no .gsd/ directory at ${basePath}\n`)
    return { exitCode: 1 }
  }

  let modules: Awaited<ReturnType<typeof loadExtensionModules>>
  try {
    modules = await loadExtensionModules()
  } catch (err) {
    const msg = recoveryErrorMessage(err)
    process.stderr.write(`[headless] recover: failed to load extension modules: ${msg}\n`)
    return { exitCode: 1 }
  }

  let action: 'assess' | 'restore' | 'forward-repair'
  try {
    action = modules.parseLegacyImportRecoveryAction(args)
  } catch (err) {
    process.stderr.write(`[headless] recover: ${recoveryErrorMessage(err)}\n`)
    return { exitCode: 1 }
  }
  const opened = modules.openWorkflowDatabase(basePath)
  if (!opened.ok) {
    // Refuse-newer version skew forwards the exact engine message (T003 spike,
    // mandate 3); every other open failure keeps the generic message.
    if (opened.reason === 'schema-too-new' && opened.error instanceof Error) {
      process.stderr.write(`[headless] recover: ${opened.error.message}\n`)
    } else {
      process.stderr.write(`[headless] recover: failed to open or create the GSD database at ${basePath}\n`)
    }
    return { exitCode: 1 }
  }
  try {
  const applicationId = args.find((arg) => arg.startsWith('--application='))?.slice('--application='.length)
  if (!applicationId && action !== 'assess') {
    process.stderr.write('[headless] recover: assess first, then provide --application evidence\n')
    return { exitCode: 1 }
  }
  let application: VerifiedRecoverApplicationResult
  try {
    const retained = applicationId
      ? modules.loadVerifiedRecoverApplication(applicationId)
      : modules.loadRetainedVerifiedRecoverApplication()
    if (retained) {
      application = retained
    } else {
      const prepared = await modules.prepareVerifiedRecoverApplication(basePath)
      const approvedPreviewHash = args
        .map((arg) => /^--preview=(sha256:[0-9a-f]{64})$/u.exec(arg)?.[1])
        .find((value): value is string => value !== undefined)
      if (approvedPreviewHash !== prepared.preview.preview_hash) {
        process.stderr.write(`[headless] recover: ${prepared.authorizationText}\n`)
        process.stderr.write(
          `[headless] recover: import not applied; re-run with --preview=${prepared.preview.preview_hash}\n`,
        )
        return { exitCode: 1 }
      }
      application = await modules.applyPreparedVerifiedRecoverApplication(prepared, approvedPreviewHash)
    }
  } catch (err) {
    const msg = recoveryErrorMessage(err)
    process.stderr.write(`[headless] recover failed: ${msg}\n`)
    return { exitCode: 1 }
  }

  let choices: ForwardRepairChoice[]
  try {
    choices = modules.parseLegacyImportForwardRepairChoices(args.join(' '))
  } catch (error) {
    process.stderr.write(`[headless] recover: malformed --choice token: ${recoveryErrorMessage(error)}\n`)
    return { exitCode: 1 }
  }
  let recoveryAction: ReturnType<ExecuteLegacyImportRecoveryAction>
  try {
    const consentHash = args
      .map((arg) => /^--consent=proceed:destructive-database-restore:(sha256:[0-9a-f]{64})$/u.exec(arg)?.[1])
      .find((value): value is string => value !== undefined)
    const consent = consentHash ? { consentSchemaVersion: 1 as const, decision: 'proceed' as const, destructiveDatabaseRestore: true as const, evidenceHash: consentHash } : undefined
    recoveryAction = modules.executeLegacyImportRecoveryAction(application, action, choices, consent)
  } catch (err) {
    const msg = recoveryErrorMessage(err)
    process.stderr.write(`[headless] recover action failed: ${msg}\n`)
    return { exitCode: 1 }
  }
  process.stderr.write(
    `[headless] recover: verified backup and restore rehearsal completed at ${application.backup.backup_ref}\n`,
  )
  if (recoveryAction.status === 'choice-required') {
    for (const choice of recoveryAction.choices ?? []) {
      process.stderr.write(
        `[headless] recover: review target ${choice.instructionIndex}:${choice.targetKind}:${choice.targetKey}; `
          + `reason ${choice.reasonCode}, evidence ${choice.reviewHash}; `
          + `current canonical value ${choice.currentValueJson}; proposed backup mutation ${choice.proposedMutationJson}; `
          + `recommended ${choice.recommendedDecision} because ${choice.recommendationRationale}; use `
          + `--application=${application.receipt.operationId} --forward-repair `
          + `${modules.formatLegacyImportForwardRepairChoice(choice, 'preserve-later')} or `
          + `--application=${application.receipt.operationId} --forward-repair `
          + `${modules.formatLegacyImportForwardRepairChoice(choice, 'restore-backup')}\n`,
      )
    }
    return { exitCode: 1 }
  }
  if (recoveryAction.status === 'restored' || recoveryAction.status === 'forward-repaired') {
    process.stderr.write(
      `[headless] recover: ${recoveryAction.status} (${recoveryAction.result?.status ?? 'unknown'})\n`,
    )
  } else {
    const assessment = recoveryAction.assessment!
    process.stderr.write(
      `[headless] recover: ${assessment.recommendation.recommendationText} `
        + `Application ${application.receipt.applicationIdentityHash}; use retained Application operation ${application.receipt.operationId}.\n`,
    )
    if (assessment.decision === 'restore-consent-required') {
      process.stderr.write(
        `[headless] recover: --application=${application.receipt.operationId} --restore `
          + `--consent=proceed:destructive-database-restore:${assessment.evidenceHash}\n`,
      )
    } else if (assessment.decision === 'forward-repair-required') {
      process.stderr.write(
        `[headless] recover: --application=${application.receipt.operationId} --forward-repair\n`,
      )
    } else if (assessment.decision === 'already-restored') {
      process.stderr.write(
        '[headless] recover: retained Application is already restored; no further recovery action is required.\n',
      )
    } else {
      // Fail closed: a refused (or otherwise non-actionable) assessment is not
      // a successful recovery — no `gsd-recover: recovered` marker, non-zero exit.
      process.stderr.write(
        `[headless] recover: assessment '${assessment.decision}' (${assessment.reasonCode}); no recovery action was taken.\n`,
      )
      return { exitCode: 1 }
    }
  }

  const completedApplication = recoveryAction.status === 'restored' || recoveryAction.status === 'forward-repaired'
    ? modules.loadVerifiedRecoverApplication(application.receipt.operationId)
    : application
  const { counts } = completedApplication
  process.stderr.write(
    `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy\n`,
  )
  return { exitCode: 0 }
  } finally {
    modules.closeWorkflowDatabase()
  }
}
