# Viva Frontend Accessibility and Performance Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before closeout. Execute one task at a time, preserve unrelated work, and stage only the paths named by the current task.

**Goal:** Make Viva's landing/library and shared visual system honest, accessible, self-hosted, and measurably responsive without changing live-session orchestration, protocol authority, or Plan 14's cross-package build orchestration.

**Architecture:** CSS custom properties in `@viva/tokens` become the single runtime design-token authority. `@viva/ui-web` owns the styles required by its exported primitives, while the app owns small base, landing/library, and session surface sheets instead of one 4,864-line global file. The landing page keeps real DOM copy and one decorative Muse canvas; the live page keeps its foreground trace but receives session semantics through plan 10. Browser-mounted accessibility checks and a production-build, CPU-throttled performance script enforce the contract.

**Tech Stack:** Next.js App Router 16, React 19, Bun tests, Playwright Chromium/CDP, CSS custom properties, `next/font/local`, Canvas 2D.

**Spec:** `docs/superpowers/reviews/2026-08-23-frontend-review.md`, `docs/superpowers/reviews/2026-08-23-web-ui.md`, `docs/superpowers/reviews/2026-08-23-packages-shared.md`, `docs/superpowers/reviews/2026-08-23-reliability-and-performance-review.md`, `docs/superpowers/reviews/2026-08-23-correctness-review.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`.

**Reviewed baseline:** `main` at `4d5d8276f03635ca74c04f4d500d13ce62198dd0`; `apps/web/app/globals.css` is 4,864 lines / 95,005 bytes; the normal Muse asset is a 99 KiB WebP and its fallback is a 2.1 MiB PNG.

**Live code anchors:** `layout.tsx:14-26` loads Google Fonts; `LandingEntry.tsx:12-33` accepts an intent string and then navigates without it; `LandingHero.tsx:12-16,50-68` renders the unsupported goal/mode affordances; `LibraryStatusPanel.tsx:54-89,261-269` runs delete on the first click; `MuseBackdrop.tsx:7-18` lacks intrinsic dimensions/stateful decode recovery; `MuseGlyphCanvas.tsx:156-196,404-523` hardcodes 32 fps/DPR 2 and separately loads WebP then PNG; `packages/tokens/src/index.ts:1-32` duplicates raw palette/type values; `packages/ui-web/src/index.tsx:291-340` emits `MasteryRing` classes whose styles currently live only in the app global sheet. Session landmark, disclosure, Transcript, and foreground-canvas anchors remain plan 10's files.

## Global Constraints and Execution Contract

Use these stable IDs in commit bodies, test names, evidence, and the coordinator ledger:

| ID | Required outcome | Source findings |
| --- | --- | --- |
| `FRONTEND-001` | One token authority and an explicit `@viva/ui-web` stylesheet dependency | FE-09, shared-packages M3, shared-packages recommendation R6 (token-authority half), REL-07 (contributing owner task under RELEASE-030) |
| `FRONTEND-002` | 44 px touch targets, AA semantic text contrast, resilient typography, and one primary landmark per route | FE-04, FE-05, FE-06 |
| `FRONTEND-003` | Honest landing intent/mode affordance after D-03 | FE-07, COR-09, web-ui M6 |
| `FRONTEND-004` | Deliberate, recoverable destructive library UX after D-04 | web-ui I3 |
| `FRONTEND-005` | Disclosure copy and gating agree after D-08 | FE-10, web-ui M5 |
| `FRONTEND-006` | Transcript disclosure has proven button semantics | FE-08 |
| `FRONTEND-007` | Self-hosted fonts and conditional WebP/PNG loading | FE-11 |
| `FRONTEND-008` | Reduced-effects support and an enforced low-end canvas budget | REL-06, web-ui M7 |
| `FRONTEND-009` | Mounted real-component accessibility and visual-performance gates | project-state U5, frontend recommendations C2-C5 (canonical); complements Plan 10's WEBSESSION-MOUNT-01 for web-ui I4 without claiming it |
| `FRONTEND-010` | Truthful static-export disposition after D-06 | shared package/app build review handoff |
| `FRONTEND-011` | Page/landing bootstrap composition matches D-07 before proxy deletion | web API/page composition handoff |
| `FRONTEND-012` | Global errors render generic copy and emit one sanitized structured report | web-ui M3 |

This plan owns future changes to:

- `apps/web/app/globals.css`, `apps/web/app/styles/**`, `apps/web/app/layout.tsx`, and committed font assets;
- `apps/web/app/error.tsx`, `apps/web/app/page.tsx`, and their frontend tests;
- `apps/web/components/landing/**` and the landing/library portions of their tests;
- `apps/web/lib/viva-effects.ts`, `apps/web/lib/viva-library.ts`, error reporting, and their tests;
- `packages/tokens/**` and `packages/ui-web/**`, including their CSS exports and React dependency declaration;
- `scripts/frontend-harness.mjs`, `scripts/frontend-accessibility.mjs`, `scripts/frontend-performance.mjs`, and `scripts/frontend-quality.test.mjs`.

It does **not** own these overlapping contracts:

- Plan 10 owns `LiveSessionPage.tsx`, `LiveSessionShell.tsx`, `SessionBottomControls.tsx`, `VoiceTraceCanvas.tsx`, and their tests. This plan supplies exact acceptance assertions but does not edit those files.
- Plan 14 consumes and tests the shared package manifests through its combined build/export contract; it does not edit them. This plan owns the `@viva/tokens/theme.css` and `@viva/ui-web/styles.css` export-map entries, the UI stylesheet's token dependency, and React peer/dev dependency declaration.
- This plan also owns D-06 static-export disposition in `apps/web/lib/viva-library.ts`, its tests, and `apps/web/app/page.tsx`; it must execute only the recorded branch.
- Plan 10 owns `apps/web/lib/viva-agent-client.ts` and removes the ignored paste `user_id`/`session_id` fields from its input type/serializer. Plan 11 owns the library proxy and exact paste/file/retry forwarding-key tests. Plan 08 adds Rust `deny_unknown_fields` and sanitized rejection. Their shared accepted shapes are paste `{ title, course?, exam_date?, pasted_text }`, file `{ title, course?, exam_date?, file_name, content_type?, file_base64 }`, and retry `{ file_name, content_type?, file_base64 }`; no lane may make browser identity authoritative. Plan 13 edits none of those files.
- The protocol/shared-contract plan owns all wire shapes. `FRONTEND-003` consumes the selected D-03 contract or removes unsupported affordances; it never adds a query-only shadow protocol.
- Plan 12 owns `.github/workflows/validate.yml`. It must add the exact frontend commands from Task 12 to the `loopback-and-browser` job after they pass locally.

D-01 note: if D-01 selects Branch B (`EVENTS_PLUS_READ_TIME_PROJECTION`), Plan 03 lands a read-time projection seam in `apps/web/lib/viva-library.ts` before this lane merges. Before executing Tasks 6, 8, or 9, rebase on the integration tip, identify that seam, and extend it; never recreate or remove the D-01B projection branch, and route any needed change to its behavior through a Plan 04/09 handoff.

Never edit `LiveSessionPage.tsx`, protocol files, or Plan 14's cross-package build/test orchestration while executing this plan. Never stage `docs/superpowers/reviews/**`, `.impeccable.md`, or unrelated dirty files.

## Hard decision checkpoints

Record the selected branch in the coordinator decision record before the dependent task starts. Tests for an unselected branch must not be committed.

### D-03 `MODE_GOAL_CONTRACT`

- **Branch A — signed mode/goal contract exists:** Keep the command input and only the mode suggestions the signed start contract actually supports. `LandingHero` emits a structured `{ initialGoal, mode }` selection, and the cross-layer owner proves those exact values are bound into the authenticated start/session configuration. Empty free text is rejected in the UI. This plan tests the mounted landing dispatch but does not define the wire shape.
- **Branch B — unsupported mode/goal contract is removed:** Remove the command input, ornamental microphone, and quiz/mock/review suggestion chips. Render one honest 44 px `Begin oral exam` button plus neutral copy that does not promise a mode or goal. Delete now-unused landing components only after `rg` proves no remaining import.

Do not retain typed text or mode chips if the receiving authority still discards them. Do not pass intent in an unsigned query parameter as a substitute for Branch A.

### D-04 `DELETION_UX`

- **Branch A — `CONFIRM_DELETE`:** Apply the same named inline `role="alertdialog"` flow independently to both a study-set/source row and a session-recap/history row. The dialog names the exact target, moves focus to the confirm action, supports Cancel and Escape, and returns focus to that row's initiating button. No DELETE request is issued before confirmation. Confirm calls the exact existing study-set or session-history endpoint once.
- **Branch B — `SOFT_DELETE_UNDO`:** For study-set/source deletion, Plan 09's authoritative `SoftDeleteReceiptV1` never contains a token. The BFF must return exact `BrowserSoftDeleteReceiptV1 = SoftDeleteReceiptV1 & { restore_control_token }`, concretely `{ schema: "viva.soft_delete_receipt.v1", deletion_id, study_set_id, deleted_at: RFC3339 string, undo_expires_at: RFC3339 string, policy: "soft_delete_undo", restore_control_token }`; the deadline is database-authored and the Plan-11-minted control token is one-time. The frontend removes the study-set row only after that browser response, displays the authoritative RFC3339 deadline, exposes a 44 px `Undo` action in a `role="status"` message until it, and sends exactly one `POST /api/viva-library/{study_set_id}/restore` with `Origin`, JSON content type, body `{ "deletion_id": receipt.deletion_id }`, and header `X-Viva-Control-Token: receipt.restore_control_token`. Only exact 200 `RestoreStudySetOutcomeV1` `{ schema: "viva.restore_study_set_outcome.v1", deletion_id, study_set_id, restored_at: RFC3339 string, outcome: "restored" | "already_restored" }` triggers the authoritative refresh. It never persists/logs the token, attempts restore after expiry, retries a consumed token after any failure, or reinserts cached row data. Because no recap/history restore contract exists, session-recap/history deletion still uses the full named `CONFIRM_DELETE` flow in this branch; it never displays a fake Undo.

