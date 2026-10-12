// Project/App: gsd-pi
// File Purpose: Registers the auto-mode ScheduleWakeup continuation tool.

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { getAutoRuntimeSnapshot } from "../auto-runtime-state.js";
import { scheduleAutoWakeup } from "../auto/schedule-wakeup.js";
import { logWarning } from "../workflow-logger.js";
import { resolveCtxCwd } from "./dynamic-tools.js";

const MAX_WAKEUP_DELAY_SECONDS = 24 * 60 * 60;
const INTERACTIVE_WAKEUP_CUSTOM_TYPE = "gsd-schedule-wakeup";

/** GSD-owned name so Claude Code's native `ScheduleWakeup` does not collide (#1847). */
export const GSD_SCHEDULE_WAKEUP_TOOL_NAME = "gsd_schedule_wakeup";
export const CLAUDE_CODE_NATIVE_SCHEDULE_WAKEUP_TOOL_NAME = "ScheduleWakeup";

// One pending interactive wakeup per session, keyed by base path — the same
// scoping auto-mode uses for its wakeup map (see `wakeupKey`). Re-arming cancels
// only that session's prior timer, so repeated polling never stacks overlapping
// wakeups, and concurrent projects in one host process don't cancel each other.
const pendingInteractiveWakeups = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleInteractiveWakeup(
  pi: ExtensionAPI,
  key: string,
  delaySeconds: number,
  prompt: string,
  reason: string,
): void {
  const existing = pendingInteractiveWakeups.get(key);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    if (pendingInteractiveWakeups.get(key) === handle) {
      pendingInteractiveWakeups.delete(key);
    }
    try {
      void Promise.resolve(pi.sendMessage(
        {
          customType: INTERACTIVE_WAKEUP_CUSTOM_TYPE,
          content: prompt,
          display: true,
          details: { delaySeconds, reason },
        },
        { triggerTurn: true },
      )).catch((error) => {
        logWarning(
          "bootstrap",
          `${GSD_SCHEDULE_WAKEUP_TOOL_NAME} interactive dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      logWarning(
        "bootstrap",
        `${GSD_SCHEDULE_WAKEUP_TOOL_NAME} interactive dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, delaySeconds * 1000);
  pendingInteractiveWakeups.set(key, handle);
  if (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof handle.unref === "function"
  ) {
    handle.unref();
  }
}

export function _resetInteractiveWakeupsForTest(): void {
  for (const handle of pendingInteractiveWakeups.values()) {
    clearTimeout(handle);
  }
  pendingInteractiveWakeups.clear();
}

export function registerScheduleWakeupTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GSD_SCHEDULE_WAKEUP_TOOL_NAME,
    label: "Schedule Wakeup",
    description:
      "Schedule a delayed continuation turn. Non-blocking: the call returns immediately and does not wait or advance " +
      "elapsed time — never claim the requested delay has elapsed merely because scheduling returned. After scheduling, " +
      "finish the current turn instead of polling in the same turn. " +
      "In GSD auto-mode, after a completed unit turn (while auto-mode stays active and unpaused), the wakeup is consumed and " +
      "the unit continues once the full requested delay has elapsed from that point; one pending wakeup is kept per unit, " +
      "re-scheduling replaces it, and it is cleared if the unit ends without completing. " +
      "Outside auto-mode, the timer is armed immediately and a new turn starts with the supplied wakeup prompt when it fires; " +
      "one pending timer is kept per project, and re-scheduling cancels and replaces it. " +
      "Do not call Claude Code's native ScheduleWakeup tool.",
    promptSnippet: "Schedule a wakeup prompt after a delay.",
    promptGuidelines: [
      `Use ${GSD_SCHEDULE_WAKEUP_TOOL_NAME} at the end of an execute-task turn when waiting for a long external process.`,
      "Include a prompt that says exactly what external state to check next and what artifact to write when done.",
      `${GSD_SCHEDULE_WAKEUP_TOOL_NAME} is non-blocking: it returns immediately without advancing elapsed time. ` +
        "After scheduling, finish the current turn instead of polling in the same turn or reporting the delay as elapsed.",
      `Re-arm ${GSD_SCHEDULE_WAKEUP_TOOL_NAME} on each polling turn if the external process is still running; re-arming ` +
        "replaces the previous wakeup instead of queueing another (one pending wakeup per project outside auto-mode, one per unit in auto-mode).",
      `Outside auto-mode, use ${GSD_SCHEDULE_WAKEUP_TOOL_NAME} when the user asks you to check back or poll later.`,
      "Never call the native ScheduleWakeup tool; it is not GSD's continuation mechanism.",
    ],
    parameters: Type.Object({
      delaySeconds: Type.Number({
        minimum: 1,
        maximum: MAX_WAKEUP_DELAY_SECONDS,
        description:
          "Seconds before the continuation fires. Scheduling returns immediately; the call does not block for this delay.",
      }),
      prompt: Type.String({
        minLength: 1,
        description: "Prompt to send when the session wakes up.",
      }),
      reason: Type.Optional(Type.String({
        description: "Why this delay is appropriate.",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dash = getAutoRuntimeSnapshot();
      const currentUnit = dash.currentUnit;
      const delaySeconds = Math.max(
        1,
        Math.min(MAX_WAKEUP_DELAY_SECONDS, Math.floor(params.delaySeconds)),
      );
      const reason = params.reason ?? "";

      if (!dash.active || !currentUnit) {
        const interactiveKey = dash.basePath || resolveCtxCwd(ctx);
        scheduleInteractiveWakeup(pi, interactiveKey, delaySeconds, params.prompt, reason);
        return {
          content: [{
            type: "text",
            text: `Wakeup scheduled for ${delaySeconds}s. GSD will start a new turn with the wakeup prompt.`,
          }],
          details: { operation: "schedule_wakeup", delaySeconds, mode: "interactive" },
        };
      }

      const basePath = dash.basePath || resolveCtxCwd(ctx);
      scheduleAutoWakeup({
        basePath,
        unitType: currentUnit.type,
        unitId: currentUnit.id,
        delayMs: delaySeconds * 1000,
        prompt: params.prompt,
        reason,
        createdAt: Date.now(),
      });

      return {
        content: [{
          type: "text",
          text: `Wakeup scheduled for ${delaySeconds}s. Auto-mode will continue ${currentUnit.type} ${currentUnit.id} in the same session.`,
        }],
        details: {
          operation: "schedule_wakeup",
          delaySeconds,
          unitType: currentUnit.type,
          unitId: currentUnit.id,
        },
      };
    },
  });
}
