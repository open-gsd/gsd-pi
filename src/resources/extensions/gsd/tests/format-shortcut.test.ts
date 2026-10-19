// GSD Extension — formatShortcut tests
// Verifies OS-specific keyboard shortcut rendering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatShortcut } from '../files.ts';
import {
  formattedShortcutPair,
  GSD_SHORTCUTS,
  primaryShortcutCombo,
  fallbackShortcutCombo,
} from '../shortcut-defs.ts';

// Controls the env vars supportsCtrlAltShortcuts() reads so the advertised
// pair is deterministic regardless of the terminal the suite runs in.
function withShortcutEnv(env: Record<string, string | undefined>, run: () => void): void {
  const keys = ["TERM_PROGRAM", "TERMINAL_EMULATOR", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID"];
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    run();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SUPPORTED_ENV = { TERM_PROGRAM: "iTerm.app" };
const UNSUPPORTED_ENV = { TERM_PROGRAM: "apple_terminal" };

// ─── formatShortcut renders per-platform shortcuts ──────────────────────

test('formatShortcut: converts Ctrl+Alt combo on macOS', () => {
  // formatShortcut uses process.platform at module load time.
  // We can only test the current platform's behavior.
  const result = formatShortcut('Ctrl+Alt+G');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥G', 'macOS should use ⌃⌥ symbols');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+G', 'non-macOS should pass through unchanged');
  }
});

test('formatShortcut: converts Ctrl+Alt+N', () => {
  const result = formatShortcut('Ctrl+Alt+N');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥N');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+N');
  }
});

test('formatShortcut: converts Ctrl+Alt+B', () => {
  const result = formatShortcut('Ctrl+Alt+B');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃⌥B');
  } else {
    assert.strictEqual(result, 'Ctrl+Alt+B');
  }
});

test('formatShortcut: converts standalone Ctrl modifier', () => {
  const result = formatShortcut('Ctrl+C');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌃C');
  } else {
    assert.strictEqual(result, 'Ctrl+C');
  }
});

test('formatShortcut: converts Shift modifier', () => {
  const result = formatShortcut('Shift+Tab');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⇧Tab');
  } else {
    assert.strictEqual(result, 'Shift+Tab');
  }
});

test('formatShortcut: converts Cmd modifier', () => {
  const result = formatShortcut('Cmd+S');
  if (process.platform === 'darwin') {
    assert.strictEqual(result, '⌘S');
  } else {
    assert.strictEqual(result, 'Cmd+S');
  }
});

test('formatShortcut: passes through plain key names', () => {
  assert.strictEqual(formatShortcut('Escape'), 'Escape');
  assert.strictEqual(formatShortcut('Enter'), 'Enter');
});

test("shortcut-defs: exposes canonical dashboard combos", () => {
  assert.equal(primaryShortcutCombo("dashboard"), "Ctrl+Alt+G");
  assert.equal(fallbackShortcutCombo("dashboard"), "Alt+G");
});

test("shortcut-defs: advertised fallback combo is reachable on legacy terminals (ESC prefix)", async () => {
  // #2371: the old Ctrl+Shift fallback only matched via Kitty/modifyOtherKeys,
  // i.e. it needed strictly more capability than the Ctrl+Alt primary. The
  // advertised fallback must match the legacy ESC-prefix byte that every
  // terminal emits for Alt+<letter>.
  const { matchesKey } = await import("@gsd/pi-tui");
  for (const id of ["dashboard", "notifications"] as const) {
    const fallback = fallbackShortcutCombo(id);
    assert.equal(
      matchesKey(`\x1b${GSD_SHORTCUTS[id].key}`, fallback.toLowerCase() as Parameters<typeof matchesKey>[1]),
      true,
      `advertised fallback "${fallback}" must match the legacy ESC-prefix byte`,
    );
  }
});

test("shortcut-defs: formats shortcut pair using platform symbols", () => {
  withShortcutEnv(SUPPORTED_ENV, () => {
    const pair = formattedShortcutPair("notifications");
    if (process.platform === "darwin") {
      assert.equal(pair, "⌃⌥N / ⌥N");
    } else {
      assert.equal(pair, "Ctrl+Alt+N / Alt+N");
    }
  });
});

test("shortcut-defs: terminals that cannot fire Ctrl+Alt advertise only the reachable Alt chord", () => {
  // #2371: never advertise a chord the current terminal cannot emit. In a
  // terminal on the unsupported list the pair collapses to the Alt fallback,
  // which has the legacy ESC-prefix path and is actually deliverable.
  withShortcutEnv(UNSUPPORTED_ENV, () => {
    const pair = formattedShortcutPair("notifications");
    if (process.platform === "darwin") {
      assert.equal(pair, "⌥N");
    } else {
      assert.equal(pair, "Alt+N");
    }
    assert.ok(!pair.includes("/"), "unsupported terminals must not advertise the unreachable primary");
  });
  // A supported terminal keeps advertising both chords.
  withShortcutEnv(SUPPORTED_ENV, () => {
    const pair = formattedShortcutPair("notifications");
    assert.ok(pair.includes("/"), "supported terminals keep the primary/fallback pair");
  });
});

test("shortcut-defs: parallel shortcut omits fallback (hasFallback: false)", () => {
  withShortcutEnv(SUPPORTED_ENV, () => {
    const pair = formattedShortcutPair("parallel");
    if (process.platform === "darwin") {
      assert.equal(pair, "⌃⌥P", "parallel should only show primary combo");
    } else {
      assert.equal(pair, "Ctrl+Alt+P", "parallel should only show primary combo");
    }
    // Verify it does NOT contain the fallback separator
    assert.ok(!pair.includes("/"), "parallel pair should not contain fallback separator");
  });
});

test("shortcut-defs: dashboard shortcut includes fallback (hasFallback: true)", () => {
  withShortcutEnv(SUPPORTED_ENV, () => {
    const pair = formattedShortcutPair("dashboard");
    assert.ok(pair.includes("/"), "dashboard pair should contain fallback separator");
  });
});
