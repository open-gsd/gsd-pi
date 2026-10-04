// Project/App: gsd-pi
// File Purpose: Test helper that sets the opt-in flag for the automatic Authority Epoch cutover on open and gives back its restore.

/**
 * The automatic cutover on open runs only with GSD_AUTHORITY_CUTOVER=1.
 * A test that proves that path calls `t.after(setAuthorityCutoverFlag("1"))`.
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
