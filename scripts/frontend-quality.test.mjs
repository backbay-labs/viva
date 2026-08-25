import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { vivaContrastPairs } from "../packages/tokens/src/index.ts";

/**
 * Frontend quality: static, source-level checks over the frontend's CSS
 * authority. Unlike `scripts/frontend-accessibility.mjs` (which mounts real
 * pages in a browser), everything here runs against CSS source text with
 * plain Node — no build step, no DOM.
 *
 * `checkTokenAuthority` is the one-token-authority checker
 * (`FRONTEND-001`/`FRONTEND-002`): it rejects a `:root` block that declares
 * the same custom property with more than one literal (non-`var()`) value,
 * and it rejects insufficient contrast for every pair declared in
 * `@viva/tokens`'s `vivaContrastPairs`.
 *
 * `checkCssOwnership` (added by Task 2) is the CSS-ownership checker: it
 * rejects a `globals.css` that still contains a selector block or the
 * wrong/extra imports, rejects a selector's identical declarations
 * authored in more than one of the four owned sheets, rejects a
 * `.viva-hero`/`.viva-library`- or
 * `.live-session`/`.session-`/`.question-`/`.marginalia`/`.source-`/`.voice-`-
 * named selector authored outside its assigned landing/session sheet (the
 * plan's Step 1 partition), and rejects a `@viva/ui-web` primitive class
 * with no selector in the package's own `styles.css`.
 *
 * `checkOchreTextRole` (added by Task 3) is the ochre semantic-text-role
 * checker (`FRONTEND-002`): the decorative `--viva-ochre` custom property
 * may be used for non-text declarations (`background`, `border*`, etc.),
 * but the `color` (text) property may only ever resolve through the
 * AA-contrast `--viva-ochre-text` token.
 *
 * `checkFontProvenance` and `checkNoRemoteFontLinks` (added by Task 4) are
 * the self-hosted-font checkers (`FRONTEND-007`): every committed WOFF2
 * under `apps/web/app/fonts` must be recorded in that directory's
 * `PROVENANCE.md` with a single, self-consistent pinned upstream
 * `google/fonts` commit SHA, its exact upstream source path, and a SHA-256
 * that matches the real committed file byte-for-byte; the combined WOFF2
 * payload must stay at or under the 300 KiB budget; and every font family
 * *implied by the committed WOFF2 filenames themselves* (never merely by
 * whatever happens to be sitting in the OFL-license-file listing, which
 * would vacuously "pass" an empty listing) must have a matching, real,
 * SHA-256-verified OFL license file committed alongside it.
 * `checkNoRemoteFontLinks` is the fast, no-browser source-level half of "no
 * request host is fonts.googleapis.com or fonts.gstatic.com" —
 * `scripts/frontend-accessibility.mjs --assets` proves the same thing by
 * observing real network requests from a mounted page.
 *
 * `checkTargetSize` (added by Task 7) is the static, no-browser half of the
 * `FRONTEND-012` 44x44 touch-target claim for `apps/web/app/error.tsx`'s
 * "Try again" button: it resolves the combined `.button`/`.button-primary`
 * class rules to a numeric px block size and rejects any width cap below
 * the target. It exists because Next's global error boundary only mounts
 * after a real render-time exception, which `scripts/frontend-accessibility.mjs`'s
 * normal page navigation never triggers — every other 44px button target
 * in this codebase is proven by that script's real Playwright-measured
 * bounding boxes instead.
 *
 * Later tasks extend this file with further asset checks; they must keep
 * reusing these checkers rather than re-implementing their parsing.
 */

/** @typedef {{ name: string, value: string }} Declaration */

/**
 * Parses the declarations inside *every* `:root { ... }` block of a CSS
 * source string. A stylesheet may legally contain more than one `:root`
 * block, and every one of them contributes to the cascade, so a checker
 * that only read the first would be blind to a duplicate (or
 * contrast-insufficient) declaration reintroduced in a later block.
 * Comments are stripped from the *entire* source before any `:root`
 * matching happens (not merely from within an already-matched block), so a
 * comment containing a literal colon (e.g. "restrained luxury: warm
 * vellum") can never be mistaken for a declaration, and a comment
 * containing literal text like ":root {" can never hijack block matching.
 *
 * @param {string} css
 * @returns {Declaration[]}
 */
function parseRootDeclarations(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [];
  for (const rootMatch of withoutComments.matchAll(/:root\s*{([^}]*)}/gs)) {
    for (const rawStatement of rootMatch[1].split(";")) {
      const statement = rawStatement.trim();
      if (!statement.startsWith("--")) continue;
      const colonIndex = statement.indexOf(":");
      if (colonIndex === -1) continue;
      declarations.push({
        name: statement.slice(0, colonIndex).trim(),
        value: statement.slice(colonIndex + 1).trim(),
      });
    }
  }
  return declarations;
}

/** @param {string} value */
function isLiteralValue(value) {
  return !value.startsWith("var(");
}

/** @param {Declaration[]} declarations */
function groupByName(declarations) {
  /** @type {Map<string, Declaration[]>} */
  const byName = new Map();
  for (const declaration of declarations) {
    const existing = byName.get(declaration.name) ?? [];
    existing.push(declaration);
    byName.set(declaration.name, existing);
  }
  return byName;
}

/** @param {string} hex */
function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

/** @param {[number, number, number]} rgb */
function relativeLuminance([r, g, b]) {
  const channel = (c) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = [channel(r), channel(g), channel(b)];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * WCAG 2.x contrast ratio between two literal hex colors. Returns a real
 * number computed from relative luminance, never a string comparison, so a
 * caller can assert on the numeric ratio itself.
 *
 * @param {string} hexA
 * @param {string} hexB
 */
function contrastRatio(hexA, hexB) {
  const luminanceA = relativeLuminance(hexToRgb(hexA));
  const luminanceB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] =
    luminanceA > luminanceB ? [luminanceA, luminanceB] : [luminanceB, luminanceA];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Checks a `:root`-bearing CSS source string against the one-token-authority
 * invariants this task owns: at most one literal declaration per custom
 * property, and sufficient contrast for every pair `@viva/tokens` declares
 * in `vivaContrastPairs` (FRONTEND-002) — the same array
 * `packages/tokens/src/index.test.ts` resolves against the real `theme.css`,
 * imported here directly rather than duplicated, so the two checkers can
 * never drift apart. A fixture that omits one pair's custom properties
 * (most of this file's synthetic fixtures declare only the properties they
 * care about) simply skips that pair rather than erroring, so this
 * generalization stays backward-compatible with every existing fixture.
 *
 * @param {string} cssText
 */
function checkTokenAuthority(cssText) {
  const declarations = parseRootDeclarations(cssText);
  const byName = groupByName(declarations);
  const errors = [];
  const contrastRatios = {};

  for (const [name, occurrences] of byName) {
    const literalOccurrences = occurrences.filter((declaration) =>
      isLiteralValue(declaration.value),
    );
    if (literalOccurrences.length > 1) {
      errors.push(
        `duplicate literal declaration of ${name}: found ${literalOccurrences.length} literal values (${literalOccurrences
          .map((declaration) => declaration.value)
          .join(", ")})`,
      );
    }
  }

  for (const pair of vivaContrastPairs) {
    const foreground = byName.get(pair.foreground)?.[0];
    const background = byName.get(pair.background)?.[0];
    if (!foreground || !background) continue;
    if (!isLiteralValue(foreground.value) || !isLiteralValue(background.value)) continue;
    const ratio = contrastRatio(foreground.value, background.value);
    contrastRatios[`${pair.foreground} on ${pair.background}`] = ratio;
    if (ratio < pair.minimumRatio) {
      errors.push(
        `${pair.foreground} (${foreground.value}) on ${pair.background} (${background.value}) contrast is ${ratio.toFixed(
          2,
        )}:1, below the required ${pair.minimumRatio}:1`,
      );
    }
  }

  return { ok: errors.length === 0, errors, contrastRatios };
}

test("rejects duplicated literal declarations of the same custom property", () => {
  const fixture = `
    :root {
      --viva-paper: #fffdf8;
      --viva-paper: #eeeeee;
      --viva-ochre-text: #8a5a23;
    }
  `;
  const result = checkTokenAuthority(fixture);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("--viva-paper")),
    `expected an error naming --viva-paper, got: ${JSON.stringify(result.errors)}`,
  );
});

