import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GsdCli, isGsdProject, SUPPORTED_INTEGRATION_VERSION } from "./gsd-cli.js";
import type { ExecFn } from "./gsd-cli.js";

const PROGRESS = {
  activeMilestone: { id: "M001", title: "Hermes Integration" },
  activeSlice: { id: "S01", title: "Gateway MVP" },
  activeTask: { id: "T01", title: "Plugin scaffold" },
  phase: "execute",
  milestones: { total: 1, done: 0, active: 1, pending: 0, parked: 0 },
  slices: { total: 1, done: 0, active: 1, pending: 0 },
  tasks: { total: 1, done: 0, pending: 1 },
  requirements: { active: 2, validated: 0, deferred: 0, outOfScope: 0 },
  blockers: [],
  nextAction: "Run contract tests",
};

function fakeExec(stdout: string, stderr = ""): ExecFn {
  return async () => ({ stdout, stderr });
}

describe("GsdCli.readProgress", () => {
  it("passes the read seam arguments and returns the envelope data", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify({ integration_version: 1, kind: "progress", projectDir: "/p", data: PROGRESS }), stderr: "" };
    };
    const cli = new GsdCli("/opt/gsd", exec);
    const data = await cli.readProgress("/p");
    assert.deepEqual(calls, [{ file: "/opt/gsd", args: ["read", "progress", "--json", "--project", "/p"] }]);
    assert.equal(data.activeMilestone?.id, "M001");
    assert.equal(data.phase, "execute");
  });

  it("refuses an envelope version it does not understand", async () => {
    const cli = new GsdCli("gsd", fakeExec(JSON.stringify({ integration_version: SUPPORTED_INTEGRATION_VERSION + 1, data: PROGRESS })));
    await assert.rejects(() => cli.readProgress("/p"), /unsupported gsd read envelope version 2/);
  });

  it("reports non-JSON stdout instead of throwing a parse error", async () => {
    const cli = new GsdCli("gsd", fakeExec("not json"));
    await assert.rejects(() => cli.readProgress("/p"), /non-JSON output/);
  });

  it("surfaces exec failures with their message", async () => {
    const exec: ExecFn = async () => {
      throw new Error("gsd CLI not found at \"gsd\"; set plugins.entries.open-gsd-openclaw.config.cliPath");
    };
    const cli = new GsdCli("gsd", exec);
    await assert.rejects(() => cli.readProgress("/p"), /cliPath/);
  });
});

describe("isGsdProject", () => {
  it("recognises .gsd and .planning directories only", () => {
    const root = mkdtempSync(join(tmpdir(), "open-gsd-openclaw-"));
    try {
      assert.equal(isGsdProject(root), false);
      mkdirSync(join(root, "a", ".gsd"), { recursive: true });
      mkdirSync(join(root, "b", ".planning"), { recursive: true });
      mkdirSync(join(root, "c"), { recursive: true });
      assert.equal(isGsdProject(join(root, "a")), true);
      assert.equal(isGsdProject(join(root, "b")), true);
      assert.equal(isGsdProject(join(root, "c")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
