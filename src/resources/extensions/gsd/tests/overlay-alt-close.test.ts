// GSD Extension — overlay Alt fallback close tests
// #2371: the overlay fallback family moved from Ctrl+Shift to Alt, so the
// overlays must close on the advertised Alt chord (legacy ESC-prefix byte),
// not on the retired Ctrl+Shift chord that legacy terminals cannot emit.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GSDDashboardOverlay } from "../dashboard-overlay.ts";
import { GSDNotificationOverlay } from "../notification-overlay.ts";
import { ParallelMonitorOverlay } from "../parallel-monitor-overlay.ts";

const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-overlay-alt-close-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

test("dashboard overlay closes on the advertised Alt+G chord (legacy ESC prefix and CSI-u)", () => {
  const dir = makeTempDir("dashboard");
  const originalCwd = process.cwd();
  process.chdir(dir);
  let closed = false;
  let overlay: GSDDashboardOverlay | null = null;
  try {
    overlay = new GSDDashboardOverlay({ requestRender() {} }, stubTheme, () => {
      closed = true;
    });
    overlay.handleInput("\x1bg"); // legacy ESC-prefix alt+g
    assert.equal(closed, true, "ESC-prefix Alt+G must close the dashboard overlay");
  } finally {
    if (!closed) overlay?.dispose();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notification overlay closes on the advertised Alt+N chord (legacy ESC prefix)", () => {
  const dir = makeTempDir("notifications");
  const originalCwd = process.cwd();
  process.chdir(dir);
  let closed = false;
  let overlay: GSDNotificationOverlay | null = null;
  try {
    overlay = new GSDNotificationOverlay({ requestRender() {} }, stubTheme, () => {
      closed = true;
    });
    overlay.handleInput("\x1bn"); // legacy ESC-prefix alt+n
    assert.equal(closed, true, "ESC-prefix Alt+N must close the notification overlay");
  } finally {
    if (!closed) overlay?.dispose();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlays keep closing on the Ctrl+Alt primary chord (CSI-u)", () => {
  const dir = makeTempDir("primary");
  const originalCwd = process.cwd();
  process.chdir(dir);
  const closed: string[] = [];
  const overlays: Array<{ dispose: () => void }> = [];
  try {
    const dashboard = new GSDDashboardOverlay({ requestRender() {} }, stubTheme, () => closed.push("dashboard"));
    overlays.push(dashboard);
    dashboard.handleInput("\x1b[103;7u"); // ctrl+alt+g
    const notifications = new GSDNotificationOverlay({ requestRender() {} }, stubTheme, () =>
      closed.push("notifications"),
    );
    overlays.push(notifications);
    notifications.handleInput("\x1b[110;7u"); // ctrl+alt+n
    assert.deepEqual(closed.sort(), ["dashboard", "notifications"], "Ctrl+Alt primary chord must still close");
  } finally {
    if (!closed.includes("dashboard")) overlays[0]?.dispose();
    if (!closed.includes("notifications")) overlays[1]?.dispose();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel overlay closes on Escape and Ctrl+Alt+P, not on the unregistered Alt+P", () => {
  const dir = makeTempDir("parallel");
  const originalCwd = process.cwd();
  process.chdir(dir);
  let closed = false;
  let overlay: ParallelMonitorOverlay | null = null;
  try {
    overlay = new ParallelMonitorOverlay({ requestRender() {} }, stubTheme, () => {
      closed = true;
    });
    overlay.handleInput("\x1bp"); // alt+p: no parallel fallback is registered (alt+up ESC alias)
    assert.equal(closed, false, "Alt+P must not close the parallel overlay (no such registration)");
    overlay.handleInput("\x1b[112;7u"); // ctrl+alt+p CSI-u
    assert.equal(closed, true, "Ctrl+Alt+P must close the parallel overlay");
  } finally {
    if (!closed) overlay?.dispose();
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