test("rejects the current ochre-on-paper pair by computed contrast ratio, not string matching", () => {
  const fixture = `
    :root {
      --viva-paper: #fffdf8;
      --viva-ochre-text: #c88b48;
    }
  `;
  const result = checkTokenAuthority(fixture);
  assert.equal(result.ok, false);
  const ratio = result.contrastRatios["--viva-ochre-text on --viva-paper"];
  assert.equal(typeof ratio, "number");
  assert.ok(ratio < 4.5, `expected a computed contrast ratio below 4.5, got ${ratio}`);
  // The rejection must follow from the computed ratio, not from matching the
  // literal string "#c88b48" — a fixture using a *different* insufficient
  // hex must be rejected too, by the same numeric threshold.
  const otherInsufficientFixture = `
    :root {
      --viva-paper: #fffdf8;
      --viva-ochre-text: #a97f3f;
    }
  `;
  const otherResult = checkTokenAuthority(otherInsufficientFixture);
  assert.equal(otherResult.ok, false);
  assert.ok(otherResult.contrastRatios["--viva-ochre-text on --viva-paper"] < 4.5);
});

test("accepts the canonical theme.css authority", () => {
  const themeCssPath = fileURLToPath(new URL("../packages/tokens/src/theme.css", import.meta.url));
  const themeCss = fs.readFileSync(themeCssPath, "utf8");
  const result = checkTokenAuthority(themeCss);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(result.contrastRatios["--viva-ochre-text on --viva-paper"] >= 4.5);
});

test("rejects the canonical theme.css with a duplicate literal appended in a second :root block", () => {
  // Regression test: a checker that reads only the *first* `:root` block in
  // a source is blind to a duplicate (or contrast-insufficient) declaration
  // reintroduced in a later one. This is exactly the shape of the original
  // FRONTEND-001 defect (globals.css had two literal `:root` palette
  // blocks), so appending a second `:root` block to the real, currently
  // passing theme.css must still be rejected.
  const themeCssPath = fileURLToPath(new URL("../packages/tokens/src/theme.css", import.meta.url));
  const themeCss = fs.readFileSync(themeCssPath, "utf8");
  const mutated = `${themeCss}\n:root {\n  --viva-paper: #eeeeee;\n  --viva-ochre-text: #c88b48;\n}\n`;
  const result = checkTokenAuthority(mutated);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("--viva-paper")),
    `expected an error naming --viva-paper, got: ${JSON.stringify(result.errors)}`,
  );
  assert.ok(
    result.errors.some((error) => error.includes("--viva-ochre-text")),
    `expected an error naming --viva-ochre-text, got: ${JSON.stringify(result.errors)}`,
  );
});

test("does not let a comment containing literal ':root {' text hijack block parsing", () => {
  const fixture = `
    /* legacy note: an old rule once read :root { color: red } here */
    :root {
      --viva-paper: #fffdf8;
      --viva-ochre-text: #8a5a23;
    }
  `;
  const result = checkTokenAuthority(fixture);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(result.contrastRatios["--viva-ochre-text on --viva-paper"] >= 4.5);
});

test("checkTokenAuthority scans every declared vivaContrastPairs entry, not a one-off ochre assertion (FRONTEND-002)", () => {
  // `vivaContrastPairs` is imported straight from @viva/tokens, so this is
  // the exact array packages/tokens/src/index.test.ts resolves against the
  // real theme.css — proving the two checkers can never drift apart, and
  // that the scan generalizes to every declared pair (ink, ink-soft, muted),
  // not only ochre-on-paper.
  assert.ok(vivaContrastPairs.length >= 5, "expected at least 5 declared contrast pairs");
  assert.ok(
    vivaContrastPairs.some(
      (pair) => pair.foreground === "--viva-ink" && pair.background === "--viva-paper",
    ),
    "expected --viva-ink vs --viva-paper to be a declared pair",
  );

  // A fixture with every declared pair's tokens present, but --viva-muted
  // deliberately insufficient, must be rejected by name — proving the loop
  // really checks a *non*-ochre pair, not only the two ochre ones.
  const fixture = `
    :root {
      --viva-paper: #fffdf8;
      --viva-bg-soft: #fbf6ee;
      --viva-ochre-text: #8a5a23;
      --viva-ink: #24182f;
      --viva-ink-soft: #4e4259;
      --viva-muted: #d8d2df;
    }
  `;
  const result = checkTokenAuthority(fixture);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("--viva-muted") && error.includes("--viva-paper")),
    `expected an error naming --viva-muted on --viva-paper, got: ${JSON.stringify(result.errors)}`,
  );
  // The other four declared pairs, all sufficient in this fixture, must
  // still pass — a single insufficient pair does not mask the rest.
  assert.equal(result.errors.length, 1);
});

/*
 * CSS-ownership checker (`FRONTEND-001`, Task 2): the split of
 * `apps/web/app/globals.css` into `packages/ui-web/src/styles.css` plus
 * `apps/web/app/styles/{base,landing,session}.css`.
 */

/**
 * Parses a CSS source string into a flat list of `{ selector, body }`
 * entries — one per individual (comma-split) selector — from every style
 * rule in the source, including rules nested inside `@media`/`@supports`.
 * `@keyframes` blocks are skipped entirely (their "selectors" are
 * percentages/`from`/`to`, not classes an owner sheet can claim). `body`
 * is the rule's declaration text with whitespace runs collapsed to a
 * single space and trimmed, so two rules are compared by their effective
 * declarations, not incidental formatting.
 *
 * @param {string} cssText
 * @returns {{ selector: string, body: string }[]}
 */
function extractSelectorRules(cssText) {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const entries = [];

  function walk(text) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) break;
      let j = i;
      let parenDepth = 0;
      while (j < n) {
        const c = text[j];
        if (c === "(") parenDepth++;
        else if (c === ")") parenDepth--;
        else if (c === "{" && parenDepth === 0) break;
        else if (c === ";" && parenDepth === 0) break;
        j++;
      }
      if (j >= n) break;
      if (text[j] === ";") {
        i = j + 1;
        continue;
      }
      const header = text.slice(i, j).trim();
      let depth = 1;
      let k = j + 1;
      while (k < n && depth > 0) {
        if (text[k] === "{") depth++;
        else if (text[k] === "}") depth--;
        k++;
      }
      const body = text.slice(j + 1, k - 1);
      if (header.startsWith("@keyframes")) {
        // internal percentage selectors are not class selectors.
      } else if (header.startsWith("@")) {
        walk(body);
      } else {
        const normalizedBody = body.replace(/\s+/g, " ").trim();
        for (const selector of splitTopLevelCommaList(header)) {
          entries.push({ selector, body: normalizedBody });
        }
      }
      i = k;
    }
  }

  walk(withoutComments);
  return entries;
}

/** Splits a selector list by top-level commas (respecting parens/brackets). */
function splitTopLevelCommaList(header) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of header) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((entry) => entry.replace(/\s+/g, " "));
}

