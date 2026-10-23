// Project/App: gsd-pi
// File Purpose: Exact boolean auto-recover parsing; no DB or authority side effects.
export function parseAutoRecoverFlag(input: string): { autoRecover: boolean; rest: string } {
  // Match parseYoloFlag's quoted-value grammar before normalizing separators.
  const tokens = input.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [];
  const flags = tokens.filter((token) => token.startsWith("--auto-recover"));
  if (flags.some((token) => token !== "--auto-recover") || flags.length > 1) {
    throw new Error("Use --auto-recover once, without a value; this does not ignore human gates");
  }
  return { autoRecover: flags.length === 1,
    rest: tokens.filter((token) => token !== "--auto-recover").join(" ") };
}
