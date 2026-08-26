import { describe, expect, test } from "bun:test";

import { gaussianStops, VIGNETTE, WELL } from "./atmosphere-geometry";

describe("gaussianStops", () => {
  test("returns the requested number of stops", () => {
    expect(gaussianStops(0.13, 5)).toHaveLength(5);
  });

  test("offsets span 0 to 1 inclusive", () => {
    const stops = gaussianStops(0.13, 5);
    expect(stops[0].offset).toBe(0);
    expect(stops[stops.length - 1].offset).toBe(1);
  });

  test("peaks at the centre with the requested opacity", () => {
    expect(gaussianStops(0.13, 5)[0].opacity).toBeCloseTo(0.13, 4);
  });

  test("falls off monotonically", () => {
    const stops = gaussianStops(0.13, 6);
    for (let i = 1; i < stops.length; i += 1) {
      expect(stops[i].opacity).toBeLessThan(stops[i - 1].opacity);
    }
  });

  test("approximates the shader's exp(-(d*1.15)^2) falloff", () => {
    // The shader lifts by exp(-(distance*1.15)^2); the SVG stops must track it
    // or the readability well will not match the live tier in Act 2.
    const stops = gaussianStops(1, 5);
    for (const { offset, opacity } of stops) {
      const d = offset * 1.15;
      expect(opacity).toBeCloseTo(Math.exp(-(d * d)), 3);
    }
  });

  test("rejects a degenerate stop count", () => {
    expect(() => gaussianStops(0.13, 1)).toThrow();
  });
});

describe("locked geometry", () => {
  test("the well sits where the shader puts it", () => {
    expect(WELL.cx).toBe(0.5);
    expect(WELL.cy).toBe(0.44);
    expect(WELL.peakOpacity).toBeCloseTo(0.13, 4);
  });

  test("the vignette only darkens the outer third", () => {
    expect(VIGNETTE.innerStop).toBeGreaterThan(0.4);
    expect(VIGNETTE.edgeOpacity).toBeLessThan(0.25);
  });
});
