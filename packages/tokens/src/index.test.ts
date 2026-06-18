import { describe, expect, test } from "bun:test";
import { vivaColors, vivaTypography } from "./index";

describe("Viva tokens", () => {
  test("exposes the supplied design reference palette and font roles", () => {
    expect(vivaColors.bg).toBe("#f4efe6");
    expect(vivaColors.plum).toBe("#7a5ba6");
    expect(vivaTypography.serif).toContain("Cormorant");
  });
});
