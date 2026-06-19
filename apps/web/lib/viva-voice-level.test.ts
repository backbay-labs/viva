import { describe, expect, test } from "bun:test";
import {
  clamp01,
  computeRms,
  createVoiceLevelMeter,
  smoothLevel,
  voiceLevelFromRms,
} from "./viva-voice-level";

describe("computeRms", () => {
  test("is 0 for silence", () => {
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  test("is 1 for a full-scale square wave", () => {
    expect(computeRms([1, -1, 1, -1])).toBeCloseTo(1, 6);
  });

  test("is the root-mean-square of a half-scale signal", () => {
    expect(computeRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 6);
  });

  test("is 0 (not NaN) for an empty buffer", () => {
    expect(computeRms([])).toBe(0);
  });

  test("treats non-finite samples as silence rather than emitting NaN", () => {
    const rms = computeRms([Number.NaN, 1, Number.POSITIVE_INFINITY, -1]);
    expect(Number.isNaN(rms)).toBe(false);
    expect(rms).toBeCloseTo(Math.sqrt(0.5), 6);
  });
});

describe("clamp01", () => {
  test("clamps below 0, above 1, and passes through the middle", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe("smoothLevel", () => {
  test("eases the previous value toward the next by the coefficient", () => {
    expect(smoothLevel(0, 1, 0.2)).toBeCloseTo(0.2, 6);
    expect(smoothLevel(0.2, 1, 0.2)).toBeCloseTo(0.36, 6);
  });

  test("clamps the coefficient into [0,1] so it can never overshoot", () => {
    expect(smoothLevel(0, 1, 5)).toBe(1);
    expect(smoothLevel(0.4, 1, -1)).toBe(0.4);
  });
});

describe("voiceLevelFromRms", () => {
  test("is 0 at or below the noise floor", () => {
    expect(voiceLevelFromRms(0)).toBe(0);
    expect(voiceLevelFromRms(0.02, { noiseFloor: 0.02, ceiling: 0.2 })).toBe(0);
  });

  test("is 1 at or above the ceiling and never exceeds 1", () => {
    expect(voiceLevelFromRms(0.2, { noiseFloor: 0.02, ceiling: 0.2 })).toBe(1);
    expect(voiceLevelFromRms(0.9, { noiseFloor: 0.02, ceiling: 0.2 })).toBe(1);
  });

  test("rises monotonically between floor and ceiling", () => {
    const mid = voiceLevelFromRms(0.11, { noiseFloor: 0.02, ceiling: 0.2 });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeCloseTo(0.5, 1);
  });
});

describe("createVoiceLevelMeter", () => {
  test("smooths pushed buffers toward their gained level and resets to 0", () => {
    const meter = createVoiceLevelMeter({ coefficient: 1, noiseFloor: 0, ceiling: 1 });
    expect(meter.get()).toBe(0);
    meter.push([1, -1, 1, -1]);
    expect(meter.get()).toBeCloseTo(1, 6);
    meter.reset();
    expect(meter.get()).toBe(0);
  });

  test("smooths worklet-computed RMS without requiring main-thread samples", () => {
    const meter = createVoiceLevelMeter({ coefficient: 0.5, noiseFloor: 0, ceiling: 1 });

    expect(meter.pushRms(0.5)).toBe(0.25);
    expect(meter.pushRms(1)).toBe(0.625);
    expect(meter.get()).toBe(0.625);
  });
});
