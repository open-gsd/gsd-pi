// Project/App: gsd-pi
// File Purpose: Best-effort dispatch ledger write helpers for auto-mode loop adapters.

interface DispatchLedgerWriteDeps {
  logWriteFailure: (err: unknown) => void;
}

interface DispatchLedgerFailDeps extends DispatchLedgerWriteDeps {
  markFailed: (dispatchId: number, details: { errorSummary: string; exitReason?: string }) => boolean;
}

interface DispatchLedgerCompleteDeps extends DispatchLedgerWriteDeps {
  markCompleted: (dispatchId: number) => boolean;
}

export function settleDispatchIfNeeded(
  alreadySettled: boolean,
  settle: () => boolean,
): boolean {
  return alreadySettled || settle();
}

export function settleDispatchFailed(
  dispatchId: number | null,
  errorSummary: string,
  deps: DispatchLedgerFailDeps,
  exitReason?: string,
): boolean {
  if (dispatchId === null) return false;

  try {
    return deps.markFailed(dispatchId, { errorSummary, ...(exitReason ? { exitReason } : {}) });
  } catch (err) {
    deps.logWriteFailure(err);
    return false;
  }
}

export function settleDispatchCompleted(
  dispatchId: number | null,
  deps: DispatchLedgerCompleteDeps,
): boolean {
  if (dispatchId === null) return false;

  try {
    return deps.markCompleted(dispatchId);
  } catch (err) {
    deps.logWriteFailure(err);
    return false;
  }
}
