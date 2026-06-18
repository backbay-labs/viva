# BAC-330 Source Folio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render trusted `source_reference` events as bounded Source Folio museum labels in the right-margin manuscript, with honest low-confidence/conflicting/unavailable states.

**Architecture:** The shared protocol already validates `source_reference`; the web client already folds those events into `VivaAgentDerivedState.sources`. Add a pure projection helper that chooses the latest trusted source event, overlays current concept status from the active evaluation or question concept, and classifies confidence/caveat states without inventing render instructions. `SourceFolio` renders the resulting data in the margin and keeps the current question fallback only when no source event has arrived.

**Tech Stack:** Bun tests, React server rendering tests, TypeScript in `apps/web`, existing CSS in `apps/web/app/globals.css`, no new runtime dependencies.

---

### Task 1: Project Source Folio Data

**Files:**
- Modify: `apps/web/lib/viva-session-projection.ts`
- Modify: `apps/web/lib/viva-session-projection.test.ts`

- [ ] **Step 1: Write the failing projection tests**

Add imports and tests covering source present, low confidence, conflicting source, and unavailable source.

```ts
import {
  projectSourceFolio,
  // existing imports...
} from "./viva-session-projection";

describe("projectSourceFolio", () => {
  test("uses the latest source_reference event as the bounded museum label", () => {
    const folio = projectSourceFolio(
      derived({
        phase: "correction",
        question,
        evaluation: evaluation({ conceptStatus: "shaky" }),
        sources: [
          {
            ...source,
            sourceId: "src-lecture-5-slide-18",
            documentId: "lec-5",
            span: "slide:18",
          },
        ],
      }),
      NOW,
    );

    expect(folio.state).toBe("present");
    expect(folio.source.sourceId).toBe("src-lecture-5-slide-18");
    expect(folio.conceptStatus).toContain("Shaky");
    expect(folio.regionNavigation).toBe("Document span only; exact page/bbox navigation is unverified.");
  });

  test("labels low-confidence source material honestly", () => {
    const folio = projectSourceFolio(
      derived({
        question,
        evaluation: evaluation({
          label: "insufficient evidence",
          source: { ...source, confidence: "low", retrievalReason: "retrieval confidence below threshold" },
        }),
      }),
      NOW,
    );

    expect(folio.state).toBe("low_confidence");
    expect(folio.confidenceLabel).toContain("Low confidence");
    expect(folio.caveat).toContain("retrieval confidence below threshold");
  });

  test("labels conflicting source material as a caveat", () => {
    const folio = projectSourceFolio(
      derived({
        question,
        evaluation: evaluation({
          label: "insufficient evidence",
          source: { ...source, confidence: "medium", retrievalReason: "conflicting source spans disagree" },
        }),
      }),
      NOW,
    );

    expect(folio.state).toBe("conflicting");
    expect(folio.caveat).toContain("Conflicting source material");
  });

  test("records source unavailable without exposing fallback document text", () => {
    const folio = projectSourceFolio(
      derived({
        question: {
          ...question,
          source: { label: "", excerpt: "", confidence: "low" },
        },
      }),
      NOW,
    );

    expect(folio.state).toBe("unavailable");
    expect(folio.source.excerpt).toBe("");
    expect(folio.caveat).toContain("No bounded source_reference");
  });
});
```

- [ ] **Step 2: Run the projection test to verify RED**

Run: `bun test apps/web/lib/viva-session-projection.test.ts`

Expected: FAIL because `projectSourceFolio` is not exported.

- [ ] **Step 3: Implement the pure projection**

Add exported types and helper near `projectSessionQuestion`.

```ts
export type SourceFolioState = "present" | "low_confidence" | "conflicting" | "unavailable";

export type SourceFolioProjection = {
  state: SourceFolioState;
  source: SourceReference;
  conceptStatus: string;
  confidenceLabel: string;
  caveat: string;
  challengeLabel: string;
  regionNavigation: string;
};

export function projectSourceFolio(
  derived: VivaAgentDerivedState,
  now: Date,
): SourceFolioProjection {
  const source = latestBoundedSource(derived);
  if (!source || !source.excerpt.trim()) {
    return {
      state: "unavailable",
      source: { label: "Source unavailable", excerpt: "", confidence: "low" },
      conceptStatus: "Source status unavailable",
      confidenceLabel: "Source unavailable",
      caveat: "No bounded source_reference has arrived for this correction.",
      challengeLabel: "Challenge unavailable source",
      regionNavigation: "Document span only; exact page/bbox navigation is unverified.",
    };
  }

  const state = sourceFolioState(source, derived.evaluation?.label);
  return {
    state,
    source,
    conceptStatus: derived.evaluation
      ? conceptStatusVerdict(derived.evaluation.conceptStatus, now)
      : "Awaiting concept status",
    confidenceLabel: sourceConfidenceLabel(source.confidence),
    caveat: sourceFolioCaveat(source, state),
    challengeLabel: "Challenge citation",
    regionNavigation: "Document span only; exact page/bbox navigation is unverified.",
  };
}
```