Branch B is blocked until the study-set server/API restore contract is merged and proven. Do not offer confirmation and undo for the same study-set deletion, but never remove the required named confirmation for recap/history deletion.

### D-06 `STATIC_EXPORT`

- **Branch A — static export remains supported:** Retain the `staticExport` projection branch and `vivaStaticExportEnabled()` composition, then add a real built consumer/browser proof that static export preserves only the capabilities required to start/control a session, never puts signed values in query strings or rendered text, and functions without the same-origin proxy. Existing projection-only tests are insufficient.
- **Branch B — static export is retired:** Remove the `staticExport` option/branches and their tests from `viva-library.ts`, remove `vivaStaticExportEnabled` composition from `app/page.tsx`, and let the normal browser projection always strip control/session credentials according to the selected D-07 route. Plan 14 removes or retains the broader build mode only after this frontend composition commit.

Do not choose D-06 in this plan. Plan 14 owns the final build-mode disposition check, but this plan owns these frontend branches.

### D-07 `TOKEN_ONLY_REFRESH` (frontend session-bootstrap composition half)

- **Branch A — same-origin bootstrap remains:** Keep `attachVivaSessionBootstrapTokensToLibrarySnapshot`, `/api/viva-session/start`, `/refresh`, and the landing's bootstrap-capability start/retry path. Mounted proof must show the capability is absent from DOM text, attributes, query strings, and logs; it is sent only in the same-origin POST body and replaced by a fragment session token before `/session` connects.
- **Branch B — bootstrap proxy is removed:** Before plan 11 deletes/rebases the helper and routes, remove the helper import/call from `app/page.tsx`, remove `session_bootstrap_token`/`sessionBootstrapToken` browser projection and landing branches, remove `/api/viva-session/start` calls and bootstrap-expiry refresh retries, and delete their tests. Direct session-token behavior may remain only if its separately selected trust/static-export contract authorizes it. No browser snapshot or rendered data attribute may contain a bootstrap token.

Do not select D-07 here. Under Branch B, the frontend removal commit is an ordering prerequisite for plan 11's helper and `/start`/`/refresh` deletion.

### D-08 `DISCLOSURE_SCOPE`

- **Branch A — gate all live content:** Plan 10 gates both typed answers and microphone start on the same per-tab/session acknowledgment in live-provider mode. The disclosure may continue to name audio, derived transcripts, answers, study events, and the provider cascade. Synthetic mode remains accurately distinguished.
- **Branch B — microphone-only disclosure:** Plan 10 leaves typed answers available and narrows the disclosure and acknowledgment label to microphone capture/processing only. It removes any sentence claiming the acknowledgment gates typed answers. The broader server-provided privacy statements remain visible in the landing library.

This is D-08, not D-07. This plan adds the mounted acceptance check after plan 10 lands; it does not edit the live page to force either branch.

---

## Phase 13A — additive frontend foundation and prerequisite handoffs

Execute Tasks 0-7 on the early Plan-13 branch. The required outbound handoffs are exact:

1. Task 0 lands `apps/web/lib/viva-effects.ts` first; Plan 10 imports its types, resolver, preference reader, key, and event without duplicating policy.
2. Tasks 1-2 edit both `packages/tokens/package.json` and `packages/ui-web/package.json`; Plan 14 only consumes and verifies those manifests after receiving the commit SHA with `node --test scripts/package-build-contract.test.mjs`, the UI package typecheck, and the app build.
3. If D-07 selects Branch B, Task 6 removes the `app/page.tsx` bootstrap helper import/call and all Plan-13-owned browser bootstrap branches before Plan 11 deletes the helper/routes. If D-07 selects Branch A, Task 6 instead lands the mounted capability-location proof and Plan 11 retains the routes.
4. Plan 10, not this plan, removes paste `user_id`/`session_id` from `viva-agent-client.ts`; Plan 11 locks proxy request keys; Plan 08 locks Rust unknown-field rejection. Record all three SHAs for the final combined-tree gate.
5. Plan 12 owns `apps/web/package.json` and `bun.lock`; before Task 7, it adds exact app dev dependencies `"happy-dom": "20.11.6"` and `"@happy-dom/global-registrator": "20.11.6"` and regenerates the lockfile with Bun 1.3.3. Plan 13 consumes that SHA and never stages either file.
6. Task 5 is branch-scoped: D-03 Branch B completes fully in Phase 13A, while under Branch A only Step 1's mounted RED and the component-level callback-shape work land in 13A; Branch A's cross-layer GREEN and commit defer to Phase 13B per the Task 5 scheduling note.
7. Immediately after the Task 1 and Task 2 commits, send both manifest commit SHAs to Plan 12 (owner of `bun.lock`), which regenerates the lockfile with Bun 1.3.3 in an additive commit mirroring its happy-dom handoff; 13A must not be merged to integration before that lockfile commit exists, the coordinator admits 13A as the very next merge after it (no intervening lane merge, per Plan 12 constraint 9(c)), and Plan 13 never stages `bun.lock` itself.

Do not start Phase 13B from a partial 13A tree. The early branch can publish these additive/prerequisite commits, but it cannot close D-04, D-06, session canvas contention, or final accessibility/performance acceptance.

### Task 0: Publish the additive canvas-effects policy handoff (`FRONTEND-008`)

**Purpose:** Land this pure module before plan 10 implements `VoiceTraceCanvas` performance work. Plan 10 imports it; it must not define a parallel policy or edit this module.

**Files:**

- Create: `apps/web/lib/viva-effects.ts`
- Create: `apps/web/lib/viva-effects.test.ts`

- [ ] **Step 1: Write the failing policy contract tests**

Lock these exact public types and function:

```ts
export type VivaEffectsPolicy = {
  mode: "full" | "reduced" | "static";
  dprCap: number;
  fps: number;
  glyphCountScale: number;
};

export type VivaEffectsPolicyInput = {
  canvasRole: "landing_muse" | "session_muse" | "voice_trace";
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  hardwareConcurrency: number | null;
  prefersReducedMotion: boolean;
  prefersReducedTransparency: boolean;
  saveData: boolean;
  explicitPreference: "reduced" | null;
};

export const VIVA_EFFECTS_PREFERENCE_STORAGE_KEY = "viva.effects.preference.v1" as const;
export const VIVA_EFFECTS_CHANGE_EVENT = "viva-effects-change" as const;

export function readVivaEffectsPreference(
  storage: Pick<Storage, "getItem">,
): "reduced" | null;

export function resolveVivaEffectsPolicy(
  input: VivaEffectsPolicyInput,
): VivaEffectsPolicy;
```

Table-test all roles and precedence:

| Condition | Exact result |
| --- | --- |
| `canvasRole === "session_muse"` | `{ mode: "static", dprCap: 1.5, fps: 0, glyphCountScale: 0.5 }` |
| any reduced-motion, reduced-transparency, or explicit-reduced input | `{ mode: "static", dprCap: 1.5, fps: 0, glyphCountScale: 0.5 }` |
| otherwise `hardwareConcurrency !== null && hardwareConcurrency <= 4`, or Save-Data | `{ mode: "reduced", dprCap: 1.5, fps: 24, glyphCountScale: 0.5 }` |
| otherwise | `{ mode: "full", dprCap: 2, fps: 32, glyphCountScale: 1 }` |

