// Project/App: gsd-pi
// File Purpose: Test helper that sets the opt-out flag of the automatic Authority Epoch cutover on open and gives back its restore.

/**
 * The automatic cutover on open runs unless GSD_AUTHORITY_CUTOVER=0.
 * `undefined` unsets the variable, which is the default.
 */
export function setAuthorityCutoverFlag(value: string | undefined): () => void {
  const before = process.env.GSD_AUTHORITY_CUTOVER;
  const set = (next: string | undefined): void => {
    if (next === undefined) delete process.env.GSD_AUTHORITY_CUTOVER;
    else process.env.GSD_AUTHORITY_CUTOVER = next;
  };
  set(value);
  return () => set(before);
}
