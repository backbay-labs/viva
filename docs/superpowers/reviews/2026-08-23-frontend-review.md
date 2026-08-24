# Viva frontend and UX review — 2026-08-23

**Scope:** Landing/library and live manuscript at desktop 1280×720 and mobile 375×667, plus component/CSS/a11y source review.  
**Method:** Local synthetic agent, Next dev server, Playwright inspection, production-shaped repository E2E, screenshots, DOM geometry, accessibility roles, and source review.  
**Overall confidence:** High for Chromium layout/DOM findings; unknown for real screen-reader and non-Chromium behavior.

## Verdict

The visual design is distinctive and coherent. Parchment, editorial type, bounded source folios, living manuscript traces, and restrained marginalia produce a real product identity rather than a generic AI dashboard. Desktop and mobile did not overflow horizontally. Reduced-motion and tab-visibility behavior are thoughtfully implemented.

The primary frontend problems are truth and semantics, not aesthetics: the page shows the wrong study set, rewrites recap facts, labels successful completion as disconnection, and cannot transport a normal live voice answer. Accessibility is serviceable but incomplete: missing session landmark, sub-requirement target sizes, and low-contrast ochre text.

## Audit scores

| Dimension | Score / 4 | Evidence |
| --- | ---: | --- |
| Aesthetic usability | 3 | Strong hierarchy and source/turn surfaces; dense technical readiness copy competes with learner focus |
| Responsive | 3 | No overflow at 1280×720 or 375×667; clean one-column collapse; some controls remain too short |
| Accessibility | 2 | Live regions, labels, text fallback, reduced motion, hidden decorative canvases; no session `main`, contrast/target issues |
| Performance | 2 | DPR cap, ~32 fps throttle, visibility pause, cleanup; two simultaneous canvases, backdrop effects, 95 KiB CSS |
| Theming | 2 | Good tokens and coherent light theme; duplicated token sets plus 70 hex/221 rgba values in global CSS |
| Anti-pattern compliance | 2 | No gradient text/generic dashboard, but systemic glass/pill treatments and multiple 2–3 px accent stripes |

**Total:** 14/24. The anti-pattern verdict is **noticeable but not dominant**: the manuscript metaphor is authored, while glass, pill controls, and left-border callouts recur often enough to read as a system tell.

## Findings

| ID | Priority | Finding | Confidence |
| --- | --- | --- | --- |
| FE-01 | P1 | Session UI renders fixture identity/mastery around arbitrary server sessions | High |
| FE-02 | P1 | Normal live spoken answers cannot be submitted within the frame budget | High |
| FE-03 | P1 | Successful recap visibly contradicts itself with “Session not connected” | High |
| FE-04 | P2 | Session route lacks a `main` landmark and skip target | High |
| FE-05 | P2 | Several interactive targets miss the product's 44 px mobile requirement | High |
| FE-06 | P2 | Ochre small/body text fails normal-text contrast against paper | High |
| FE-07 | P2 | Command intent and mode affordances imply behavior that is discarded | High |
| FE-08 | P2 | Transcript disclosure semantics need cross-browser assistive-tech proof | Moderate |
| FE-09 | P2 | Global CSS/theming is duplicated and monolithic | High |
| FE-10 | P3 | Consent acknowledgment is tab/session-local and typed input bypasses the mic disclosure | High |
| FE-11 | P3 | Third-party fonts and large PNG fallback add avoidable privacy/weight | High |

## FE-01 — P1 — The manuscript can be about the wrong course

See COR-05. Route identity overwrites IDs on `seedStudySets[0]`; the page still displays the fixture title/course/concepts, forces readiness, and remaps recap through fixture concepts. Browser screenshots confirm the hardcoded “Trusted server set: Biology Midterm” and biology node field.

**Recommendation:** Block session render until the authenticated server study-set projection loads. Use skeleton/error states instead of fixture fallback for a non-fixture route.

## FE-02 — P1 — Voice-first UI has a one-second answer ceiling

See COR-01. The screen invites up to a 45-second answer and labels the control “I'm ready — check it,” but the buffered JSON transport exceeds server limits at about 1.022 seconds.

**Recommendation:** Build a streaming turn state visible in the UI: capture, buffered/backpressured, ending, submitted, and recoverable failure. Do not let a frame-size close collapse into a generic connection error.

## FE-03 — P1 — Completed and disconnected appear simultaneously

The local E2E terminal screenshot rendered a recap headline and study plan while the top capsule said “Session not connected” and the turn panel offered “Retry agent.” The E2E currently records recap success without asserting that visible runtime copy is completion-safe.

**Recommendation:** Make terminal recap the dominant page state and add exact visible-copy assertions to the browser gate.

## FE-04 — P2 — Missing primary landmark