`readVivaEffectsPreference` reads only `VIVA_EFFECTS_PREFERENCE_STORAGE_KEY`, returns `"reduced"` only for that exact stored value, and returns `null` for missing, malformed, or throwing storage. `session_muse` static precedence is unconditional. A `null` hardware-concurrency value is unknown, not low-end. Viewport and device-pixel-ratio fields must be finite and positive in test fixtures, but the returned cap is the policy ceiling; consumers use `Math.min(input.devicePixelRatio, policy.dprCap)`. Plan 10 calls the preference helper only after mount, calls the resolver with `canvasRole: "voice_trace"`, may ignore `glyphCountScale`, and never duplicates the storage key or policy table.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/lib/viva-effects.test.ts
```

Expected: FAIL because the module and named exports do not exist.

- [ ] **Step 3: Implement the pure resolver only**

Implement the precedence table without reading `window`, media queries, navigator, React state, or the DOM. The storage helper receives its storage dependency and fails closed to the system default (`null`). Export no React hook: each owning canvas gathers browser/media inputs in its own lifecycle, reads the explicit preference after mount with the helper, and calls the pure resolver. The shared module is the only place allowed to name the storage key/event or choose mode/DPR/FPS/scale values.

- [ ] **Step 4: Verify GREEN and precedence mutations**

Run the focused test again. Expected: PASS. Then independently invert the static/reduced precedence, treat `hardwareConcurrency: null` as low-end, accept an unknown stored string as reduced, and let a throwing storage escape; each mutation must fail a named table row. Restore and rerun to PASS.

- [ ] **Step 5: Publish the early additive handoff**

```bash
git add apps/web/lib/viva-effects.ts apps/web/lib/viva-effects.test.ts
git commit -m "feat(frontend): publish canvas effects policy"
```

Send the exact commit SHA and exported interface to plan 10. Plan 10 may begin VoiceTrace work after this commit; this plan's final acceptance still waits for plan 10's combined-tree implementation.

### Task 1: Establish one runtime token authority (`FRONTEND-001`)

**Dependency:** This task publishes the token CSS subpath that Plan 14's combined package/build checks consume. Do not bypass the package boundary with `../../../packages/...` imports.

**Files:**

- Create: `packages/tokens/src/theme.css`
- Modify: `packages/tokens/src/index.ts`
- Modify: `packages/tokens/src/index.test.ts`
- Modify: `packages/tokens/package.json`
- Create: `scripts/frontend-quality.test.mjs`
- Modify later in this task: `apps/web/app/globals.css`

- [ ] **Step 1: Write token authority and contrast-parsing tests**

In `packages/tokens/src/index.test.ts`, read `theme.css` and assert:

1. every exported token name resolves to exactly one CSS custom property;
2. the source contains one literal value per semantic color, with legacy names implemented only as `var(--viva-...)` aliases;
3. `--viva-ochre-text` has at least 4.5:1 contrast against both `--viva-paper` and `--viva-bg-soft`;
4. `--viva-target-min` is exactly `44px`;
5. serif/sans tokens are declared as `--viva-serif: var(--viva-font-serif, "Cormorant", Georgia, serif)` and `--viva-sans: var(--viva-font-sans, "Hanken Grotesk", "Avenir Next", -apple-system, BlinkMacSystemFont, sans-serif)` so rendering is unchanged while Google Fonts still load; no remote family declaration appears in `theme.css` itself.

In `scripts/frontend-quality.test.mjs`, add a negative control that feeds the checker duplicated `--viva-paper` declarations and the current `#c88b48` text-on-paper pair. Assert both are rejected. Then feed the canonical sample and assert it passes.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test packages/tokens/src/index.test.ts
node --test scripts/frontend-quality.test.mjs
```

Expected: FAIL because `theme.css`, `--viva-ochre-text`, `--viva-target-min`, and the authority checker do not exist. The negative contrast control must report a ratio below 4.5 rather than merely string-matching a hex value.

- [ ] **Step 3: Implement the minimal token source**

Create `theme.css` as the only place that assigns literal design-system color, radius, typography, target-size, and shadow values. Preserve necessary legacy names such as `--paper`, `--ink`, `--plum`, `--serif`, and `--sans` only as aliases to `--viva-*` properties. Use `#8a5a23` for `--viva-ochre-text` (approximately 5.79:1 on `#fffdf8`); keep `#c88b48` as the non-text ochre for borders, fills, and icons.

Change `index.ts` to export CSS variable references/names rather than a second table of raw hex values. Remove literal palette duplication from `globals.css` and import `@viva/tokens/theme.css` through this task's owned package export.

Add the exact package export while preserving the root TypeScript export:

```json
"exports": {
  ".": "./src/index.ts",
  "./theme.css": "./src/theme.css"
}
```

- [ ] **Step 4: Verify GREEN and the mutation control**

Run the two focused commands again. Expected: PASS. Temporarily change `--viva-ochre-text` back to `#c88b48`; the contrast test must fail. Restore the canonical value and rerun to PASS.

- [ ] **Step 5: Commit only the token authority**

```bash
git add packages/tokens/package.json packages/tokens/src/theme.css packages/tokens/src/index.ts packages/tokens/src/index.test.ts scripts/frontend-quality.test.mjs apps/web/app/globals.css
git commit -m "fix(frontend): establish one token authority"
```

Report `FRONTEND-001` and the RED/GREEN command output in the lane handoff/PR referenced by the coordinator ledger.

### Task 2: Split app and shared-primitive CSS without changing rendering (`FRONTEND-001`)

**Files:**

- Create: `packages/ui-web/src/styles.css`
- Modify: `packages/ui-web/src/index.test.tsx`
- Modify: `packages/ui-web/package.json`
- Create: `apps/web/app/styles/base.css`
- Create: `apps/web/app/styles/landing.css`
- Create: `apps/web/app/styles/session.css`
- Modify: `apps/web/app/globals.css`
- Create: `scripts/frontend-harness.mjs`
- Create: `scripts/frontend-accessibility.mjs`
- Modify: `scripts/frontend-quality.test.mjs`

- [ ] **Step 1: Write the failing CSS ownership test**

Add source-level tests which enumerate every class emitted by each `@viva/ui-web` component and require its selector in `packages/ui-web/src/styles.css`. Require `globals.css` to contain only ordered imports/comments and no selector blocks. Require app selectors to be partitioned as follows:

- reset, root document, focus utility, error/loading/not-found shell: `base.css`;
- `.viva-hero`, `.viva-library`, and their descendants: `landing.css`;
- `.live-session`, `.session-*`, `.question-*`, `.marginalia-*`, `.source-*`, and `.voice-*`: `session.css`;
- `@viva/ui-web` primitive classes such as `.mastery-ring`, `.action-card`, `.timeline-item`, and `.mobile-tabs`: package `styles.css`.

The test must fail on a duplicate selector across owners and on any UI primitive with no style. Add a mutation fixture which puts `.mastery-ring` in both package and app CSS and assert rejection.

- [ ] **Step 2: Create the minimal harness and capture a mounted computed-style baseline**

Implement the bounded loopback process/browser lifecycle completed in Task 11, plus only the computed-style write/compare mode needed for this extraction. Write the baseline to the fixed path `/tmp/viva-frontend-style-before.json` (or the session scratchpad directory) so a later shell can find it without inherited environment:

```bash
node scripts/frontend-accessibility.mjs --write-computed-style-baseline /tmp/viva-frontend-style-before.json
```

The write mode must capture both 1280x720 and 375x667, the same viewports the Step 5 compare asserts.

The baseline contains only allowlisted computed properties for the mounted landing/library (`display`, `position`, `font-family`, `font-size`, `line-height`, `color`, `background-color`, `border-radius`, `min-block-size`) and no text content, tokens, or session credentials.

- [ ] **Step 3: Verify RED**

```bash
bun test packages/ui-web/src/index.test.tsx
node --test scripts/frontend-quality.test.mjs
```

Expected: FAIL because package styles and the three owned app sheets do not exist and `globals.css` still contains 4,800+ lines.

- [ ] **Step 4: Perform a mechanical extraction**

Move selectors without restyling them. Keep the resolved import order `tokens -> ui-web -> base -> landing -> session`: `packages/ui-web/src/styles.css` explicitly imports `@viva/tokens/theme.css`, while `globals.css` replaces Task 1's temporary direct-token import with this task's owned `@viva/ui-web/styles.css` export followed by the three app sheets. The ownership test must reject a second direct `@viva/tokens/theme.css` import from `globals.css`, so the token sheet enters the app graph once through the UI stylesheet dependency. Do not combine extraction with contrast, target-size, copy, or animation changes.

In the still-private `packages/ui-web/package.json`, preserve root export `".": "./src/index.tsx"`, add export `"./styles.css": "./src/styles.css"`, add `"@viva/tokens": "workspace:*"` as a dependency, move React out of regular dependencies to `peerDependencies` as `"react": "^19.2.3"`, and retain `"react": "19.2.3"` in `devDependencies` for package-local tests/typechecking. Do not make a broader reusable/public component-library claim without a second real consumer. Plan 14 verifies consumer resolution and peer installation; it does not make these edits.

- [ ] **Step 5: Verify GREEN and differential parity**

```bash
bun test packages/ui-web/src/index.test.tsx
node --test scripts/frontend-quality.test.mjs
node scripts/frontend-accessibility.mjs --compare-computed-style-baseline /tmp/viva-frontend-style-before.json
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
```

Expected: all checks PASS; the allowlisted computed-style diff is empty at 1280x720 and 375x667. `wc -l apps/web/app/globals.css` must be at most 20 lines. Any visual change means the extraction is not mechanical and must be corrected before continuing.

After this commit SHA is handed off, Plan 14 runs:

```bash
node --test scripts/package-build-contract.test.mjs
bun run --cwd packages/ui-web typecheck
bun run --cwd apps/web build
```

All three must pass without Plan 14 editing either package manifest.

- [ ] **Step 6: Commit the extraction separately**

```bash
git add packages/ui-web/package.json packages/ui-web/src/styles.css packages/ui-web/src/index.test.tsx apps/web/app/globals.css apps/web/app/styles/base.css apps/web/app/styles/landing.css apps/web/app/styles/session.css scripts/frontend-harness.mjs scripts/frontend-accessibility.mjs scripts/frontend-quality.test.mjs
git commit -m "refactor(frontend): assign stylesheet ownership"
```

### Task 3: Enforce landmarks, 44 px targets, contrast, and zoom-safe typography (`FRONTEND-002`)

**Files:**

- Modify: `packages/tokens/src/theme.css`
- Modify: `packages/tokens/src/index.ts`
- Modify: `packages/tokens/src/index.test.ts`
- Modify: `packages/ui-web/src/styles.css`
- Modify: `apps/web/app/styles/base.css`
- Modify: `apps/web/app/styles/landing.css`
- Modify: `apps/web/app/styles/session.css`
- Modify: `scripts/frontend-accessibility.mjs`
- Modify: `scripts/frontend-quality.test.mjs`
- Plan-10 handoff only: `LiveSessionShell.tsx` and its test

- [ ] **Step 1: Add failing mounted accessibility assertions**

The Playwright script must mount the real Next pages and assert at 1280x720, 375x667, and 320x568. Its Phase-13A `--owned-surfaces` mode enforces items 2-5 plus the landing half of item 1; its full mode, run in Phase 13B after Plan 10, enforces every item:

1. `/` and `/session` each expose exactly one `main`; `/session` has a visible-on-focus skip link targeting the active question/answer region (implemented by plan 10).
2. Every visible enabled `button`, `summary`, actionable link, and `[role=button]` has a bounding box at least 44x44 CSS px at touch widths. The failure prints the accessible name and measured dimensions.
3. Semantic normal text using the ochre role resolves to `--viva-ochre-text`; decorative borders/fills may still use `--viva-ochre`.
4. At a 200% root text scale and 320 px viewport, document horizontal overflow is at most 1 px, no focused action is clipped, and privacy/deletion copy is not truncated.
5. Keyboard traversal reaches the main action, library actions, delete decision UI, and skip link with a visible focus indicator. Forced-colors emulation retains an outline.

