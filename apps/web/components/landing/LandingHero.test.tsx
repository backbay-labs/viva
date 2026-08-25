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

  test("renders one honest 'Begin oral exam' button and no command textbox (D-03 Branch B)", () => {
    expect(markup).toContain("Begin oral exam");
    expect(markup).not.toContain("Where should Viva begin?");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<form");
  });

  test("does not render the ornamental 'Answer out loud' mic (D-03 Branch B)", () => {
    expect(markup).not.toContain("Answer out loud");
  });

  test("does not render the removed unsigned mode/goal suggestion chips (D-03 Branch B)", () => {
    expect(markup).not.toContain("Quiz Lecture 5");
    expect(markup).not.toContain("Mock viva · 10 min");
    expect(markup).not.toContain("Review missed concepts");
  });

  test("the begin action is the hero's single button, honest about promising no mode or goal", () => {
    const buttonCount = (markup.match(/<button[ >]/g) ?? []).length;
    expect(buttonCount).toBe(1);
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

  test("the muse image declares its real intrinsic dimensions (FRONTEND-007)", () => {
    // 1672x941 is the real pixel size of both apps/web/public/viva-muse.png
    // and viva-muse.webp — declaring it lets the browser reserve layout
    // space before either image decodes, instead of a post-decode reflow.
    expect(markup).toContain('width="1672"');
    expect(markup).toContain('height="941"');
  });
});