- [ ] **Step 4: Run the projection test to verify GREEN**

Run: `bun test apps/web/lib/viva-session-projection.test.ts`

Expected: PASS.

### Task 2: Render Source Folio Marginalia

**Files:**
- Modify: `apps/web/components/session/SourceFolio.tsx`
- Modify: `apps/web/components/session/MarginaliaPanel.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`

- [ ] **Step 1: Write the failing render tests**

Add a fixture `sourceFolio` and render `MarginaliaPanel state="source" sourceFolio={sourceFolio}`.

```tsx
expect(markup).toContain("Source Folio");
expect(markup).toContain("Low confidence");
expect(markup).toContain("Conflicting source material");
expect(markup).toContain("Document span only");
expect(markup).toContain("Challenge citation");
expect(markup).not.toContain("page/bbox");
expect(markup).not.toContain("Full document");
```

- [ ] **Step 2: Run the render test to verify RED**

Run: `bun test apps/web/components/session/LiveSessionShell.test.tsx`

Expected: FAIL because `MarginaliaPanel` does not accept or render `sourceFolio`.

- [ ] **Step 3: Update props and rendering**

Thread `sourceFolio?: SourceFolioProjection` through `LiveSessionPage -> LiveSessionShell -> MarginaliaPanel -> SourceFolio`. `LiveSessionPage` computes it with `projectSourceFolio(agent.derived, sessionStart)`.

`SourceFolio` should:
- render `Source Folio`
- render source label, concept status, confidence label, bounded excerpt, caveat, and document-span note
- render a `Challenge citation` button
- keep the existing `Back to question` button for non-recap source view
- not render a generic PDF/document viewer

- [ ] **Step 4: Run render tests to verify GREEN**

Run: `bun test apps/web/components/session/LiveSessionShell.test.tsx`

Expected: PASS.

### Task 3: Browser Evidence And Full Gates

**Files:**
- Modify: `scripts/e2e-browser.mjs`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Add browser evidence assertion**

After the checked answer path, make the browser story open the source folio if needed and assert:

```js
await page.getByRole("button", { name: "Show source" }).click().catch(() => {});
const sourceFolioVisible = await isVisible(page.getByText("Source Folio"));
const boundedSourceVisible = await isVisible(page.getByText("Document span only", { exact: false }));
```

Record `source_folio_visible` and `bounded_source_visible` in `result.json`; fail if either is false on the checked-answer path.

- [ ] **Step 2: Style without layout churn**

Extend existing `.folio` CSS with small label rows, caveat blocks, and a muted challenge affordance. Keep text sizes compact and avoid nested cards.

- [ ] **Step 3: Run targeted verification**

Run:

```bash
bun test apps/web/lib/viva-session-projection.test.ts apps/web/components/session/LiveSessionShell.test.tsx
bun run e2e:browser
```

Expected: all pass, `result.json` includes `source_folio_visible: true` and `bounded_source_visible: true`.

- [ ] **Step 4: Run full completion gates**

Run:

```bash
bun test apps/web/lib/*.test.ts apps/web/components/**/*.test.tsx
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
git diff --check
bun run validate
bun run release:check
```

Expected: all pass before PR.

### Task 4: PR, Review, Merge, Linear Closeout

**Files:**
- GitHub PR for branch `connor/bac-330-source-folio`
- Linear issue `BAC-330`

- [ ] **Step 1: Commit**

Run:

```bash
git add apps/web/lib/viva-session-projection.ts apps/web/lib/viva-session-projection.test.ts apps/web/components/session/SourceFolio.tsx apps/web/components/session/MarginaliaPanel.tsx apps/web/components/session/LiveSessionShell.tsx apps/web/components/session/LiveSessionPage.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/app/globals.css scripts/e2e-browser.mjs docs/superpowers/plans/2026-06-18-bac-330-source-folio.md
git commit -m "feat: render source folio marginalia

Co-Authored-By: Codex <codex@openai.com>"
```

- [ ] **Step 2: Open PR**

Run `gh pr create` with a body containing the acceptance checklist, verification evidence, and `Generated-with: Codex`.

- [ ] **Step 3: Request review and resolve feedback**

Run a subagent code review against `origin/main...HEAD`, then resolve every important finding. Query GitHub GraphQL `reviewThreads` and resolve all actionable bot threads after fixes.

- [ ] **Step 4: Merge and close Linear**

After local gates pass, review threads are resolved, and hosted checks are understood, merge the PR. Then move `BAC-330` to Done with a comment listing PR, files, and verification commands.