In `packages/tokens/src/index.ts`, export `vivaContrastPairs: ReadonlyArray<{ foreground: string; background: string; minimumRatio: number }>` naming CSS custom-property names, seeded with at least: `--viva-ochre-text` vs `--viva-paper` (4.5), `--viva-ochre-text` vs `--viva-bg-soft` (4.5), `--viva-ink` vs `--viva-paper` (4.5), `--viva-ink-soft` vs `--viva-paper` (4.5), and `--viva-muted` vs `--viva-paper` (4.5). Extend `packages/tokens/src/index.test.ts` to resolve each pair against `theme.css` literals and assert every declared minimum; the frontend-quality checker consumes the same exported array so the scan covers every declared pair, not a one-off ochre assertion.

- [ ] **Step 2: Verify RED**

```bash
bun test packages/tokens/src/index.test.ts
node --test scripts/frontend-quality.test.mjs
node scripts/frontend-accessibility.mjs --owned-surfaces
```

Expected: FAIL with the current 35-42 px library/consent controls and ochre text at about 2.85:1. Separately, after D-08 is recorded, run exactly one Plan-10 handoff RED:

```bash
node scripts/frontend-accessibility.mjs --session-handoff --disclosure-scope all-live-content
# or, only for D-08 Branch B:
node scripts/frontend-accessibility.mjs --session-handoff --disclosure-scope microphone-only
```

The selected command must fail on the baseline missing main/skip target and Transcript button semantics; Branch A must additionally show typed and voice content are not jointly gated, while Branch B must show the copy still claims broader answer gating. Record that external RED for Plan 10. It is not allowed to keep this Phase-13A owned-style commit permanently red.

- [ ] **Step 3: Implement owned CSS fixes**

Use `--viva-target-min: 44px` for actionable controls and preserve quiet styling through padding, borders, and type weight rather than smaller hitboxes. Apply `--viva-ochre-text` only where ochre carries labels, retry/caveat state, or body meaning. Keep the brighter ochre for non-text decoration. Establish minimum 1.5 body line-height, 1.2 heading line-height, fluid heading sizes, logical spacing, and wrapping/min-width rules that survive 200% text.

Plan 10 must independently change the live root to `<main>` (or put one `<main>` around the stage), add the skip target, and prove its test RED/GREEN. Do not edit the live component from this task.

- [ ] **Step 4: Verify GREEN**

Run the three owned-surface commands again. Expected: PASS without requiring Plan 10's files. Run a mutation control that sets one mobile library button to `min-block-size: 35px`; the mounted check must identify that button and fail. Restore and rerun. Send the still-failing selected `--session-handoff` command and exact landmark/Transcript/disclosure contract to Plan 10; Task 12 turns that same command GREEN on the combined tree.

- [ ] **Step 5: Commit owned accessibility styles**

```bash
git add packages/tokens/src/theme.css packages/tokens/src/index.ts packages/tokens/src/index.test.ts packages/ui-web/src/styles.css apps/web/app/styles/base.css apps/web/app/styles/landing.css apps/web/app/styles/session.css scripts/frontend-accessibility.mjs scripts/frontend-quality.test.mjs
git commit -m "fix(frontend): enforce accessible type and targets"
```

Do not stage plan-10 files in this commit.

### Task 4: Self-host fonts and prove conditional Muse fallback (`FRONTEND-007`)

**Files:**

- Create: `apps/web/app/fonts/cormorant-latin-roman.woff2`
- Create: `apps/web/app/fonts/cormorant-latin-italic.woff2`
- Create: `apps/web/app/fonts/hanken-grotesk-latin.woff2`
- Create: `apps/web/app/fonts/OFL-Cormorant.txt`
- Create: `apps/web/app/fonts/OFL-Hanken-Grotesk.txt`
- Create: `apps/web/app/fonts/PROVENANCE.md`
- Modify: `apps/web/app/layout.tsx`
- Modify: `packages/tokens/src/theme.css`
- Modify: `apps/web/components/landing/MuseBackdrop.tsx`
- Modify: `apps/web/components/landing/MuseGlyphCanvas.tsx`
- Modify: `apps/web/components/landing/LandingHero.test.tsx`
- Modify: `scripts/frontend-accessibility.mjs`
- Modify: `scripts/frontend-quality.test.mjs`

- [ ] **Step 1: Add failing asset/network assertions**

Require the mounted production page to satisfy all of these:

- no request host is `fonts.googleapis.com` or `fonts.gstatic.com`;
- `document.fonts.check` succeeds for the serif normal, serif italic, and sans roles;
- total WOFF2 bytes are at most 300 KiB, each font family has its OFL text committed, and `PROVENANCE.md` records the official upstream revision, source path, and SHA-256 for each committed binary;
- the Muse image has intrinsic `width="1672"` and `height="941"`, async decoding, and eager/high-priority loading;
- a normal WebP-capable Chromium load requests `/viva-muse.webp` and never requests `/viva-muse.png`;
- when the harness fulfills WebP with invalid image bytes, the mounted component requests PNG, the image reaches `complete && naturalWidth === 1672`, and CDP records at most one non-cached PNG body transfer (the visible image and canvas sampler may share that cached response).

The fallback check must observe actual network requests and decoded image state. A source grep for `<picture>` is insufficient.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/components/landing/LandingHero.test.tsx
node --test scripts/frontend-quality.test.mjs
node scripts/frontend-accessibility.mjs --assets
```

Expected: FAIL because the page contacts Google Fonts, committed WOFF2/OFL files are absent, dimensions are absent, and visible PNG recovery is not state-driven.

- [ ] **Step 3: Implement local fonts and decode fallback**

Commit licensed Latin WOFF2 variable subsets for Cormorant Roman (weights 400-600), Cormorant Italic (400-500), and Hanken Grotesk (400-700). Obtain the variable TTFs from the official google/fonts repository at a pinned commit: `ofl/cormorant/Cormorant[wght].ttf`, `ofl/cormorant/Cormorant-Italic[wght].ttf`, and `ofl/hankengrotesk/HankenGrotesk[wght].ttf`, plus each family's OFL.txt from the same directories. Produce WOFF2 latin subsets with fonttools (`pip install fonttools brotli`): `pyftsubset <input.ttf> --flavor=woff2 --layout-features="*" --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" --output-file=<output.woff2>`, restricting instance ranges to the stated weights. Record the pinned google/fonts commit SHA, source path, and `shasum -a 256` of each committed WOFF2 in `PROVENANCE.md`. If network access to fetch the upstream files is unavailable in this worktree, record the task as blocked with the exact URLs needed rather than sourcing binaries elsewhere.

Register the fonts with `next/font/local` in `layout.tsx` using `variable: "--viva-font-serif"` (Cormorant, with the italic file in the same declaration) and `variable: "--viva-font-sans"` (Hanken Grotesk), attach both variable classes to `<html>`, and remove all Google preconnect/stylesheet links. Then tighten the Task 1 token test to assert the tokens resolve through `--viva-font-serif`/`--viva-font-sans` and that the quoted remote family names are only fallbacks.

Make `MuseBackdrop` a small client component whose `<source type="image/webp">` is removed after a real image error, allowing the PNG `<img>` source to load. Preserve empty alt/`aria-hidden`; add intrinsic dimensions. Keep `MuseGlyphCanvas`'s sampler WebP-first/PNG-on-error logic, but resolve canvas colors from computed token values instead of a second hardcoded palette.

- [ ] **Step 4: Verify GREEN and fallback mutation**

Run the three focused commands again. Expected: PASS. Then remove the state update from the image error handler and rerun `--assets`; the invalid-WebP scenario must fail because PNG was not decoded. Restore and rerun.

- [ ] **Step 5: Commit assets separately**

```bash
git add apps/web/app/fonts apps/web/app/layout.tsx packages/tokens/src/theme.css apps/web/components/landing/MuseBackdrop.tsx apps/web/components/landing/MuseGlyphCanvas.tsx apps/web/components/landing/LandingHero.test.tsx scripts/frontend-accessibility.mjs scripts/frontend-quality.test.mjs
git commit -m "perf(frontend): self-host fonts and lazy-load fallback art"
```

### Task 5: Resolve the landing affordance exactly as D-03 selects (`FRONTEND-003`)

**Hard gate:** D-03 must be recorded. Execute exactly one branch.

**Branch-scoped scheduling:** Branch B completes fully in Phase 13A. Under Branch A, complete only Step 1's mounted RED and the component-level callback-shape work in 13A; defer Branch A's Step 3 adaptation, Step 4 cross-layer GREEN, and the Step 5 commit to Phase 13B after the Plan 05/08/11 signed-start contract has merged, and record the deferred state in the lane handoff.

**Files (owned branch surface):**

- Modify: `apps/web/components/landing/LandingEntry.tsx`
- Modify: `apps/web/components/landing/LandingHero.tsx`
- Modify: `apps/web/components/landing/LandingEntry.test.tsx`
- Modify: `apps/web/components/landing/LandingHero.test.tsx`
- Modify if Branch A: `apps/web/components/landing/CommandSurface.tsx`
- Modify if Branch A: `apps/web/components/landing/SuggestionChip.tsx`
- Delete if Branch B and unreferenced: `apps/web/components/landing/CommandSurface.tsx`
- Delete if Branch B and unreferenced: `apps/web/components/landing/SuggestionChip.tsx`
- Modify: `apps/web/app/styles/landing.css`
- Modify: `scripts/frontend-accessibility.mjs`