/**
 * Extracts every class-name token (`.foo`, `.foo__bar`, `.foo--bar`, …)
 * that appears anywhere in a — possibly compound/descendant — selector
 * string, ignoring element names, combinators, pseudo-classes/-elements,
 * and attribute selectors. `.marginalia[data-state="recap"]` yields only
 * `marginalia`; `.viva-library__actions button.viva-library__action--danger`
 * yields `viva-library__actions` and `viva-library__action--danger`.
 *
 * @param {string} selector
 * @returns {string[]}
 */
function classTokens(selector) {
  return [...selector.matchAll(/\.[\w-]+/g)].map((match) => match[0].slice(1));
}

/**
 * Task 2 Step 1's required selector partition, expressed as the two
 * groups that have a closed-form class-name pattern. `base.css` is this
 * partition's residual bucket — reset, root document, focus utility,
 * error/loading/not-found shell, and the cross-cutting chrome shared by
 * every route (the plan's Step 1 list is illustrative of what belongs
 * there, not an exhaustive selector-name grammar to validate against) —
 * so it has no pattern here and is checked only as a required *non*-owner
 * below. `@viva/ui-web`'s own primitive bucket is already fully enforced
 * by `requiredUiWebSelectors`; the one documented overlap is `source-chip`
 * itself, which is both a real ui-web primitive *and* matches the session
 * group's `.source-*` pattern — see the carve-out in `checkCssOwnership`.
 */
const PARTITION_GROUPS = [
  {
    owner: "apps/web/app/styles/landing.css",
    label: ".viva-hero/.viva-library",
    matches: (token) => /^viva-(hero|library)(?:[_-]|$)/.test(token),
  },
  {
    owner: "apps/web/app/styles/session.css",
    label: ".live-session/.session-*/.question-*/.marginalia-*/.source-*/.voice-*",
    matches: (token) =>
      /^live-session(?:[_-]|$)/.test(token) ||
      /^session-/.test(token) ||
      /^question-/.test(token) ||
      /^marginalia(?:[_-]|$)/.test(token) ||
      /^source-/.test(token) ||
      /^voice-/.test(token),
  },
];

/**
 * Checks the CSS-ownership invariants Task 2 establishes: `globalsCss`
 * contains only ordered `@import` statements/comments, in the exact
 * resolved order `@viva/ui-web/styles.css -> ./styles/base.css ->
 * ./styles/landing.css -> ./styles/session.css`, and no longer imports
 * `@viva/tokens/theme.css` directly; no *identical* rule (same selector,
 * same declarations) is authored in more than one of the four owned
 * sheets; a selector matching `PARTITION_GROUPS`'s `.viva-hero`/
 * `.viva-library` or `.live-session`/`.session-*`/`.question-*`/
 * `.marginalia-*`/`.source-*`/`.voice-*` patterns is authored only in
 * that group's owner sheet, never `base.css`, the other route's sheet, or
 * (aside from a declared ui-web primitive such as `source-chip`)
 * `uiWebStylesCss`; and every selector in `requiredUiWebSelectors` (the
 * classes `@viva/ui-web`'s own components emit, without the leading `.`)
 * has at least one declaration in `uiWebStylesCss`.
 *
 * A selector legitimately appearing in more than one sheet with
 * *different* declarations (for example a base chip-family rule in
 * `uiWebStylesCss` layered under a session-specific refinement in
 * `sessionCss` for the same `.source-chip` class) is not a
 * duplicate-authority violation — only an identical (selector,
 * declarations) pair copied into a second sheet is.
 *
 * @param {{
 *   globalsCss: string,
 *   uiWebStylesCss: string,
 *   baseCss: string,
 *   landingCss: string,
 *   sessionCss: string,
 *   requiredUiWebSelectors: string[],
 * }} sheets
 */
