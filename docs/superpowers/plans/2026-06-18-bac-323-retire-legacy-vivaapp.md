# BAC-323 Retire Legacy VivaApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the legacy three-mode `VivaApp` path so `/session` is the single event-driven Listening Manuscript entry point while preserving the no-key synthetic Conductor fallback.

**Architecture:** The landing hero remains the front door, but entering it routes to `/session` instead of mounting `components/viva/VivaApp`. Legacy local-demo helpers/tests owned only by `VivaApp` are deleted. Browser E2E is narrowed to the current product path: landing -> `/session` -> fake-provider Conductor recap, with assertions that local-only share/schedule actions are absent.

**Tech Stack:** Next.js App Router, React server-render tests with Bun, Playwright browser smoke script, Rust agent fake provider.

---

### Task 1: Landing Entry Targets `/session`

**Files:**
- Modify: `apps/web/components/landing/LandingEntry.tsx`
- Create: `apps/web/components/landing/LandingEntry.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
test("routes command and suggestion directly to /session", () => {
  const intents: string[] = [];
  const element = LandingEntry({ onEnter: (intent) => intents.push(intent) }) as ReactElement<
    LandingHeroProps
  >;

  element.props.onSubmit("oxidative phosphorylation");
  element.props.onSuggestion("Review missed concepts");

  expect(landingEntryTarget()).toBe("/session");
  expect(intents).toEqual(["oxidative phosphorylation", "Review missed concepts"]);
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test apps/web/components/landing/LandingEntry.test.tsx`

Expected: fail because `LandingEntry` currently does not export `landingEntryTarget`, and entering renders `VivaApp` via state.

- [ ] **Step 3: Implement minimal landing routing**

Replace `VivaApp` state with:

```tsx
export function landingEntryTarget(): string {
  return "/session";
}

export function LandingEntry({ onEnter = enterSession }: { onEnter?: (intent: string) => void }) {
  return <LandingHero onSubmit={onEnter} onSuggestion={onEnter} />;
}

function enterSession() {
  window.location.assign(landingEntryTarget());
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test apps/web/components/landing/LandingEntry.test.tsx`

Expected: pass.

### Task 2: Remove Legacy VivaApp-Only Surfaces

**Files:**
- Delete: `apps/web/components/viva/VivaApp.tsx`
- Delete: `apps/web/components/viva/VivaApp.test.tsx`
- Delete if unused: `apps/web/lib/viva-connected-actions.ts`
- Delete if unused: `apps/web/lib/viva-connected-actions.test.ts`
- Delete if unused: `apps/web/lib/viva-connected-lifecycle.ts`
- Delete if unused: `apps/web/lib/viva-connected-lifecycle.test.ts`
- Delete: `apps/web/lib/viva-flow.test.ts`

- [ ] **Step 1: Prove references are gone**

Run: `rg -n "VivaApp|local-demo|connected-agent|buildSessionRecap\\(|evaluateAnswer\\(" apps/web`

Expected after implementation: no app references to deleted legacy mode code.

- [ ] **Step 2: Delete unused files**

Remove the files listed above after confirming no remaining imports.

- [ ] **Step 3: Verify web tests**

Run: `bun test apps/web/lib/*.test.ts apps/web/components/**/*.test.tsx`

Expected: pass with no unresolved imports.

### Task 3: Update Browser Evidence Path

**Files:**
- Modify: `scripts/e2e-browser.mjs`

- [ ] **Step 1: Replace old upload/local-demo journey**

Navigate to the landing page, enter `/session`, wait for the fake-provider manuscript, submit the connected turn, and wait for recap/terminal source state.

- [ ] **Step 2: Assert local-only actions absent**

Keep checks for absent `Share` and schedule buttons in the connected session path.

- [ ] **Step 3: Verify browser smoke**

Run: `bun run e2e:browser`

Expected: JSON result with `local_only_actions_hidden: true`; if hosted Playwright browser is missing locally, run equivalent system-Chrome verification and record that explicitly.

### Task 4: Full Gate And PR

**Files:**
- No new implementation files.

- [ ] **Step 1: Run gates**

Run:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
git diff --check
bun run validate
```

- [ ] **Step 2: PR loop**

Commit with `Co-Authored-By`, open PR with `Generated-with`, run subagent review, resolve all GitHub reviewThreads, merge, delete remote branch, and mark BAC-323 Done with evidence.
