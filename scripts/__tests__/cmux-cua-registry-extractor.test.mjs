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
  it("fails (no valid zero) when register_all has no recognisable registrations", () => {
    const root = mkdtempSync(join(tmpdir(), "cmux-cua-unrec-"));
    try {
      mkdirSync(join(root, "platform-macos/src/tools"), { recursive: true });
      mkdirSync(join(root, "cmux-cua-core/src"), { recursive: true });
      writeFileSync(join(root, "platform-macos/src/tools/mod.rs"), "pub fn register_all(registry: &mut R, compat: bool) {\n    let _ = compat;\n}\n");
      writeFileSync(join(root, "cmux-cua-core/src/tool.rs"), "impl R {}\n");
      const r = run(root);
      assert.notEqual(r.status, 0, "unrecognised source must not exit 0 with a zero total");
      assert.match(JSON.parse(r.out).error, /no direct registrations|register_all body not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores commented-out registrations", () => {
    const root = fixture(["A::X"], { recording: 1, session: 1 });
    try {
      const modPath = join(root, "platform-macos/src/tools/mod.rs");
      writeFileSync(modPath, readFileSync(modPath, "utf8").replace("    registry.register(Box::new(A::X));", "    // registry.register(Box::new(A::X));"));
      const r = run(root);
      assert.notEqual(r.status, 0, "a commented-out only register_all must fail closed");
      assert.match(JSON.parse(r.out).error, /no direct registrations/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not count a type_text_chars type reference as a registration", () => {
    const root = fixture(["A::X", "let_ref::Ignore"], { recording: 1, session: 1 });
    try {
      const modPath = join(root, "platform-macos/src/tools/mod.rs");
      writeFileSync(modPath, readFileSync(modPath, "utf8").replace("    registry.register_recording_tools();", "    let _: &type_text_chars::TypeTextCharsTool = &type_text_chars::TypeTextCharsTool::new(s);\n    registry.register_recording_tools();"));
      const d = JSON.parse(run(root).out);
      assert.equal(d.type_text_chars_registered, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not count a registration that appears only inside a string literal", () => {
    const root = fixture(["A::X"], { recording: 1, session: 1 });
    try {
      const modPath = join(root, "platform-macos/src/tools/mod.rs");
      writeFileSync(modPath, readFileSync(modPath, "utf8").replace(
        "    registry.register_recording_tools();",
        '    let _s = "registry.register(Box::new(type_text_chars::T))";\n    registry.register_recording_tools();'));
      const d = JSON.parse(run(root).out);
      assert.equal(d.type_text_chars_registered, false);
      assert.equal(d.direct_registrations_in_macos_register_all, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
