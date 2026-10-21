// Project/App: gsd-pi
// File Purpose: Auto-mode ScheduleWakeup state shared between the tool and runUnit.

export interface ScheduledWakeup {
  basePath: string;
  unitType: string;
  unitId: string;
  delayMs: number;
  prompt: string;
  reason: string;
  createdAt: number;
}

function wakeupKey(basePath: string, unitType: string, unitId: string): string {
  return `${basePath}\0${unitType}\0${unitId}`;
}

const pendingWakeups = new Map<string, ScheduledWakeup>();

export function scheduleAutoWakeup(wakeup: ScheduledWakeup): void {
  pendingWakeups.set(
    wakeupKey(wakeup.basePath, wakeup.unitType, wakeup.unitId),
    wakeup,
  );
}

export function consumeAutoWakeup(
  basePath: string,
  unitType: string,
  unitId: string,
): ScheduledWakeup | null {
  const key = wakeupKey(basePath, unitType, unitId);
  const wakeup = pendingWakeups.get(key) ?? null;
  pendingWakeups.delete(key);
  return wakeup;
}

export function clearAutoWakeup(
  basePath: string,
  unitType: string,
  unitId: string,
): void {
  pendingWakeups.delete(wakeupKey(basePath, unitType, unitId));
}

export function _resetAutoWakeupsForTest(): void {
  pendingWakeups.clear();
}
