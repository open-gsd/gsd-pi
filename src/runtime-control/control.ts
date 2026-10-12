// Project/App: gsd-pi
// File Purpose: Daemon runtime-control singleton. Reconstruct from the same state root to simulate restart.

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

import { gsdHome } from "../resources/extensions/gsd/gsd-home.ts";
import { registerRequiredPolicy, getRegisteredRequiredPolicy, type RequiredPolicy } from "../resources/extensions/gsd/required-policy.ts";
import { JobCatalog } from "./job-catalog.ts";
import { ModelLease } from "./model-lease.ts";
import { OperationStore } from "./operation-store.ts";
import { RegistrationRegistry } from "./registration.ts";
import { runtimeUnavailable } from "./errors.ts";
import { configureRecoveryStore, getRecovery, issueRecoveryId } from "./recovery.ts";
import { publishOperationUpdated, publishSnapshotInvalidated } from "./event-hub.ts";
import type { CrashHook, JobRecord, RegistrationFile } from "./types.ts";

export type RuntimeControlOptions = {
  stateRoot: string;
  registrationPath?: string;
  registration?: RegistrationFile;
  clock?: () => Date;
  loadEnv?: boolean;
};

export class RuntimeControl {
  readonly registration: RegistrationRegistry;
  readonly jobs: JobCatalog;
  readonly store: OperationStore;
  readonly lease: ModelLease;
  readonly clock: () => Date;
  readonly stateRoot: string;

  constructor(options: RuntimeControlOptions) {
    this.stateRoot = options.stateRoot;
    mkdirSync(join(options.stateRoot, "runtime-control"), { recursive: true });
    this.lease = new ModelLease(options.stateRoot);
    this.registration = new RegistrationRegistry(() => this.lease.admissionGate());
    if (this.lease.ownershipUnknown()) {
      throw runtimeUnavailable("Lease file is unreadable; previous ownership is unknown");
    }
    this.jobs = new JobCatalog(options.stateRoot);
    this.store = new OperationStore(options.stateRoot);
    this.clock = options.clock ?? (() => new Date());
    this.store.onChange((stored) => {
      const jobId = stored.operation.job_id;
      const job = jobId ? this.jobs.get(jobId) : undefined;
      publishOperationUpdated(this, job?.project_id ?? "unknown", { operation: stored.operation }, {
        job_id: jobId,
        operation_id: stored.operation.operation_id,
        revision: job?.revision ?? 0,
        authority_epoch: job?.authority_epoch ?? 1,
      });
    });
    this.jobs.onRevisionBump((job) => {
      publishSnapshotInvalidated(this, job.project_id, job.job_id, job.revision, job.authority_epoch);
    });
    configureRecoveryStore(options.stateRoot);
    const recovered = this.store.reconcile();
    for (const operationId of recovered.recoveryRequired) {
      this.lease.retainForRecovery(operationId);
      const stored = this.store.read(operationId);
      if (!stored) continue;
      const existingId = stored.operation.result && typeof stored.operation.result.recovery_id === "string"
        ? stored.operation.result.recovery_id
        : null;
      if (existingId) continue;
      const recovery = issueRecoveryId({
        operation_id: operationId,
        job_id: stored.operation.job_id,
        reason: stored.operation.error?.message ?? "Dispatch was interrupted",
        issued_at: (this.clock() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
        next_state: "recovery_required",
      });
      stored.operation.result = { ...(stored.operation.result ?? {}), recovery_id: recovery.recovery_id };
      this.store.update(stored);
    }
    // A prior recover may have applied the diagnostic while an earlier failed
    // recover op stayed LIVE as recovery_required. Clear those orphans when the
    // recovery_id is already applied and this process does not hold their lease.
    const held = this.lease.current();
    for (const stored of this.store.list()) {
      if (stored.operation.state !== "recovery_required") continue;
      if (held && held.operation_id === stored.operation.operation_id) continue;
      const recoveryId = stored.operation.result && typeof stored.operation.result.recovery_id === "string"
        ? stored.operation.result.recovery_id
        : null;
      if (!recoveryId) continue;
      const diagnostic = getRecovery(recoveryId);
      if (!diagnostic?.applied) continue;
      const clearedAt = (this.clock() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
      stored.operation.state = "cancelled";
      stored.operation.updated_at = clearedAt;
      stored.operation.error = null;
      stored.operation.result = {
        ...(stored.operation.result ?? {}),
        reconciled: true,
        idle_confirmed: true,
        recovery_id: recoveryId,
      };
      this.store.update(stored);
    }
    if (options.registration) {
      this.registration.loadFromObject(options.registration, options.registrationPath ?? "<memory>");
    } else if (options.registrationPath) {
      this.registration.loadFromPath(options.registrationPath);
    } else if (options.loadEnv !== false) {
      this.registration.loadFromEnv();
    }
  }

  seedJob(job: JobRecord): JobRecord {
    return this.jobs.seed(job);
  }

  setCrashHookForTest(hook: CrashHook): void {
    this.store.setCrashHookForTest(hook);
  }

  static createForTest(options: Omit<RuntimeControlOptions, "loadEnv">): RuntimeControl {
    return new RuntimeControl({ ...options, loadEnv: false });
  }

  static reopen(stateRoot: string, options: Omit<RuntimeControlOptions, "stateRoot"> = {}): RuntimeControl {
    return new RuntimeControl({ stateRoot, loadEnv: false, ...options });
  }
}

let daemon: RuntimeControl | null = null;
let policyModuleLoad: Promise<void> | null = null;
let policyModuleError: string | null = null;

export const REQUIRED_POLICY_MODULE_ENV = "GSD_REQUIRED_POLICY_MODULE";

export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GSD_STATE_DIR && env.GSD_STATE_DIR.trim()) return env.GSD_STATE_DIR.trim();
  return gsdHome();
}