- [ ] **Step 1: Write the selected branch's failing mounted test**

For Branch A, mount the real landing, enter `oxidative phosphorylation`, select each displayed mode, intercept the same-origin signed-start request, and assert its accepted server-side session configuration contains the exact goal/mode once. Assert whitespace-only goals do not issue a start request and that no suggestion advertises a mode outside the signed contract. Keep a focused component unit test for the callback shape, but do not treat that spy as cross-layer proof.

For Branch B, assert there is no textbox named `Where should Viva begin?`, no ornamental `Answer out loud` mic, and none of `Quiz Lecture 5`, `Mock viva · 10 min`, or `Review missed concepts`. Click the one 44 px `Begin oral exam` button and assert the main frame navigates to the session entry exactly once.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/components/landing/LandingEntry.test.tsx apps/web/components/landing/LandingHero.test.tsx
node scripts/frontend-accessibility.mjs --landing-affordance
```

Expected Branch A RED: the callback still receives only a discarded string and the mounted path always becomes quiz. Expected Branch B RED: the dead textbox, mic, and three suggestions are still present.

- [ ] **Step 3: Implement only the selected branch**

Branch A may adapt display and callback types only after the authoritative start/session owner supplies the signed receiving contract and end-to-end proof. Branch B removes the unused affordances and their animation coupling rather than merely disabling them. In either branch, keep a single obvious primary action and retain the real `<h1>`.

- [ ] **Step 4: Verify GREEN and cross-layer truth**

Run the focused commands again. Branch A additionally runs the owning signed-start integration test and inspects the server-side session config; a landing spy alone is not completion evidence. Branch B runs:

```bash
rg -n "Where should Viva begin|Answer out loud|Quiz Lecture 5|Mock viva|Review missed concepts" apps/web/components/landing apps/web/app/styles/landing.css
```

Expected Branch B: no product-affordance hits; test descriptions may retain quoted negative assertions.

- [ ] **Step 5: Commit the D-03 disposition**

```bash
git add apps/web/components/landing apps/web/app/styles/landing.css scripts/frontend-accessibility.mjs
git commit -m "fix(frontend): align landing affordance with session contract"
```

The lane handoff/PR must name `D-03`, the selected branch, and the cross-layer proof command.

### Task 6: Align page and landing bootstrap behavior with D-07 (`FRONTEND-011`)

**Hard gate:** D-07 must be recorded. Execute exactly one branch. Under Branch B this commit must land before Plan 11 deletes `attachVivaSessionBootstrapTokensToLibrarySnapshot`, `/api/viva-session/start`, and `/api/viva-session/refresh`.

**Files:**

- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/lib/viva-library.ts`
- Modify: `apps/web/lib/viva-library.test.ts`
- Modify: `apps/web/components/landing/LibraryStatusPanel.tsx`
- Modify: `apps/web/components/landing/LandingEntry.test.tsx`
- Modify: `scripts/frontend-accessibility.mjs`

- [ ] **Step 1: Write the selected branch's failing mounted capability test**

Branch A mounts the real server-composed page/landing with a seeded bootstrap sentinel. Assert the sentinel is absent from DOM text, attributes, URLs, referrers, and logs; clicking Start sends it exactly once only as `session_bootstrap_token` in the same-origin `/api/viva-session/start` JSON body; the returned `session_token` appears only in the navigation fragment and is consumed before socket connection. Before client navigation, Branch A must also call Plan 10's `replaceBrowserSessionCredential` (exported from `apps/web/lib/use-viva-agent-session.ts`, read-only import) with the complete start response — `session_token`, `refresh_token`, `refresh_expires_at`, `session_absolute_expires_at`, identity, `mode: "retain-token-only"` — not only the fragment token, so the session page's in-memory credential vault can renew; assert the vault call happens exactly once with all fields and that no credential field enters DOM, URL query, storage, or logs. Bound the `/api/viva-session/start` fetch (and its expiry retry) with the same 6,000 ms abort/timeout policy as Plan 10's `VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS`: a never-resolving start fetch must abort at the bound and surface the explicit retry/fallback state — this commit supplies the Web UI R6 ledger alias' start-deadline proof. A 403 bootstrap-expiry response refreshes the library once, retries once with the replacement capability, and never logs either value.

Branch B asserts the server page no longer imports or calls `attachVivaSessionBootstrapTokensToLibrarySnapshot`; the browser snapshot and projection types contain no `session_bootstrap_token`/`sessionBootstrapToken`; and clicking the remaining authorized start path makes zero `/api/viva-session/start` or `/refresh` requests. Delete the expiry-refresh test instead of rewriting it to pass vacuously. Direct-session-token behavior remains only when the separately recorded D-06/trust contract permits it.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx
node scripts/frontend-accessibility.mjs --session-bootstrap
```

Expected Branch A: the new mounted secrecy/location proof is absent even though lower-level bootstrap tests exist. Expected Branch B: the page import/call, projection fields, same-origin start request, and refresh retry still exist.

- [ ] **Step 3: Implement only the selected D-07 branch**

Branch A keeps the helper, projection field, start route call, and one bounded expiry retry; it adds no persistent browser storage, calls Plan 10's `replaceBrowserSessionCredential` with the complete start response before client navigation, and bounds the start fetch with the 6,000 ms `VIVA_SESSION_ENTRY_REFRESH_TIMEOUT_MS` abort/timeout policy. Branch B first removes the page helper import/call, then removes the wire/projection fields and landing branches, then removes the start/refresh calls and tests. In either branch, never place a bootstrap or session token in JSX props that become DOM attributes, React keys, error text, analytics, or query strings.

- [ ] **Step 4: Verify GREEN, secrecy mutations, and ordering**

Run the focused tests and mounted script again. Seed the literal sentinel into a rendered data attribute and into a thrown fetch error; both mutations must fail the DOM/log scan. Restore and rerun. Under Branch B also require:

```bash
rg -n 'attachVivaSessionBootstrapTokensToLibrarySnapshot|session_bootstrap_token|sessionBootstrapToken|/api/viva-session/(start|refresh)' apps/web/app/page.tsx apps/web/lib/viva-library.ts apps/web/components/landing apps/web/components/landing/LandingEntry.test.tsx
```

Expected Branch B: no hits. Send the commit SHA to Plan 11 before it deletes/rebases the helper and routes; verify the combined tree after that deletion.

- [ ] **Step 5: Commit the D-07 frontend prerequisite**

```bash
git add apps/web/app/page.tsx apps/web/lib/viva-library.ts apps/web/lib/viva-library.test.ts apps/web/components/landing/LibraryStatusPanel.tsx apps/web/components/landing/LandingEntry.test.tsx scripts/frontend-accessibility.mjs
git commit -m "fix(frontend): align session bootstrap composition"
```

The lane handoff/PR must name `D-07`, the selected branch, and whether Plan 11 is now unblocked to delete the proxy routes.

### Task 7: Sanitize the global app error boundary (`FRONTEND-012`)

**Files:**

- Modify: `apps/web/app/error.tsx`
- Create: `apps/web/app/error.test.tsx`
- Create: `apps/web/lib/viva-client-error-reporting.ts`
- Create: `apps/web/lib/viva-client-error-reporting.test.ts`
- Modify: `scripts/frontend-quality.test.mjs`
- Plan-12 prerequisite only: `apps/web/package.json` and `bun.lock`

- [ ] **Step 1: Write the reporting adapter and real-component RED tests**

Lock this structured report contract:

```ts
export type VivaClientRenderErrorReport = {
  event: "viva_client_render_error";
  reference: string | null;
};

export function safeVivaErrorReference(digest: unknown): string | null;
export function reportVivaClientRenderError(
  error: Error & { digest?: string },
  sink?: (report: VivaClientRenderErrorReport) => void,
): void;
```

`safeVivaErrorReference` accepts only an unmodified `^[A-Za-z0-9_-]{1,64}$` digest. The report has exactly the two keys above: never error name/message/stack/cause, current URL, component state, tokens, headers, or source text. The adapter deduplicates by error object identity so React Strict Mode/effect replay emits exactly once, marks the error before calling the sink, and never retries a throwing sink with raw data.

After Plan 12 supplies exact dev dependencies `"happy-dom": "20.11.6"` and `"@happy-dom/global-registrator": "20.11.6"`, use the registrator directly in this focused test to mount the real `AppError` under Strict Mode. Give it an error whose message, stack, cause, and URL-shaped text contain `HOSTILE_STATE_SENTINEL`, `Bearer HOSTILE_BEARER`, and `https://evil.invalid/?session_token=viva1.hostile#state=HOSTILE_STATE_SENTINEL`, with digest `SAFE_REF_42`. Assert:

