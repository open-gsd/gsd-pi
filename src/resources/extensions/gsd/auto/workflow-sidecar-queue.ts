// Project/App: gsd-pi
// File Purpose: Sidecar queue scheduling and dequeue adapter for auto-mode loop.

import type { SidecarItem } from "./session.js";

export interface SidecarDequeuePayload extends Record<string, unknown> {
  kind: SidecarItem["kind"];
  unitType: string;
  unitId: string;
}

export interface DequeueSidecarItemInput<T extends SidecarItem> {
  queue: T[];
  executionGraphEnabled: boolean;
  scheduleQueue: (queue: T[]) => Promise<T[]>;
  warnSchedulingFailure: (message: string) => void;
  logDequeue: (payload: SidecarDequeuePayload) => void;
  emitDequeue: (payload: SidecarDequeuePayload) => void;
}

export async function dequeueSidecarItem<T extends SidecarItem>(
  input: DequeueSidecarItemInput<T>,
): Promise<T | undefined> {
  if (input.queue.length === 0) return undefined;

  if (input.executionGraphEnabled && input.queue.length > 1) {
    try {
      const scheduledQueue = await input.scheduleQueue(input.queue);
      input.queue.splice(0, input.queue.length, ...scheduledQueue);
    } catch (err) {
      input.warnSchedulingFailure(err instanceof Error ? err.message : String(err));
    }
  }

  const sidecarItem = input.queue.shift();
  if (!sidecarItem) return undefined;

  const payload = {
    kind: sidecarItem.kind,
    unitType: sidecarItem.unitType,
    unitId: sidecarItem.unitId,
  };
  input.logDequeue(payload);
  input.emitDequeue(payload);
  return sidecarItem;
}
