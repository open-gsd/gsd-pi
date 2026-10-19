import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in legacy.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});

describe("edit tool misnamed edits field", () => {
	it("recovers edits sent under the `oldEntries` alias (array value)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldEntries: [{ oldText: "a", newText: "b" }],
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("recovers edits sent under the `oldEntries` alias (stringified JSON value)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldEntries: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("recovers edits sent under the `edit` alias (singular)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edit: [{ oldText: "a", newText: "b" }],
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("prefers the real `edits` field over an alias when both are present", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldEntries: [{ oldText: "c", newText: "d" }],
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldEntries: [{ oldText: "c", newText: "d" }],
		});
	});

	it("prepared alias input executes correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "alias.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "alias.txt",
			oldEntries: [{ oldText: "before", newText: "after" }],
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in alias.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("leaves an unusable alias value as-is so schema validation fails clearly downstream", () => {
		const definition = createEditToolDefinition(process.cwd());

		// Alias value is a non-JSON string: promoted to `edits`, but the
		// stringified-JSON recovery's catch{} silently leaves it as a string,
		// which downstream schema validation must reject with a clear error
		// rather than this normalizer papering over it.
		const preparedString = definition.prepareArguments!({
			path: "file.txt",
			oldEntries: "not json",
		});
		expect(preparedString).toEqual({
			path: "file.txt",
			edits: "not json",
		});

		// Alias value is neither an array nor a string (e.g. a number):
		// promoted verbatim, still not a valid edits array.
		const preparedNumber = definition.prepareArguments!({
			path: "file.txt",
			edit: 42,
		});
		expect(preparedNumber).toEqual({
			path: "file.txt",
			edits: 42,
		});
	});
});

describe("edit tool leaked parameter-wrapper strings", () => {
	it("recovers the exact reported payload: oldEntries as a bare <parameter name=\"oldText\"> wrapper plus a real newText", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldEntries: '\n<parameter name="oldText">const before = 1;',
			newText: "const after = 2;",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
		});
	});

	it("recovers a wrapper with a properly closed </parameter> tag", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: '<parameter name="old_text">before text</parameter>',
			oldText: undefined,
			newText: "after text",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before text", newText: "after text" }],
		});
	});

	it("does not unwrap a wrapper-shaped edits string when a real oldText is already present", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: '<parameter name="oldText">should not be used</parameter>',
			oldText: "real old",
			newText: "real new",
		});
		// oldText already present -> wrapper unwrap is skipped, and the raw
		// wrapper string in `edits` is discarded in favor of the real
		// oldText/newText fold-in (edits was never a valid array to begin with).
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "real old", newText: "real new" }],
		});
	});

	it("leaves a non-wrapper, non-JSON string alone (unrecoverable, surfaces a clear schema error)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldEntries: "just some prose, not a parameter wrapper or JSON",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "just some prose, not a parameter wrapper or JSON",
		});
	});

	it("end-to-end: prepared parameter-wrapper payload executes correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "wrapper.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "wrapper.txt",
			oldEntries: '<parameter name="oldText">before',
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in wrapper.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});
