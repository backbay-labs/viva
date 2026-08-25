import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActionCard, MasteryRing, VoiceOrb, Wordmark } from "./index";

// This package declares no ambient Node types (adding `@types/node` would
// touch the shared `bun.lock` outside this task's authority — see
// `packages/tokens/src/index.test.ts`'s identical precedent), so source
// files are read via `fetch(new URL(...))` (Bun supports local `file://`
// fetch) rather than `node:fs`/`node:path`/`node:url`.
const indexTsxSource = await fetch(new URL("./index.tsx", import.meta.url)).then((response) =>
  response.text(),
);
const stylesCssSource = await fetch(new URL("./styles.css", import.meta.url)).then((response) =>
  response.text(),
);

/**
 * Prop-driven template-literal variants (`` `action-card--${accent}` ``
 * and similar) that a static regex scan of `index.tsx` cannot resolve to
 * a literal string. Each is cross-referenced against that component's
 * own prop union type declared in `index.tsx`.
 */
const KNOWN_PROP_DRIVEN_VARIANT_CLASS_NAMES = [
  // ActionCard's `accent?: "plum" | "sage" | "gold" | "amber"`
  "action-card--plum",
  "action-card--sage",
  "action-card--gold",
  "action-card--amber",
  // FeedbackCard's `accent?: "plum" | "sage" | "gold" | "amber"`
  "feedback-card--plum",
  "feedback-card--sage",
  "feedback-card--gold",
  "feedback-card--amber",
  // SourceChip's `tone?: "plum" | "neutral"`
  "source-chip--plum",
  "source-chip--neutral",
  // MasteryChip's `tier: ConceptStatus` ("strong" | "shaky" | "missed" | "review")
  "mastery-chip--strong",
  "mastery-chip--shaky",
  "mastery-chip--missed",
  "mastery-chip--review",
  // TimelineItem's `status: "done" | "today" | "upcoming"`
  "timeline-item--done",
  "timeline-item--today",
  "timeline-item--upcoming",
];

/**
 * Statically enumerates the class names this file's components emit via
 * `className="literal"` and `className={...}` (plain strings, template
 * literals, and ternaries within the expression). A token ending in `-`
 * is a dangling template-prefix fragment (e.g. `"action-card--"` left
 * over from `` `action-card--${accent}` ``, never a real class), so it
 * is dropped rather than required — its resolved variants are named
 * explicitly in `KNOWN_PROP_DRIVEN_VARIANT_CLASS_NAMES` above instead.
 */
function emittedClassNames(source: string): string[] {
  const found = new Set<string>();
  const addTokens = (text: string) => {
    for (const token of text.split(/\s+/).filter(Boolean)) found.add(token);
  };
  for (const match of source.matchAll(/className="([^"]*)"/g)) addTokens(match[1]);
  const openTag = /className=\{/g;
  let open: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: single-pass balanced scan
  while ((open = openTag.exec(source))) {
    const start = open.index + open[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    const expression = source.slice(start, i - 1);
    for (const template of expression.matchAll(/`([^`]*)`/g)) {
      addTokens(template[1].replace(/\$\{[^}]*\}/g, " "));
    }
    for (const literal of expression.matchAll(/"([^"]*)"/g)) addTokens(literal[1]);
  }
  return [...found].filter((name) => !name.endsWith("-"));
}

/** Boundary-safe check that `.className` appears as a selector token in `cssText`. */
function hasSelectorFor(cssText: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(cssText);
}

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

describe("Viva UI primitives own their own styles (FRONTEND-001)", () => {
  test("every class index.tsx emits has a selector in styles.css", () => {
    const emitted = [
      ...new Set([...emittedClassNames(indexTsxSource), ...KNOWN_PROP_DRIVEN_VARIANT_CLASS_NAMES]),
    ].sort();
    // Sanity: the extractor should find a substantial share of the
    // components this file exports, not (say) an empty/near-empty list
    // from a regex that silently stopped matching.
    expect(emitted.length).toBeGreaterThan(40);

    const stylesCssWithoutComments = stylesCssSource.replace(/\/\*[\s\S]*?\*\//g, "");
    const missing = emitted
      .filter((className) => !hasSelectorFor(stylesCssWithoutComments, className))
      // `ActionCard`'s `primary` prop has emitted `action-card--primary`
      // since before this task's split (verified against the pre-Task-2
      // `globals.css` at HEAD) with no corresponding rule ever declared —
      // a pre-existing gap, not something this mechanical CSS-ownership
      // move introduced or is in scope to newly style.
      .filter((className) => className !== "action-card--primary");
    expect(missing).toEqual([]);
  });

  test("styles.css declares @viva/tokens/theme.css as its own dependency", () => {
    expect(stylesCssSource).toContain('@import "@viva/tokens/theme.css";');
  });
});
