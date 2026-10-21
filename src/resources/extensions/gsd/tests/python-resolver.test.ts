import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Regression tests for #4416: python invocation normalization for Windows.
// These tests import from python-resolver.ts which is created as part of the fix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { normalizePythonCommand, detectPythonExecutable, resolveVenvInterpreter, normalizeVerifyCommandForVenv, venvPythonCandidates } from "../python-resolver.ts";
import { discoverCommands, runVerificationGate } from "../verification-gate.ts";

describe("normalizePythonCommand", () => {
  test("passes through command that does not start with python", () => {
    assert.equal(normalizePythonCommand("npm run test"), "npm run test");
  });

  test("passes through empty string", () => {
    assert.equal(normalizePythonCommand(""), "");
  });

  test("passes through non-python shell commands unchanged", () => {
    assert.equal(normalizePythonCommand("node index.js"), "node index.js");
    assert.equal(normalizePythonCommand("npx tsc --noEmit"), "npx tsc --noEmit");
  });

  test("passes through command unchanged when no python is detected", () => {
    // We cannot fully mock detectPythonExecutable here without a mock framework,
    // but we can verify that a command without python tokens is always preserved.
    const cmd = "cargo test";
    assert.equal(normalizePythonCommand(cmd), cmd);
  });

  test("rewrites leading python3 token when interpreter is detected", () => {
    const input = "python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`,
    );
    assert.ok(result.includes("-m pytest"), `Expected arguments preserved in: ${result}`);
  });

  test("rewrites leading python token when interpreter is detected", () => {
    const input = "python manage.py migrate";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`,
    );
    assert.ok(result.includes("manage.py migrate"), `Expected arguments preserved in: ${result}`);
  });

  test("rewrites python token after && compound separator", () => {
    const input = "echo ok && python3 -m pytest --tb=short";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.includes(`&& ${detected} `),
      `Expected '&& ${detected} ' segment in: ${result}`,
    );
    assert.ok(
      result.includes("-m pytest --tb=short"),
      `Expected arguments preserved in: ${result}`,
    );
  });

  test("rewrites leading python token when command has leading whitespace", () => {
    const input = "  python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `  ${detected} -m pytest`,
      `Expected leading whitespace preserved and python3 rewritten in: ${result}`,
    );
  });

  test("does not duplicate '-3' when rewriting existing 'py -3' token", () => {
    const input = "py -3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `${detected} -m pytest`,
      `Expected clean rewrite without duplicated '-3' in: ${result}`,
    );
  });
});

describe("detectPythonExecutable", () => {
  test("returns a string or null — never throws", () => {
    let result: string | null | undefined;
    assert.doesNotThrow(() => {
      result = detectPythonExecutable();
    });
    assert.ok(result === null || typeof result === "string");
  });

  test("return value is a known python invocation form, venv path, or null", () => {
    const result = detectPythonExecutable();
    const valid = [null, "python3", "python", "py -3"];
    const isVenvPath = typeof result === "string" && /(?:[\\/](?:bin|Scripts)[\\/]python(?:3)?(?:\.exe)?)$/.test(result);
    assert.ok(
      valid.includes(result as string | null) || isVenvPath,
      `Expected a system form, venv path, or null, got: ${String(result)}`,
    );
  });

  test("returns the same value on repeated calls (cached)", () => {
    const first = detectPythonExecutable();
    const second = detectPythonExecutable();
    assert.equal(first, second, "detectPythonExecutable must return consistent cached result");
  });
});

describe("venv awareness (#1700 / #1784)", () => {
  function makeProject(layout: "posix" | "win32"): { dir: string; python: string } {
    const dir = mkdtempSync(join(tmpdir(), "gsd-venv-"));
    const platform = layout === "win32" ? "win32" : "linux";
    const python = venvPythonCandidates(join(dir, ".venv"), platform)[0];
    mkdirSync(join(python, ".."), { recursive: true });
    writeFileSync(python, "");
    return { dir, python };
  }

  test("detectPythonExecutable prefers project .venv over system", () => {
    const { dir, python } = makeProject("posix");
    const previous = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      assert.equal(resolveVenvInterpreter(dir, {}, "linux"), python);
      assert.equal(detectPythonExecutable(dir), python);
    } finally {
      if (previous === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Windows Scripts/python.exe is detected the same way as POSIX bin/python", () => {
    const { dir, python } = makeProject("win32");
    try {
      assert.equal(resolveVenvInterpreter(dir, {}, "win32"), python);
      assert.match(python, /Scripts[/\\]python\.exe$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("VIRTUAL_ENV wins over project-local venv", () => {
    const local = makeProject("posix");
    const active = makeProject("posix");
    try {
      assert.equal(
        resolveVenvInterpreter(local.dir, { VIRTUAL_ENV: join(active.dir, ".venv") }, "linux"),
        active.python,
      );
    } finally {
      rmSync(local.dir, { recursive: true, force: true });
      rmSync(active.dir, { recursive: true, force: true });
    }
  });

  test("discoverPythonPytestCommand uses the venv interpreter", () => {
    const { dir, python } = makeProject("posix");
    const previous = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests", "test_sample.py"), "def test_ok():\n    assert True\n");
      const result = discoverCommands({ cwd: dir });
      assert.equal(result.source, "python-project");
      assert.deepEqual(result.commands, [`${python} -m pytest`]);
    } finally {
      if (previous === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verification child PATH prepends the venv bin directory", () => {
    const { dir, python } = makeProject("posix");
    const previous = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      writeFileSync(
        join(dir, "probe.js"),
        "process.stdout.write(process.env.PATH || '');\n",
      );
      const result = runVerificationGate({
        cwd: dir,
        preferenceCommands: ["node probe.js"],
      });
      assert.equal(result.passed, true);
      const pathOut = result.checks[0]?.stdout ?? "";
      assert.equal(pathOut.split(delimiter)[0], dirname(python));
    } finally {
      if (previous === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-venv project still discovers python3 -m pytest", () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-novenv-"));
    try {
      mkdirSync(join(dir, "tests"));
      writeFileSync(join(dir, "tests", "test_sample.py"), "def test_ok():\n    assert True\n");
      const result = discoverCommands({ cwd: dir });
      assert.equal(result.source, "python-project");
      assert.deepEqual(result.commands, ["python3 -m pytest"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plan-time rewrites bare pytest and python; leaves qualified commands", () => {
    const { dir, python } = makeProject("posix");
    const empty = mkdtempSync(join(tmpdir(), "gsd-novenv-"));
    const previous = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
      assert.equal(normalizeVerifyCommandForVenv("pytest", dir), `${python} -m pytest`);
      assert.equal(normalizeVerifyCommandForVenv("python -m pytest tests/", dir), `${python} -m pytest tests/`);
      assert.equal(normalizeVerifyCommandForVenv("/usr/bin/pytest tests/", dir), "/usr/bin/pytest tests/");
      assert.equal(normalizeVerifyCommandForVenv("pytest", empty), "pytest");
    } finally {
      if (previous === undefined) delete process.env.VIRTUAL_ENV;
      else process.env.VIRTUAL_ENV = previous;
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
