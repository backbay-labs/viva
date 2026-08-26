import { describe, expect, test } from "bun:test";

import { createReadyLatch } from "./atmosphere-readiness";

// Short enough to keep the suite fast, long enough that a signal fired on the
// same tick as construction is unambiguously ahead of the deadline.
const DEADLINE_MS = 10;
const PAST_DEADLINE_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recorder(): { calls: number; release: () => void } {
  const record = {
    calls: 0,
    release: () => {
      record.calls += 1;
    },
  };
  return record;
}

describe("createReadyLatch", () => {
  test("releases as soon as the first signal arrives", () => {
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    expect(record.calls).toBe(0);
    latch.signal();
    expect(record.calls).toBe(1);

    latch.cancel();
  });

  test("ignores every signal after the first", () => {
    // The plate reports onLoad once, but a re-decode after a resize or a
    // second tier arriving later must not re-notify a caller that has already
    // torn its loading state down.
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    latch.signal();
    latch.signal();
    latch.signal();
    expect(record.calls).toBe(1);

    latch.cancel();
  });

  test("the deadline cannot release a second time behind a signal", async () => {
    // The interesting half of "whichever comes first": firing early has to
    // clear the timer, not merely mark the release as already delivered.
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    latch.signal();
    await sleep(PAST_DEADLINE_MS);
    expect(record.calls).toBe(1);

    latch.cancel();
  });

  test("releases on the deadline when no signal ever arrives", async () => {
    // A plate that neither decodes nor errors — the case that wedges the
    // splash shut if the deadline is missing.
    const record = recorder();
    createReadyLatch(record.release, DEADLINE_MS);

    expect(record.calls).toBe(0);
    await sleep(PAST_DEADLINE_MS);
    expect(record.calls).toBe(1);
  });

  test("a cancelled latch never reaches its deadline", async () => {
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    latch.cancel();
    await sleep(PAST_DEADLINE_MS);
    expect(record.calls).toBe(0);
  });

  test("a signal after cancellation is ignored", () => {
    // The unmount path: an image can report a load after its view is gone, and
    // the caller's setState is a leak by then.
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    latch.cancel();
    latch.signal();
    expect(record.calls).toBe(0);
  });

  test("cancelling after a release does not retract it", () => {
    const record = recorder();
    const latch = createReadyLatch(record.release, DEADLINE_MS);

    latch.signal();
    latch.cancel();
    expect(record.calls).toBe(1);
  });
});
