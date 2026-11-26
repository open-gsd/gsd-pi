// gsd-pi TUI Tests - Built-in terminal theme palette coverage (pi v1.6.1).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const themesDir = join(dirname(fileURLToPath(import.meta.url)), "../../packages/pi-coding-agent/src/theme");

function loadBuiltinTheme(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(themesDir, `${name}.json`), "utf-8")) as Record<string, unknown>;
}

test("dark built-in theme ships the v1.6.1 terminal palette", () => {
	const theme = loadBuiltinTheme("dark");
	assert.equal(theme.name, "dark");
	assert.equal(theme.appearance, "dark");

	const vars = theme.vars as Record<string, string>;
	assert.equal(typeof vars.text, "string");
	assert.equal(typeof vars.muted, "string");
	assert.match(vars.green, /^okhsl\(/);

	const colors = theme.colors as Record<string, string>;
	assert.equal(colors.warning, "yellow");
	assert.match(colors.toolPendingBg, /^okhsl\(/);
});

test("light built-in theme ships the v1.6.1 terminal palette", () => {
	const theme = loadBuiltinTheme("light");
	assert.equal(theme.name, "light");
	assert.equal(theme.appearance, "light");

	const vars = theme.vars as Record<string, string>;
	assert.equal(typeof vars.text, "string");
	assert.match(vars.blue, /^okhsl\(/);
});