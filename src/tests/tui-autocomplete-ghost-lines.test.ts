// gsd-pi + src/tests/tui-autocomplete-ghost-lines.test.ts - Regression coverage for TUI shrink clearing near autocomplete rows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, TUI, type Component, type Terminal } from "@gsd/pi-tui";

class MockTTYTerminal implements Terminal {
  public writtenData: string[] = [];

  readonly isTTY = true;

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

  write(data: string): void {
    this.writtenData.push(data);
  }

  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
}

class DynamicLinesComponent implements Component {
  public lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  render(_width: number): string[] {
    return this.lines;
  }

  invalidate(): void {}
}

describe("TUI autocomplete shrink clearing (#3721)", () => {
  it("clears deleted autocomplete rows relative to the actual hardware cursor row", () => {
    const terminal = new MockTTYTerminal();
    const tui = new TUI(terminal, false);
    const component = new DynamicLinesComponent([
      "top border",
      `prompt${CURSOR_MARKER}`,
      "editor body",
      "autocomplete row 1",
      "autocomplete row 2",
      "autocomplete row 3",
    ]);

    tui.addChild(component);
    (tui as any).doRender();

    terminal.writtenData = [];
    component.lines = [
      "top border",
      `prompt${CURSOR_MARKER}`,
      "editor body",
      "autocomplete row 1",
    ];

    (tui as any).doRender();

    assert.ok(terminal.writtenData.length >= 1, "shrink render should write a differential buffer");
    const buffer = terminal.writtenData[0];
    // #2415: clean repaints erase per-line instead of \x1b[2J (which erased
    // never-flushed lines in place). The shrink still homes to row 1, erases
    // every screen row exactly once (20 above the block + 4 written), and
    // leaves the retained block bottom-anchored: block height 4, terminal
    // height 24 → the block occupies rows 21..24.
    assert.ok(buffer.includes("\x1b[1;1H"), `expected the repaint to home to row 1, got ${JSON.stringify(buffer)}`);
    assert.ok(!buffer.includes("\x1b[2J"), `clean repaints must not emit \\x1b[2J, got ${JSON.stringify(buffer)}`);
    const eraseCount = (buffer.match(/\x1b\[2K/g) ?? []).length;
    assert.strictEqual(eraseCount, 24, `expected one \\x1b[2K per screen row, got ${eraseCount} in ${JSON.stringify(buffer)}`);
    assert.ok(
      buffer.includes("autocomplete row 1"),
      `expected the retained autocomplete row to be repainted, got ${JSON.stringify(buffer)}`,
    );
  });
});
