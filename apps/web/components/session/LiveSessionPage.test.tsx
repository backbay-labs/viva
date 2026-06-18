import { describe, expect, test } from "bun:test";
import { stopCaptureForRecap } from "./LiveSessionPage";

describe("LiveSessionPage recap cleanup", () => {
  test("stops microphone capture when a terminal recap appears", () => {
    let stops = 0;
    const captureRef = {
      current: {
        stop: () => {
          stops += 1;
        },
      },
    };
    const captureStartedRef = { current: true };
    const levelRef = { current: { agent: 0.2, user: 0.8 } };

    stopCaptureForRecap(captureRef, captureStartedRef, levelRef);

    expect(stops).toBe(1);
    expect(captureRef.current).toBe(null);
    expect(captureStartedRef.current).toBe(false);
    expect(levelRef.current).toEqual({ agent: 0.2, user: 0 });
  });
});
