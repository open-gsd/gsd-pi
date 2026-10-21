// Project/App: gsd-pi
// File Purpose: Pure blocker command recognition shared by routing and behavior tests.

export function isBlockerCommand(command: string): boolean {
  return /^blocker(?:\s|$)/u.test(command.trim());
}
