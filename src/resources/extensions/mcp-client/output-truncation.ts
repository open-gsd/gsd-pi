/**
 * Truncation of MCP tool output for delivery to the model.
 *
 * MCP responses are often compact single-line JSON. `truncateHead()` never
 * returns partial lines: when a single line exceeds the byte cap it returns
 * empty content with `firstLineExceedsLimit: true`. Composing the delivered
 * text naively from that result drops the response entirely — the model
 * receives only a "[Output truncated: 0/1 lines (0B of ...)]" notice.
 *
 * For that case we deliver a bounded UTF-8-safe prefix of the response,
 * clearly labeled as a partial prefix (not parseable complete JSON). All
 * other cases keep `truncateHead()`'s exact output and notice format.
 */

import {
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@gsd/pi-coding-agent";

export interface McpOutputResult {
	/** Final text delivered to the model (body + truncation label when truncated) */
	text: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Total bytes of the original response */
	totalBytes: number;
	/** Bytes of response body emitted (excludes the truncation label) */
	outputBytes: number;
	/** Whether the first line alone exceeded the byte cap (prefix-delivered) */
	firstLineExceedsLimit: boolean;
}

/**
 * Longest prefix of `str` that fits in `maxBytes` without splitting a
 * multi-byte UTF-8 character.
 */
export function utf8SafePrefix(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}
	return buf.subarray(0, end).toString("utf-8");
}

/**
 * Format raw MCP response text for delivery to the model.
 *
 * - Below/at cap: returned byte-identical.
 * - Truncated across lines: complete lines + the usual truncation notice.
 * - Single line (or first line) over the cap: a bounded UTF-8-safe prefix,
 *   preceded by a label stating it is partial and not parseable complete
 *   JSON — never zero body bytes.
 */
export function formatMcpOutputText(raw: string, noticeLabel = "Output truncated"): McpOutputResult {
	const truncation = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

	if (!truncation.firstLineExceedsLimit) {
		let text = truncation.content;
		if (truncation.truncated) {
			text += `\n\n[${noticeLabel}: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
		}
		return {
			text,
			truncated: truncation.truncated,
			totalBytes: truncation.totalBytes,
			outputBytes: truncation.outputBytes,
			firstLineExceedsLimit: false,
		};
	}

	const prefix = utf8SafePrefix(raw, DEFAULT_MAX_BYTES);
	const prefixBytes = Buffer.byteLength(prefix, "utf-8");
	// Report the oversize cause accurately: totalBytes covers the whole
	// response, which only equals the first line when the response is one line.
	const firstLineBytes = Buffer.byteLength(raw.split("\n", 1)[0], "utf-8");
	const cause =
		truncation.totalLines === 1
			? `single-line response of ${formatSize(truncation.totalBytes)}`
			: `first line of ${formatSize(firstLineBytes)} (response total ${formatSize(truncation.totalBytes)})`;
	const text =
		`[${noticeLabel}: 0/${truncation.totalLines} lines — ${cause} exceeds the ${formatSize(DEFAULT_MAX_BYTES)} cap; ` +
		`showing the first ${formatSize(prefixBytes)} below as a partial prefix; it is cut mid-content and is not parseable as complete JSON]\n` +
		prefix;
	return {
		text,
		truncated: true,
		totalBytes: truncation.totalBytes,
		outputBytes: prefixBytes,
		firstLineExceedsLimit: true,
	};
}
