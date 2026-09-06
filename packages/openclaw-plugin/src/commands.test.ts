import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindStore } from "./binding.js";
import { HELP_TEXT, createGsdCommand, handleGsdCommand, tokenize, type ServiceState } from "./commands.js";
import { GsdCli, type ExecFn } from "./gsd-cli.js";
import { PLUGIN_ID, register } from "./plugin.js";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition, OpenClawPluginServiceContext, PluginCommandContext } from "./types.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const PROGRESS_ENVELOPE = JSON.stringify({
  integration_version: 1,
  kind: "progress",
  projectDir: "/p",
  data: {
    activeMilestone: { id: "M001", title: "Hermes Integration" },
    activeSlice: { id: "S01", title: "Gateway MVP" },
    activeTask: { id: "T01", title: "Plugin scaffold" },
    phase: "execute",
    milestones: { total: 1, done: 0, active: 1 },
    slices: { total: 1, done: 0 },
    tasks: { total: 1, done: 0 },
    requirements: { active: 2, validated: 0 },
    blockers: [],
    nextAction: "Run contract tests",
  },
});

function ctx(overrides: Partial<PluginCommandContext> = {}): PluginCommandContext {
  return { channel: "telegram", to: "-100123", isAuthorizedSender: true, commandBody: "/gsd", ...overrides };
}

async function withProject<T>(fn: (root: string, project: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "open-gsd-openclaw-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".gsd"), { recursive: true });
  try {
    return await fn(root, project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Minimal stub of the OpenClaw plugin API that records registrations (kitchen-sink harness pattern). */
function stubApi(pluginConfig: Record<string, unknown> = {}) {
  const commands: OpenClawPluginCommandDefinition[] = [];
  const services: Array<{ id: string; start: (c: OpenClawPluginServiceContext) => void | Promise<void>; stop?: (c: OpenClawPluginServiceContext) => void | Promise<void> }> = [];
  const api: OpenClawPluginApi = {
    id: PLUGIN_ID,
    name: "Open GSD",
    pluginConfig,
    logger: silentLogger,
    registrationMode: "full",
    registerCommand: (definition) => void commands.push(definition),
    registerService: (service) => void services.push(service),
  };
  return { api, commands, services };
}

describe("tokenize", () => {
  it("splits on whitespace and honours quotes", () => {
    assert.deepEqual(tokenize('bind "/Users/me/my app" extra'), ["bind", "/Users/me/my app", "extra"]);
    assert.deepEqual(tokenize("  status  "), ["status"]);
    assert.deepEqual(tokenize(undefined), []);
  });
});

describe("createGsdCommand", () => {
  it("delegates authorization to the host via requireAuth and operator.write", () => {
    const definition = createGsdCommand({ config: { cliPath: "gsd" }, logger: silentLogger, getService: () => null });
    assert.equal(definition.name, "gsd");
    assert.equal(definition.acceptsArgs, true);
    assert.equal(definition.requireAuth, true);
    assert.deepEqual(definition.requiredScopes, ["operator.write"]);
  });
});

describe("register", () => {
  it("registers the /gsd command and one service whose start wires the bind store", async () => {
    await withProject(async (root, project) => {
      const { api, commands, services } = stubApi({ defaultProject: project });
      register(api);
      assert.deepEqual(commands.map((c) => c.name), ["gsd"]);
      assert.deepEqual(services.map((s) => s.id), [PLUGIN_ID]);

      // Before the service starts, commands answer with a not-ready message instead of failing.
      const early = await commands[0].handler(ctx({ args: "status" }));
      assert.match(early.text ?? "", /has not started/);

      await services[0].start({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
      const bound = await commands[0].handler(ctx({ args: `bind ${project}` }));
      assert.match(bound.text ?? "", /Bound this conversation/);
      const unbound = await commands[0].handler(ctx({ args: "unbind" }));
      assert.equal(unbound.text, "Binding removed.");
      await services[0].stop?.({ config: {}, stateDir: join(root, "state"), logger: silentLogger });
    });
  });
});

describe("handleGsdCommand", () => {
  function deps(service: ServiceState | null, defaultProject?: string) {
    return { config: { cliPath: "gsd", defaultProject }, logger: silentLogger, getService: () => service };
  }

  function service(root: string, exec: ExecFn): ServiceState {
    return { bindStore: new BindStore(join(root, "bindings.json")), cli: new GsdCli("gsd", exec) };
  }

  it("prints help for no subcommand and for unknown subcommands", async () => {
    assert.equal((await handleGsdCommand(deps(null), ctx())).text, HELP_TEXT);
    assert.match((await handleGsdCommand(deps(null), ctx({ args: "frobnicate" }))).text ?? "", /Unknown subcommand `frobnicate`/);
  });

  it("status fails closed with guidance when nothing is bound", async () => {
    await withProject(async (root) => {
      const result = await handleGsdCommand(deps(service(root, async () => ({ stdout: PROGRESS_ENVELOPE, stderr: "" }))), ctx({ args: "status" }));
      assert.match(result.text ?? "", /No GSD project bound/);
    });
  });

  it("status renders the snapshot for the bound project", async () => {
    await withProject(async (root, project) => {
      const seen: string[][] = [];
      const svc = service(root, async (_file, args) => {
        seen.push(args);
        return { stdout: PROGRESS_ENVELOPE, stderr: "" };
      });
      await handleGsdCommand(deps(svc), ctx({ args: `bind ${project}` }));
      const result = await handleGsdCommand(deps(svc), ctx({ args: "status" }));
      assert.deepEqual(seen, [["read", "progress", "--json", "--project", project]]);
      assert.match(result.text ?? "", /Active milestone: M001: Hermes Integration/);
      assert.match(result.text ?? "", /Project: `/);
    });
  });

  it("status uses defaultProject when the conversation is unbound and an explicit path when given", async () => {
    await withProject(async (root, project) => {
      const seen: string[][] = [];
      const svc = service(root, async (_file, args) => {
        seen.push(args);
        return { stdout: PROGRESS_ENVELOPE, stderr: "" };
      });
      await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      await handleGsdCommand(deps(svc), ctx({ args: `status ${project}` }));
      assert.equal(seen.length, 2);
      assert.equal(seen[0][4], project);
      assert.equal(seen[1][4], project);
    });
  });

  it("status reports read failures without leaking a stack", async () => {
    await withProject(async (root, project) => {
      const svc = service(root, async () => {
        throw new Error("unsupported gsd read envelope version 2 (expected 1)");
      });
      const result = await handleGsdCommand(deps(svc, project), ctx({ args: "status" }));
      assert.equal(result.text, "GSD status unavailable: unsupported gsd read envelope version 2 (expected 1)");
    });
  });

  it("bind validates the path and keys the binding by conversation route", async () => {
    await withProject(async (root, project) => {
      const svc = service(root, async () => ({ stdout: PROGRESS_ENVELOPE, stderr: "" }));
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "bind" }))).text ?? "", /Usage/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "bind relative" }))).text ?? "", /must be absolute/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: `bind ${root}` }))).text ?? "", /not a GSD project/);
      await handleGsdCommand(deps(svc), ctx({ args: `bind ${project}` }));
      assert.equal(svc.bindStore.get("telegram||-100123|"), project);
      // A different conversation on the same channel sees no binding.
      assert.match((await handleGsdCommand(deps(svc), ctx({ to: "-100999", args: "status" }))).text ?? "", /No GSD project bound/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "unbind" }))).text ?? "", /Binding removed/);
      assert.match((await handleGsdCommand(deps(svc), ctx({ args: "unbind" }))).text ?? "", /has no binding/);
    });
  });
});
