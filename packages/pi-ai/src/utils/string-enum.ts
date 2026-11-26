import type { Schema } from "@gsd/pi-schema";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns: `{ type: "string", enum: [...] }`.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide" (Static from @gsd/pi-schema)
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): Schema<T[number]> {
	return {
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	};
}