function checkCssOwnership({
  globalsCss,
  uiWebStylesCss,
  baseCss,
  landingCss,
  sessionCss,
  requiredUiWebSelectors,
}) {
  const errors = [];

  const globalsWithoutComments = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
  if (globalsWithoutComments.includes("{")) {
    errors.push(
      "globals.css contains a selector block; it must contain only ordered @import statements",
    );
  }
  const importLines = [...globalsWithoutComments.matchAll(/@import\s+"([^"]+)"\s*;/g)].map(
    (match) => match[1],
  );
  const expectedImportOrder = [
    "@viva/ui-web/styles.css",
    "./styles/base.css",
    "./styles/landing.css",
    "./styles/session.css",
  ];
  if (importLines.join(",") !== expectedImportOrder.join(",")) {
    errors.push(
      `globals.css imports must be exactly ${JSON.stringify(expectedImportOrder)} in that order, found ${JSON.stringify(
        importLines,
      )}`,
    );
  }
  if (globalsWithoutComments.includes("@viva/tokens/theme.css")) {
    errors.push(
      "globals.css must not import @viva/tokens/theme.css directly; the token sheet must enter the app once, through @viva/ui-web/styles.css's own dependency",
    );
  }

  const owners = [
    ["packages/ui-web/src/styles.css", uiWebStylesCss],
    ["apps/web/app/styles/base.css", baseCss],
    ["apps/web/app/styles/landing.css", landingCss],
    ["apps/web/app/styles/session.css", sessionCss],
  ];
  /** @type {Map<string, Map<string, string[]>>} selector -> body -> owner names */
  const bySelector = new Map();
  for (const [ownerName, cssText] of owners) {
    for (const { selector, body } of extractSelectorRules(cssText)) {
      const byBody = bySelector.get(selector) ?? new Map();
      const ownersForBody = byBody.get(body) ?? [];
      ownersForBody.push(ownerName);
      byBody.set(body, ownersForBody);
      bySelector.set(selector, byBody);
    }
  }
  for (const [selector, byBody] of bySelector) {
    for (const ownersForBody of byBody.values()) {
      const uniqueOwners = [...new Set(ownersForBody)];
      if (uniqueOwners.length > 1) {
        errors.push(
          `duplicate authority for selector "${selector}": the identical rule is authored in more than one owner (${uniqueOwners.join(
            ", ",
          )})`,
        );
      }
    }
  }

  // Task 2 Step 1's required partition: a selector matching one of
  // PARTITION_GROUPS's two closed-form patterns must be authored only in
  // that group's owner sheet. The one documented exception is a
  // `source-*` selector that is itself a *declared* `@viva/ui-web`
  // primitive (SourceChip) — that one may also live in `uiWebStylesCss`,
  // since it is real package styling, not a misplaced session selector.
  // An undeclared `source-*` class in `uiWebStylesCss` still fails, so
  // this carve-out cannot be used to smuggle an arbitrary session
  // selector into the package sheet.
  for (const [ownerName, cssText] of owners) {
    for (const { selector } of extractSelectorRules(cssText)) {
      const tokens = classTokens(selector);
      for (const group of PARTITION_GROUPS) {
        const matchingTokens = tokens.filter((token) => group.matches(token));
        if (matchingTokens.length === 0 || ownerName === group.owner) continue;
        const isDeclaredUiWebPrimitive =
          ownerName === "packages/ui-web/src/styles.css" &&
          matchingTokens.every((token) => requiredUiWebSelectors.includes(token));
        if (isDeclaredUiWebPrimitive) continue;
        errors.push(
          `selector "${selector}" in ${ownerName} matches the ${group.label} partition, which Task 2 assigns to ${group.owner}`,
        );
      }
    }
  }

  const uiWebSelectors = new Set(extractSelectorRules(uiWebStylesCss).map((rule) => rule.selector));
  const uiWebCssNoComments = uiWebStylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const className of requiredUiWebSelectors) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasBareSelector = uiWebSelectors.has(`.${className}`);
    const hasCompoundSelector = new RegExp(`\\.${escaped}(?![\\w-])`).test(uiWebCssNoComments);
    if (!hasBareSelector && !hasCompoundSelector) {
      errors.push(`@viva/ui-web primitive class ".${className}" has no selector in styles.css`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Splits a normalized declaration-body string (semicolon-separated, as
 * `extractSelectorRules` produces) into `{ property, value }` pairs.
 *
 * @param {string} body
 * @returns {{ property: string, value: string }[]}
 */
function splitDeclarations(body) {
  const declarations = [];
  for (const raw of body.split(";")) {
    const statement = raw.trim();
    if (!statement) continue;
    const colonIndex = statement.indexOf(":");
    if (colonIndex === -1) continue;
    declarations.push({
      property: statement.slice(0, colonIndex).trim(),
      value: statement.slice(colonIndex + 1).trim(),
    });
  }
  return declarations;
}

// Matches `var(--viva-ochre)` or `var(--viva-ochre, <fallback>)` exactly —
// never `var(--viva-ochre-text)`, whose "-text" suffix is not immediately
// followed by "," or ")", so it can never satisfy this pattern.
const BARE_OCHRE_VAR_PATTERN = /var\(\s*--viva-ochre\s*(?:,[^)]*)?\)/;

/**
 * Checks the ochre semantic-text-role invariant (`FRONTEND-002`, mounted
 * item 3): the decorative `--viva-ochre` custom property carries borders,
 * fills, and other non-text decoration, but real text — the `color`
 * property specifically — may only ever resolve through the AA-contrast
 * `--viva-ochre-text` token. `background`/`background-color`/`border*`/
 * `box-shadow`/`fill` declarations naming `--viva-ochre` are unaffected;
 * only the `color` property is checked, since that is what determines
 * rendered text color.
 *
 * @param {[string, string][]} cssSources array of `[ownerName, cssText]`
 */
function checkOchreTextRole(cssSources) {
  const errors = [];
  for (const [ownerName, cssText] of cssSources) {
    for (const { selector, body } of extractSelectorRules(cssText)) {
      for (const declaration of splitDeclarations(body)) {
        if (declaration.property !== "color") continue;
        if (BARE_OCHRE_VAR_PATTERN.test(declaration.value)) {
          errors.push(
            `${ownerName} selector "${selector}" sets text color: var(--viva-ochre), which is ` +
              "below AA contrast for text; use var(--viva-ochre-text) for the color property " +
              "(the brighter, decorative --viva-ochre stays valid for background/border/fill)",
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Prop-driven template-literal variants (`` `action-card--${accent}` ``
 * and similar) in `packages/ui-web/src/index.tsx` that a static regex
 * scan cannot resolve to a literal string. Each is cross-referenced
 * against that component's own prop union type in `index.tsx`, mirroring
 * `packages/ui-web/src/index.test.tsx`'s own coverage list.
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
 * Statically enumerates the class names `packages/ui-web/src/index.tsx`
 * emits via `className="literal"` and `className={...}` (plain strings,
 * template literals, and ternaries within the expression). A token
 * ending in `-` is a dangling template-prefix fragment (e.g.
 * `"action-card--"` left over from `` `action-card--${accent}` ``, never
 * a real class), so it is dropped rather than required.
 *
 * @param {string} source
 */
function emittedClassNames(source) {
  const found = new Set();
  const addTokens = (text) => {
    for (const token of text.split(/\s+/).filter(Boolean)) found.add(token);
  };
  for (const match of source.matchAll(/className="([^"]*)"/g)) addTokens(match[1]);
  const openTag = /className=\{/g;
  let open;
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

function requiredUiWebSelectorsFromSource(indexTsxSource) {
  const all = new Set([
    ...emittedClassNames(indexTsxSource),
    ...KNOWN_PROP_DRIVEN_VARIANT_CLASS_NAMES,
  ]);
  // `ActionCard`'s `primary` prop has emitted `action-card--primary` since
  // before this task's split (verified against the pre-Task-2
  // `globals.css` at HEAD) with no corresponding rule ever declared — a
  // pre-existing gap, not something this mechanical CSS-ownership move
  // introduced or is in scope to newly style.
  all.delete("action-card--primary");
  return [...all];
}

test("checkCssOwnership rejects an identical rule duplicated across owners (mastery-ring mutation)", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: ".mastery-ring {\n  height: 88px;\n  width: 88px;\n}\n",
    baseCss: "",
    landingCss: ".mastery-ring {\n  height: 88px;\n  width: 88px;\n}\n",
    sessionCss: "",
    requiredUiWebSelectors: ["mastery-ring"],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes("mastery-ring") && error.includes("duplicate authority"),
    ),
    `expected a duplicate-authority error naming mastery-ring, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkCssOwnership accepts the same selector layered with different declarations across two owners (source-chip)", () => {
  // packages/ui-web/src/styles.css's SourceChip primitive establishes the
  // base look; apps/web/app/styles/session.css separately refines the
  // *same* `.source-chip` class (shared with session's local
  // `StatusChip` sibling) at a later cascade position — a real, existing
  // layering, not a copy-pasted duplicate authority.
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: ".source-chip {\n  color: var(--viva-plum);\n  font-size: 0.76rem;\n}\n",
    baseCss: "",
    landingCss: "",
    sessionCss:
      ".source-chip {\n  background: rgba(222, 208, 241, 0.5);\n  color: var(--viva-amethyst-deep);\n}\n",
    requiredUiWebSelectors: ["source-chip"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("checkCssOwnership rejects a landing-owned selector authored outside landing.css", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: "",
    baseCss: "",
    landingCss: "",
    sessionCss: ".viva-hero__stray {\n  color: red;\n}\n",
    requiredUiWebSelectors: [],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes(".viva-hero__stray") && error.includes("apps/web/app/styles/landing.css"),
    ),
    `expected a partition error assigning .viva-hero__stray to landing.css, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkCssOwnership rejects a session-owned selector authored outside session.css", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: "",
    baseCss: "",
    landingCss: ".session-action {\n  color: red;\n}\n",
    sessionCss: "",
    requiredUiWebSelectors: [],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes(".session-action") && error.includes("apps/web/app/styles/session.css"),
    ),
    `expected a partition error assigning .session-action to session.css, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkCssOwnership rejects an undeclared source-* selector in styles.css, proving the SourceChip carve-out is scoped rather than a blanket hole", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: ".source-unlisted {\n  color: red;\n}\n",
    baseCss: "",
    landingCss: "",
    sessionCss: "",
    // Deliberately omits "source-unlisted" — only a *declared* ui-web
    // primitive (like the real "source-chip") gets the session-partition
    // carve-out below; an invented source-* class must not.
    requiredUiWebSelectors: [],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.includes(".source-unlisted") && error.includes("apps/web/app/styles/session.css"),
    ),
    `expected a partition error for the undeclared .source-unlisted, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkCssOwnership accepts landing- and session-owned selectors correctly placed, plus the declared source-chip primitive layered in styles.css", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: ".source-chip {\n  color: var(--viva-plum);\n}\n",
    baseCss: "",
    landingCss: ".viva-hero {\n  display: grid;\n}\n.viva-library__row {\n  display: flex;\n}\n",
    sessionCss:
      ".live-session {\n  display: grid;\n}\n.session-action {\n  border: 0;\n}\n.question-stage {\n  padding: 1rem;\n}\n.marginalia {\n  display: block;\n}\n.voice-trace {\n  display: block;\n}\n.source-chip {\n  background: rgba(0, 0, 0, 0.1);\n}\n",
    requiredUiWebSelectors: ["source-chip"],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkCssOwnership rejects a required @viva/ui-web primitive with no style", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: ".avatar {\n  display: inline-flex;\n}\n",
    baseCss: "",
    landingCss: "",
    sessionCss: "",
    requiredUiWebSelectors: ["avatar", "mastery-ring"],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes('".mastery-ring" has no selector')),
    `expected a missing-style error naming .mastery-ring, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkCssOwnership rejects a globals.css that still contains a selector block", () => {
  const result = checkCssOwnership({
    globalsCss:
      '@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\nbody { margin: 0; }\n',
    uiWebStylesCss: "",
    baseCss: "",
    landingCss: "",
    sessionCss: "",
    requiredUiWebSelectors: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("selector block")));
});

test("checkCssOwnership rejects the wrong import order and a lingering direct theme.css import", () => {
  const wrongOrder = checkCssOwnership({
    globalsCss: '@import "./styles/base.css";\n@import "@viva/ui-web/styles.css";\n',
    uiWebStylesCss: "",
    baseCss: "",
    landingCss: "",
    sessionCss: "",
    requiredUiWebSelectors: [],
  });
  assert.equal(wrongOrder.ok, false);
  assert.ok(wrongOrder.errors.some((error) => error.includes("imports must be exactly")));

  const lingeringTokenImport = checkCssOwnership({
    globalsCss:
      '@import "@viva/tokens/theme.css";\n@import "@viva/ui-web/styles.css";\n@import "./styles/base.css";\n@import "./styles/landing.css";\n@import "./styles/session.css";\n',
    uiWebStylesCss: "",
    baseCss: "",
    landingCss: "",
    sessionCss: "",
    requiredUiWebSelectors: [],
  });
  assert.equal(lingeringTokenImport.ok, false);
  assert.ok(
    lingeringTokenImport.errors.some((error) =>
      error.includes("must not import @viva/tokens/theme.css directly"),
    ),
  );
});

test("checkCssOwnership accepts the real, split repository CSS", () => {
  const readRepo = (relativePath) =>
    fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
  const indexTsxSource = readRepo("packages/ui-web/src/index.tsx");
  const result = checkCssOwnership({
    globalsCss: readRepo("apps/web/app/globals.css"),
    uiWebStylesCss: readRepo("packages/ui-web/src/styles.css"),
    baseCss: readRepo("apps/web/app/styles/base.css"),
    landingCss: readRepo("apps/web/app/styles/landing.css"),
    sessionCss: readRepo("apps/web/app/styles/session.css"),
    requiredUiWebSelectors: requiredUiWebSelectorsFromSource(indexTsxSource),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

/*
 * Ochre semantic-text-role checker (`FRONTEND-002`, Task 3): the decorative
 * `--viva-ochre` custom property may style borders/fills/backgrounds, but
 * real (`color`) text must resolve through the AA-contrast
 * `--viva-ochre-text` token instead.
 */

function readRepoFile(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("checkOchreTextRole rejects a selector that sets text color to the decorative --viva-ochre", () => {
  const result = checkOchreTextRole([
    [
      "apps/web/app/styles/session.css",
      ".student-hand__caveat {\n  color: var(--viva-ochre);\n}\n",
    ],
  ]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes(".student-hand__caveat") && error.includes("--viva-ochre"),
    ),
    `expected an error naming .student-hand__caveat, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkOchreTextRole does not let --viva-ochre-text's shared prefix escape the bare-token match", () => {
  // A naive `.includes("--viva-ochre")` check would false-positive on
  // "--viva-ochre-text" too, since it is a textual prefix of it. This proves
  // the checker distinguishes the two tokens correctly in both directions.
  const result = checkOchreTextRole([
    [
      "apps/web/app/styles/session.css",
      ".student-hand__caveat {\n  color: var(--viva-ochre-text);\n}\n",
    ],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkOchreTextRole accepts --viva-ochre used for non-text (background/border) declarations", () => {
  const result = checkOchreTextRole([
    [
      "apps/web/app/styles/session.css",
      '.turn-taking[data-phase="thinking"]::before {\n  background: var(--viva-ochre);\n}\n' +
        ".checklist__ring--partial {\n  border-color: var(--viva-ochre);\n}\n" +
        ".correction__retry-cue {\n  border-left: 2px solid var(--viva-ochre);\n}\n",
    ],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkOchreTextRole accepts the real, split repository CSS", () => {
  const result = checkOchreTextRole([
    ["packages/ui-web/src/styles.css", readRepoFile("packages/ui-web/src/styles.css")],
    ["apps/web/app/styles/base.css", readRepoFile("apps/web/app/styles/base.css")],
    ["apps/web/app/styles/landing.css", readRepoFile("apps/web/app/styles/landing.css")],
    ["apps/web/app/styles/session.css", readRepoFile("apps/web/app/styles/session.css")],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

/*
 * Self-hosted font provenance checker (`FRONTEND-007`, Task 4): see the
 * file header comment above.
 */

const FONT_PROVENANCE_BUDGET_BYTES = 300 * 1024;

/**
 * Derives the font "family" slug used to name a font's OFL license file
 * from a committed WOFF2 filename, e.g. `cormorant-latin-roman.woff2` and
 * `cormorant-latin-italic.woff2` both derive `cormorant`, and
 * `hanken-grotesk-latin.woff2` derives `hanken-grotesk` — this project's
 * `<family>-latin[-<variant>].woff2` naming convention (Task 4). An
 * unrecognized filename shape falls back to the filename itself (minus the
 * extension) so an unmatched OFL requirement is still reported rather than
 * silently skipped.
 *
 * @param {string} fontFileName
 */
function fontFamilySlug(fontFileName) {
  const match = fontFileName.match(/^(.+?)-latin(?:-[a-z0-9]+)?\.woff2$/i);
  return match ? match[1] : fontFileName.replace(/\.woff2$/i, "");
}

/**
 * Normalizes a font family slug or an OFL filename (e.g. `hanken-grotesk`
 * or `OFL-Hanken-Grotesk.txt`) to a lowercase, punctuation-free key so the
 * two naming conventions can be compared by substring containment without
 * requiring an exact case-conversion match.
 *
 * @param {string} name
 */
function normalizeFontFamilyKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parses `apps/web/app/fonts/PROVENANCE.md`:
 *
 * - the pinned upstream `google/fonts` commit: every distinct
 *   40-hex-character substring found anywhere in the text. There must be
 *   exactly one distinct value — a bare "first 40-hex string anywhere in
 *   the file" match would silently accept an incidental/unrelated
 *   hex-looking string, and would silently pick just one of two genuinely
 *   different recorded pins without ever noticing the ambiguity (a real
 *   correctness risk: a font re-fetched from a different revision than the
 *   one the document claims governs every committed file);
 * - one record per markdown table row that contains both a `*.woff2` or
 *   `*.txt` (OFL license) cell and a bare 64-hex-character SHA-256 cell —
 *   that record's source path is the row's first remaining cell that looks
 *   like a path (contains `/`), and WOFF2 rows and OFL rows are returned
 *   separately so each can be checked against the right committed-file map.
 *
 * Deliberately tolerant of surrounding markdown table syntax
 * (leading/trailing `|`, ``` ` ``` code-span backticks around cells,
 * header/separator rows, and extra columns such as a weight-range cell) so
 * the real, human-authored file does not need to match a brittle exact
 * format.
 *
 * @param {string} provenanceMd
 * @returns {{
 *   upstreamCommit: string | null,
 *   upstreamCommitCandidates: string[],
 *   records: Array<{ file: string, sourcePath: string, sha256: string }>,
 *   oflRecords: Array<{ file: string, sourcePath: string, sha256: string }>,
 * }}
 */
function parseFontProvenance(provenanceMd) {
  const upstreamCommitCandidates = [
    ...new Set(
      [...provenanceMd.matchAll(/\b([0-9a-f]{40})\b/gi)].map((match) => match[1].toLowerCase()),
    ),
  ];
  const records = [];
  const oflRecords = [];
  for (const line of provenanceMd.split("\n")) {
    const cells = line
      .split("|")
      .map((cell) =>
        cell
          .trim()
          .replace(/^`+|`+$/g, "")
          .trim(),
      )
      .filter((cell) => cell.length > 0);
    if (cells.length < 3) continue;
    const sha256 = cells.find((cell) => /^[0-9a-f]{64}$/i.test(cell));
    if (!sha256) continue;
    const woff2File = cells.find((cell) => /\.woff2$/i.test(cell));
    const oflFile = cells.find((cell) => /\.txt$/i.test(cell));
    const file = woff2File ?? oflFile;
    if (!file) continue;
    const sourcePath = cells.find((cell) => cell !== file && cell !== sha256 && cell.includes("/"));
    const record = { file, sourcePath: sourcePath ?? "", sha256: sha256.toLowerCase() };
    (woff2File ? records : oflRecords).push(record);
  }
  return {
    upstreamCommit: upstreamCommitCandidates.length === 1 ? upstreamCommitCandidates[0] : null,
    upstreamCommitCandidates,
    records,
    oflRecords,
  };
}

/**
 * @param {{
 *   provenanceMd: string | null,
 *   fontFiles: Map<string, Buffer>,
 *   oflFiles: Map<string, string>,
 * }} input
 */
function checkFontProvenance({ provenanceMd, fontFiles, oflFiles }) {
  const errors = [];
  if (!provenanceMd) {
    errors.push("apps/web/app/fonts/PROVENANCE.md is missing");
    return { ok: false, errors };
  }

  const { upstreamCommit, upstreamCommitCandidates, records, oflRecords } =
    parseFontProvenance(provenanceMd);
  if (!upstreamCommit) {
    if (upstreamCommitCandidates.length > 1) {
      errors.push(
        `PROVENANCE.md records more than one distinct 40-character commit SHA (${upstreamCommitCandidates.join(", ")}); every committed font must be pinned to the exact same upstream google/fonts revision`,
      );
    } else {
      errors.push("PROVENANCE.md does not record a 40-character upstream google/fonts commit SHA");
    }
  }
  if (records.length === 0) {
    errors.push("PROVENANCE.md records no committed-file/source-path/SHA-256 rows");
  }

  const recordedFiles = new Set();
  for (const record of records) {
    recordedFiles.add(record.file);
    const bytes = fontFiles.get(record.file);
    if (!bytes) {
      errors.push(`PROVENANCE.md records ${record.file} but no such file is committed`);
      continue;
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== record.sha256) {
      errors.push(
        `${record.file} sha256 is ${actualSha256} but PROVENANCE.md records ${record.sha256}`,
      );
    }
    if (!record.sourcePath.includes("/")) {
      errors.push(
        `PROVENANCE.md's source path for ${record.file} does not look like a real upstream path: "${record.sourcePath}"`,
      );
    }
  }

  let totalBytes = 0;
  for (const [file, bytes] of fontFiles) {
    totalBytes += bytes.length;
    if (!recordedFiles.has(file)) {
      errors.push(
        `${file} is committed under apps/web/app/fonts but not recorded in PROVENANCE.md`,
      );
    }
  }
  if (fontFiles.size === 0) {
    errors.push("no WOFF2 files are committed under apps/web/app/fonts");
  } else if (totalBytes > FONT_PROVENANCE_BUDGET_BYTES) {
    errors.push(
      `committed WOFF2 total is ${totalBytes} bytes, exceeds the ${FONT_PROVENANCE_BUDGET_BYTES}-byte (300 KiB) FRONTEND-007 budget`,
    );
  }

  // Every committed OFL file's recorded SHA-256 must actually match its
  // real bytes — otherwise PROVENANCE.md's OFL table is parsed but never
  // verified against the files it claims to describe (a swapped or
  // tampered-but-still-license-shaped OFL file would pass silently).
  const recordedOflFiles = new Set();
  for (const record of oflRecords) {
    recordedOflFiles.add(record.file);
    const content = oflFiles.get(record.file);
    if (content === undefined) {
      errors.push(`PROVENANCE.md records ${record.file} but no such file is committed`);
      continue;
    }
    const actualSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    if (actualSha256 !== record.sha256) {
      errors.push(
        `${record.file} sha256 is ${actualSha256} but PROVENANCE.md records ${record.sha256}`,
      );
    }
  }
  for (const name of oflFiles.keys()) {
    if (!recordedOflFiles.has(name)) {
      errors.push(
        `${name} is committed under apps/web/app/fonts but not recorded in PROVENANCE.md`,
      );
    }
  }

  // Every *committed* OFL file must look like real license text...
  for (const [name, content] of oflFiles) {
    if (!content || !/SIL OPEN FONT LICENSE/i.test(content)) {
      errors.push(`${name} does not look like a real committed OFL license text`);
    }
  }

  // ...and, independent of whether any OFL files are present at all (an
  // empty `oflFiles` map must not vacuously pass just because the loop
  // above never iterates), every font family implied by a *committed WOFF2
  // file* must have some matching committed OFL file. Derived from the
  // real WOFF2 filenames rather than from whatever PROVENANCE.md happens to
  // list, so deleting the OFL files (with or without also editing
  // PROVENANCE.md) cannot silently satisfy this gate.
  const oflFamilyKeys = [...oflFiles.keys()].map(normalizeFontFamilyKey);
  const requiredFamilies = new Set([...fontFiles.keys()].map(fontFamilySlug));
  for (const family of requiredFamilies) {
    const key = normalizeFontFamilyKey(family);
    if (!oflFamilyKeys.some((oflKey) => oflKey.includes(key))) {
      errors.push(
        `no committed OFL license text for font family "${family}" (expected a file such as OFL-<Family>.txt under apps/web/app/fonts)`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The fast, no-browser half of "no request host is fonts.googleapis.com or
 * fonts.gstatic.com" (`scripts/frontend-accessibility.mjs --assets` proves
 * the same thing by observing real network requests from a mounted page).
 *
 * @param {string} layoutTsxSource
 */
function checkNoRemoteFontLinks(layoutTsxSource) {
  const errors = [];
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(layoutTsxSource)) {
    errors.push(
      "apps/web/app/layout.tsx still references a Google Fonts host (fonts.googleapis.com/fonts.gstatic.com)",
    );
  }
  return { ok: errors.length === 0, errors };
}

test("checkFontProvenance rejects a missing PROVENANCE.md", () => {
  const result = checkFontProvenance({
    provenanceMd: null,
    fontFiles: new Map(),
    oflFiles: new Map(),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("PROVENANCE.md is missing")));
});

test("checkFontProvenance rejects a committed WOFF2 whose bytes do not match its recorded SHA-256", () => {
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const wrongSha256 = "0".repeat(64);
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${wrongSha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "...SIL OPEN FONT LICENSE Version 1.1..."]]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes("cormorant-latin-roman.woff2") && error.includes("sha256"),
    ),
  );
});

test("checkFontProvenance rejects a committed OFL license file whose bytes do not match its recorded SHA-256", () => {
  // The OFL table is a second, independently hash-verified record, not
  // merely parsed-and-ignored: a swapped/tampered OFL file must be caught
  // even though its content still passes the "looks like a real license"
  // regex check below.
  const oflContent = "...SIL OPEN FONT LICENSE Version 1.1...";
  const wrongOflSha256 = "0".repeat(64);
  const fontBytes = Buffer.from("stand-in font bytes, not a real font file");
  const fontSha256 = createHash("sha256").update(fontBytes).digest("hex");
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${fontSha256} |`,
    `| OFL-Cormorant.txt | ofl/cormorant/OFL.txt | ${wrongOflSha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", fontBytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", oflContent]]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("OFL-Cormorant.txt") && error.includes("sha256")),
  );
});

test("checkFontProvenance rejects a committed WOFF2 total over the 300 KiB FRONTEND-007 budget", () => {
  const big = Buffer.alloc(301 * 1024, 1);
  const sha256 = createHash("sha256").update(big).digest("hex");
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", big]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "...SIL OPEN FONT LICENSE Version 1.1..."]]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("300 KiB")));
});

test("checkFontProvenance rejects a font whose committed OFL license text does not look like a real license", () => {
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "TODO: paste the license here"]]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("OFL-Cormorant.txt")));
});

test("checkFontProvenance rejects a font whose family has no committed OFL license text", () => {
  // Regression test for a real adversarial-review finding: this exact test
  // name previously exercised a fixture with a *present* (but bogus-content)
  // OFL file, so it could never have caught a family with no OFL file
  // committed at all — the `oflFiles` map below is empty, which the old
  // implementation (a bare `for (const [name, content] of oflFiles)` loop)
  // would iterate zero times and vacuously accept.
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map(),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes("cormorant") && /no committed ofl license text/i.test(error),
    ),
    `expected a "no committed OFL license text" error naming the cormorant family, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkFontProvenance rejects a committed OFL file that is not recorded in PROVENANCE.md", () => {
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provenanceMd = [
    `pinned commit \`${"a".repeat(40)}\``,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "...SIL OPEN FONT LICENSE Version 1.1..."]]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes("OFL-Cormorant.txt") && error.includes("not recorded"),
    ),
  );
});

