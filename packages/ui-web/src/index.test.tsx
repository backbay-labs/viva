import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCard, MasteryRing, VoiceOrb, Wordmark } from "./index";

describe("Viva UI primitives", () => {
  test("exports core component functions", () => {
    expect(typeof Wordmark).toBe("function");
    expect(typeof VoiceOrb).toBe("function");
    expect(typeof ActionCard).toBe("function");
  });

  test("MasteryRing exposes a draw-on hook without changing its resting value", () => {
    const markup = renderToStaticMarkup(<MasteryRing pct={50} size={88} stroke={8} />);

    // The progress arc carries the draw-on class and the custom properties the
    // keyframe interpolates between (full circumference -> target offset).
    expect(markup).toContain("mastery-ring__progress");
    expect(markup).toContain("--ring-circ:");
    expect(markup).toContain("--ring-offset:");
    // The resting strokeDashoffset is still the true value for pct=50
    // (circumference 251.327 * (1 - 0.5) = 125.66), so the final ring is unchanged.
    expect(markup).toContain('stroke-dashoffset="125.6');
  });
});
