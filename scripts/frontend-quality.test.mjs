import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Frontend quality: static, source-level checks over the frontend's CSS
 * authority. Unlike `scripts/frontend-accessibility.mjs` (which mounts real
 * pages in a browser), everything here runs against CSS source text with
 * plain Node — no build step, no DOM.
 *
 * `checkTokenAuthority` is the one-token-authority checker
 * (`FRONTEND-001`): it rejects a `:root` block that declares the same
 * custom property with more than one literal (non-`var()`) value, and it
 * rejects insufficient contrast for the ochre-on-paper text role. Later
 * tasks extend this file with CSS-ownership and asset checks; they must
 * keep reusing this checker rather than re-implementing its parsing.
 */

const MINIMUM_OCHRE_TEXT_CONTRAST = 4.5;

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
 * property, and sufficient ochre-text/paper contrast.
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

  const ochreText = byName.get("--viva-ochre-text")?.[0];
  const paper = byName.get("--viva-paper")?.[0];
  if (ochreText && paper && isLiteralValue(ochreText.value) && isLiteralValue(paper.value)) {
    const ratio = contrastRatio(ochreText.value, paper.value);
    contrastRatios["--viva-ochre-text on --viva-paper"] = ratio;
    if (ratio < MINIMUM_OCHRE_TEXT_CONTRAST) {
      errors.push(
        `--viva-ochre-text (${ochreText.value}) on --viva-paper (${paper.value}) contrast is ${ratio.toFixed(
          2,
        )}:1, below the required ${MINIMUM_OCHRE_TEXT_CONTRAST}:1`,
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
