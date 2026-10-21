import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { handleRecoverableExtensionProcessError } from "../bootstrap/register-extension.ts";

test("handleRecoverableExtensionProcessError swallows spawn ENOENT", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("missing binary"), {
        code: "ENOENT",
        syscall: "spawn npm",
        path: "npm",
      }),
    );
    assert.equal(handled, true);
    assert.match(stderr, /spawn ENOENT: npm/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError swallows uv_cwd ENOENT", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("process.cwd failed"), {
        code: "ENOENT",
        syscall: "uv_cwd",
      }),
    );
    assert.equal(handled, true);
    assert.match(stderr, /ENOENT \(uv_cwd\): process\.cwd failed/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError suppresses uv_cwd stderr in TUI mode", async () => {
  const { setStderrLoggingEnabled } = await import("../workflow-logger.ts");
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  const previous = setStderrLoggingEnabled(false);

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("process.cwd failed"), {
        code: "ENOENT",
        syscall: "uv_cwd",
      }),
    );
    assert.equal(handled, true);
    assert.equal(stderr, "");
  } finally {
    setStderrLoggingEnabled(previous);
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError swallows read EIO", () => {
	let stderr = "";
	const originalWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	try {
		const handled = handleRecoverableExtensionProcessError(
			Object.assign(new Error("read EIO"), {
				code: "EIO",
				syscall: "read",
			}),
		);
		assert.equal(handled, true);
		assert.match(stderr, /\[gsd\] EIO: read EIO/);
	} finally {
		process.stderr.write = originalWrite;
	}
});

test("handleRecoverableExtensionProcessError leaves non-read EIO unhandled", () => {
  const handled = handleRecoverableExtensionProcessError(
    Object.assign(new Error("open EIO"), {
      code: "EIO",
      syscall: "open",
    }),
  );
  assert.equal(handled, false);
});

test("handleRecoverableExtensionProcessError leaves unrelated errors unhandled", () => {
  const handled = handleRecoverableExtensionProcessError(
    Object.assign(new Error("permission denied"), {
      code: "EPERM",
      syscall: "open",
    }),
  );
  assert.equal(handled, false);
});

test("handleRecoverableExtensionProcessError leaves ECONNRESET network errors unhandled", () => {
  const handled = handleRecoverableExtensionProcessError(
    Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      syscall: "read",
    }),
  );
  assert.equal(handled, false);
});

test("handleRecoverableExtensionProcessError swallows EPIPE without writing a crash log", () => {
  const tmpHome = join(tmpdir(), `gsd-epipe-test-${randomUUID()}`);
  const origHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tmpHome;

  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("broken pipe"), {
        code: "EPIPE",
        syscall: "write",
      }),
    );
    assert.equal(handled, true);
    assert.match(stderr, /swallowed EPIPE/);
    const crashDir = join(tmpHome, "crash");
    assert.equal(existsSync(crashDir), false);
  } finally {
    process.stderr.write = originalWrite;
    process.env.GSD_HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("handleRecoverableExtensionProcessError tolerates stderr.write throwing EPIPE (re-entry guard)", () => {
  // process.stderr.write itself can EPIPE; safeStderr() must swallow it so the
  // handler doesn't re-enter the EPIPE branch and loop forever.
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => {
    throw Object.assign(new Error("stderr broken pipe"), {
      code: "EPIPE",
      syscall: "write",
    });
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      Object.assign(new Error("broken pipe"), {
        code: "EPIPE",
        syscall: "write",
      }),
    );
    assert.equal(handled, true);
  } finally {
    process.stderr.write = originalWrite;
  }
});

// #181: Windows surfaces a closed pipe mid-write as `Error: write EOF` (or
// `read EOF`) with no `code` set. Both are the same logical condition as POSIX
// EPIPE and must be swallowed, else they escape to the uncaught-exception path
// and crash auto-mode workers. These non-storm cases run before the storm test
// below so the shared storm counter stays under threshold. ECONNRESET is
// intentionally NOT in this set — see the dedicated "leaves ECONNRESET network
// errors unhandled" test above.
test("handleRecoverableExtensionProcessError swallows Windows 'write EOF' (no code)", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    // Mirror the real Windows error: message "write EOF", no `code`, no `syscall`.
    const handled = handleRecoverableExtensionProcessError(new Error("write EOF"));
    assert.equal(handled, true);
    assert.match(stderr, /swallowed write EOF/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError swallows 'read EOF' (no code)", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(new Error("read EOF"));
    assert.equal(handled, true);
    assert.match(stderr, /swallowed read EOF/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError swallows dead transport control write errors", () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  try {
    const handled = handleRecoverableExtensionProcessError(
      new Error("ProcessTransport is not ready for writing"),
    );
    assert.equal(handled, true);
    assert.match(stderr, /swallowed dead transport control write/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("handleRecoverableExtensionProcessError leaves a plain EOF-substring error unhandled", () => {
  // Guard against over-matching: only the exact "write EOF"/"read EOF" messages
  // are the Windows pipe-closed signature; an unrelated error must not be eaten.
  const handled = handleRecoverableExtensionProcessError(new Error("could not write EOF marker to log"));
  assert.equal(handled, false);
});

test("handleRecoverableExtensionProcessError exits on EPIPE storm (>100 within 10s)", () => {
  // After the storm threshold, the pipe is gone for good — handler must exit
  // cleanly instead of swallowing forever in a tight CPU loop.
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const originalExit = process.exit;
  const exitCalls: Array<number | undefined> = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code);
    // Don't actually exit; just record the call.
    return undefined as never;
  }) as typeof process.exit;

  try {
    const err = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
      syscall: "write",
    });
    // Fire well above the 100-event threshold inside the 10s window.
    for (let i = 0; i < 150; i++) {
      handleRecoverableExtensionProcessError(err);
    }
    assert.ok(
      exitCalls.length > 0,
      `expected process.exit to be called during EPIPE storm, got ${exitCalls.length} calls`,
    );
    assert.equal(exitCalls[0], 0);
    assert.match(stderr, /EPIPE storm/);
  } finally {
    process.stderr.write = originalWrite;
    process.exit = originalExit;
  }
});

test("handleRecoverableExtensionProcessError exits on a Windows 'write EOF' storm too (#181)", () => {
  // The storm counter is shared across all pipe-closed encodings, so a runaway
  // Windows `write EOF` loop must trip the same clean-exit guard as EPIPE.
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const originalExit = process.exit;
  const exitCalls: Array<number | undefined> = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code);
    return undefined as never;
  }) as typeof process.exit;

  try {
    const err = new Error("write EOF");
    for (let i = 0; i < 150; i++) {
      handleRecoverableExtensionProcessError(err);
    }
    assert.ok(exitCalls.length > 0, "expected process.exit during write EOF storm");
    assert.equal(exitCalls[0], 0);
    assert.match(stderr, /write EOF storm/);
  } finally {
    process.stderr.write = originalWrite;
    process.exit = originalExit;
  }
});