1. the DOM contains generic recovery copy, `Reference: SAFE_REF_42`, and one `Try again` button using the shared primary-button class; `frontend-quality.test.mjs` resolves that class to a minimum 44x44 CSS px target;
2. the DOM and serialized sink/console evidence contain none of the hostile message, URL, bearer, token prefix, stack, or state sentinel;
3. the sink receives exactly `{ event: "viva_client_render_error", reference: "SAFE_REF_42" }` once across Strict Mode effect replay and a same-error rerender;
4. a new Error object produces one new report, while a malformed/overlong digest renders no reference and reports `reference: null`; and
5. activating `Try again` invokes `reset` exactly once and preserves keyboard focus while pending.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/app/error.test.tsx apps/web/lib/viva-client-error-reporting.test.ts
node --test scripts/frontend-quality.test.mjs
```

Expected: FAIL because the adapter/tests do not exist and current `error.tsx` renders `error.message` verbatim.

- [ ] **Step 3: Implement generic rendering and one sanitized report**

Render only fixed product copy and the validated reference. Call the adapter from an effect keyed by the error object; do not interpolate the error into JSX, `console.*`, JSON, telemetry tags, or button labels. The default sink logs only the structured report object. Keep the global `<main>` and recovery action; use the shared button styles/target token established earlier. Do not run a package-manager command or edit the Plan-12-owned manifest/lockfile in this task.

- [ ] **Step 4: Verify GREEN and hostile mutations**

Run the focused tests. Then temporarily render `error.message` and temporarily add `error.stack` to the report; the DOM and log-sentinel assertions must fail independently. Restore and rerun. Run `bun run --cwd apps/web typecheck` to prove the Next global-error signature and reporting adapter remain compatible.

- [ ] **Step 5: Commit the error boundary alone**

```bash
git add apps/web/app/error.tsx apps/web/app/error.test.tsx apps/web/lib/viva-client-error-reporting.ts apps/web/lib/viva-client-error-reporting.test.ts scripts/frontend-quality.test.mjs
git commit -m "fix(frontend): sanitize global render failures"
```

## Phase 13B — dependent integration and final acceptance

Start 13B only after the Phase-13A commit SHAs are recorded and Plans 10/11 have landed the selected session/bootstrap counterparts. Rebase without rewriting their commits, then run Tasks 8-12 on one combined tree. D-06, D-04 deletion, shared effects integration, production harnesses, and the final mounted/AT gates are 13B work; none can be declared complete from the early additive branch.

### Task 8: Resolve the frontend static-export branch (`FRONTEND-010`)

**Hard gate:** D-06 must be recorded. Execute exactly one branch. Plan 14 owns `apps/web/next.config.ts`, root scripts, Turbo hashing, and the final build-mode disposition; this task owns the page/library composition it consumes.

**Files:**

- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/lib/viva-library.ts`
- Modify: `apps/web/lib/viva-library.test.ts`
- Modify: `apps/web/components/landing/LandingEntry.test.tsx`
- Modify: `scripts/frontend-accessibility.mjs`

- [ ] **Step 1: Write only the selected branch's failing proof**

For Branch A, first require the decision record to name the static artifact's real consumer and the separate server BFF that owns the API/session routes. Extend the mounted browser script with `--static-export`. It must serve the built `apps/web/out` artifact, intercept the named consumer's direct library origin, mount the real landing, and prove all of the following:

1. the artifact makes no request to `/api/viva-library`, `/api/viva-session/start`, or `/api/viva-session/refresh`;
2. a returned start/session capability is absent from DOM text, HTML attributes, query strings, referrers, and captured console/child logs;
3. clicking the real primary action once reaches `/session` with the authorized session token only in the URL fragment, and the session consumes/removes that fragment before opening its socket;
4. any supported library control capability travels only in its header, never in rendered markup or a URL; and
5. both `/` and `/session` load from the generated artifact without a Next server.

Keep focused library tests for `browserInitialLibrarySnapshot(..., { staticExport: true })`, but do not accept them as the real consumer proof.

For Branch B, add focused tests showing the page never passes `staticExport`, browser projection has no static branch, and no capability is retained solely because a static flag is set. Session/control-token handling must match the separately selected D-07/trust contract; retain `directSessionTokens` only if that contract independently authorizes it. Add a source assertion that these Plan-13-owned files contain none of `staticExport`, `vivaStaticExportEnabled`, `VIVA_STATIC_EXPORT`, or `NEXT_PUBLIC_VIVA_STATIC_EXPORT`.

- [ ] **Step 2: Verify RED**

Branch A:

```bash
VIVA_STATIC_EXPORT=1 NEXT_PUBLIC_VIVA_STATIC_EXPORT=1 bun --cwd apps/web run build
node scripts/frontend-accessibility.mjs --static-export
```

Expected: FAIL because no named built-consumer browser proof exists; if Next rejects the mixed API/static artifact, Branch A remains blocked rather than weakening the test.

Branch B:

```bash
bun test apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx
rg -n 'staticExport|vivaStaticExportEnabled|VIVA_STATIC_EXPORT|NEXT_PUBLIC_VIVA_STATIC_EXPORT' apps/web/app/page.tsx apps/web/lib/viva-library.ts apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx
```

Expected: tests FAIL and the scan reports the live static-only branches.

- [ ] **Step 3: Implement only the frontend half of the selected disposition**

Branch A retains `vivaStaticExportEnabled()` composition and the explicit projection option. It may not claim support until the named consumer, separate BFF, generated routes, and mounted proof all exist. Branch B removes the option and every conditional from `browserInitialLibrarySnapshot`, removes the page import/call, and deletes only static-specific assertions; it does not edit `next.config.ts`, root/Turbo build flags, or Plan-10-owned URL selection.

- [ ] **Step 4: Verify GREEN and hand off to Plan 14**

Run the selected RED commands again. Branch A additionally inspects network and console capture for seeded `viva1.`, `viva-bootstrap1.`, and `viva-control1.` sentinels. Branch B requires the `rg` command to exit 1 with no hits in the four owned paths. Then send Plan 14 the commit SHA; Plan 14 must run its selected normal/static build differential only after rebasing this commit.

- [ ] **Step 5: Commit the selected D-06 frontend branch**

```bash
git add apps/web/app/page.tsx apps/web/lib/viva-library.ts apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx scripts/frontend-accessibility.mjs
git commit -m "fix(frontend): resolve static export composition"
```

The lane handoff/PR must name `D-06`, the selected branch, the named consumer/BFF for Branch A, and the mounted or no-hit proof command. Do not stage a generated `apps/web/out` directory.

### Task 9: Make library deletion deliberate or truly undoable (`FRONTEND-004`)

**Hard gate:** D-04 must be recorded. Execute exactly one branch.

**Files:**

- Modify if `SOFT_DELETE_UNDO`: `apps/web/lib/viva-library.ts`
- Modify if `SOFT_DELETE_UNDO`: `apps/web/lib/viva-library.test.ts`
- Modify: `apps/web/components/landing/LibraryStatusPanel.tsx`
- Modify: `apps/web/components/landing/LandingEntry.test.tsx`
- Modify: `apps/web/app/styles/landing.css`
- Modify: `scripts/frontend-accessibility.mjs`

- [ ] **Step 1: Write the selected branch's failing interaction tests**

Use the mounted browser with DELETE/restore routes intercepted and counted.

Branch A (`CONFIRM_DELETE`) uses one table-driven mounted suite for both exact targets:

| Target | Required dialog name | Exact DELETE request |
| --- | --- | --- |
| study-set/source row | `Delete Biology Midterm?` | `/api/viva-library/study-sets/biology-midterm?user_id=user-1` |
| session-recap/history row | `Delete Biology Midterm session recap?` | `/api/viva-library/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1` |

For each row, prove the first click issues zero DELETE requests; confirm has focus; Escape and Cancel close the dialog and restore focus to that row's initiating button; confirm issues its table endpoint exactly once; double activation while busy cannot issue a second request; and success/failure is announced through a stable `role="status"` without replacing focus unexpectedly.

Branch B (`SOFT_DELETE_UNDO`) must prove:

1. the DELETE response parses exactly as `BrowserSoftDeleteReceiptV1 = SoftDeleteReceiptV1 & { restore_control_token }`, with concrete keys `{ schema: "viva.soft_delete_receipt.v1", deletion_id, study_set_id, deleted_at: RFC3339 string, undo_expires_at: RFC3339 string, policy: "soft_delete_undo", restore_control_token }`; only then is the exact matching row removed, and no test or type falsely adds the token to Plan 09's `SoftDeleteReceiptV1`;
2. `Undo` is present, named, and at least 44x44 until current time reaches the parsed authoritative `undo_expires_at`; the status displays that RFC3339 deadline and rejects a malformed date instead of guessing;
3. one activation before expiry issues exactly one `POST /api/viva-library/biology-midterm/restore`, with browser `Origin`, `Content-Type: application/json`, JSON body exactly `{ "deletion_id": receipt.deletion_id }`, and `X-Viva-Control-Token` exactly equal to the in-memory restore capability;
4. only exact 200 `RestoreStudySetOutcomeV1` `{ schema: "viva.restore_study_set_outcome.v1", deletion_id, study_set_id, restored_at: RFC3339 string, outcome: "restored" | "already_restored" }` triggers a server refresh that returns the row; both named outcomes are idempotent success, and double activation cannot issue a second request;
5. 400 invalid, 413 oversized, 403 capability rejection, 404 not found, 409 expired, 502 upstream, and 503 store responses produce truthful fixed UI copy, clear the now-consumed capability, permit no retry, and never reinsert client-cached data;
6. expiry before activation issues no restore request, clears the capability, and announces that the undo window ended; and
7. storage, DOM, URL, console, and captured request-log scans never expose `restore_control_token` (the test may inspect the intercepted header in memory only).