export function requiredPolicyModuleError(): string | null {
  return policyModuleError;
}

function asRequiredPolicy(value: unknown): RequiredPolicy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<RequiredPolicy>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.version !== "string" || !record.version.trim()) return null;
  if (typeof record.selfCheck !== "function") return null;
  if (typeof record.validatePlan !== "function") return null;
  if (typeof record.verifyTask !== "function") return null;
  return record as RequiredPolicy;
}

export async function loadRequiredPolicyModule(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const spec = env[REQUIRED_POLICY_MODULE_ENV]?.trim();
  if (!spec) {
    return;
  }
  const resolved = isAbsolute(spec) ? spec : resolve(spec);
  if (!existsSync(resolved)) {
    policyModuleError = `${REQUIRED_POLICY_MODULE_ENV} file is missing: ${resolved}`;
    return;
  }
  try {
    const loaded = await import(/* webpackIgnore: true */ pathToFileURL(resolved).href) as {
      default?: unknown;
      policy?: unknown;
      createPolicy?: () => unknown;
    };
    const candidate = loaded.default ?? loaded.policy ?? loaded.createPolicy?.();
    const policy = asRequiredPolicy(candidate);
    if (!policy) {
      policyModuleError = `${REQUIRED_POLICY_MODULE_ENV} did not export a RequiredPolicy`;
      return;
    }
    registerRequiredPolicy(policy);
  } catch (error) {
    if (getRegisteredRequiredPolicy("ftm-science/v1") || getRegisteredRequiredPolicy("test-policy/v1")) {
      return;
    }
    policyModuleError = `${REQUIRED_POLICY_MODULE_ENV} failed to load: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function ensureRuntimeControl(): Promise<RuntimeControl> {
  if (daemon) return daemon;
  if (!policyModuleLoad) {
    policyModuleLoad = loadRequiredPolicyModule();
  }
  await policyModuleLoad;
  return getRuntimeControl();
}

export function getRuntimeControl(): RuntimeControl {
  if (!daemon) {
    daemon = new RuntimeControl({ stateRoot: resolveStateRoot(), loadEnv: true });
  }
  return daemon;
}

export function setRuntimeControlForTest(control: RuntimeControl | null): void {
  daemon = control;
}

export function resetRuntimeControlForTest(): void {
  daemon = null;
  policyModuleLoad = null;
  policyModuleError = null;
}
