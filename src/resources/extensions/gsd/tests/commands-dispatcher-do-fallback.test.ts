// Project/App: gsd-pi
// File Purpose: Dispatcher regression tests for the /gsd do natural-language fallback (#2784).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { handleGSDCommand } from "../commands/dispatcher.ts";
import { closeDatabase } from "../gsd-db.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

interface NotifyCall {
  message: string;
  kind: string;
}

// The loop never yields to timers, so a test timeout cannot stop it. Throwing
// from notify after a bounded number of re-dispatches breaks it instead.
const MAX_REDISPATCHES = 5;

function makeMockCtx(base: string): { ctx: any; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  let redispatches = 0;
  return {
    ctx: {
      cwd: base,
      ui: {
        notify: (message: string, kind: string) => {
          calls.push({ message, kind });
          if (message.startsWith("→ /gsd ") && ++redispatches > MAX_REDISPATCHES) {
            throw new Error(`re-dispatch loop: ${message}`);
          }
        },
        setWidget: () => {},
        setStatus: () => {},
      },
    },
    calls,
  };
}

function withBase(run: (base: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const base = makeTempRepo(`gsd-dispatch-do-${randomUUID()}-`);
    mkdirSync(join(base, ".gsd"), { recursive: true });
    try {
      await run(base);
    } finally {
      closeDatabase();
      cleanup(base);
    }
  };
}

for (const command of ["status d", "do status d", "pause later now"]) {
  test(`/gsd ${command} reports unknown instead of re-dispatching forever`, withBase(async (base) => {
    const { ctx, calls } = makeMockCtx(base);

    await handleGSDCommand(command, ctx, { sendMessage: () => {} } as any);

    const redispatches = calls.filter((call) => call.message.startsWith("→ /gsd "));
    assert.equal(redispatches.length, 1, JSON.stringify(calls));
    const unknown = calls.at(-1);
    assert.equal(unknown?.kind, "warning");
    assert.match(unknown?.message ?? "", /^Unknown: \/gsd /);
  }));
}