In the same Branch-B suite, run the session-recap/history row from the Branch-A table through every named confirmation/cancel/focus/exact-once assertion. Assert no recap restore route is requested, no restore capability is accepted or retained, and no `Undo` is rendered for recap/history deletion.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx
node scripts/frontend-accessibility.mjs --deletion
```

Expected: FAIL because both current buttons invoke permanent deletion on the first click; neither has named confirmation, and study-set deletion has no authoritative undo.

- [ ] **Step 3: Implement the selected branch**

For `CONFIRM_DELETE`, model pending deletion by stable `{ kind: "study_set" | "session_history", rowId }`, use `useId` for labelled/described alert-dialog relationships, keep per-row busy identity, and prove no restore route/token is touched. For `SOFT_DELETE_UNDO`, keep that identical model and named confirmation for `session_history`, while only `study_set` consumes undo. Add strict `viva-library.ts` consumers for `BrowserSoftDeleteReceiptV1` and `RestoreStudySetOutcomeV1` that reject missing, mistyped, unknown-key, wrong-schema/policy/outcome, or malformed-RFC3339 values before state changes; keep the underlying `SoftDeleteReceiptV1` token-free. Keep `restore_control_token` in component memory for the browser receipt lifetime, compare the parsed authoritative `undo_expires_at` to current time before issuing the request, clear the capability on success/expiry/unmount or any restore response, and refresh from the server only after either exact success outcome. The token is consumed even when restore fails, so never offer a retry with it. Never place it in React-persisted state adapters, browser storage, markup, URLs, analytics, or logs; never synthesize deleted rows from stale projection state.

- [ ] **Step 4: Verify GREEN and destructive negative control**

Run both focused commands. Expected: PASS. For `CONFIRM_DELETE`, temporarily call each table row's `onDelete` from the first click; the corresponding zero-request-before-confirm assertion must fail. For `SOFT_DELETE_UNDO`, independently bypass recap confirmation, remove the study-set expiry check, omit the control header, and reinsert a cached study-set row before restore succeeds; each named assertion must fail. Restore and rerun.

- [ ] **Step 5: Commit only deletion UX**

```bash
git add apps/web/lib/viva-library.ts apps/web/lib/viva-library.test.ts apps/web/components/landing/LibraryStatusPanel.tsx apps/web/components/landing/LandingEntry.test.tsx apps/web/app/styles/landing.css scripts/frontend-accessibility.mjs
git commit -m "fix(frontend): require deliberate library deletion"
```

The lane handoff/PR must name `D-04` and the canonical selected value `CONFIRM_DELETE` or `SOFT_DELETE_UNDO`.

### Task 10: Apply the shared reduced-effects policy and remove simultaneous canvas contention (`FRONTEND-008`)

**Files:**

- Modify: `apps/web/lib/viva-effects.test.ts`
- Create: `apps/web/components/landing/VisualEffectsControl.tsx`
- Modify: `apps/web/components/landing/LandingHero.tsx`
- Modify: `apps/web/components/landing/MuseGlyphCanvas.tsx`
- Modify: `apps/web/app/styles/landing.css`
- Modify: `apps/web/app/styles/session.css`
- Create: `scripts/frontend-performance.mjs`
- Modify: `scripts/frontend-quality.test.mjs`
- Plan-10 handoff only: `VoiceTraceCanvas.tsx` and its tests

- [ ] **Step 1: Write failing policy-integration tests**

Using the Task 0 resolver unchanged, test browser-input collection and application. Required outcomes:

- default desktop `landing_muse`: DPR cap 2, 32 fps, scale 1;
- low-end (`hardwareConcurrency <= 4` or Save-Data): DPR cap 1.5, 24 fps, scale 0.5;
- reduced motion/transparency or explicit reduced effects: one static frame, no continuous rAF;
- `session_muse`: static after resize/rebuild so only plan 10's `voice_trace` may animate.

The mounted test must toggle `Reduce visual effects`, observe `document.documentElement.dataset.vivaEffects === "reduced"` without reload, and observe the mounted canvas recompute after one `VIVA_EFFECTS_CHANGE_EVENT`. Reload and verify `readVivaEffectsPreference(window.localStorage)` restores the static render. The control label changes to `Use system visual effects`; clearing the value removes the root data attribute and dispatches the same event. Storage events cover cross-tab changes, while media-query change events cover system motion/transparency changes; system reduced-motion remains authoritative after clearing the explicit preference.

This task also creates `scripts/frontend-performance.mjs`, containing only the shared `frontend-harness.mjs` import and the `--policy-only` mode (mounted policy data-attribute assertions, no production-build sampling); Task 11 completes the full production sampling modes. Create that skeleton before running Step 2 so the RED failure is the missing behavior, not a missing file. Plan 10 does not run this script; Plan 13B and Plan 15 run `--policy-only` on the combined tree.

- [ ] **Step 2: Verify RED**

```bash
bun test apps/web/lib/viva-effects.test.ts
node --test scripts/frontend-quality.test.mjs
node scripts/frontend-performance.mjs --policy-only
```

Expected: FAIL because the preference control, browser-input adapter, and observable data attributes do not exist and the session Muse still runs continuously beside VoiceTrace. The Task 0 pure resolver tests remain GREEN.

- [ ] **Step 3: Implement the owned effects policy**

Use only `VIVA_EFFECTS_PREFERENCE_STORAGE_KEY` with the exact value `"reduced"` or absence; do not store study/session data. The control updates the root `data-viva-effects` attribute and dispatches `new Event(VIVA_EFFECTS_CHANGE_EVENT)` after every same-tab preference change. Construct the exact `VivaEffectsPolicyInput` from owned browser signals, call `readVivaEffectsPreference` and `resolveVivaEffectsPolicy`, and do not copy their validation/decision tables. Put `data-render-mode`, `data-fps-budget`, and `data-dpr-cap` on owned canvas nodes for observable proof. Under `prefers-reduced-transparency: reduce` or `html[data-viva-effects="reduced"]`, replace backdrop filters/translucent surfaces with opaque token surfaces, remove decorative glow/shadow animation, and preserve borders/focus.

In `MuseGlyphCanvas`, apply `glyphCountScale` and cap actual DPR/FPS from the returned policy. For `canvasRole: "session_muse"`, draw once and rebuild only on resize/preference changes. Plan 10 must call the same resolver with `canvasRole: "voice_trace"`, cache `VoiceTraceCanvas` label planning outside rAF, and expose the same budget attributes; do not edit it here.

- [ ] **Step 4: Verify GREEN and listener cleanup**

Run the focused commands again. Expected: PASS. Mount/unmount the canvas twice and assert exactly one listener each for visibility, both media-query changes, cross-tab `storage`, and same-tab `VIVA_EFFECTS_CHANGE_EVENT` while mounted, then zero after cleanup. Mutation control: force live-session Muse mode to animated; the simultaneous-canvas assertion must fail.

- [ ] **Step 5: Commit effects policy separately**

```bash
git add apps/web/lib/viva-effects.test.ts apps/web/components/landing/VisualEffectsControl.tsx apps/web/components/landing/LandingHero.tsx apps/web/components/landing/MuseGlyphCanvas.tsx apps/web/app/styles/landing.css apps/web/app/styles/session.css scripts/frontend-performance.mjs scripts/frontend-quality.test.mjs
git commit -m "perf(frontend): budget decorative effects"
```

### Task 11: Complete mounted accessibility and production performance harnesses (`FRONTEND-009`)

**Files:**

- Modify: `scripts/frontend-harness.mjs`
- Complete: `scripts/frontend-accessibility.mjs`
- Complete: `scripts/frontend-performance.mjs`
- Modify: `scripts/frontend-quality.test.mjs`
- No workflow edit in this plan; CI handoff goes to Plan 12

- [ ] **Step 1: Test the metric validators with hostile fixtures**

`scripts/frontend-quality.test.mjs` must import the scripts without running browsers and prove the assertions reject:

- a 43x44 target;
- a 4.49:1 semantic text pair;
- two `main` landmarks;
- missing `aria-expanded`/`aria-controls` on Transcript;
- PNG transfer during a healthy WebP load;
- p95 frame interval 50.01 ms;
- total blocking time 300.01 ms;
- 8 MiB + 1 byte heap growth;
- CLS 0.051;
- both session canvases marked animated.

Then prove exact-boundary values pass. This is the differential control for threshold direction and unit mistakes.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/frontend-quality.test.mjs
```

Expected: FAIL until the reusable harness and complete validators exist.

- [ ] **Step 3: Implement the reusable no-secret harness**

`frontend-harness.mjs` must allocate loopback ports, start the synthetic Rust agent and either Next production server or dev server, wait with bounded timeouts, capture sanitized child logs on failure, and always terminate children/browser in `finally`. It must clear ambient database, session-signing, provider-key, hosted, and failure-control variables just as a no-secret gate requires. No generated artifact is committed.

`frontend-accessibility.mjs` uses the dev server for interaction diagnostics. `frontend-performance.mjs` refuses dev mode, requires a completed `apps/web` production build, starts `next start`, launches Chromium at 375x667 with device scale factor 3, overrides `navigator.hardwareConcurrency` to 4 before app code, and uses CDP `Emulation.setCPUThrottlingRate` with rate 4. Assert the mounted policy reports reduced mode, DPR cap 1.5, and 24 fps before sampling; a desktop-policy unit test is not low-end runtime evidence.

- [ ] **Step 4: Enforce exact performance budgets**

After a 3-second warm-up per route, sample the landing and active synthetic session for 30 seconds each, producing the required 60 seconds of low-end trace evidence. Fail unless every scenario independently satisfies:

| Metric | Budget |
| --- | ---: |
| rAF interval p95 | `<= 50 ms` |
| total blocking time (`sum(max(0, longTask - 50))`) | `<= 300 ms` |
| JS heap growth after forced GC | `<= 8 MiB` |
| cumulative layout shift | `<= 0.05` |
| route CSS transfer | `<= 100 KiB` |
| WOFF2 transfer | `<= 300 KiB` |
| Muse WebP transfer | `<= 120 KiB` |
| healthy-load PNG requests | `0` |
| simultaneously animated canvases on `/session` | `<= 1` |

Record JSON to `artifacts/frontend-performance/result.json` with schema `viva.frontend_performance.v1`, exact git SHA, viewport, CPU rate, metric values, and pass/fail only. Do not record transcript, answer, source text, tokens, URLs with credentials, or browser trace.

- [ ] **Step 5: Run the mounted real-component gates**

```bash
bun run --cwd apps/web build
node scripts/frontend-accessibility.mjs
node scripts/frontend-performance.mjs
```

