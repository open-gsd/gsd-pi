// Project/App: gsd-pi
// File Purpose: Pure blocker command recognition shared by routing and behavior tests.

export function isBlockerCommand(command: string): boolean {
  return /^blocker(?:\s|$)/u.test(command.trim());
}

/** Read-only native attention overview (#2932). Same token rule as blocker routing. */
export function isAttentionCommand(command: string): boolean {
  return /^attention(?:\s|$)/u.test(command.trim());
}
