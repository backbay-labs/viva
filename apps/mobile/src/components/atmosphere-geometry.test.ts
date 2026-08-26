import { describe, expect, test } from "bun:test";

import {
  gaussianStops,
  meanRadius,
  VIGNETTE,
  VIGNETTE_RADIUS,
  WELL,
  WELL_RADIUS,
} from "./atmosphere-geometry";

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

  test("matches the shader's exp(-(d*1.15)^2) falloff", () => {
    // A golden table, not a recomputation of the formula: re-deriving
    // exp(-(d*d)) inside the assertion can never fail while both sides stay in
    // sync. These five numbers change if the 1.15 coefficient changes or if the
    // sampling changes, which is exactly what would drift the static tier away
    // from Act 2's live shader.
    const opacities = gaussianStops(0.13, 5).map(({ opacity }) => Number(opacity.toFixed(4)));
    expect(opacities).toEqual([0.13, 0.1197, 0.0934, 0.0618, 0.0346]);
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

  test("the well is the wide, shallow ellipse the shader draws", () => {
    // Pinned because web silently ignores rx/ry on a radialGradient and falls
    // back to r; these two are what WELL_RADIUS has to summarise.
    expect(WELL.rx).toBe(0.86);
    expect(WELL.ry).toBe(0.6);
    expect(WELL.rx).toBeGreaterThan(WELL.ry);
  });

  test("the vignette only darkens the outer third", () => {
    expect(VIGNETTE.innerStop).toBeGreaterThan(0.4);
    expect(VIGNETTE.edgeOpacity).toBeLessThan(0.25);
  });

  test("the vignette ellipse is pinned too", () => {
    expect(VIGNETTE.cx).toBe(0.5);
    expect(VIGNETTE.cy).toBe(0.5);
    expect(VIGNETTE.rx).toBe(0.74);
    expect(VIGNETTE.ry).toBe(0.64);
  });
});

describe("meanRadius", () => {
  test("collapses to the radius when the ellipse is a circle", () => {
    expect(meanRadius(0.5, 0.5)).toBe(0.5);
  });

  test("lands between the two radii", () => {
    expect(meanRadius(0.2, 0.8)).toBeGreaterThan(0.2);
    expect(meanRadius(0.2, 0.8)).toBeLessThan(0.8);
  });

  test("is the geometric mean, not the arithmetic one", () => {
    // sqrt(0.2 * 0.8) = 0.4, whereas the arithmetic mean is 0.5. Getting this
    // wrong would inflate the well on web rather than merely mis-shape it.
    expect(meanRadius(0.2, 0.8)).toBeCloseTo(0.4, 6);
  });
});

describe("the scalar radii web falls back to", () => {
  // A DOM <radialGradient> has no rx/ry, so the browser uses r. These exist so
  // the web tier approximates the same ellipse instead of the SVG default 50%.
  test("the well's radius summarises its own ellipse", () => {
    expect(WELL_RADIUS).toBeCloseTo(0.7183, 4);
    expect(WELL_RADIUS).toBeGreaterThan(WELL.ry);
    expect(WELL_RADIUS).toBeLessThan(WELL.rx);
  });

  test("the vignette's radius summarises its own ellipse", () => {
    expect(VIGNETTE_RADIUS).toBeCloseTo(0.6882, 4);
    expect(VIGNETTE_RADIUS).toBeGreaterThan(VIGNETTE.ry);
    expect(VIGNETTE_RADIUS).toBeLessThan(VIGNETTE.rx);
  });

  test("both are far enough from the SVG default to matter", () => {
    // If either drifted back toward 0.5 the fix would be silently undone and
    // the contrast guarantee would break again on web.
    expect(WELL_RADIUS).toBeGreaterThan(0.6);
    expect(VIGNETTE_RADIUS).toBeGreaterThan(0.6);
  });
});