test("checkFontProvenance rejects a committed WOFF2 with no PROVENANCE.md row at all", () => {
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const provenanceMd = `pinned commit \`${"a".repeat(40)}\`\n(no table rows)`;
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "...SIL OPEN FONT LICENSE Version 1.1..."]]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (error) => error.includes("cormorant-latin-roman.woff2") && error.includes("not recorded"),
    ),
  );
});

test("checkFontProvenance rejects PROVENANCE.md recording more than one distinct upstream commit SHA", () => {
  // Not "any bare 40-hex string anywhere in the file": a document that
  // names two different revisions is ambiguous about which one actually
  // governs the committed files, and must be rejected rather than silently
  // accepting whichever candidate is found first.
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const commitA = "a".repeat(40);
  const commitB = "b".repeat(40);
  const provenanceMd = [
    `Upstream: google/fonts, pinned commit \`${commitA}\`.`,
    `Reproduction script pin: ${commitB}`,
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", "...SIL OPEN FONT LICENSE Version 1.1..."]]),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes(commitA) && error.includes(commitB)),
    `expected an error naming both distinct commit SHAs, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkFontProvenance accepts a correctly recorded WOFF2 under budget", () => {
  const bytes = Buffer.from("stand-in font bytes, not a real font file");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const oflContent = "...SIL OPEN FONT LICENSE Version 1.1...";
  const oflSha256 = createHash("sha256").update(oflContent, "utf8").digest("hex");
  const provenanceMd = [
    `Upstream: google/fonts, pinned commit \`${"a".repeat(40)}\`.`,
    "",
    "| Committed file | Upstream source path | SHA-256 |",
    "| --- | --- | --- |",
    `| cormorant-latin-roman.woff2 | ofl/cormorant/Cormorant[wght].ttf | ${sha256} |`,
    "",
    "| Committed OFL license text | Upstream source path | SHA-256 |",
    "| --- | --- | --- |",
    `| OFL-Cormorant.txt | ofl/cormorant/OFL.txt | ${oflSha256} |`,
  ].join("\n");
  const result = checkFontProvenance({
    provenanceMd,
    fontFiles: new Map([["cormorant-latin-roman.woff2", bytes]]),
    oflFiles: new Map([["OFL-Cormorant.txt", oflContent]]),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkFontProvenance accepts the real committed font provenance", () => {
  const fontsDirUrl = new URL("../apps/web/app/fonts/", import.meta.url);
  const provenanceMd = fs.readFileSync(new URL("PROVENANCE.md", fontsDirUrl), "utf8");
  const fontFiles = new Map();
  const oflFiles = new Map();
  for (const entry of fs.readdirSync(fileURLToPath(fontsDirUrl))) {
    if (entry.endsWith(".woff2")) {
      fontFiles.set(entry, fs.readFileSync(new URL(entry, fontsDirUrl)));
    } else if (entry.startsWith("OFL-")) {
      oflFiles.set(entry, fs.readFileSync(new URL(entry, fontsDirUrl), "utf8"));
    }
  }
  const result = checkFontProvenance({ provenanceMd, fontFiles, oflFiles });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkFontProvenance rejects the real committed fonts when every OFL license file is missing", () => {
  // Direct regression test for the adversarial-review finding: deleting
  // every committed `apps/web/app/fonts/OFL-*.txt` file while leaving the
  // WOFF2 binaries in place must fail this gate on the real repository
  // state, not vacuously pass.
  const fontsDirUrl = new URL("../apps/web/app/fonts/", import.meta.url);
  const provenanceMd = fs.readFileSync(new URL("PROVENANCE.md", fontsDirUrl), "utf8");
  const fontFiles = new Map();
  for (const entry of fs.readdirSync(fileURLToPath(fontsDirUrl))) {
    if (entry.endsWith(".woff2")) {
      fontFiles.set(entry, fs.readFileSync(new URL(entry, fontsDirUrl)));
    }
  }
  const result = checkFontProvenance({ provenanceMd, fontFiles, oflFiles: new Map() });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => /no committed ofl license text/i.test(error)),
    `expected a "no committed OFL license text" error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkNoRemoteFontLinks rejects a layout source that still links fonts.googleapis.com", () => {
  const result = checkNoRemoteFontLinks(
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant" rel="stylesheet" />',
  );
  assert.equal(result.ok, false);
});

test("checkNoRemoteFontLinks rejects a layout source that still preconnects to fonts.gstatic.com", () => {
  const result = checkNoRemoteFontLinks(
    '<link crossOrigin="anonymous" href="https://fonts.gstatic.com" rel="preconnect" />',
  );
  assert.equal(result.ok, false);
});

test("checkNoRemoteFontLinks accepts the real, self-hosted layout.tsx", () => {
  const layoutSource = readRepoFile("apps/web/app/layout.tsx");
  const result = checkNoRemoteFontLinks(layoutSource);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

/*
 * Touch-target size checker (`FRONTEND-012`, Task 7): the static,
 * no-browser half of `error.tsx`'s "Try again" button's 44x44 CSS px
 * touch-target claim. See `checkTargetSize`'s own doc comment for why this
 * one button is proven statically here instead of by
 * `scripts/frontend-accessibility.mjs`.
 */

/**
 * Resolves a single CSS length declaration to a numeric CSS px value.
 * Supports bare `px`/`rem` literals (16px root — the browser default this
 * app relies on everywhere; nothing in `apps/web/app/styles/base.css`
 * overrides `html`'s font-size, matching `--viva-target-min: 44px` ==
 * `2.75rem` elsewhere in this file) and `var(--custom-property[,
 * fallback])`, resolved against `tokenLiterals` and falling back to the
 * `var()`'s own fallback argument when the referenced token is absent from
 * `tokenLiterals`. Returns `null` — never `0` or a guess — for anything
 * this cannot reduce to a literal number, so "unresolvable" and "resolved
 * but insufficient" stay distinct, explicit failure states.
 *
 * @param {string} value
 * @param {Record<string, string>} tokenLiterals
 * @returns {number | null}
 */
function resolveLengthPx(value, tokenLiterals) {
  const trimmed = value.trim();
  const pxMatch = /^(-?[\d.]+)px$/.exec(trimmed);
  if (pxMatch) return Number.parseFloat(pxMatch[1]);
  const remMatch = /^(-?[\d.]+)rem$/.exec(trimmed);
  if (remMatch) return Number.parseFloat(remMatch[1]) * 16;
  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(trimmed);
  if (varMatch) {
    const [, tokenName, fallback] = varMatch;
    if (tokenLiterals[tokenName] !== undefined) {
      return resolveLengthPx(tokenLiterals[tokenName], tokenLiterals);
    }
    if (fallback !== undefined) return resolveLengthPx(fallback, tokenLiterals);
  }
  return null;
}

const BLOCK_SIZE_PROPERTIES = new Set(["min-height", "min-block-size", "height", "block-size"]);
const CAPPING_INLINE_SIZE_PROPERTIES = new Set([
  "width",
  "max-width",
  "inline-size",
  "max-inline-size",
]);

/**
 * The static, no-browser half of the `FRONTEND-012` 44x44 touch-target
 * claim for `error.tsx`'s "Try again" button — the one actionable control
 * in this codebase `scripts/frontend-accessibility.mjs` cannot mount,
 * since Next's global error boundary only renders after a real
 * render-time exception, which the Playwright harness's normal page
 * navigation never triggers.
 *
 * Resolves every `min-height`/`min-block-size`/`height`/`block-size`
 * declaration across every *exact* class-selector match (e.g. `.button`,
 * `.button-primary`) in the given CSS sources, and requires at least one
 * to resolve to `>= minPx`. Separately rejects any `width`/`max-width`/
 * `inline-size`/`max-inline-size` declaration on those same selectors that
 * resolves below `minPx`, so a future "compact" variant cannot silently
 * cap the button under the target size. Also rejects a selector named in
 * `selectors` that has no rule at all in the given sources — a silent,
 * vacuous pass would be worse than no check.
 *
 * The inline (width) dimension for *this specific* button is guaranteed
 * in practice by its fixed, non-empty "Try again" label plus `.button`'s
 * horizontal padding; real rendered text width is not re-derived here,
 * since this file has no layout engine. Every *other* 44px button target
 * in this codebase is proven the way this one's height claim is
 * structurally unreachable for: `scripts/frontend-accessibility.mjs
 * --owned-surfaces`'s real Playwright-measured bounding boxes.
 *
 * @param {[string, string][]} cssSources array of `[ownerName, cssText]`
 * @param {{ selectors: string[], minPx: number, tokenLiterals?: Record<string, string> }} target
 */
function checkTargetSize(cssSources, { selectors, minPx, tokenLiterals = {} }) {
  const errors = [];
  const selectorSet = new Set(selectors);
  const foundSelectors = new Set();
  let bestBlockSizePx = null;

  for (const [ownerName, cssText] of cssSources) {
    for (const { selector, body } of extractSelectorRules(cssText)) {
      if (!selectorSet.has(selector)) continue;
      foundSelectors.add(selector);
      for (const declaration of splitDeclarations(body)) {
        const property = declaration.property.toLowerCase();
        if (BLOCK_SIZE_PROPERTIES.has(property)) {
          const resolved = resolveLengthPx(declaration.value, tokenLiterals);
          if (resolved === null) {
            errors.push(
              `${ownerName} selector "${selector}" declares ${property}: ${declaration.value}, which does not resolve to a literal px/rem/var() value`,
            );
          } else if (bestBlockSizePx === null || resolved > bestBlockSizePx) {
            bestBlockSizePx = resolved;
          }
        } else if (CAPPING_INLINE_SIZE_PROPERTIES.has(property)) {
          const resolved = resolveLengthPx(declaration.value, tokenLiterals);
          if (resolved !== null && resolved < minPx) {
            errors.push(
              `${ownerName} selector "${selector}" caps ${property} at ${resolved}px, below the required ${minPx}px target`,
            );
          }
        }
      }
    }
  }

  for (const selector of selectors) {
    if (!foundSelectors.has(selector)) {
      errors.push(`no rule for selector "${selector}" was found in the given CSS sources`);
    }
  }

  if (bestBlockSizePx === null) {
    errors.push(
      `none of [${selectors.join(", ")}] declares a min-height/min-block-size/height/block-size resolving to a literal px value`,
    );
  } else if (bestBlockSizePx < minPx) {
    errors.push(
      `[${selectors.join(", ")}] resolves to a ${bestBlockSizePx}px block size, below the required ${minPx}px target`,
    );
  }

  return { ok: errors.length === 0, errors, resolvedBlockSizePx: bestBlockSizePx };
}

test("checkTargetSize rejects a min-height that resolves below the target, naming the resolved px value", () => {
  const fixture = `.button { min-height: 2.2rem; }`;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button"],
    minPx: 44,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("35.2")),
    `expected an error naming the resolved 35.2px value, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkTargetSize accepts a literal rem min-height that resolves to exactly the target", () => {
  const fixture = `.button { min-height: 2.75rem; }`;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button"],
    minPx: 44,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.resolvedBlockSizePx, 44);
});

