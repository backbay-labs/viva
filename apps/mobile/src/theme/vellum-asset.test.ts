import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// bun test runs from apps/mobile, so this resolves against the app root.
const HERE = dirname(fileURLToPath(import.meta.url));
const PLATE = join(HERE, "../../assets/images/vellum-plate.webp");

describe("the baked vellum plate", () => {
  test("exists", () => {
    expect(() => statSync(PLATE)).not.toThrow();
  });

  test("stays inside its size budget", () => {
    // 311 KB when baked at q95/1242x2688. The ceiling leaves room for a
    // re-bake at slightly different parameters without silently bloating the
    // bundle; blowing past it means someone changed quality or dimensions.
    const kb = statSync(PLATE).size / 1024;
    expect(kb).toBeLessThan(420);
    expect(kb).toBeGreaterThan(120); // a q85 re-bake would lose most of the grain
  });

  test("is a RIFF/WEBP container", () => {
    const head = readFileSync(PLATE).subarray(0, 12);
    expect(head.toString("ascii", 0, 4)).toBe("RIFF");
    expect(head.toString("ascii", 8, 12)).toBe("WEBP");
  });
});
