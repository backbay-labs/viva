import { describe, expect, test } from "bun:test";
import { prefersReducedMotion } from "./use-prefers-reduced-motion";

describe("prefersReducedMotion", () => {
  test("reflects a matching media query", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });

  test("defaults to motion allowed when the query is unavailable", () => {
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });
});
