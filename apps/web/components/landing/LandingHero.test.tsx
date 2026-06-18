import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingHero } from "./LandingHero";

const markup = renderToStaticMarkup(<LandingHero />);

describe("LandingHero", () => {
  test("renders the real 'All you must know, viva voce.' headline as an h1", () => {
    expect(markup).toContain("<h1");
    expect(markup).toContain("All you must know,");
    expect(markup).toContain("viva voce.");
  });

  test("renders the reduced subheadline copy", () => {
    expect(markup).toContain("Speak until it stays.");
  });

  test("command surface uses the spec placeholder and is keyboard reachable", () => {
    expect(markup).toContain('placeholder="Where should Viva begin?"');
    expect(markup).toContain("<input");
    expect(markup).toContain("<form");
  });

  test("renders all three suggestion chips as buttons", () => {
    expect(markup).toContain("Quiz Lecture 5");
    expect(markup).toContain("Mock viva · 10 min");
    expect(markup).toContain("Review missed concepts");
  });

  test("renders the wordmark and the context pill", () => {
    expect(markup).toContain("Viva");
    expect(markup).toContain("Biology Midterm");
    expect(markup).toContain("Exam Friday");
  });

  test("the muse is a real image asset, decorative to assistive tech", () => {
    expect(markup).toContain("/viva-muse.png");
    expect(markup).toContain("/viva-muse.webp");
    expect(markup).toContain('aria-hidden="true"');
  });
});