Expected: PASS with actual landing/library/session components mounted. A static markup snapshot, policy-unit test, or CSS grep cannot substitute for either command.

- [ ] **Step 6: Commit harnesses only after they fail closed**

```bash
git add scripts/frontend-harness.mjs scripts/frontend-accessibility.mjs scripts/frontend-performance.mjs scripts/frontend-quality.test.mjs
git commit -m "test(frontend): enforce mounted accessibility and performance"
```

### Task 12: Close session-semantic handoffs and run the full gate (`FRONTEND-002`, `FRONTEND-005`, `FRONTEND-006`, `FRONTEND-009`)

**Dependency:** Plan 10's selected D-08 implementation, session landmark/skip target, Transcript semantics, VoiceTrace cache/budget commit, and paste-request cleanup must be present. Plan 11's selected D-07 proxy work and exact ingestion forwarding tests, plus Plan 08's Rust unknown-field rejection, must be present. This plan's package export-map commits and only Plan 14A's package-consumer verification commit must be present. Do not wait for Plan 14B's D-06/build closeout: Task 8 hands its selected frontend SHA to that later phase. The recorded Plan-13 halves of D-06 and D-07 must be complete in dependency order.

**Files:**

- Modify only if assertion wiring is incomplete: `scripts/frontend-accessibility.mjs`
- Modify only if assertion wiring is incomplete: `scripts/frontend-performance.mjs`
- No live-session implementation files

- [ ] **Step 1: Verify the exact plan-10 handoff**

Require plan 10 to prove:

1. exactly one session `main` and one skip target;
2. Transcript is a real button with `aria-expanded`, stable `aria-controls`, and a labelled region whose hidden state agrees with expansion;
3. D-08 Branch A blocks both typed and voice live content until acknowledgment, or Branch B uses mic-only copy and gates only mic;
4. terminal recap copy remains completion-safe;
5. VoiceTrace label planning is cached by concept nodes/canvas size/font scale and the session has at most one animated canvas.

The frontend browser scripts reassert 1-3 and 5 against mounted code; they do not accept a plan-10 unit test alone. On the landing/library route they also require the server-projected data-handling, retention, and deletion statements to remain visibly grouped under the named Privacy controls section. The landing must not invent a persistent consent record or duplicate provider-specific acknowledgment copy.

Rerun the exact D-08-selected Task-3 command (`--disclosure-scope all-live-content` for Branch A or `--disclosure-scope microphone-only` for Branch B). It must now pass with the real session mounted. Plan 10 supplies its source-level mutation evidence for non-button Transcript and inverted typed-answer gating; Plan 13 consumes that evidence and reasserts the mounted result without altering a live-session file. This RED-to-GREEN record closes `FRONTEND-005` and `FRONTEND-006`.

Also require the ingestion handoff to prove the browser never claims server identity: Plan 10's exact paste-body test permits only `{ title, course?, exam_date?, pasted_text }` and no `user_id`/`session_id`; Plan 11's proxy tests permit only that set, file `{ title, course?, exam_date?, file_name, content_type?, file_base64 }`, and retry `{ file_name, content_type?, file_base64 }`; Plan 08 rejects a hostile extra field on all three Rust structs without echoing its value. These are combined-tree dependencies, not authorization for Plan 13 to edit their files.

- [ ] **Step 2: Run automated focused and full validation**

```bash
bun test packages/tokens/src/index.test.ts packages/ui-web/src/index.test.tsx apps/web/app/error.test.tsx apps/web/lib/viva-client-error-reporting.test.ts apps/web/lib/viva-effects.test.ts apps/web/lib/viva-library.test.ts apps/web/components/landing/LandingEntry.test.tsx apps/web/components/landing/LandingHero.test.tsx
bun test apps/web/lib/viva-agent-client.test.ts apps/web/lib/viva-library-proxy.test.ts
cargo test --manifest-path agent/Cargo.toml -p agent-service
node --test scripts/frontend-quality.test.mjs
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
node scripts/frontend-accessibility.mjs
node scripts/frontend-performance.mjs
bun run e2e:browser
bun run validate
git diff --check
```

Expected: all commands PASS on the same combined tree. `bun run e2e:browser` must still show the real server-owned library -> session -> recap path; the frontend scripts do not replace product E2E.

- [ ] **Step 3: Complete the assistive-technology evidence**

Run the exact built session UI with VoiceOver/Safari, NVDA/Chrome, and JAWS/Edge. For each pair verify keyboard activation, expanded/collapsed announcement, focus retention, transcript-region navigation, skip-link destination, live-region restraint, recap/recovery actions, and no repeated whole-transcript announcement. Record OS/browser/AT versions and pass/fail in sanitized external evidence; no transcript text is retained. Confidence remains incomplete until all three pairs are observed. If any AT pair (VoiceOver/Safari, NVDA/Chrome, JAWS/Edge) cannot be executed on available hardware, record that pair as `BLOCKED_EXTERNAL` in the lane handoff with owner `OPS-05`, the attempted environment, and the required state change, per program Section 8; do not mark it PASS and do not block the lane merge on it.

- [ ] **Step 4: Hand CI commands to the integration owner**

Plan 12 (sole owner of `.github/workflows/validate.yml`, per program Section 4) must add these two steps to the `loopback-and-browser` job after pinned Chromium installation. Send Plan 12 the exact commands and this lane's commit SHA as a named workflow handoff, and record in the coordinator ledger that `FRONTEND-009` hosted enforcement is blocked until Plan 12 confirms the workflow commit:

```bash
node scripts/frontend-accessibility.mjs
node scripts/frontend-performance.mjs
```

It uploads only `artifacts/frontend-performance/result.json` on success. Re-run the hosted workflow at the exact head; a local pass is not hosted evidence.

- [ ] **Step 5: Final scope and authority scan**

```bash
rg -n "fonts\.googleapis|fonts\.gstatic" apps/web packages
rg -n -- "--(viva-|bg:|paper:|ink:|plum:|serif:|sans:)" apps/web/app/styles packages/ui-web/src/styles.css
rg -n "LiveSessionPage|VIVA_VOICE_PROTOCOL|ClientFrame|ServerFrame" docs/superpowers/plans/2026-08-23-frontend-accessibility-performance.md
git status --short
```

Expected: no runtime Google-font references; no literal token declarations outside `packages/tokens/src/theme.css`; protocol references in this plan are boundary statements only; unrelated dirty/untracked files remain untouched.

- [ ] **Step 6: Commit only minor assertion/metadata wiring if needed**

Human prose, evidence schema metadata, or assertion registration may be batched here. No behavior fix may be hidden in this batch.

```bash
git add scripts/frontend-accessibility.mjs scripts/frontend-performance.mjs
git commit -m "test(frontend): close accessibility evidence gate"
```

Skip this commit when there is no diff.

## Acceptance criteria

The frontend lane is complete only when all are true on one combined exact-head tree:

- D-03, D-04, D-06, D-07, and D-08 branch choices are recorded and only the selected behaviors are implemented; D-07 Branch B's Plan-13 removal precedes Plan 11's helper/route deletion.
- The selected D-06 frontend composition is implemented and proven by Task 8, and its SHA is handed to Plan 14B for the later matching build-mode closeout; Task 12 does not wait for or claim that downstream result.
- Runtime design values have one literal authority; this plan owns the `@viva/tokens/theme.css` and `@viva/ui-web/styles.css` manifest exports and React peer/dev declarations, and Plan 14's consumer proof resolves them.
- Landing and session each expose one `main`; session skip and Transcript semantics pass mounted and AT checks.
- Every visible touch-width action is at least 44x44 CSS px, all semantic normal-text pairs are at least 4.5:1, and 200% text at 320 px does not clip or horizontally overflow.
- The global error boundary never renders/logs a hostile exception, emits exactly one two-field sanitized report per Error object, exposes only a validated digest reference, and preserves a 44 px recovery action.
- D-04 is exactly `CONFIRM_DELETE` for both study-set/source and session-recap/history rows, or it is `SOFT_DELETE_UNDO` with token-free Plan-09 `SoftDeleteReceiptV1`, Plan-11 `BrowserSoftDeleteReceiptV1`, exact `RestoreStudySetOutcomeV1`, an in-memory restore capability, exact restore body/header, authoritative expiry enforcement, and no cached study-set reinsert while recap/history still receives full named confirmation.
- Plan 10 emits no paste identity fields, Plan 11 forwards only the exact paste/file/retry keys, and Plan 08 rejects/sanitizes unknown keys; server-authoritative identity is unchanged.
- No runtime request reaches Google Fonts; all committed fonts are licensed and within budget.
- Healthy Chromium loads only WebP; a genuine WebP decode failure loads and decodes PNG.
- Reduced motion/transparency/effects produce an opaque, static, still-readable experience; live session never continuously animates both canvases.
- Production-build performance stays inside every stated threshold under 4x CPU throttle, with a negative-control test proving each threshold fails in the correct direction.
- Mounted accessibility, mounted performance, product E2E, and `bun run validate` all pass locally on the combined tree. Hosted exact-head CI and the full AT matrix are Level 4-5 external gates: they must be attempted and recorded as PASS or `BLOCKED_EXTERNAL` (with `OPS-01`/`OPS-05` owner, attempted evidence, and reason) in the coordinator ledger; a `BLOCKED_EXTERNAL` record does not block lane merge but prevents any `RELEASE_READY` claim. Static markup tests alone do not satisfy this lane.

## Commit discipline

Use one commit per material `FRONTEND-*` behavior. Explicitly stage named paths because the worktree may contain other plans and untracked review artifacts. Only human prose/evidence metadata minors may be batched. Do not amend, rebase, reset, or clean other workers' commits; if a dependency lands concurrently, re-read the combined diff and adapt without reverting it.
