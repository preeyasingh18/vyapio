/**
 * Keeps a transition up long enough to be read.
 *
 * Against a local API, signing in finishes in well under a tenth of a second,
 * and an overlay that appears and vanishes inside one frame reads as a glitch
 * rather than as a transition.
 *
 * It only ever sets a floor. Work that was already slower than `ms` resolves
 * the moment it finishes — the wait must never become a delay on a slow
 * connection, which would punish exactly the shopkeeper it is meant to help.
 *
 * A rejection passes straight through, so a failed sign-in still surfaces its
 * error rather than being swallowed by the wait.
 */
export async function atLeast<T>(work: Promise<T>, ms = 900): Promise<T> {
  const [result] = await Promise.all([work, new Promise((done) => setTimeout(done, ms))]);
  return result;
}
