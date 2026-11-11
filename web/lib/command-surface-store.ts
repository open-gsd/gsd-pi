"use client"

import {
  applyCommandSurfaceActionResult,
  setCommandSurfacePending,
  type CommandSurfaceDiagnosticsPhaseState,
  type CommandSurfaceDoctorState,
  type CommandSurfaceForkMessage,
  type CommandSurfaceGitSummaryState,
  type CommandSurfaceKnowledgeCapturesState,
  type CommandSurfaceModelOption,
  type CommandSurfaceSessionBrowserState,
  type CommandSurfaceSessionStats,
  type CommandSurfaceTarget,
  type CommandSurfaceThinkingLevel,
  type WorkspaceRecoveryDiagnostics,
} from "./command-surface-contract"
import type { DoctorFixResult, DoctorReport, ForensicReport, SkillHealthReport } from "./diagnostics-types"
import type { KnowledgeData, CapturesData, CaptureResolveRequest, CaptureResolveResult } from "./knowledge-captures-types"
import type { SettingsData } from "./settings-types"
import type {
  HistoryData,
  InspectData,
  HooksData,
  ExportResult,
  UndoInfo,
  UndoResult,
  CleanupData,
  CleanupResult,
  SteerData,
} from "./remaining-command-types"
import type { GitSummaryResponse } from "./git-summary-contract"
import type {
  SessionManageResponse,
} from "./session-browser-contract"
import { authFetch } from "./auth"
import {
  createWorkspaceRecoverySummary,
  withFreshnessFailed,
  withFreshnessRequested,
  withFreshnessSucceeded,
  withEntitySliceSucceeded,
} from "./workspace-live-state"
import type {
  LiveStateInvalidationEvent,
  WorkspaceBridgeCommand,
  WorkspaceCommandResponse,
  WorkspaceLiveState,
  WorkspaceModelRef,
  WorkspaceOnboardingState,
  WorkspaceSessionState,
  WorkspaceStoreState,
} from "./gsd-workspace-store"
import { resolveResumableSessions } from "./workspace-live-state"
import {
  cloneBootWithBridge,
  describeSessionPath,
  patchBootActiveSession,
  patchBootSessionName,
  patchBootSessionState,
} from "./workspace-boot-helpers"
import {
  findOnboardingProviderLabel,
  getCurrentModelSelection,
  markRecoveryStateFailure,
  markRecoveryStatePending,
  normalizeAvailableModels,
  normalizeClientError,
  normalizeCompactionResult,
  normalizeForkMessages,
  normalizeGitSummaryError,
  normalizeGitSummaryPayload,
  normalizeRecoveryDiagnosticsPayload,
  normalizeSessionBrowserPayload,
  normalizeSessionStats,
  overlayLiveBridgeSessionState,
  patchSessionBrowserSession,
  syncSessionBrowserStateWithBridge,
  createRecoveryStateFromDiagnostics,
} from "./command-surface-helpers"

export interface CommandSurfaceHost {
  getState(): WorkspaceStoreState
  patchState(patch: Partial<WorkspaceStoreState>): void
  buildUrl(path: string): string
  sendCommand(
    command: WorkspaceBridgeCommand,
    options?: { displayInput?: string; appendInputLine?: boolean; appendResponseLine?: boolean },
  ): Promise<WorkspaceCommandResponse | null>
  refreshBoot(options?: { soft?: boolean }): Promise<void>
  refreshOnboarding(): Promise<WorkspaceOnboardingState | null>
  logoutProvider(providerId: string): Promise<WorkspaceOnboardingState | null>
  saveApiKey(providerId: string, apiKey: string): Promise<WorkspaceOnboardingState | null>
  startProviderFlow(providerId: string): Promise<WorkspaceOnboardingState | null>
  submitProviderFlowInput(flowId: string, input: string): Promise<WorkspaceOnboardingState | null>
  cancelProviderFlow(flowId: string): Promise<WorkspaceOnboardingState | null>
}

export class CommandSurfaceStore {
  private readonly host: CommandSurfaceHost

  constructor(host: CommandSurfaceHost) {
    this.host = host
  }

