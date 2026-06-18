import { describe, expect, test } from "bun:test";
import { ActionCard, VoiceOrb, Wordmark } from "./index";

describe("Viva UI primitives", () => {
  test("exports core component functions", () => {
    expect(typeof Wordmark).toBe("function");
    expect(typeof VoiceOrb).toBe("function");
    expect(typeof ActionCard).toBe("function");
  });
});
