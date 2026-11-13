import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../cmux-cua/extract_registry.py");

function run(root) {
  const r = spawnSync("python3", [script, root], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function fixture(macosRegs, groupRegs) {
  const root = mkdtempSync(join(tmpdir(), "cmux-cua-fixture-"));
  mkdirSync(join(root, "platform-macos/src/tools"), { recursive: true });
  mkdirSync(join(root, "cmux-cua-core/src"), { recursive: true });
  const modBody = macosRegs
    .map((t) => `    registry.register(Box::new(${t}));`)
    .join("\n");
  writeFileSync(
    join(root, "platform-macos/src/tools/mod.rs"),
    `pub fn register_all(registry: &mut ToolRegistry, compat: bool) {\n${modBody}\n    registry.register_recording_tools();\n    registry.register_session_tools();\n}\n`,
  );
  const groupBody = (name, n) =>
    `    pub fn ${name}(&mut self) {\n${Array.from({ length: n }, (_, i) => `        self.register(Box::new(T${i}));`).join("\n")}\n    }`;
  writeFileSync(
    join(root, "cmux-cua-core/src/tool.rs"),
    `impl R {\n${groupBody("register_recording_tools", groupRegs.recording)}\n${groupBody("register_session_tools", groupRegs.session)}\n}\n`,
  );
  return root;
}

describe("cmux-cua registry extractor (source-only)", () => {
  it("counts direct and grouped registrations from valid source", () => {
    const root = fixture(["A::X", "B::Y", "C::Z"], { recording: 5, session: 2 });
    try {
      const r = run(root);
      assert.equal(r.status, 0, r.err);
      const d = JSON.parse(r.out);
      assert.equal(d.direct_registrations_in_macos_register_all, 3);
      assert.equal(d.group_bodies.register_recording_tools, 5);
      assert.equal(d.group_bodies.register_session_tools, 2);
      assert.equal(d.total_registrations_static, 10);
      assert.equal(d.type_text_chars_registered, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when required source files are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "cmux-cua-empty-"));
    try {
      const r = run(root);
      assert.equal(r.status, 2);
      assert.equal(JSON.parse(r.out).error, "source files not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is deterministic: identical source yields identical output", () => {
    const root = fixture(["A::X", "B::Y"], { recording: 5, session: 2 });
    try {
      assert.equal(run(root).out, run(root).out);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not hard-code the historical expected count", () => {
    const root = fixture(["A::X"], { recording: 1, session: 1 });
    try {
      const d = JSON.parse(run(root).out);
      assert.equal(d.total_registrations_static, 3);
      assert.notEqual(d.total_registrations_static, 38);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("detects a registered type_text_chars by registration, not by literal name", () => {
    const root = fixture(["A::X", "type_text_chars::TypeTextCharsTool"], { recording: 1, session: 1 });
    try {
      const d = JSON.parse(run(root).out);
      assert.equal(d.type_text_chars_registered, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when a called helper body cannot be resolved (no silent zero)", () => {
    const root = fixture(["A::X"], { recording: 1, session: 1 });
    try {
      // rename the helper so the extractor cannot find its body
      const toolRs = join(root, "cmux-cua-core/src/tool.rs");
      writeFileSync(toolRs, readFileSync(toolRs, "utf8").replace("fn register_recording_tools", "fn renamed_recording"));
      const r = run(root);
      assert.notEqual(r.status, 0, "unresolved helper must not exit successfully");
      assert.match(JSON.parse(r.out).error, /unresolved/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