  loadGitSummary = async (): Promise<GitSummaryResponse | null> => {
    const requestedGitSummary: CommandSurfaceGitSummaryState = {
      ...this.host.getState().commandSurface.gitSummary,
      pending: true,
      error: null,
    }

    const requestedLive: WorkspaceLiveState = {
      ...this.host.getState().live,
      freshness: {
        ...this.host.getState().live.freshness,
        gitSummary: withFreshnessRequested(this.host.getState().live.freshness.gitSummary),
      },
    }

    this.host.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.host.getState().commandSurface,
          gitSummary: requestedGitSummary,
        },
        "load_git_summary",
      ),
    })

    try {
      const response = await authFetch(this.host.buildUrl("/api/git"), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const normalizedGitSummary = normalizeGitSummaryPayload(payload)
      if (!response.ok || !normalizedGitSummary) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Current-project git summary failed with ${response.status}`
        const failedGitSummary = normalizeGitSummaryError(requestedGitSummary, message)
        const failedLive: WorkspaceLiveState = {
          ...this.host.getState().live,
          freshness: {
            ...this.host.getState().live.freshness,
            gitSummary: withFreshnessFailed(this.host.getState().live.freshness.gitSummary, message),
          },
        }
        this.host.patchState({
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.host.getState().commandSurface,
              gitSummary: failedGitSummary,
            },
            {
              action: "load_git_summary",
              success: false,
              message,
              gitSummary: failedGitSummary,
            },
          ),
        })
        return null
      }

      const gitSummary: CommandSurfaceGitSummaryState = {
        pending: false,
        loaded: true,
        result: normalizedGitSummary,
        error: null,
      }

      const nextLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          gitSummary: withFreshnessSucceeded(this.host.getState().live.freshness.gitSummary),
        },
      }

      this.host.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "load_git_summary",
          success: true,
          message: "",
          gitSummary,
        }),
      })

      return normalizedGitSummary
    } catch (error) {
      const message = normalizeClientError(error)
      const failedGitSummary = normalizeGitSummaryError(requestedGitSummary, message)
      const failedLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          gitSummary: withFreshnessFailed(this.host.getState().live.freshness.gitSummary, message),
        },
      }
      this.host.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            gitSummary: failedGitSummary,
          },
          {
            action: "load_git_summary",
            success: false,
            message,
            gitSummary: failedGitSummary,
          },
        ),
      })
      return null
    }
  }

  loadRecoveryDiagnostics = async (): Promise<WorkspaceRecoveryDiagnostics | null> => {
    const requestedRecovery = markRecoveryStatePending(this.host.getState().commandSurface.recovery)
    const requestedLive: WorkspaceLiveState = {
      ...this.host.getState().live,
      freshness: {
        ...this.host.getState().live.freshness,
        recovery: withFreshnessRequested(this.host.getState().live.freshness.recovery),
      },
    }

    this.host.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.host.getState().commandSurface,
          recovery: requestedRecovery,
        },
        "load_recovery_diagnostics",
      ),
    })

    try {
      const response = await authFetch(this.host.buildUrl("/api/recovery"), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const diagnostics = normalizeRecoveryDiagnosticsPayload(payload)
      if (!response.ok || !diagnostics) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Recovery diagnostics failed with ${response.status}`
        const failedRecovery = markRecoveryStateFailure(requestedRecovery, message)
        const failedLive: WorkspaceLiveState = {
          ...this.host.getState().live,
          freshness: {
            ...this.host.getState().live.freshness,
            recovery: withFreshnessFailed(this.host.getState().live.freshness.recovery, message),
          },
        }
        this.host.patchState({
          lastClientError: message,
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.host.getState().commandSurface,
              recovery: failedRecovery,
            },
            {
              action: "load_recovery_diagnostics",
              success: false,
              message,
              recovery: failedRecovery,
            },
          ),
        })
        return null
      }

      const recovery = {
        ...createRecoveryStateFromDiagnostics(diagnostics),
        lastInvalidatedAt: this.host.getState().commandSurface.recovery.lastInvalidatedAt,
      }
      const nextLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          recovery: withFreshnessSucceeded(this.host.getState().live.freshness.recovery),
        },
      }

      this.host.patchState({
        lastClientError: null,
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            recovery,
          },
          {
            action: "load_recovery_diagnostics",
            success: true,
            message:
              diagnostics.status === "ready"
                ? "Recovery diagnostics refreshed"
                : "Recovery diagnostics are currently unavailable",
            recovery,
          },
        ),
      })

      return diagnostics
    } catch (error) {
      const message = normalizeClientError(error)
      const failedRecovery = markRecoveryStateFailure(requestedRecovery, message)
      const failedLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          recovery: withFreshnessFailed(this.host.getState().live.freshness.recovery, message),
        },
      }
      this.host.patchState({
        lastClientError: message,
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            recovery: failedRecovery,
          },
          {
            action: "load_recovery_diagnostics",
            success: false,
            message,
            recovery: failedRecovery,
          },
        ),
      })
      return null
    }
  }

  // ─── Diagnostics panel fetch methods ────────────────────────────────────────

  private patchDiagnosticsPhaseState<K extends "forensics" | "skillHealth">(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<K extends "forensics" ? ForensicReport : SkillHealthReport>>,
  ): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        diagnostics: {
          ...this.host.getState().commandSurface.diagnostics,
          [key]: { ...this.host.getState().commandSurface.diagnostics[key], ...patch },
        },
      },
    })
  }

  private patchDoctorState(patch: Partial<CommandSurfaceDoctorState>): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        diagnostics: {
          ...this.host.getState().commandSurface.diagnostics,
          doctor: { ...this.host.getState().commandSurface.diagnostics.doctor, ...patch },
        },
      },
    })
  }

  private patchKnowledgeCapturesState(patch: Partial<CommandSurfaceKnowledgeCapturesState>): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        knowledgeCaptures: { ...this.host.getState().commandSurface.knowledgeCaptures, ...patch },
      },
    })
  }

  private patchKnowledgeCapturesPhaseState<K extends "knowledge" | "captures">(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<K extends "knowledge" ? KnowledgeData : CapturesData>>,
  ): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        knowledgeCaptures: {
          ...this.host.getState().commandSurface.knowledgeCaptures,
          [key]: { ...this.host.getState().commandSurface.knowledgeCaptures[key], ...patch },
        },
      },
    })
  }

  private patchSettingsPhaseState(patch: Partial<CommandSurfaceDiagnosticsPhaseState<SettingsData>>): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        settingsData: { ...this.host.getState().commandSurface.settingsData, ...patch },
      },
    })
  }

  private patchRemainingCommandsPhaseState<
    K extends keyof import("./command-surface-contract").CommandSurfaceRemainingState,
  >(
    key: K,
    patch: Partial<CommandSurfaceDiagnosticsPhaseState<import("./command-surface-contract").CommandSurfaceRemainingState[K] extends CommandSurfaceDiagnosticsPhaseState<infer T> ? T : never>>,
  ): void {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        remainingCommands: {
          ...this.host.getState().commandSurface.remainingCommands,
          [key]: { ...this.host.getState().commandSurface.remainingCommands[key], ...patch },
        },
      },
    })
  }

  loadForensicsDiagnostics = async (): Promise<ForensicReport | null> => {
    this.patchDiagnosticsPhaseState("forensics", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/forensics"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Forensics request failed with ${response.status}`
        this.patchDiagnosticsPhaseState("forensics", { phase: "error", error: message })
        return null
      }
      this.patchDiagnosticsPhaseState("forensics", { phase: "loaded", data: payload as ForensicReport, lastLoadedAt: new Date().toISOString() })
      return payload as ForensicReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDiagnosticsPhaseState("forensics", { phase: "error", error: message })
      return null
    }
  }

  loadDoctorDiagnostics = async (scope?: string): Promise<DoctorReport | null> => {
    this.patchDoctorState({ phase: "loading", error: null })
    try {
      const url = this.host.buildUrl(scope ? `/api/doctor?scope=${encodeURIComponent(scope)}` : "/api/doctor")
      const response = await authFetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Doctor request failed with ${response.status}`
        this.patchDoctorState({ phase: "error", error: message })
        return null
      }
      this.patchDoctorState({ phase: "loaded", data: payload as DoctorReport, lastLoadedAt: new Date().toISOString() })
      return payload as DoctorReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDoctorState({ phase: "error", error: message })
      return null
    }
  }

  applyDoctorFixes = async (scope?: string): Promise<DoctorFixResult | null> => {
    this.patchDoctorState({ fixPending: true, lastFixError: null, lastFixResult: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/doctor"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(scope ? { scope } : {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Doctor fix request failed with ${response.status}`
        this.patchDoctorState({ fixPending: false, lastFixError: message })
        return null
      }
      const fixResult = payload as DoctorFixResult
      this.patchDoctorState({ fixPending: false, lastFixResult: fixResult })
      // Reload doctor data after applying fixes so the issue list refreshes
      void this.loadDoctorDiagnostics(scope)
      return fixResult
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDoctorState({ fixPending: false, lastFixError: message })
      return null
    }
  }

  loadSkillHealthDiagnostics = async (): Promise<SkillHealthReport | null> => {
    this.patchDiagnosticsPhaseState("skillHealth", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/skill-health"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Skill health request failed with ${response.status}`
        this.patchDiagnosticsPhaseState("skillHealth", { phase: "error", error: message })
        return null
      }
      this.patchDiagnosticsPhaseState("skillHealth", { phase: "loaded", data: payload as SkillHealthReport, lastLoadedAt: new Date().toISOString() })
      return payload as SkillHealthReport
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchDiagnosticsPhaseState("skillHealth", { phase: "error", error: message })
      return null
    }
  }

  loadKnowledgeData = async (): Promise<KnowledgeData | null> => {
    this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/knowledge"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Knowledge request failed with ${response.status}`
        this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "error", error: message })
        return null
      }
      this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "loaded", data: payload as KnowledgeData, lastLoadedAt: new Date().toISOString() })
      return payload as KnowledgeData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesPhaseState("knowledge", { phase: "error", error: message })
      return null
    }
  }

  loadCapturesData = async (): Promise<CapturesData | null> => {
    this.patchKnowledgeCapturesPhaseState("captures", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/captures"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Captures request failed with ${response.status}`
        this.patchKnowledgeCapturesPhaseState("captures", { phase: "error", error: message })
        return null
      }
      this.patchKnowledgeCapturesPhaseState("captures", { phase: "loaded", data: payload as CapturesData, lastLoadedAt: new Date().toISOString() })
      return payload as CapturesData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesPhaseState("captures", { phase: "error", error: message })
      return null
    }
  }

  loadSettingsData = async (): Promise<SettingsData | null> => {
    this.patchSettingsPhaseState({ phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/settings-data"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Settings request failed with ${response.status}`
        this.patchSettingsPhaseState({ phase: "error", error: message })
        return null
      }
      this.patchSettingsPhaseState({ phase: "loaded", data: payload as SettingsData, lastLoadedAt: new Date().toISOString() })
      return payload as SettingsData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchSettingsPhaseState({ phase: "error", error: message })
      return null
    }
  }

  // ─── Remaining command surface load/mutation methods ──────────────────────────

  loadHistoryData = async (): Promise<HistoryData | null> => {
    this.patchRemainingCommandsPhaseState("history", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/history"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `History request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("history", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("history", { phase: "loaded", data: payload as HistoryData, lastLoadedAt: new Date().toISOString() })
      return payload as HistoryData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("history", { phase: "error", error: message })
      return null
    }
  }

  loadInspectData = async (): Promise<InspectData | null> => {
    this.patchRemainingCommandsPhaseState("inspect", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/inspect"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Inspect request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("inspect", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("inspect", { phase: "loaded", data: payload as InspectData, lastLoadedAt: new Date().toISOString() })
      return payload as InspectData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("inspect", { phase: "error", error: message })
      return null
    }
  }

  loadHooksData = async (): Promise<HooksData | null> => {
    this.patchRemainingCommandsPhaseState("hooks", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/hooks"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Hooks request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("hooks", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("hooks", { phase: "loaded", data: payload as HooksData, lastLoadedAt: new Date().toISOString() })
      return payload as HooksData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("hooks", { phase: "error", error: message })
      return null
    }
  }

  loadExportData = async (format?: "markdown" | "json"): Promise<ExportResult | null> => {
    this.patchRemainingCommandsPhaseState("exportData", { phase: "loading", error: null })
    try {
      const url = this.host.buildUrl(format ? `/api/export-data?format=${encodeURIComponent(format)}` : "/api/export-data")
      const response = await authFetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Export request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("exportData", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("exportData", { phase: "loaded", data: payload as ExportResult, lastLoadedAt: new Date().toISOString() })
      return payload as ExportResult
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("exportData", { phase: "error", error: message })
      return null
    }
  }

  loadUndoInfo = async (): Promise<UndoInfo | null> => {
    this.patchRemainingCommandsPhaseState("undo", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/undo"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Undo info request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("undo", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("undo", { phase: "loaded", data: payload as UndoInfo, lastLoadedAt: new Date().toISOString() })
      return payload as UndoInfo
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("undo", { phase: "error", error: message })
      return null
    }
  }

  loadCleanupData = async (): Promise<CleanupData | null> => {
    this.patchRemainingCommandsPhaseState("cleanup", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/cleanup"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Cleanup data request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("cleanup", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("cleanup", { phase: "loaded", data: payload as CleanupData, lastLoadedAt: new Date().toISOString() })
      return payload as CleanupData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("cleanup", { phase: "error", error: message })
      return null
    }
  }

  loadSteerData = async (): Promise<SteerData | null> => {
    this.patchRemainingCommandsPhaseState("steer", { phase: "loading", error: null })
    try {
      const response = await authFetch(this.host.buildUrl("/api/steer"), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Steer data request failed with ${response.status}`
        this.patchRemainingCommandsPhaseState("steer", { phase: "error", error: message })
        return null
      }
      this.patchRemainingCommandsPhaseState("steer", { phase: "loaded", data: payload as SteerData, lastLoadedAt: new Date().toISOString() })
      return payload as SteerData
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchRemainingCommandsPhaseState("steer", { phase: "error", error: message })
      return null
    }
  }

  executeUndoAction = async (): Promise<UndoResult | null> => {
    try {
      const response = await authFetch(this.host.buildUrl("/api/undo"), {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Undo action failed with ${response.status}`
        return { success: false, message }
      }
      // Reload undo info after executing
      void this.loadUndoInfo()
      return payload as UndoResult
    } catch (error) {
      const message = normalizeClientError(error)
      return { success: false, message }
    }
  }

  executeCleanupAction = async (branches: string[], snapshots: string[]): Promise<CleanupResult | null> => {
    try {
      const response = await authFetch(this.host.buildUrl("/api/cleanup"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ branches, snapshots }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Cleanup action failed with ${response.status}`
        return { deletedBranches: 0, prunedSnapshots: 0, message }
      }
      // Reload cleanup data after executing
      void this.loadCleanupData()
      return payload as CleanupResult
    } catch (error) {
      const message = normalizeClientError(error)
      return { deletedBranches: 0, prunedSnapshots: 0, message }
    }
  }

  resolveCaptureAction = async (request: CaptureResolveRequest): Promise<CaptureResolveResult | null> => {
    this.patchKnowledgeCapturesState({ resolveRequest: { pending: true, lastError: null, lastResult: null } })
    try {
      const response = await authFetch(this.host.buildUrl("/api/captures"), {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        const message = payload?.error ?? `Capture resolve failed with ${response.status}`
        this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: message, lastResult: null } })
        return null
      }
      const result = payload as CaptureResolveResult
      this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: null, lastResult: result } })
      // Auto-reload captures after successful resolve
      void this.loadCapturesData()
      return result
    } catch (error) {
      const message = normalizeClientError(error)
      this.patchKnowledgeCapturesState({ resolveRequest: { pending: false, lastError: message, lastResult: null } })
      return null
    }
  }

  updateSessionBrowserState = (
    patch: Partial<Pick<CommandSurfaceSessionBrowserState, "query" | "sortMode" | "nameFilter">>,
  ): void => {
    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        sessionBrowser: {
          ...this.host.getState().commandSurface.sessionBrowser,
          ...patch,
          error: null,
        },
        lastError: null,
        lastResult: null,
      },
    })
  }

  loadSessionBrowser = async (
    overrides: Partial<Pick<CommandSurfaceSessionBrowserState, "query" | "sortMode" | "nameFilter">> = {},
  ): Promise<CommandSurfaceSessionBrowserState | null> => {
    const requestedSessionBrowser = {
      ...this.host.getState().commandSurface.sessionBrowser,
      ...overrides,
      error: null,
    }

    const requestedLive: WorkspaceLiveState = {
      ...this.host.getState().live,
      freshness: {
        ...this.host.getState().live.freshness,
        sessionBrowser: withFreshnessRequested(this.host.getState().live.freshness.sessionBrowser),
      },
    }

    this.host.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(
        {
          ...this.host.getState().commandSurface,
          sessionBrowser: requestedSessionBrowser,
        },
        "load_session_browser",
      ),
    })

    const params = new URLSearchParams()
    if (requestedSessionBrowser.query.trim()) {
      params.set("query", requestedSessionBrowser.query.trim())
    }
    params.set("sortMode", requestedSessionBrowser.sortMode)
    params.set("nameFilter", requestedSessionBrowser.nameFilter)

    try {
      const response = await authFetch(this.host.buildUrl(`/api/session/browser?${params.toString()}`), {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })

      const payload = await response.json().catch(() => null)
      const normalizedSessionBrowser = normalizeSessionBrowserPayload(payload)
      if (!response.ok || !normalizedSessionBrowser) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Current-project session browser failed with ${response.status}`
        const failedSessionBrowser = {
          ...requestedSessionBrowser,
          error: message,
        }
        const failedLive: WorkspaceLiveState = {
          ...this.host.getState().live,
          freshness: {
            ...this.host.getState().live.freshness,
            sessionBrowser: withFreshnessFailed(this.host.getState().live.freshness.sessionBrowser, message),
          },
        }
        this.host.patchState({
          live: {
            ...failedLive,
            recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
          },
          commandSurface: applyCommandSurfaceActionResult(
            {
              ...this.host.getState().commandSurface,
              sessionBrowser: failedSessionBrowser,
            },
            {
              action: "load_session_browser",
              success: false,
              message,
              sessionBrowser: failedSessionBrowser,
            },
          ),
        })
        return null
      }

      const sessionBrowser = syncSessionBrowserStateWithBridge(normalizedSessionBrowser, this.host.getState().boot)
      const currentTarget = this.host.getState().commandSurface.selectedTarget
      const defaultResumePath = sessionBrowser.sessions.find((session) => !session.isActive)?.path ?? sessionBrowser.sessions[0]?.path
      const defaultRenameSession =
        sessionBrowser.sessions.find((session) => session.path === sessionBrowser.activeSessionPath) ?? sessionBrowser.sessions[0]

      let selectedTarget = currentTarget
      if (currentTarget?.kind === "resume" || this.host.getState().commandSurface.section === "resume") {
        const visiblePath =
          currentTarget?.kind === "resume" && currentTarget.sessionPath && sessionBrowser.sessions.some((session) => session.path === currentTarget.sessionPath)
            ? currentTarget.sessionPath
            : defaultResumePath
        selectedTarget = { kind: "resume", sessionPath: visiblePath }
      } else if (currentTarget?.kind === "name" || this.host.getState().commandSurface.section === "name") {
        const visibleSession =
          currentTarget?.kind === "name" && currentTarget.sessionPath
            ? sessionBrowser.sessions.find((session) => session.path === currentTarget.sessionPath) ?? defaultRenameSession
            : defaultRenameSession
        selectedTarget = {
          kind: "name",
          sessionPath: visibleSession?.path,
          name:
            currentTarget?.kind === "name" && currentTarget.sessionPath === visibleSession?.path
              ? currentTarget.name
              : visibleSession?.name ?? "",
        }
      }

      const nextLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          sessionBrowser: withFreshnessSucceeded(this.host.getState().live.freshness.sessionBrowser),
        },
      }

      this.host.patchState({
        live: {
          ...nextLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: nextLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            sessionBrowser,
          },
          {
            action: "load_session_browser",
            success: true,
            message: "",
            selectedTarget,
            sessionBrowser,
          },
        ),
      })

      return sessionBrowser
    } catch (error) {
      const message = normalizeClientError(error)
      const failedSessionBrowser = {
        ...requestedSessionBrowser,
        error: message,
      }
      const failedLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          sessionBrowser: withFreshnessFailed(this.host.getState().live.freshness.sessionBrowser, message),
        },
      }
      this.host.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            sessionBrowser: failedSessionBrowser,
          },
          {
            action: "load_session_browser",
            success: false,
            message,
            sessionBrowser: failedSessionBrowser,
          },
        ),
      })
      return null
    }
  }

  renameSessionFromSurface = async (sessionPath: string, name?: string): Promise<SessionManageResponse | null> => {
    const currentTarget = this.host.getState().commandSurface.selectedTarget
    const requestedName = name ?? (currentTarget?.kind === "name" ? currentTarget.name : "")
    const trimmedName = requestedName.trim()
    const selectedTarget: CommandSurfaceTarget = { kind: "name", sessionPath, name: requestedName }

    if (!trimmedName) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "rename_session",
          success: false,
          message: "Session name cannot be empty",
          selectedTarget,
        }),
      })
      return null
    }

    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "rename_session", selectedTarget),
    })

    try {
      const response = await authFetch(this.host.buildUrl("/api/session/manage"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action: "rename",
          sessionPath,
          name: trimmedName,
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || typeof payload !== "object" || payload.success !== true) {
        const message =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Session rename failed with ${response.status}`
        this.host.patchState({
          commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
            action: "rename_session",
            success: false,
            message,
            selectedTarget,
          }),
        })
        return null
      }

      const result = payload as SessionManageResponse & { success: true }
      const nextBoot = patchBootSessionName(this.host.getState().boot, result.sessionPath, result.name)
      const nextSessionBrowser = syncSessionBrowserStateWithBridge(
        patchSessionBrowserSession(this.host.getState().commandSurface.sessionBrowser, result.sessionPath, {
          name: result.name,
          ...(result.isActiveSession ? { isActive: true } : {}),
        }),
        nextBoot,
      )
      const nextSelectedTarget: CommandSurfaceTarget = {
        kind: "name",
        sessionPath: result.sessionPath,
        name: result.name,
      }
      const nextLiveBase: WorkspaceLiveState = {
        ...this.host.getState().live,
        resumableSessions: withEntitySliceSucceeded(
          this.host.getState().live.resumableSessions,
          overlayLiveBridgeSessionState(
            resolveResumableSessions(this.host.getState()).map((session) =>
              session.path === result.sessionPath
                ? {
                    ...session,
                    name: result.name,
                  }
                : session,
            ),
            nextBoot,
          ),
        ),
      }

      this.host.patchState({
        ...(nextBoot ? { boot: nextBoot } : {}),
        live: {
          ...nextLiveBase,
          recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
        },
        commandSurface: applyCommandSurfaceActionResult(
          {
            ...this.host.getState().commandSurface,
            sessionBrowser: nextSessionBrowser,
          },
          {
            action: "rename_session",
            success: true,
            message: `Session name set: ${result.name}`,
            selectedTarget: nextSelectedTarget,
            sessionBrowser: nextSessionBrowser,
          },
        ),
      })

      return result
    } catch (error) {
      const message = normalizeClientError(error)
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "rename_session",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return null
    }
  }

  loadAvailableModels = async (): Promise<CommandSurfaceModelOption[]> => {
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "loading_models"),
    })

    const response = await this.host.sendCommand(
      { type: "get_available_models" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "loading_models",
          success: false,
          message: `Couldn't load models — ${message}`,
        }),
      })
      return []
    }

    const availableModels = normalizeAvailableModels(response.data, getCurrentModelSelection(this.host.getState().boot?.bridge))
    const currentTarget = this.host.getState().commandSurface.selectedTarget
    const selectedTarget =
      currentTarget?.kind === "model"
        ? currentTarget
        : availableModels[0]
          ? { kind: "model" as const, provider: availableModels[0].provider, modelId: availableModels[0].modelId }
          : currentTarget

    this.host.patchState({
      commandSurface: {
        ...this.host.getState().commandSurface,
        pendingAction: null,
        lastError: null,
        availableModels,
        selectedTarget: selectedTarget ?? null,
      },
    })

    return availableModels
  }

  applyModelSelection = async (provider: string, modelId: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "model", provider, modelId }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_model", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_model", provider, modelId },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_model",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const boot = this.host.getState().boot
    const nextBridge = boot?.bridge.sessionState
      ? {
          ...boot.bridge,
          sessionState: {
            ...boot.bridge.sessionState,
            model: response.data as WorkspaceModelRef,
          },
        }
      : null

    const nextAvailableModels = this.host.getState().commandSurface.availableModels.map((model) => ({
      ...model,
      isCurrent: model.provider === provider && model.modelId === modelId,
    }))

    this.host.patchState({
      ...(nextBridge && this.host.getState().boot ? { boot: cloneBootWithBridge(this.host.getState().boot, nextBridge) } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_model",
        success: true,
        message: `Model set to ${provider}/${modelId}`,
        selectedTarget,
        availableModels: nextAvailableModels,
      }),
    })

    return response
  }

  applyThinkingLevel = async (level: CommandSurfaceThinkingLevel): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "thinking", level }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_thinking_level", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_thinking_level", level },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_thinking_level",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const boot = this.host.getState().boot
    const nextBridge = boot?.bridge.sessionState
      ? {
          ...boot.bridge,
          sessionState: {
            ...boot.bridge.sessionState,
            thinkingLevel: level,
          },
        }
      : null

    this.host.patchState({
      ...(nextBridge && this.host.getState().boot ? { boot: cloneBootWithBridge(this.host.getState().boot, nextBridge) } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_thinking_level",
        success: true,
        message: `Thinking level set to ${level}`,
        selectedTarget,
      }),
    })

    return response
  }

  setSteeringModeFromSurface = async (
    mode: WorkspaceSessionState["steeringMode"],
  ): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.host.getState().commandSurface.selectedTarget
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_steering_mode", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_steering_mode", mode },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_steering_mode",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.host.getState().boot, { steeringMode: mode })
    this.host.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_steering_mode",
        success: true,
        message: `Steering mode set to ${mode}`,
        selectedTarget,
      }),
    })

    return response
  }

  setFollowUpModeFromSurface = async (
    mode: WorkspaceSessionState["followUpMode"],
  ): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.host.getState().commandSurface.selectedTarget
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_follow_up_mode", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_follow_up_mode", mode },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_follow_up_mode",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.host.getState().boot, { followUpMode: mode })
    this.host.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_follow_up_mode",
        success: true,
        message: `Follow-up mode set to ${mode}`,
        selectedTarget,
      }),
    })

    return response
  }

  setAutoCompactionFromSurface = async (enabled: boolean): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.host.getState().commandSurface.selectedTarget
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_auto_compaction", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_auto_compaction", enabled },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_auto_compaction",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.host.getState().boot, { autoCompactionEnabled: enabled })
    this.host.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_auto_compaction",
        success: true,
        message: `Auto-compaction ${enabled ? "enabled" : "disabled"}`,
        selectedTarget,
      }),
    })

    return response
  }

  setAutoRetryFromSurface = async (enabled: boolean): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.host.getState().commandSurface.selectedTarget
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "set_auto_retry", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "set_auto_retry", enabled },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "set_auto_retry",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    const nextBoot = patchBootSessionState(this.host.getState().boot, { autoRetryEnabled: enabled })
    this.host.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "set_auto_retry",
        success: true,
        message: `Auto-retry ${enabled ? "enabled" : "disabled"}`,
        selectedTarget,
      }),
    })

    return response
  }

  abortRetryFromSurface = async (): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget = this.host.getState().commandSurface.selectedTarget
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "abort_retry", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "abort_retry" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "abort_retry",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "abort_retry",
        success: true,
        message: "Retry cancellation requested. Live retry state will update when the bridge confirms the abort.",
        selectedTarget,
      }),
    })

    return response
  }

  switchSessionFromSurface = async (sessionPath: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "resume", sessionPath }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "switch_session", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "switch_session", sessionPath },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "switch_session",
          success: false,
          message,
          selectedTarget,
        }),
      })
      return response
    }

    if (response.data && typeof response.data === "object" && "cancelled" in response.data && response.data.cancelled) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "switch_session",
          success: false,
          message: "Session switch was cancelled before the browser changed sessions.",
          selectedTarget,
        }),
      })
      return response
    }

    const nextSessionName =
      this.host.getState().commandSurface.sessionBrowser.sessions.find((session) => session.path === sessionPath)?.name ??
      this.host.getState().boot?.resumableSessions.find((session) => session.path === sessionPath)?.name
    const nextBoot = patchBootActiveSession(this.host.getState().boot, sessionPath, nextSessionName)
    const nextSessionBrowser = syncSessionBrowserStateWithBridge(
      patchSessionBrowserSession(this.host.getState().commandSurface.sessionBrowser, sessionPath, {
        isActive: true,
        ...(nextSessionName ? { name: nextSessionName } : {}),
      }),
      nextBoot,
    )

    const nextLiveBase: WorkspaceLiveState = {
      ...this.host.getState().live,
      resumableSessions: withEntitySliceSucceeded(
        this.host.getState().live.resumableSessions,
        overlayLiveBridgeSessionState(
          resolveResumableSessions(this.host.getState()).map((session) => ({
            ...session,
            isActive: session.path === sessionPath,
            ...(session.path === sessionPath && nextSessionName ? { name: nextSessionName } : {}),
          })),
          nextBoot,
        ),
      ),
    }

    this.host.patchState({
      ...(nextBoot ? { boot: nextBoot } : {}),
      live: {
        ...nextLiveBase,
        recoverySummary: createWorkspaceRecoverySummary({ boot: nextBoot, live: nextLiveBase }),
      },
      commandSurface: applyCommandSurfaceActionResult(
        {
          ...this.host.getState().commandSurface,
          sessionBrowser: nextSessionBrowser,
        },
        {
          action: "switch_session",
          success: true,
          message: `Switched to ${describeSessionPath(sessionPath, nextBoot ?? this.host.getState().boot)}`,
          selectedTarget,
          sessionBrowser: nextSessionBrowser,
        },
      ),
    })

    return response
  }

  loadSessionStats = async (): Promise<CommandSurfaceSessionStats | null> => {
    const requestedLive: WorkspaceLiveState = {
      ...this.host.getState().live,
      freshness: {
        ...this.host.getState().live.freshness,
        sessionStats: withFreshnessRequested(this.host.getState().live.freshness.sessionStats),
      },
    }

    this.host.patchState({
      live: {
        ...requestedLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: requestedLive }),
      },
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "load_session_stats"),
    })

    const response = await this.host.sendCommand(
      { type: "get_session_stats" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      const failedLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          sessionStats: withFreshnessFailed(this.host.getState().live.freshness.sessionStats, message),
        },
      }
      this.host.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "load_session_stats",
          success: false,
          message: `Couldn't load session details — ${message}`,
          sessionStats: null,
        }),
      })
      return null
    }

    const sessionStats = normalizeSessionStats(response.data)
    if (!sessionStats) {
      const message = "Session details response was missing the expected fields."
      const failedLive: WorkspaceLiveState = {
        ...this.host.getState().live,
        freshness: {
          ...this.host.getState().live.freshness,
          sessionStats: withFreshnessFailed(this.host.getState().live.freshness.sessionStats, message),
        },
      }
      this.host.patchState({
        live: {
          ...failedLive,
          recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: failedLive }),
        },
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "load_session_stats",
          success: false,
          message,
          sessionStats: null,
        }),
      })
      return null
    }

    const nextLive: WorkspaceLiveState = {
      ...this.host.getState().live,
      freshness: {
        ...this.host.getState().live.freshness,
        sessionStats: withFreshnessSucceeded(this.host.getState().live.freshness.sessionStats),
      },
    }

    this.host.patchState({
      live: {
        ...nextLive,
        recoverySummary: createWorkspaceRecoverySummary({ boot: this.host.getState().boot, live: nextLive }),
      },
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "load_session_stats",
        success: true,
        message: `Loaded session details for ${sessionStats.sessionId}`,
        sessionStats,
      }),
    })

    return sessionStats
  }

  exportSessionFromSurface = async (outputPath?: string): Promise<WorkspaceCommandResponse | null> => {
    const normalizedOutputPath = outputPath?.trim() || undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "session", outputPath: normalizedOutputPath }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "export_html", selectedTarget),
    })

    const response = await this.host.sendCommand(
      normalizedOutputPath ? { type: "export_html", outputPath: normalizedOutputPath } : { type: "export_html" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "export_html",
          success: false,
          message: `Couldn't export this session — ${message}`,
          selectedTarget,
        }),
      })
      return response
    }

    const exportedPath =
      response.data && typeof response.data === "object" && "path" in response.data && typeof response.data.path === "string"
        ? response.data.path
        : "the generated file"

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "export_html",
        success: true,
        message: `Session exported to ${exportedPath}`,
        selectedTarget,
      }),
    })

    return response
  }

  loadForkMessages = async (): Promise<CommandSurfaceForkMessage[]> => {
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "load_fork_messages"),
    })

    const response = await this.host.sendCommand(
      { type: "get_fork_messages" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "load_fork_messages",
          success: false,
          message: `Couldn't load fork points — ${message}`,
          forkMessages: [],
        }),
      })
      return []
    }

    const forkMessages = normalizeForkMessages(response.data)
    const currentTarget = this.host.getState().commandSurface.selectedTarget
    const selectedTarget =
      currentTarget?.kind === "fork" && currentTarget.entryId
        ? currentTarget
        : forkMessages[0]
          ? { kind: "fork" as const, entryId: forkMessages[0].entryId }
          : currentTarget

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "load_fork_messages",
        success: true,
        message: forkMessages.length > 0 ? `Loaded ${forkMessages.length} fork points.` : "No fork points are available yet.",
        selectedTarget: selectedTarget ?? null,
        forkMessages,
      }),
    })

    return forkMessages
  }

  forkSessionFromSurface = async (entryId: string): Promise<WorkspaceCommandResponse | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "fork", entryId }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "fork_session", selectedTarget),
    })

    const response = await this.host.sendCommand(
      { type: "fork", entryId },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "fork_session",
          success: false,
          message: `Couldn't create a fork — ${message}`,
          selectedTarget,
        }),
      })
      return response
    }

    if (response.data && typeof response.data === "object" && "cancelled" in response.data && response.data.cancelled) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "fork_session",
          success: false,
          message: "Fork creation was cancelled before a new session was created.",
          selectedTarget,
        }),
      })
      return response
    }

    const sourceText =
      response.data && typeof response.data === "object" && "text" in response.data && typeof response.data.text === "string"
        ? response.data.text.trim()
        : ""

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "fork_session",
        success: true,
        message: sourceText ? `Forked from “${sourceText.slice(0, 120)}${sourceText.length > 120 ? "…" : ""}”` : "Created a forked session.",
        selectedTarget,
      }),
    })

    return response
  }

  compactSessionFromSurface = async (customInstructions?: string): Promise<WorkspaceCommandResponse | null> => {
    const normalizedInstructions = customInstructions?.trim() ?? ""
    const selectedTarget: CommandSurfaceTarget = { kind: "compact", customInstructions: normalizedInstructions }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "compact_session", selectedTarget),
    })

    const response = await this.host.sendCommand(
      normalizedInstructions ? { type: "compact", customInstructions: normalizedInstructions } : { type: "compact" },
      { appendInputLine: false, appendResponseLine: false },
    )

    if (!response || response.success === false) {
      const message = response?.error ?? this.host.getState().lastClientError ?? "Unknown error"
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "compact_session",
          success: false,
          message: `Couldn't compact the session — ${message}`,
          selectedTarget,
          lastCompaction: null,
        }),
      })
      return response
    }

    const compactionResult = normalizeCompactionResult(response.data)
    if (!compactionResult) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "compact_session",
          success: false,
          message: "Compaction finished but the browser could not read the compaction result.",
          selectedTarget,
          lastCompaction: null,
        }),
      })
      return response
    }

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "compact_session",
        success: true,
        message: `Compacted ${compactionResult.tokensBefore.toLocaleString()} tokens into a fresh summary${normalizedInstructions ? " with custom instructions" : ""}.`,
        selectedTarget,
        lastCompaction: compactionResult,
      }),
    })

    return response
  }

  saveApiKeyFromSurface = async (providerId: string, apiKey: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "manage" }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "save_api_key", selectedTarget),
    })

    const onboarding = await this.host.saveApiKey(providerId, apiKey)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "save_api_key",
          success: false,
          message: this.host.getState().lastClientError ?? `${providerLabel} setup failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.lastValidation?.status === "failed") {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "save_api_key",
          success: false,
          message: onboarding.lastValidation.message,
          selectedTarget,
        }),
      })
      return onboarding
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "save_api_key",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} credentials validated but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "save_api_key",
        success: true,
        message: `${providerLabel} credentials validated and saved.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  startProviderFlowFromSurface = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "start_provider_flow", selectedTarget),
    })

    const onboarding = await this.host.startProviderFlow(providerId)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "start_provider_flow",
          success: false,
          message: this.host.getState().lastClientError ?? `${providerLabel} sign-in failed to start`,
          selectedTarget,
        }),
      })
      return null
    }

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "start_provider_flow",
        success: true,
        message: `${providerLabel} sign-in started. Continue in the auth section.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  submitProviderFlowInputFromSurface = async (flowId: string, input: string): Promise<WorkspaceOnboardingState | null> => {
    const providerId = this.host.getState().boot?.onboarding.activeFlow?.providerId ?? undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "submit_provider_flow_input", selectedTarget),
    })

    const onboarding = await this.host.submitProviderFlowInput(flowId, input)
    const providerLabel =
      onboarding?.activeFlow?.providerLabel ??
      (providerId && onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId) ??
      "Provider"

    if (!onboarding) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: this.host.getState().lastClientError ?? `${providerLabel} sign-in failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.activeFlow?.status === "failed") {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: onboarding.activeFlow.error ?? `${providerLabel} sign-in failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "submit_provider_flow_input",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} sign-in completed but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    const successMessage =
      onboarding.activeFlow && ["running", "awaiting_browser_auth", "awaiting_input"].includes(onboarding.activeFlow.status)
        ? `${providerLabel} sign-in advanced. Complete the remaining step in this panel.`
        : `${providerLabel} sign-in complete.`

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "submit_provider_flow_input",
        success: true,
        message: successMessage,
        selectedTarget,
      }),
    })

    return onboarding
  }

  cancelProviderFlowFromSurface = async (flowId: string): Promise<WorkspaceOnboardingState | null> => {
    const providerId = this.host.getState().boot?.onboarding.activeFlow?.providerId ?? undefined
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "login" }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "cancel_provider_flow", selectedTarget),
    })

    const onboarding = await this.host.cancelProviderFlow(flowId)
    const providerLabel =
      onboarding?.activeFlow?.providerLabel ??
      (providerId && onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId) ??
      "Provider"

    if (!onboarding) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "cancel_provider_flow",
          success: false,
          message: this.host.getState().lastClientError ?? `${providerLabel} sign-in cancellation failed`,
          selectedTarget,
        }),
      })
      return null
    }

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "cancel_provider_flow",
        success: true,
        message: `${providerLabel} sign-in cancelled.`,
        selectedTarget,
      }),
    })

    return onboarding
  }

  logoutProviderFromSurface = async (providerId: string): Promise<WorkspaceOnboardingState | null> => {
    const selectedTarget: CommandSurfaceTarget = { kind: "auth", providerId, intent: "logout" }
    this.host.patchState({
      commandSurface: setCommandSurfacePending(this.host.getState().commandSurface, "logout_provider", selectedTarget),
    })

    const onboarding = await await this.host.logoutProvider(providerId)
    const providerLabel = onboarding ? findOnboardingProviderLabel(onboarding, providerId) : providerId

    if (!onboarding) {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "logout_provider",
          success: false,
          message: this.host.getState().lastClientError ?? `${providerLabel} logout failed`,
          selectedTarget,
        }),
      })
      return null
    }

    if (onboarding.bridgeAuthRefresh.phase === "failed") {
      this.host.patchState({
        commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
          action: "logout_provider",
          success: false,
          message: onboarding.bridgeAuthRefresh.error ?? `${providerLabel} logout completed but bridge auth refresh failed`,
          selectedTarget,
        }),
      })
      return onboarding
    }

    const providerState = onboarding.required.providers.find((provider) => provider.id === providerId)
    const resultMessage = providerState?.configured
      ? `${providerLabel} saved credentials were removed, but ${providerState.configuredVia} auth still keeps the provider available.`
      : onboarding.locked
        ? `${providerLabel} logged out — required setup is needed again.`
        : `${providerLabel} logged out.`

    this.host.patchState({
      commandSurface: applyCommandSurfaceActionResult(this.host.getState().commandSurface, {
        action: "logout_provider",
        success: true,
        message: resultMessage,
        selectedTarget,
      }),
    })

    return onboarding
  }
}

export function refreshOpenCommandSurfacesForInvalidation(host: CommandSurfaceHost, actions: CommandSurfaceStore, event: LiveStateInvalidationEvent): void {
    if (event.domains.includes("workspace") && host.getState().commandSurface.open && host.getState().commandSurface.section === "git") {
      if (host.getState().commandSurface.pendingAction !== "load_git_summary") {
        void actions.loadGitSummary()
      }
    }

    if (event.domains.includes("recovery") && host.getState().commandSurface.open && host.getState().commandSurface.section === "recovery") {
      if (host.getState().commandSurface.pendingAction !== "load_recovery_diagnostics") {
        void actions.loadRecoveryDiagnostics()
      }
    }

    if (event.domains.includes("resumable_sessions")) {
      if (
        host.getState().commandSurface.open &&
        (host.getState().commandSurface.section === "resume" || host.getState().commandSurface.section === "name") &&
        host.getState().commandSurface.pendingAction !== "load_session_browser"
      ) {
        void actions.loadSessionBrowser()
      }

      if (host.getState().commandSurface.open && host.getState().commandSurface.section === "session") {
        const activeSessionPath = host.getState().boot?.bridge.activeSessionFile ?? host.getState().boot?.bridge.sessionState?.sessionFile ?? null
        const commandSurface = host.getState().commandSurface
        const sessionStats = commandSurface.sessionStats
        host.patchState({
          commandSurface: {
            ...commandSurface,
            sessionStats:
              sessionStats && sessionStats.sessionFile === activeSessionPath
                ? sessionStats
                : null,
          },
        })
        if (host.getState().commandSurface.pendingAction !== "load_session_stats") {
          void actions.loadSessionStats()
        }
      }
    }
}