Landing uses `<main>`. `LiveSessionShell` returns `<section className="live-session">` with header/stage content and no `<main>` or skip link (`apps/web/components/session/LiveSessionShell.tsx:103-155`). Playwright found zero main landmarks on the session route.

**Recommendation:** Render the session root as `<main>` or place a `<main>` around the question/marginalia stage. Add a skip link targeting the active question/answer region.

## FE-05 — P2 — Touch sizes do not meet Viva's stated 44 px contract

Measured Chromium heights:

- desktop bottom End/Transcript/Sources: about 30 px;
- mobile bottom controls: about 29 px;
- marginalia actions: about 40 px;
- recording acknowledgment: 42 px;
- landing library controls: about 35–38 px;
- mobile hero suggestions: 44 px; mic/input/submit: 46/46/48 px.

These generally exceed WCAG 2.5.8's 24 px AA minimum but miss the project's own 44 px mobile target and make the quiet control rail unnecessarily delicate.

**Recommendation:** Set a shared `min-block-size: 44px` for actionable controls on touch layouts and preserve visual quiet through color/weight, not hitbox reduction.

## FE-06 — P2 — Ochre text is decorative contrast applied to meaning

`--viva-ochre: #c88b48` on `--viva-paper: #fffdf8` is approximately **2.85:1**. It is used for normal/small text such as turn-caption labels, low-confidence caveats, and retry labels (`globals.css:3518-3523,3830-3839,4179-4189`). Those are meaningful states, not decorative graphics. Normal text needs 4.5:1 under WCAG AA.

`--viva-muted` is roughly 4.96:1 and is acceptable; the defect is concentrated enough to fix without darkening the whole design.

**Recommendation:** Add a darker semantic ochre for text and retain current ochre for fills/borders/icons. Test token contrast automatically.

## FE-07 — P2 — The landing command is ornamental

The command asks “Where should Viva begin?” and suggestions advertise quiz/mock/review. Navigation discards the typed string and the session always sends `mode: "quiz"`.

**Recommendation:** Wire goal/mode through a signed start request or replace the command with an honest single “Start oral exam” action.

## FE-08 — P2 — Transcript disclosure has uncertain action semantics

Transcript uses native `<details><summary>`. Chromium's inspected accessibility snapshot exposed the details as a group and the summary text without a button role; Playwright `getByRole('button', { name: 'Transcript' })` found none. Native behavior can vary across browser/screen-reader pairs.

**Recommendation:** Verify VoiceOver/Safari and NVDA/Chrome. If inconsistent, use a button with `aria-expanded`/`aria-controls` while retaining native no-JS behavior if desired.

## FE-09 — P2 — Design tokens do not control the whole surface

`globals.css` is 4,864 lines/95 KiB and includes a base palette plus a second `--viva-*` palette, roughly 70 hex literals and 221 rgba values. Landing/session/library/legacy styles share one file. The result is visually consistent today but hard to audit for contrast, darkening, or dead styles.

**Recommendation:** Split by mounted surface, consolidate semantic tokens, and generate CSS variables from `packages/tokens`. Avoid extracting one-off micro-components merely to reduce file length.

## FE-10 — P3 — Consent state is narrow

The recording disclosure correctly gates microphone capture. A refresh asks again because acknowledgment lives in component state, while typed answers can proceed without seeing the same data-use statement. This is not a mic-consent violation, but disclosure is inconsistent across input modes.

**Recommendation:** Persist acknowledgment for the tab/session and explicitly distinguish microphone/provider processing from typed-answer processing.

## FE-11 — P3 — Avoidable external and fallback weight

The interface loads Google Fonts, and the Muse canvas has a 2.1 MiB PNG fallback behind a 100 KiB WebP. The fallback is sensible, but modern browsers should not pay or expose the PNG unless WebP genuinely fails.

**Recommendation:** Self-host subset fonts and verify caching/preload behavior for the WebP without preloading both formats.

## Positive findings

- No horizontal overflow at tested desktop/mobile viewports.
- The 1040 px breakpoint cleanly stacks manuscript and marginalia; the 620 px breakpoint remains readable.
- Decorative canvas layers are inside `aria-hidden` wrappers; the question remains real DOM text.
- Question, turn-taking, checking progress, and marginalia have scoped live-region/label tests.
- Mic start is blocked until acknowledgment; typed fallback exists for denied/unsupported capture.
- Canvas rendering caps DPR at 2, throttles around 32 fps, pauses when hidden, uses a static reduced-motion frame, and cleans observers/listeners/rAF.
- URL token canonicalization and no-referrer behavior are tested.
- Focus styles exist for core actions, including forced-colors restoration.

## Recommended browser checks

```bash
bun run dev:agent
bun run dev:web
bun run e2e:browser
```

Add separate automated stories for 375×667, 320 px width, keyboard-only traversal, forced colors, reduced motion, text zoom 200%, 44.1 kHz fake microphone input, and the visible successful terminal copy.
