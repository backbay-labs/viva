/**
 * The one-shot release the atmosphere hands its caller.
 *
 * Kept out of `atmosphere.tsx` because that module imports React Native, which
 * `bun:test` cannot parse — the same reason `atmosphere-geometry.ts` is its own
 * module. The interesting behaviour here is the race, so it lives where the
 * suite can hold it to account.
 */
export type ReadyLatch = {
  /**
   * The thing we were waiting on arrived. Releases immediately, unless the
   * latch has already released or been cancelled.
   */
  signal: () => void;
  /**
   * Stop waiting. Clears the deadline, and nothing releases afterwards — a
   * signal that lands after the component is gone is a leak, not a release.
   */
  cancel: () => void;
};

/**
 * Calls `onRelease` exactly once: on the first `signal()`, or `deadlineMs`
 * after construction, whichever comes first.
 *
 * The gate has to be total. A plate that never decodes and never errors, a
 * decode that fails, and a decode that succeeds all end the same way — the
 * caller is released — because an app that opens on flat canvas is far better
 * than an app that never opens at all. The deadline starts at construction, so
 * the caller creates the latch at the same moment it starts waiting.
 */
export function createReadyLatch(onRelease: () => void, deadlineMs: number): ReadyLatch {
  let settled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    deadline = undefined;
    onRelease();
  };

  deadline = setTimeout(release, deadlineMs);

  return {
    signal: release,
    cancel: () => {
      settled = true;
      clearTimeout(deadline);
      deadline = undefined;
    },
  };
}
