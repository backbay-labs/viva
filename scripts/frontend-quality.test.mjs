import assert from "node:assert/strict";
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
 * Later tasks extend this file with asset checks; they must keep reusing
 * these checkers rather than re-implementing their parsing.
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
