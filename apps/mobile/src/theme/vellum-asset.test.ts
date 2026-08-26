import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

// Local ambient shim, type-only (erased at build/runtime, no behavior change).
// No @types/bun / bun-types package exists anywhere in this repo, so the two
// Bun-only surfaces this file touches (import.meta.dir and the global Bun
// object) have no other source of types. `declare module` augmentation can't
// introduce a brand-new ambient module from inside a module file (TS2664),
// so node:fs/node:path are covered instead via apps/mobile/tsconfig.json's
// `types: ["node"]` (see that file's comment).
declare global {
  interface ImportMeta {
    dir: string;
  }
  const Bun: {
    file(path: string): {
      slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
    };
  };
}

// bun test runs from apps/mobile, so this resolves against the app root.
const PLATE = join(import.meta.dir, "../../assets/images/vellum-plate.webp");

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

  test("is a RIFF/WEBP container", async () => {
    const bytes = new Uint8Array(await Bun.file(PLATE).slice(0, 12).arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WEBP");
  });
});
