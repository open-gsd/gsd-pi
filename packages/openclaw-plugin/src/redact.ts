/**
 * Redaction for text that leaves the Gateway host for a chat channel.
 * The gsd child inherits the Gateway environment, so a crash tail can carry
 * provider keys or bearer tokens.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk|pk|ghp|gho|xox[abp])-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/g, "$1=[redacted]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Keep the last `maxBytes` of a string (UTF-8 byte budget, char-safe). */
export function tail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  return buf.subarray(buf.length - maxBytes).toString("utf8").replace(/^�+/, "");
}