test("checkTargetSize resolves var(--viva-target-min) against the supplied token literal", () => {
  const fixture = `.button-primary { min-height: var(--viva-target-min); }`;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button-primary"],
    minPx: 44,
    tokenLiterals: { "--viva-target-min": "44px" },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("checkTargetSize rejects a width cap below the target even when min-height is sufficient", () => {
  const fixture = `
    .button { min-height: 2.75rem; }
    .button-primary { max-width: 32px; }
  `;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button", ".button-primary"],
    minPx: 44,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("max-width") && error.includes("32")),
    `expected an error naming the max-width cap, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkTargetSize rejects selectors that are present but declare no block-size constraint at all", () => {
  const fixture = `
    .button { color: blue; }
    .button-primary { color: red; }
  `;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button", ".button-primary"],
    minPx: 44,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("none of")),
    `expected a "none of [...] declares" error, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkTargetSize rejects a selector missing from the given CSS sources entirely", () => {
  const fixture = `.button { min-height: 2.75rem; }`;
  const result = checkTargetSize([["fixture", fixture]], {
    selectors: [".button", ".button-nonexistent"],
    minPx: 44,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes(".button-nonexistent")),
    `expected an error naming the missing .button-nonexistent selector, got: ${JSON.stringify(result.errors)}`,
  );
});

test("checkTargetSize accepts the real, committed .button/.button-primary rules error.tsx's Try again button uses", () => {
  const baseCss = readRepoFile("apps/web/app/styles/base.css");
  const uiWebStylesCss = readRepoFile("packages/ui-web/src/styles.css");
  const result = checkTargetSize(
    [
      ["apps/web/app/styles/base.css", baseCss],
      ["packages/ui-web/src/styles.css", uiWebStylesCss],
    ],
    { selectors: [".button", ".button-primary"], minPx: 44 },
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(
    result.resolvedBlockSizePx >= 44,
    `expected the real .button/.button-primary rules to resolve to >= 44px, got: ${result.resolvedBlockSizePx}`,
  );
});
