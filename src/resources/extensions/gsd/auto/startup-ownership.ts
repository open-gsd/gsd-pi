// Invocation-local ownership for asynchronous bootstrap/guided-entry descendants.
// The predicate reads AutoSession's actual startup token; this context grants no authority.
import { AsyncLocalStorage } from "node:async_hooks";
import { logWarning } from "../workflow-logger.js";

type StartupScope = { isCurrent: () => boolean; cleanups: Set<() => void>; dispatched: boolean; isCancelled: () => boolean };
const ownership = new AsyncLocalStorage<StartupScope>();
const unrestricted = () => true;

export function captureAutoStartupOwnership(): () => boolean {
  return ownership.getStore()?.isCurrent ?? unrestricted;
}

export function captureAutoStartupCancellation(): () => boolean {
  return ownership.getStore()?.isCancelled ?? (() => false);
}

export function noteAutoStartupDispatch(): void {
  const scope = ownership.getStore();
  if (scope?.isCurrent()) scope.dispatched = true;
}

export function onAutoStartupCancelled(cleanup: () => void): void {
  const scope = ownership.getStore();
  if (!scope) return;
  if (!scope.isCurrent()) { cleanup(); return; }
  scope.cleanups.add(cleanup);
}

export function createAutoStartupOwnership(isCurrent: () => boolean, isCancelled: () => boolean = () => !isCurrent()) {
  const scope: StartupScope = { isCurrent, isCancelled, cleanups: new Set(), dispatched: false };
  const cancel = () => {
    const cleanups = [...scope.cleanups];
    scope.cleanups.clear();
    for (const cleanup of cleanups) {
      try { cleanup(); }
      catch { logWarning("engine", "Could not clear an owned cancelled startup handoff"); }
    }
  };
  return {
    cancel,
    run<T>(action: () => Promise<T>): Promise<T> {
      return ownership.run(scope, async () => {
        try { return await action(); }
        catch (error) { cancel(); throw error; }
        finally {
          if (!isCurrent() || !scope.dispatched) cancel();
          scope.cleanups.clear();
        }
      });
    },
  };
}
