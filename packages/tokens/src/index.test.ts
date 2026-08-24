import { describe, expect, test } from "bun:test";
import {
  vivaColorTokens,
  vivaRadiusTokens,
  vivaTargetMinToken,
  vivaTypographyTokens,
} from "./index";

/**
 * These tests read the real `theme.css` authority (not a copy/fixture) and
 * assert structural invariants about it, so the exported token names and
 * the CSS file itself can never drift apart undetected. Read via `fetch`
 * against a `file://` URL (Bun supports local-file `fetch`) rather than
 * `node:fs`/`node:url`, which this package does not declare ambient types
 * for.
 */

const themeCss = await fetch(new URL("./theme.css", import.meta.url)).then((response) =>
  response.text(),
);

type Declaration = { name: string; value: string };

// Parses every `:root { ... }` block in the source (a stylesheet may
// legally contain more than one, and every one contributes to the cascade,
// so reading only the first would miss a declaration reintroduced in a
// later block). Comments are stripped from the *entire* source before any
// `:root` matching happens, so a comment containing literal text like
// ":root {" cannot hijack block boundaries either.
function parseRootDeclarations(css: string): Declaration[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations: Declaration[] = [];
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

function isLiteralValue(value: string): boolean {
  return !value.startsWith("var(");
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = [channel(r), channel(g), channel(b)];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2.x contrast ratio between two hex colors. */
function contrastRatio(hexA: string, hexB: string): number {
  const luminanceA = relativeLuminance(hexToRgb(hexA));
  const luminanceB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] =
    luminanceA > luminanceB ? [luminanceA, luminanceB] : [luminanceB, luminanceA];
  return (lighter + 0.05) / (darker + 0.05);
}

const declarations = parseRootDeclarations(themeCss);
const declarationsByName = new Map<string, Declaration[]>();
for (const declaration of declarations) {
  const existing = declarationsByName.get(declaration.name) ?? [];
  existing.push(declaration);
  declarationsByName.set(declaration.name, existing);
}

function literalValueOf(name: string): string {
  const [declaration] = declarationsByName.get(name) ?? [];
  if (!declaration) {
    throw new Error(`theme.css does not declare ${name}`);
  }
  return declaration.value;
}

describe("@viva/tokens theme.css authority", () => {
  test("every exported token name resolves to exactly one declared CSS custom property", () => {
    const exportedNames = [
      ...Object.values(vivaColorTokens),
      ...Object.values(vivaRadiusTokens),
      ...Object.values(vivaTypographyTokens),
      vivaTargetMinToken,
    ];
    for (const name of exportedNames) {
      const occurrences = declarationsByName.get(name) ?? [];
      expect(occurrences.length).toBe(1);
    }
  });

  test("no custom property has more than one literal (non-alias) declaration", () => {
    for (const occurrences of declarationsByName.values()) {
      const literalCount = occurrences.filter((declaration) =>
        isLiteralValue(declaration.value),
      ).length;
      expect(literalCount).toBeLessThanOrEqual(1);
    }
  });

  test("legacy short names are implemented only as var(--viva-...) aliases", () => {
    const legacyAliasNames = ["--paper", "--ink", "--plum", "--serif", "--sans"];
    for (const name of legacyAliasNames) {
      const occurrences = declarationsByName.get(name) ?? [];
      expect(occurrences.length).toBe(1);
      const [declaration] = occurrences;
      if (!declaration) {
        throw new Error(`theme.css does not declare ${name}`);
      }
      expect(declaration.value.startsWith("var(--viva-")).toBe(true);
    }
  });

  test("--viva-ochre-text has at least 4.5:1 contrast against --viva-paper and --viva-bg-soft", () => {
    const ochreText = literalValueOf("--viva-ochre-text");
    const paper = literalValueOf("--viva-paper");
    const bgSoft = literalValueOf("--viva-bg-soft");
    expect(contrastRatio(ochreText, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ochreText, bgSoft)).toBeGreaterThanOrEqual(4.5);
  });

  test("--viva-target-min is exactly 44px", () => {
    expect(literalValueOf("--viva-target-min")).toBe("44px");
  });

  test("serif/sans tokens resolve through --viva-font-serif/--viva-font-sans with the current family stack as fallback", () => {
    expect(literalValueOf("--viva-serif")).toBe(
      'var(--viva-font-serif, "Cormorant", Georgia, serif)',
    );
    expect(literalValueOf("--viva-sans")).toBe(
      'var(--viva-font-sans, "Hanken Grotesk", "Avenir Next", -apple-system, BlinkMacSystemFont, sans-serif)',
    );
  });

  test("no remote font-loading declaration appears in theme.css", () => {
    expect(/@import\s+url\(/i.test(themeCss)).toBe(false);
    expect(/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(themeCss)).toBe(false);
  });
});
