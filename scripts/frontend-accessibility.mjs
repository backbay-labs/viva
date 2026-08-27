import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bypassCsp,
  launchChromium,
  repoRoot,
  routeSyntheticSessionProjection,
  startLibrarySnapshotStub,
  startSyntheticAgent,
  syntheticSessionUrl,
  withFrontendDevServer,
} from "./frontend-harness.mjs";

/**
 * `scripts/frontend-accessibility.mjs` — mounts the real Next.js landing
 * page in Chromium via `scripts/frontend-harness.mjs` and runs
 * mode-selected checks against it.
 *
 * Task 2 lands exactly two modes: `--write-computed-style-baseline <path>`
 * and `--compare-computed-style-baseline <path>` — the differential-parity
 * proof that splitting `apps/web/app/globals.css` into
 * `packages/ui-web/src/styles.css` plus `apps/web/app/styles/{base,landing,
 * session}.css` changed no rendering.
 *
 * Task 3 adds two more modes (`FRONTEND-002`):
 *
 * - `--owned-surfaces` mounts both `/` and `/session` at 1280x720, 375x667,
 *   and 320x568 using only this plan's owned CSS/component surfaces — it
 *   enforces 44px touch targets, the ochre semantic-text-role rule, `/`'s
 *   single `<main>`, 200%-text-scale zoom safety at 320x568, and keyboard
 *   traversal/focus-visibility — without requiring any Plan-10 file. It
 *   must pass before Plan 10 lands.
 * - `--session-handoff --disclosure-scope all-live-content` mounts
 *   `/session` alone and asserts the Plan-10-owned session landmark/skip
 *   target and Transcript button semantics, plus the *shape* of D-08
 *   Branch A joint typed+voice gating (enforced only when the mounted
 *   session's own agent handshake reports live-provider mode — see
 *   `runSessionHandoffCheck`'s own doc comment for why that branch cannot
 *   be exercised from this no-secret, synthetic-only harness, and why that
 *   is an honest scope limit rather than a vacuous check). D-08 Branch A
 *   (`all-live-content`) is the only recorded/selected D-08 branch in this
 *   program, so this is the only `--disclosure-scope` value implemented.
 *
 * Task 4 adds `--assets` (`FRONTEND-007`): mounts `/` and proves the
 * self-hosted-font and conditional-Muse-fallback contract against real
 * browser/network state rather than source text —
 *
 * - no request during a normal load has host `fonts.googleapis.com` or
 *   `fonts.gstatic.com`;
 * - `document.fonts.check` succeeds (after `document.fonts.load`) for the
 *   serif-normal, serif-italic, and sans roles, resolved from the real
 *   `--viva-font-serif`/`--viva-font-sans` computed values rather than a
 *   hardcoded generated family name;
 * - the visible `.viva-muse__img` has intrinsic `width="1672"`/
 *   `height="941"`, `decoding="async"`, and eager/high-priority loading;
 * - a normal WebP-capable load requests `/viva-muse.webp` and never
 *   `/viva-muse.png`;
 * - when the harness fulfills `/viva-muse.webp` with invalid image bytes,
 *   `.viva-muse__img` recovers to `complete && naturalWidth === 1672` via a
 *   real PNG request, and a real Chrome DevTools Protocol `Network`-domain
 *   session records at most one non-cached (HTTP 200) `/viva-muse.png`
 *   body transfer.
 *
 * Task 5 adds `--landing-affordance` (`FRONTEND-003`, D-03 Branch B — the
 * only recorded D-03 branch in this program): mounts `/` and proves the
 * removed unsigned mode/goal affordances are actually gone from the real
 * page, not merely from source text, and that the one remaining primary
 * action really navigates to the session entry —
 *
 * - no textbox named "Where should Viva begin?" (the removed command input)
 *   is present;
 * - no "Answer out loud" ornamental mic button is present;
 * - none of the three removed suggestion chips ("Quiz Lecture 5", "Mock
 *   viva · 10 min", "Review missed concepts") are present;
 * - exactly one visible, enabled "Begin oral exam" button exists, at least
 *   44x44 CSS px;
 * - clicking it navigates the main frame to `/session` exactly once.
 *
 * Task 6 adds `--session-bootstrap` (`FRONTEND-011`, D-07 Branch A —
 * `retain-token-only`, the only recorded D-07 branch in this program):
 * mounts `/` with a seeded `session_bootstrap_token` sentinel (reusing
 * `LIBRARY_SNAPSHOT_FIXTURE`) and proves, against real browser/network
 * state —
 *
 * - the sentinel is absent from the rendered DOM (text and attributes,
 *   excluding Next's own `<script>`-embedded RSC hydration payload, which
 *   necessarily carries the client component's props and is not rendered,
 *   queryable markup) both before and after clicking Start;
 * - a real click sends the sentinel exactly once, only in the same-origin
 *   `POST /api/viva-session/start` JSON body — a real request, intercepted
 *   and fulfilled with a synthetic complete start response so this check
 *   does not depend on Plan 11's unrelated route-level bootstrap-secret
 *   configuration;
 * - the minted session token never appears in any request URL, in the URL
 *   query string, in a request referrer, or in a browser console message —
 *   only in the post-navigation URL fragment;
 * - a same-origin start request that never resolves surfaces an explicit
 *   "Session start timed out." status within the bound (proving the
 *   client-side 6000ms abort/timeout policy is real, not merely unit-level)
 *   and never navigates.
 *
 * The complementary proof that a successful start hands Plan 10's
 * not-yet-published `replaceBrowserSessionCredential` vault seam the
 * complete start response, strictly before navigation, is a Bun-test/
 * happy-dom-mounted concern (`apps/web/lib/viva-library.test.ts`,
 * `apps/web/components/landing/LandingEntry.test.tsx`) rather than this
 * script's: observing an in-page JS call's exact arguments has no natural
 * black-box browser signal, whereas a real DOM mount gives direct access.
 *
 * Task 9 adds `--deletion` (`FRONTEND-004`, D-04 Branch A — `CONFIRM_DELETE`,
 * the only recorded D-04 branch in this program): mounts `/` and proves, for
 * both a study-set/source row and a session-recap/history row, against real
 * browser/network state —
 *
 * - the first click on "Delete source for …"/"Delete recap for …" opens a
 *   named `role="alertdialog"` (`getByRole("alertdialog", { name, exact:
 *   true })`, so the accessible name is computed the same way a screen
 *   reader would) and issues zero DELETE requests;
 * - focus lands on the confirm action when the dialog opens;
 * - Escape and Cancel each close the dialog without deleting and restore
 *   focus to that row's own initiating button;
 * - confirming issues the row's exact DELETE endpoint exactly once — proved
 *   under a real Playwright `dblclick()`, with the intercepted route
 *   deliberately delayed so the second click of a genuine double-click
 *   lands while the first request is still in flight — and completion is
 *   announced through a `role="status"` region with fixed copy.
 *
 * Task 8 (`FRONTEND-010`, D-06 Branch B — `DELETE`, the only recorded D-06
 * branch in this program) adds no mode here: Branch A's `--static-export`
 * proof is not implemented, since that branch was not selected.
 *
 * Task 11 (`FRONTEND-009`) completes this script (A-27.3):
 *
 * - fixes the `--owned-surfaces` `page.addStyleTag` throw (`checkZoomSafety`,
 *   `checkKeyboardTraversal`) — Plan 11's nonce `style-src` CSP blocks an
 *   injected `<style>` element, so both now use CSP-unaffected techniques
 *   (`style-src-attr` is separately `'unsafe-inline'`) instead of a global
 *   stylesheet;
 * - fixes `--session-handoff`'s stale `"Transcript"` text match to Plan 10's
 *   real `"Show transcript"` label, and mounts a real, connected
 *   `LiveSessionShell` (via `startSyntheticAgent`,
 *   `routeSyntheticSessionProjection`, and `bypassCsp`) instead of a bare,
 *   disconnected `/session` that never rendered `<main>` at all;
 * - asserts D-08 Branch A's joint-gating requirement against what a real
 *   mounted session actually does (an enabled typed-answer/microphone
 *   control must not be reachable before acknowledgment), scoped honestly
 *   to when the mounted session's own agent handshake reports
 *   `brain.live_runtime === true` — never an unverified assumption that the
 *   whole stage container is marked `inert`, and never a claim this
 *   no-secret, synthetic-only harness cannot actually back (see
 *   `runSessionHandoffCheck`'s own doc comment);
 * - adds the bare, no-flag mode (`runFullAccessibilityCheck`): `--owned-
 *   surfaces` and `--session-handoff --disclosure-scope all-live-content`
 *   together, the full item 1-5 contract this plan's acceptance criteria
 *   and `bun run validate` require.
 */

/**
 * Task 11 (`FRONTEND-009`) pure assertion functions, exported so
 * `scripts/frontend-quality.test.mjs` can prove their threshold direction
 * against hostile fixtures without launching a browser — the real mounted
 * checks below call these same functions rather than re-deriving the
 * comparison inline, so a script-level and a quality-test-level pass can
 * never silently disagree about where the line is.
 */

/** `FRONTEND-002` item 1: a route's real `<main>` count. Exactly one passes. */
export function checkMainLandmarkCount(mainCount) {
  return mainCount === 1;
}

/**
 * `FRONTEND-006`: Transcript must be a real `<button>` (never a bare
 * `<details>`/`<summary>` pair) carrying both `aria-expanded` and
 * `aria-controls`.
 */
export function checkTranscriptButtonSemantics(transcript) {
  return (
    transcript.kind === "button" &&
    transcript.hasAriaExpanded === true &&
    transcript.hasAriaControls === true
  );
}

/**
 * `FRONTEND-007`: a healthy, WebP-capable load must never also transfer the
 * PNG fallback — `pngTransferCount` is the number of `/viva-muse.png`
 * requests observed, never a boolean, so a caller with more than one such
 * request is named exactly, not merely flagged.
 */
export function checkNoPngDuringHealthyLoad(pngTransferCount) {
  return pngTransferCount === 0;
}

const ALLOWLISTED_COMPUTED_PROPERTIES = [
  "display",
  "position",
  "font-family",
  "font-size",
  "line-height",
  "color",
  "background-color",
  "border-radius",
  "min-block-size",
];

const BASELINE_VIEWPORTS = [
  { width: 1280, height: 720, label: "1280x720" },
  { width: 375, height: 667, label: "375x667" },
];

/** The three viewports Task 3 Step 1 requires every owned-surface check to run at. */
const OWNED_SURFACE_VIEWPORTS = [
  { width: 1280, height: 720, label: "1280x720" },
  { width: 375, height: 667, label: "375x667" },
  { width: 320, height: 568, label: "320x568" },
];

/** The narrowest owned-surface viewport, used for the 200%-text-scale zoom-safety check. */
const ZOOM_TEXT_SCALE_VIEWPORT = { width: 320, height: 568, label: "320x568" };

/** `FRONTEND-002` item 2's minimum actionable-target bounding box, in CSS px. */
const TOUCH_TARGET_MIN_PX = 44;

/**
 * The routes `--owned-surfaces` mounts. `/` is fully owned by this plan;
 * `/session` is Plan 10's route, but its *current*, pre-Plan-10 markup
 * already renders real `session.css`-styled controls this plan owns the
 * styling of (touch targets, ochre-text contrast) — this mode checks only
 * those CSS-driven concerns there, never the session landmark/skip-link/
 * Transcript-semantics work `--session-handoff` covers instead.
 */
const OWNED_SURFACE_ROUTES = ["/", "/session"];

/**
 * A complete, type-shaped `VivaLibrarySnapshot` fixture (see
 * `apps/web/lib/viva-library.ts`) — content is arbitrary but structurally
 * real, so the mounted page renders actual `.viva-library__*` DOM rather
 * than the `snapshot: null` empty-render path. No production data, no
 * session/control-token shape reused from a real deployment.
 *
 * `app/page.tsx`'s server pipeline both strips every raw `control_token`
 * field (`browserInitialLibrarySnapshot` always strips it now that D-06's
 * DELETE branch retired the build-mode-conditional composition) and, since
 * `frontend-harness.mjs` clears the real signing secret so this harness can
 * never mint a genuine capability, fails to mint a replacement
 * `same_origin_control_token`/
 * `session_bootstrap_token`. The library-mutation and session-start
 * actions below therefore supply their own `same_origin_control_token` /
 * non-null `session_id` directly, so they still project as *available* on
 * the browser-facing snapshot — otherwise every mutation button would
 * render disabled and neither the 44px scan (which, matching item 2's
 * "every visible *enabled*" wording, skips disabled controls) nor the
 * keyboard-traversal check (which must reach a real library action and a
 * real delete decision control) could exercise them at all.
 */
const LIBRARY_SNAPSHOT_FIXTURE = {
  user_id: "user-1",
  privacy: {
    voice_recordings_saved: false,
    transcripts_saved: true,
    raw_audio_persistence: false,
    transcript_persistence: true,
    export_contains_raw_provider_payloads: false,
    export: { available: true, control_token: "stub-export-token" },
    copy: "Viva keeps transcripts and study progress; it does not keep raw audio.",
    data_handling_statement:
      "Viva keeps transcripts and study progress; it does not keep raw audio.",
    retention_statement: "Transcripts are retained until you delete a study set.",
    deletion_statement: "Deleting a study set removes its transcripts and progress.",
  },
  study_sets: [
    {
      id: "biology-midterm",
      user_id: "user-1",
      title: "Biology Midterm",
      course: "BIO 201",
      ingestion_status: "ready",
      ingestion_error: null,
      server_owned: true,
      documents: [
        {
          id: "doc-1",
          display_name: "Lecture 5 slides",
          source_kind: "file",
          processing_status: "ready",
          deleted: false,
        },
      ],
      concept_count: 24,
      question_count: 40,
      actions: {
        start: {
          available: true,
          session_id: "biology-midterm-session-slot",
          session_bootstrap_token: "stub-bootstrap-token",
          session_token: null,
          same_origin_control_token: null,
          control_token: "stub-control-token",
        },
        resume: { available: false, unavailable_reason: "no_active_session" },
        archive: { available: true, control_token: "stub-control-token" },
        delete: {
          available: true,
          control_token: "stub-control-token",
          same_origin_control_token: "stub-same-origin-control-token",
        },
      },
    },
  ],
  sessions: [
    {
      actions: {
        delete: {
          available: true,
          control_token: "stub-control-token",
          same_origin_control_token: "stub-same-origin-control-token",
        },
      },
      voice_session_id: "voice-session-1",
      user_id: "user-1",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      status: "completed",
      terminal_reason: "recap_delivered",
      recap: {
        voice_session_id: "voice-session-1",
        strong_concepts: ["Cell membrane transport"],
        shaky_concepts: ["Krebs cycle"],
        missed_concepts: ["Oxidative phosphorylation"],
        review_later: ["Glycolysis"],
      },
      next_review: {
        concept_id: "oxidative-phosphorylation",
        label: "Oxidative phosphorylation",
        status: "missed",
        persisted_due_at: "2026-08-24T00:00:00Z",
        source: "persisted_review_item",
      },
    },
  ],
};

/**
 * The sanitized-env overrides every owned-surface harness call passes to
 * `withFrontendDevServer` so the server-rendered library snapshot has real,
 * deterministic `.viva-library__*` content to check touch targets/contrast
 * against, instead of the `snapshot: null` empty-render path. Shared by
 * `captureComputedStyleBaseline` (Task 2) and `runOwnedSurfacesCheck`
 * (Task 3) so the fixture wiring can never drift between the two.
 *
 * @param {string} stubUrl
 */
function harnessExtraEnv(stubUrl) {
  return {
    VIVA_AGENT_HTTP_URL: stubUrl,
    VIVA_AGENT_REST_BEARER_TOKEN: "local-frontend-harness-bearer",
    VIVA_SESSION_ALLOWED_USER_IDS: LIBRARY_SNAPSHOT_FIXTURE.user_id,
    VIVA_SESSION_ALLOWED_STUDY_SET_IDS: LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].id,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const writeFlagIndex = args.indexOf("--write-computed-style-baseline");
  const compareFlagIndex = args.indexOf("--compare-computed-style-baseline");

  if (args.includes("--owned-surfaces")) {
    const failures = await runOwnedSurfacesCheck();
    if (failures.length > 0) {
      console.error(`--owned-surfaces FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      "--owned-surfaces OK: 0 issues across",
      OWNED_SURFACE_VIEWPORTS.length,
      "viewports",
    );
    return;
  }

  if (args.includes("--landing-affordance")) {
    const failures = await runLandingAffordanceCheck();
    if (failures.length > 0) {
      console.error(`--landing-affordance FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("--landing-affordance OK: 0 issues");
    return;
  }

  if (args.includes("--assets")) {
    const failures = await runAssetsCheck();
    if (failures.length > 0) {
      console.error(`--assets FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("--assets OK: 0 issues");
    return;
  }

  if (args.includes("--session-bootstrap")) {
    const failures = await runSessionBootstrapCheck();
    if (failures.length > 0) {
      console.error(`--session-bootstrap FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("--session-bootstrap OK: 0 issues");
    return;
  }

  if (args.includes("--deletion")) {
    const failures = await runDeletionCheck();
    if (failures.length > 0) {
      console.error(`--deletion FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("--deletion OK: 0 issues");
    return;
  }

  if (args.includes("--session-handoff")) {
    const scopeFlagIndex = args.indexOf("--disclosure-scope");
    const disclosureScope = scopeFlagIndex !== -1 ? args[scopeFlagIndex + 1] : undefined;
    if (disclosureScope !== "all-live-content") {
      fail(
        "--session-handoff requires --disclosure-scope all-live-content in this program: the " +
          "coordinator has recorded D-08 Branch A (gate all live content) as the selected D-08 " +
          "branch, so this script implements only that assertion set. (A D-08 Branch B " +
          "--disclosure-scope microphone-only mode is not implemented here, since that branch was " +
          "not selected.)",
      );
      return;
    }
    const failures = await runSessionHandoffCheck({ disclosureScope });
    if (failures.length > 0) {
      console.error(
        `--session-handoff --disclosure-scope ${disclosureScope} FAILED (EXPECTED until Plan 10 ` +
          `lands the session landmark/skip target/Transcript button/joint disclosure gating): ` +
          `${failures.length} issue(s)`,
      );
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(`--session-handoff --disclosure-scope ${disclosureScope} OK: 0 issues`);
    return;
  }

  if (writeFlagIndex !== -1) {
    const outPath = args[writeFlagIndex + 1];
    if (!outPath) return fail("--write-computed-style-baseline requires a file path argument");
    const baseline = await captureComputedStyleBaseline();
    writeFileSync(outPath, JSON.stringify(baseline, null, 2));
    console.log(
      `wrote computed-style baseline (${BASELINE_VIEWPORTS.length} viewports) to ${outPath}`,
    );
    return;
  }

  if (compareFlagIndex !== -1) {
    const inPath = args[compareFlagIndex + 1];
    if (!inPath) return fail("--compare-computed-style-baseline requires a file path argument");
    const before = JSON.parse(readFileSync(inPath, "utf8"));
    const after = await captureComputedStyleBaseline();
    const differences = diffComputedStyleBaselines(before, after);
    if (differences.length > 0) {
      console.error(`computed-style parity FAILED: ${differences.length} difference(s)`);
      for (const line of differences.slice(0, 100)) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `computed-style parity OK: 0 differences across ${BASELINE_VIEWPORTS.length} viewports`,
    );
    return;
  }

  if (args.length === 0) {
    const failures = await runFullAccessibilityCheck();
    if (failures.length > 0) {
      console.error(`frontend-accessibility FAILED: ${failures.length} issue(s)`);
      for (const line of failures) console.error(`  - ${line}`);
      process.exitCode = 1;
      return;
    }
    console.log("frontend-accessibility OK: 0 issues (owned surfaces + session handoff)");
    return;
  }

  fail(
    "no recognized mode flag. Supported: --write-computed-style-baseline <path>, " +
      "--compare-computed-style-baseline <path>, --owned-surfaces, --session-handoff " +
      "--disclosure-scope all-live-content, --assets, --landing-affordance, " +
      "--session-bootstrap, --deletion, or no flag at all for the full combined gate.",
  );
}

/**
 * Task 11 (`FRONTEND-009`): the full mode — every item Task 3 named,
 * across both owned and Plan-10-owned surfaces, now that Plan 10 has
 * landed. This is the superset of `--owned-surfaces` (items 2-5 plus the
 * landing half of item 1, needing no Plan-10 file) and
 * `--session-handoff --disclosure-scope all-live-content` (the session
 * half of item 1, Transcript semantics, and D-08 Branch A gating, which
 * genuinely need Plan 10's `LiveSessionShell`/`QuestionStage` mounted) run
 * together and reported as one combined failure list. Task 12 separately
 * re-runs `--session-handoff` on its own for a distinctly-labelled
 * FRONTEND-005/006 RED-to-GREEN record; this bare invocation is this
 * plan's own final acceptance gate (`bun run validate` and the hosted CI
 * step both invoke it with no flag).
 */
async function runFullAccessibilityCheck() {
  // Sequential, not `Promise.all`: each half spawns its own dev server (and
  // the session half also spawns a real agent-service), and running both
  // pairs of processes at once is needless resource contention for a check
  // with no time budget of its own (unlike `frontend-performance.mjs`).
  const ownedSurfaceFailures = await runOwnedSurfacesCheck();
  const sessionHandoffFailures = await runSessionHandoffCheck({
    disclosureScope: "all-live-content",
  });
  return [...ownedSurfaceFailures, ...sessionHandoffFailures];
}

/** Mounts `/` at every baseline viewport and captures allowlisted computed styles. */
async function captureComputedStyleBaseline() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  try {
    return await withFrontendDevServer(
      {
        artifactDir,
        extraEnv: harnessExtraEnv(stub.url),
      },
      async ({ baseUrl }) => {
        const browser = await launchChromium();
        try {
          const result = {};
          for (const viewport of BASELINE_VIEWPORTS) {
            const context = await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
            });
            const page = await context.newPage();
            await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 120_000 });
            await page.waitForSelector(".viva-hero", { state: "attached", timeout: 30_000 });
            await page.waitForSelector(".viva-library", { state: "attached", timeout: 30_000 });
            await page.evaluate(() => document.fonts.ready);
            result[viewport.label] = await page.evaluate((allowlistedProperties) => {
              function structuralPath(element) {
                const parts = [];
                let node = element;
                while (node && node.nodeType === 1 && node !== document.body) {
                  let nth = 1;
                  let sibling = node;
                  // biome-ignore lint/suspicious/noAssignInExpressions: tight DOM-walk loop
                  while ((sibling = sibling.previousElementSibling)) {
                    if (sibling.tagName === node.tagName) nth += 1;
                  }
                  parts.unshift(`${node.tagName}:nth-of-type(${nth})`);
                  node = node.parentElement;
                }
                return `BODY>${parts.join(">")}`;
              }
              const root = document.querySelector("main.viva-landing") ?? document.body;
              const captured = {};
              const elements = [root, ...root.querySelectorAll("*")];
              for (const element of elements) {
                const key = structuralPath(element);
                const computed = window.getComputedStyle(element);
                const styles = {};
                for (const property of allowlistedProperties) {
                  styles[property] = computed.getPropertyValue(property);
                }
                captured[key] = styles;
              }
              return captured;
            }, ALLOWLISTED_COMPUTED_PROPERTIES);
            await context.close();
          }
          return result;
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
}

function diffComputedStyleBaselines(before, after) {
  const differences = [];
  const viewports = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const viewport of viewports) {
    const beforeElements = before[viewport] ?? {};
    const afterElements = after[viewport] ?? {};
    const elementKeys = new Set([...Object.keys(beforeElements), ...Object.keys(afterElements)]);
    for (const key of elementKeys) {
      const beforeStyles = beforeElements[key];
      const afterStyles = afterElements[key];
      if (!beforeStyles) {
        differences.push(`${viewport} ${key}: element present after, absent before`);
        continue;
      }
      if (!afterStyles) {
        differences.push(`${viewport} ${key}: element present before, absent after`);
        continue;
      }
      for (const property of ALLOWLISTED_COMPUTED_PROPERTIES) {
        if (beforeStyles[property] !== afterStyles[property]) {
          differences.push(
            `${viewport} ${key} ${property}: "${beforeStyles[property]}" -> "${afterStyles[property]}"`,
          );
        }
      }
    }
  }
  return differences;
}

/* --------------------------------------------------------------------- *
 * Task 3 (`FRONTEND-002`): `--owned-surfaces` and `--session-handoff`.
 * -------------------------------------------------------------------- */

/**
 * Mounts `/` and `/session` at all three `OWNED_SURFACE_VIEWPORTS`, running
 * only checks this plan can satisfy without any Plan-10 file: 44px touch
 * targets, the ochre semantic-text-role rule, `/`'s single `<main>`, 200%
 * text-scale zoom safety at 320x568, and keyboard traversal/focus
 * visibility. Returns a flat list of human-readable failure strings; empty
 * means every owned-surface check passed.
 */
async function runOwnedSurfacesCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  const failures = [];
  try {
    await withFrontendDevServer(
      { artifactDir, extraEnv: harnessExtraEnv(stub.url) },
      async ({ baseUrl }) => {
        const browser = await launchChromium();
        try {
          for (const viewport of OWNED_SURFACE_VIEWPORTS) {
            for (const route of OWNED_SURFACE_ROUTES) {
              const context = await browser.newContext({
                viewport: { width: viewport.width, height: viewport.height },
              });
              const page = await context.newPage();
              try {
                await gotoRouteReady(page, baseUrl, route);
                failures.push(
                  ...(await checkOwnedSurfacePage(page, { route, viewportLabel: viewport.label })),
                );
              } finally {
                await context.close();
              }
            }
          }
          failures.push(...(await checkZoomSafety(browser, baseUrl)));
          failures.push(...(await checkKeyboardTraversal(browser, baseUrl)));
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
  return failures;
}

/**
 * Navigates `page` to `route` and waits for that route's real content to be
 * attached. `/session` never reaches Playwright's "networkidle" state (its
 * client keeps retrying a WebSocket connection with no real agent-service
 * behind this harness), so it waits on `"load"` plus an explicit selector
 * instead; `/` still uses `"networkidle"` exactly as Task 2 established.
 *
 * @param {import("playwright").Page} page
 * @param {string} baseUrl
 * @param {string} route
 */
async function gotoRouteReady(page, baseUrl, route) {
  await page.goto(`${baseUrl}${route}`, {
    waitUntil: route === "/" ? "networkidle" : "load",
    timeout: 120_000,
  });
  if (route === "/") {
    await page.waitForSelector(".viva-hero", { state: "attached", timeout: 30_000 });
    await page.waitForSelector(".viva-library", { state: "attached", timeout: 30_000 });
  } else {
    await page.waitForSelector(".live-session", { state: "attached", timeout: 30_000 });
  }
  await page.evaluate(() => document.fonts.ready);
}

/**
 * The in-browser scan shared by every `--owned-surfaces` page visit: every
 * visible, enabled `button`/`summary`/`a[href]`/`[role=button]`'s bounding
 * box, every visible text-bearing element's resolved `color` (to catch the
 * decorative `--viva-ochre` value leaking into real text), and (on `/`
 * only) the document's `<main>` count.
 *
 * @param {import("playwright").Page} page
 * @param {{ route: string, viewportLabel: string }} context
 */
async function checkOwnedSurfacePage(page, { route, viewportLabel }) {
  const result = await page.evaluate((minTouchPx) => {
    function isElementVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (Number.parseFloat(style.opacity) === 0) return false;
      if (el.closest('[aria-hidden="true"], [hidden]')) return false;
      return true;
    }
    function isDisabled(el) {
      if ("disabled" in el && el.disabled) return true;
      return el.getAttribute("aria-disabled") === "true";
    }
    function classNameOf(el) {
      return typeof el.className === "string" ? el.className : "";
    }
    function accessibleName(el) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel?.trim()) return ariaLabel.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = el.textContent?.trim();
      return text ? text.slice(0, 80) : el.tagName.toLowerCase();
    }

    const undersized = [];
    for (const el of document.querySelectorAll('button, summary, a[href], [role="button"]')) {
      if (isDisabled(el)) continue;
      if (!isElementVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      // A small epsilon absorbs browser subpixel-rounding noise (e.g.
      // 43.98px measured for an authored 44px box); it must never absorb a
      // genuine deficit like the Step 4 mutation's 35px.
      if (rect.width < minTouchPx - 0.1 || rect.height < minTouchPx - 0.1) {
        undersized.push({
          name: accessibleName(el),
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          tag: el.tagName.toLowerCase(),
          className: classNameOf(el),
        });
      }
    }

    function resolveVarColor(varExpression) {
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.color = varExpression;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }
    const ochreRgb = resolveVarColor("var(--viva-ochre)");
    const ochreTextRgb = resolveVarColor("var(--viva-ochre-text)");
    const ochreViolations = [];
    if (ochreRgb && ochreRgb !== ochreTextRgb) {
      for (const el of document.querySelectorAll("body *")) {
        if (el.closest('[aria-hidden="true"], [hidden]')) continue;
        const hasDirectText = Array.prototype.some.call(
          el.childNodes,
          (node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0,
        );
        if (!hasDirectText) continue;
        if (!isElementVisible(el)) continue;
        if (getComputedStyle(el).color === ochreRgb) {
          ochreViolations.push({
            text: (el.textContent ?? "").trim().slice(0, 60),
            tag: el.tagName.toLowerCase(),
            className: classNameOf(el),
          });
        }
      }
    }

    return { undersized, ochreViolations, mainCount: document.querySelectorAll("main").length };
  }, TOUCH_TARGET_MIN_PX);

  const failures = [];
  for (const item of result.undersized) {
    const selector = item.className
      ? `${item.tag}.${item.className.split(/\s+/).join(".")}`
      : item.tag;
    failures.push(
      `[${route} @ ${viewportLabel}] touch target too small: "${item.name}" (<${selector}>) measured ` +
        `${item.width}x${item.height}px, need >= ${TOUCH_TARGET_MIN_PX}x${TOUCH_TARGET_MIN_PX}px`,
    );
  }
  for (const item of result.ochreViolations) {
    const selector = item.className
      ? `${item.tag}.${item.className.split(/\s+/).join(".")}`
      : item.tag;
    failures.push(
      `[${route} @ ${viewportLabel}] semantic text "${item.text}" (<${selector}>) resolves to the ` +
        "decorative --viva-ochre color; text must resolve through --viva-ochre-text instead",
    );
  }
  if (route === "/" && !checkMainLandmarkCount(result.mainCount)) {
    failures.push(
      `[${route} @ ${viewportLabel}] expected exactly one <main>, found ${result.mainCount}`,
    );
  }
  return failures;
}

/**
 * `FRONTEND-002` item 4: at a 200% root text scale and 320px viewport,
 * document horizontal overflow must be at most 1px and privacy/deletion
 * copy must not be truncated. `html { font-size: 200% }` is the standard
 * way to emulate a user's OS/browser text-only zoom setting — it grows
 * every `rem`/`em`-sized value without touching physical viewport width,
 * exactly what a "200% text scale" accessibility setting does.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkZoomSafety(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({
    viewport: { width: ZOOM_TEXT_SCALE_VIEWPORT.width, height: ZOOM_TEXT_SCALE_VIEWPORT.height },
  });
  const page = await context.newPage();
  try {
    await gotoRouteReady(page, baseUrl, "/");
    // A-27.3: `page.addStyleTag` injects a real `<style>` element, which
    // Plan 11's nonce-based `style-src` CSP (no `unsafe-inline`, no static
    // hash for content this script only generates at runtime) blocks
    // outright — Playwright then throws rather than returning a diff. CSP's
    // `style-src-attr` is separately configured `'unsafe-inline'` (see
    // `apps/web/proxy.ts`), so setting the `style` ATTRIBUTE directly is
    // unaffected; this sets a single inline style declaration on the root
    // element via the DOM instead of injecting a stylesheet.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("font-size", "200%", "important");
    });
    // Let layout settle after the style change before measuring.
    await page.waitForTimeout(100);
    const report = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
      const truncated = [];
      const copyNodes = document.querySelectorAll(
        '.viva-library__privacy p, .viva-library__privacy span, [aria-label^="Delete"], [aria-label^="Start"], [aria-label^="Resume"]',
      );
      for (const el of copyNodes) {
        const style = getComputedStyle(el);
        const clippedHorizontally =
          style.overflow === "hidden" ||
          style.overflowX === "hidden" ||
          style.textOverflow === "ellipsis";
        if (clippedHorizontally && el.scrollWidth > el.clientWidth + 1) {
          truncated.push(
            (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 80),
          );
        }
      }
      return { overflow, truncated };
    });
    if (report.overflow > 1) {
      failures.push(
        `[/ @ ${ZOOM_TEXT_SCALE_VIEWPORT.label}, 200% text scale] document horizontal overflow is ` +
          `${report.overflow}px, expected <= 1px`,
      );
    }
    for (const text of report.truncated) {
      failures.push(
        `[/ @ ${ZOOM_TEXT_SCALE_VIEWPORT.label}, 200% text scale] copy is truncated: "${text}"`,
      );
    }
  } finally {
    await context.close();
  }
  return failures;
}

/**
 * `FRONTEND-002` item 5: keyboard `Tab` traversal from a fresh page reaches
 * the main hero action, a library Start/Resume action, and a delete
 * decision control, each with a visible `:focus` indicator (a non-`none`
 * outline or a `box-shadow`); under `forced-colors: active` emulation the
 * first focused control still carries an outline.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkKeyboardTraversal(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await gotoRouteReady(page, baseUrl, "/");
    // Several focus rings (e.g. .viva-chip:focus-visible) are declared with
    // a CSS transition, so getComputedStyle read synchronously after a Tab
    // press can observe a mid-transition (or even pre-transition) value
    // rather than the settled focus style. This used to disable every
    // transition/animation with a global `page.addStyleTag` `<style>` rule;
    // A-27.3: Plan 11's nonce-based `style-src` CSP now blocks that inline
    // stylesheet outright (Playwright throws rather than returning a diff),
    // and unlike `checkZoomSafety`'s single root `font-size`, this rule
    // targeted `*::before`/`*::after` too, which have no DOM node a script
    // could set an inline style property on even under `style-src-attr`'s
    // separate `'unsafe-inline'` allowance. Polling each snapshot until two
    // consecutive reads agree (bounded, so a genuinely absent focus
    // indicator still fails promptly rather than hanging) observes the real
    // settled end state instead, without touching any stylesheet.

    const tabbed = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(async () => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;

        // A composite control (e.g. the command pill) may draw its focus
        // ring on an ancestor via :focus-within/:has(:focus-visible) rather
        // than on the focused element itself, so this walks a few ancestor
        // levels rather than only inspecting `el`'s own computed style. But
        // an *ambient* decorative outline/box-shadow present regardless of
        // focus must not count as "visible focus indicator" either — so
        // this blurs the element, snapshots the same properties again, and
        // only counts a property that genuinely *changes* between the
        // focused and blurred states, then restores focus so the next Tab
        // press continues naturally from here.
        function chain(node) {
          const nodes = [];
          for (let cur = node, depth = 0; cur && depth < 5; cur = cur.parentElement, depth++) {
            nodes.push(cur);
          }
          return nodes;
        }
        function snapshot(nodes) {
          return nodes.map((node) => {
            const style = getComputedStyle(node);
            return {
              outline:
                style.outlineStyle === "none"
                  ? "none"
                  : `${style.outlineWidth}/${style.outlineStyle}`,
              boxShadow: style.boxShadow,
            };
          });
        }
        // Waits for `snapshot(nodes)` to stop changing between consecutive
        // ~16ms polls (one frame), up to ~512ms — comfortably above the
        // longest authored focus-ring transition in this codebase (450ms) —
        // so a mid-transition read never gets compared against another
        // mid-transition read.
        async function settledSnapshot(nodes) {
          let previous = snapshot(nodes);
          for (let attempt = 0; attempt < 32; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 16));
            const next = snapshot(nodes);
            if (JSON.stringify(next) === JSON.stringify(previous)) return next;
            previous = next;
          }
          return previous;
        }
        const nodes = chain(el);
        const focusedSnapshot = await settledSnapshot(nodes);
        el.blur();
        const blurredSnapshot = await settledSnapshot(nodes);
        el.focus();
        const hasVisibleFocus = focusedSnapshot.some(
          (focused, i) =>
            focused.outline !== blurredSnapshot[i].outline ||
            focused.boxShadow !== blurredSnapshot[i].boxShadow,
        );

        return {
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className : "",
          ariaLabel: el.getAttribute("aria-label"),
          text: (el.textContent ?? "").trim().slice(0, 60),
          hasVisibleFocus,
        };
      });
      if (!info) break;
      tabbed.push(info);
    }

    const nameOf = (item) => item.ariaLabel ?? item.text;
    // D-03 Branch B (Task 5, `FRONTEND-003`) replaced the old command
    // surface's "Start studying"/"Answer out loud" controls with the one
    // honest "Begin oral exam" button; this is the hero's only main action
    // now.
    const reachedMainAction = tabbed.some((item) => nameOf(item) === "Begin oral exam");
    const reachedLibraryAction = tabbed.some((item) => /^(Start|Resume) /.test(nameOf(item) ?? ""));
    const reachedDeleteAction = tabbed.some((item) => /^Delete /.test(nameOf(item) ?? ""));
    if (!reachedMainAction) {
      failures.push("[/ keyboard] Tab order never reaches the main hero action");
    }
    if (!reachedLibraryAction) {
      failures.push("[/ keyboard] Tab order never reaches a library Start/Resume action");
    }
    if (!reachedDeleteAction) {
      failures.push("[/ keyboard] Tab order never reaches a delete decision control");
    }
    for (const item of tabbed.filter((entry) => !entry.hasVisibleFocus)) {
      const selector = item.className
        ? `${item.tag}.${item.className.split(/\s+/).join(".")}`
        : item.tag;
      failures.push(
        `[/ keyboard] <${selector}> "${nameOf(item)}" has no visible focus indicator ` +
          "(no outline and no box-shadow while focused)",
      );
    }

    await page.emulateMedia({ forcedColors: "active" });
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press("Tab");
    const forcedColorsHasOutline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      const style = getComputedStyle(el);
      return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    });
    if (!forcedColorsHasOutline) {
      failures.push(
        "[/ keyboard, forced-colors: active] the first focused control has no outline under forced-colors emulation",
      );
    }
  } finally {
    await context.close();
  }
  return failures;
}

/**
 * `--session-handoff --disclosure-scope all-live-content`: mounts a real
 * `/session` and asserts the session landmark/skip target and Transcript
 * button semantics (`FRONTEND-002`/`FRONTEND-006`), plus the *shape* of
 * D-08 Branch A's joint typed+voice gating requirement.
 *
 * Reaching a real `LiveSessionShell` render needs a real synthetic
 * agent-service (`startSyntheticAgent`) plus
 * `routeSyntheticSessionProjection`'s same-origin projection interception
 * — see `frontend-harness.mjs`'s doc comments for the confirmed reason no
 * signed capability (a real click-through start, or the agent's own
 * projection route) is reachable from a database-free harness at all. It
 * also needs `bypassCsp` (see that function's own doc comment for the real,
 * confirmed, not-owned-here CSP/env-var defect that otherwise blocks the
 * agent WebSocket outright).
 *
 * D-08 Branch A's own recorded text scopes the joint-gating requirement to
 * "live-provider mode", and separately says "synthetic mode remains
 * accurately distinguished" — i.e. exempt. This mounted check reads the
 * agent's real `"ready"` WS frame's `brain.live_runtime` field (never
 * assumed) and enforces the requirement only when that field is genuinely
 * observed `true`. It can never be `true` here: `startSyntheticAgent` only
 * ever runs the agent's synthetic brain, which unconditionally reports
 * `live_runtime: false` (`agent/crates/agent-adapters/src/synthetic.rs`);
 * `live_runtime: true` requires the real Cartesia/Gemini adapter with real,
 * paid provider API keys this no-secret harness must never hold
 * (`AMBIENT_VARS_TO_CLEAR` clears exactly those). Confirmed empirically,
 * not merely inferred: with `bypassCsp` letting the agent WebSocket
 * actually open, the mounted session shows a real, *enabled* "Write
 * answer" control while the disclosure banner is still unacknowledged —
 * correct synthetic-mode behavior (`providerInputAllowed`'s own
 * `if (!input.liveProvider) return true`), not a gating violation. Treating
 * that as a failure would be a false positive against correct code, not
 * evidence of anything. `FRONTEND-005`'s actual closure — proving inverted
 * live-provider gating fails — is Plan 10's own source-level mutation
 * evidence over `providerInputAllowed`, consumed at Task 12; this script
 * never re-derives a live-provider claim it cannot actually exercise.
 *
 * @param {{ disclosureScope: "all-live-content" }} options
 */
async function runSessionHandoffCheck({ disclosureScope }) {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const failures = [];
  const agent = await startSyntheticAgent({ artifactDir });
  try {
    await withFrontendDevServer(
      {
        artifactDir,
        extraEnv: {
          NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: agent.url,
          NEXT_PUBLIC_VIVA_AGENT_WS_URL: agent.wsUrl,
        },
      },
      async ({ baseUrl }) => {
        const browser = await launchChromium();
        try {
          const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
          const page = await context.newPage();
          try {
            await bypassCsp(page);
            const openedWebSocketUrls = [];
            let liveRuntimeObserved = null;
            page.on("websocket", (socket) => {
              openedWebSocketUrls.push(socket.url());
              socket.on("framereceived", (frame) => {
                if (typeof frame.payload !== "string") return;
                let message;
                try {
                  message = JSON.parse(frame.payload);
                } catch {
                  return;
                }
                if (
                  message?.type === "ready" &&
                  typeof message.brain?.live_runtime === "boolean"
                ) {
                  liveRuntimeObserved = message.brain.live_runtime;
                }
              });
            });
            await routeSyntheticSessionProjection(page);
            await page.goto(toHydratableUrl(syntheticSessionUrl(baseUrl)), {
              timeout: 120_000,
              waitUntil: "load",
            });
            await page.waitForSelector(".live-session", { state: "attached", timeout: 30_000 });
            await page.waitForSelector(".voice-trace[data-render-mode]", { timeout: 15_000 });
            await page.evaluate(() => document.fonts.ready);

            // A basic harness health check, independent of D-08 semantics:
            // the mounted session must actually open a WebSocket to the
            // real synthetic agent (this is the CSP-bypass fix's own
            // regression guard — reproducibly false without `bypassCsp`,
            // per that function's doc comment).
            for (let attempt = 0; attempt < 20 && !openedWebSocketUrls.includes(agent.wsUrl); attempt++) {
              await page.waitForTimeout(250);
            }
            if (!openedWebSocketUrls.includes(agent.wsUrl)) {
              failures.push(
                `expected the mounted session to open a WebSocket to the real synthetic agent ` +
                  `at ${agent.wsUrl}, but it never did (openedWebSocketUrls: ` +
                  `${JSON.stringify(openedWebSocketUrls)})`,
              );
            }
            for (let attempt = 0; attempt < 20 && liveRuntimeObserved === null; attempt++) {
              await page.waitForTimeout(250);
            }

            // Item 1 (session half): exactly one <main>, plus a visible-on-focus
            // skip link targeting the active question/answer region.
            const mainCount = await page.evaluate(() => document.querySelectorAll("main").length);
            if (!checkMainLandmarkCount(mainCount)) {
              failures.push(
                `/session must expose exactly one <main>, found ${mainCount} (Plan 10 handoff, FRONTEND-002 item 1)`,
              );
            }
            const hasSkipLink = await page.evaluate(() =>
              [...document.querySelectorAll('a[href^="#"]')].some((a) =>
                /skip/i.test(a.textContent ?? ""),
              ),
            );
            if (!hasSkipLink) {
              failures.push(
                "/session has no visible-on-focus skip link targeting the active question/answer region (Plan 10 handoff, FRONTEND-002 item 1)",
              );
            }

            // FRONTEND-006: Transcript is a real button with aria-expanded and
            // stable aria-controls, not a bare <details>/<summary> pair.
            // A-27.3: Plan 10's real label is "Show transcript" — this
            // originally matched the bare word "Transcript", which never
            // matched anything real once Plan 10 landed.
            const transcript = await page.evaluate(() => {
              const button = [...document.querySelectorAll("button")].find(
                (el) => (el.textContent ?? "").trim() === "Show transcript",
              );
              if (button) {
                return {
                  kind: "button",
                  hasAriaExpanded: button.hasAttribute("aria-expanded"),
                  hasAriaControls: button.hasAttribute("aria-controls"),
                };
              }
              const summary = [...document.querySelectorAll("summary")].find(
                (el) => (el.textContent ?? "").trim() === "Show transcript",
              );
              if (summary) return { kind: "details-summary" };
              return { kind: "missing" };
            });
            if (!checkTranscriptButtonSemantics(transcript)) {
              failures.push(
                `Transcript is not a real button with aria-expanded/aria-controls semantics (found: ${JSON.stringify(
                  transcript,
                )}) (Plan 10 handoff, FRONTEND-006)`,
              );
            }

            // D-08 Branch A: acknowledgment must jointly gate typed and voice
            // live content, not only the microphone, until the disclosure is
            // acknowledged — but (per the recorded decision's own words)
            // only "in live-provider mode"; synthetic mode is exempt by
            // design. Enforced here only when the mounted session's own
            // agent handshake reports `live_runtime === true` — seeing this
            // function's doc comment for why that can never be true from
            // this no-secret, synthetic-only harness today, and why that is
            // an honest scope limit rather than a vacuous check: this
            // assertion is real and would fail the moment it is ever run
            // against a live-provider-configured agent. Never a
            // container-inertness assumption: Plan 10's `consentDisclosure`
            // prop only ever decides whether to render the banner itself
            // (confirmed by reading `QuestionStage.tsx`, which never reads
            // `consentDisclosure`/`acknowledged` at all), so asserting the
            // stage container is marked `inert`/`aria-hidden` would fail
            // against a real, correctly-gated implementation that withholds
            // only the answer surface instead of hiding a stage that still
            // legitimately shows the question.
            if (disclosureScope === "all-live-content" && liveRuntimeObserved === true) {
              const consentShown = await page.evaluate(() =>
                Boolean(document.querySelector(".session-consent")),
              );
              const answerSurfaceReachable = await page.evaluate(() => {
                const stage = document.querySelector(".live-session__stage");
                if (!stage) return false;
                const isEnabled = (el) =>
                  !("disabled" in el && el.disabled) && el.getAttribute("aria-disabled") !== "true";
                return [...stage.querySelectorAll("textarea, button, [role=button]")].some((el) => {
                  if (!isEnabled(el)) return false;
                  if (el.tagName === "TEXTAREA") return true;
                  const name = (el.getAttribute("aria-label") ?? el.textContent ?? "")
                    .trim()
                    .toLowerCase();
                  return /answer|speak|record|microphone/.test(name);
                });
              });
              if (consentShown && answerSurfaceReachable) {
                failures.push(
                  "D-08 Branch A requires both typed and voice live content to be blocked until the " +
                    "disclosure is acknowledged in live-provider mode, but an enabled answer/" +
                    "microphone control was reachable in the stage while brain.live_runtime=true " +
                    "and the disclosure banner was still shown unacknowledged " +
                    "(Plan 10 handoff, FRONTEND-005/WEBSESSION-DISCLOSURE-01)",
                );
              }
            } else if (disclosureScope === "all-live-content") {
              console.log(
                "[session-handoff] D-08 Branch A's joint-gating requirement applies only in " +
                  "live-provider mode (brain.live_runtime=true); this no-secret harness's agent " +
                  `can only ever run synthetic (observed live_runtime=` +
                  `${JSON.stringify(liveRuntimeObserved)}), so that branch is not exercised here ` +
                  "-- see FRONTEND-005/Task 12 and Plan 10's own source-level mutation evidence " +
                  "over providerInputAllowed for that closure.",
              );
            }
          } finally {
            await context.close();
          }
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await agent.close();
  }
  return failures;
}

/* --------------------------------------------------------------------- *
 * Task 5 (`FRONTEND-003`): `--landing-affordance`.
 * -------------------------------------------------------------------- */

/**
 * D-03 Branch B (the only recorded D-03 branch in this program): mounts `/`
 * and proves the removed unsigned mode/goal affordances are gone from the
 * real page and that the one remaining primary action really navigates to
 * the session entry. Clicking the begin button exercises real client-side
 * React state (its `onClick` handler), so — like Task 4's `--assets` checks
 * below — this needs a real hydrated page; see `toHydratableUrl` (defined
 * below, but a hoisted function declaration) for why `baseUrl` must be
 * rewritten first.
 */
async function runLandingAffordanceCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  const failures = [];
  try {
    await withFrontendDevServer(
      { artifactDir, extraEnv: harnessExtraEnv(stub.url) },
      async ({ baseUrl }) => {
        const hydratableBaseUrl = toHydratableUrl(baseUrl);
        const browser = await launchChromium();
        try {
          const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
          const page = await context.newPage();
          try {
            await gotoRouteReady(page, hydratableBaseUrl, "/");
            failures.push(...(await checkLandingAffordanceMarkup(page)));
            // Only attempt the click/navigation proof once the markup check
            // above confirms exactly one real begin button exists — clicking
            // a missing/duplicated button would just throw and mask the
            // same underlying defect behind a confusing second failure.
            if (failures.length === 0) {
              failures.push(...(await checkBeginButtonNavigatesOnce(page, hydratableBaseUrl)));
            }
          } finally {
            await context.close();
          }
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
  return failures;
}

/**
 * Scans the real mounted `/` DOM for the affordances D-03 Branch B removes
 * (a "Where should Viva begin?" textbox, an "Answer out loud" mic, and the
 * three suggestion chips) and for exactly one visible, enabled, >= 44x44
 * CSS px "Begin oral exam" button.
 *
 * @param {import("playwright").Page} page
 */
async function checkLandingAffordanceMarkup(page) {
  const result = await page.evaluate(() => {
    function isElementVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (Number.parseFloat(style.opacity) === 0) return false;
      if (el.closest('[aria-hidden="true"], [hidden]')) return false;
      return true;
    }
    function isDisabled(el) {
      if ("disabled" in el && el.disabled) return true;
      return el.getAttribute("aria-disabled") === "true";
    }

    const bodyText = document.body.textContent ?? "";
    const hasCommandTextbox = Array.from(
      document.querySelectorAll(
        'input[aria-label="Where should Viva begin?"], input[placeholder="Where should Viva begin?"]',
      ),
    ).some(isElementVisible);
    const hasMic = Array.from(document.querySelectorAll('[aria-label="Answer out loud"]')).some(
      isElementVisible,
    );

    const beginButtons = Array.from(document.querySelectorAll("button")).filter(
      (el) =>
        !isDisabled(el) &&
        isElementVisible(el) &&
        (el.textContent ?? "").trim() === "Begin oral exam",
    );
    const rect = beginButtons[0]?.getBoundingClientRect() ?? null;

    return {
      hasCommandTextbox,
      hasMic,
      hasQuizChip: bodyText.includes("Quiz Lecture 5"),
      hasMockChip: bodyText.includes("Mock viva · 10 min"),
      hasReviewChip: bodyText.includes("Review missed concepts"),
      beginButtonCount: beginButtons.length,
      beginButtonBox: rect ? { width: rect.width, height: rect.height } : null,
    };
  });

  const failures = [];
  if (result.hasCommandTextbox) {
    failures.push(
      '[landing-affordance] the removed command textbox "Where should Viva begin?" is still present',
    );
  }
  if (result.hasMic) {
    failures.push(
      '[landing-affordance] the removed ornamental "Answer out loud" mic is still present',
    );
  }
  if (result.hasQuizChip) {
    failures.push('[landing-affordance] the removed "Quiz Lecture 5" suggestion is still present');
  }
  if (result.hasMockChip) {
    failures.push(
      '[landing-affordance] the removed "Mock viva · 10 min" suggestion is still present',
    );
  }
  if (result.hasReviewChip) {
    failures.push(
      '[landing-affordance] the removed "Review missed concepts" suggestion is still present',
    );
  }
  if (result.beginButtonCount !== 1) {
    failures.push(
      `[landing-affordance] expected exactly one visible, enabled "Begin oral exam" button, ` +
        `found ${result.beginButtonCount}`,
    );
  } else if (
    result.beginButtonBox &&
    (result.beginButtonBox.width < TOUCH_TARGET_MIN_PX - 0.1 ||
      result.beginButtonBox.height < TOUCH_TARGET_MIN_PX - 0.1)
  ) {
    failures.push(
      `[landing-affordance] "Begin oral exam" button measured ` +
        `${Math.round(result.beginButtonBox.width * 100) / 100}x` +
        `${Math.round(result.beginButtonBox.height * 100) / 100}px, need >= ` +
        `${TOUCH_TARGET_MIN_PX}x${TOUCH_TARGET_MIN_PX}px`,
    );
  }
  return failures;
}

/**
 * Clicks the real "Begin oral exam" button and proves the main frame
 * navigates to `/session` exactly once — real Chromium navigation state,
 * not a spied callback.
 *
 * @param {import("playwright").Page} page
 * @param {string} baseUrl
 */
async function checkBeginButtonNavigatesOnce(page, baseUrl) {
  const failures = [];
  const navigations = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  try {
    await page.getByRole("button", { name: "Begin oral exam", exact: true }).click();
    await page.waitForURL(`${baseUrl}/session`, { timeout: 30_000 });
  } catch (error) {
    failures.push(
      `[landing-affordance] clicking "Begin oral exam" did not navigate to /session: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return failures;
  }

  if (navigations.length !== 1) {
    failures.push(
      `[landing-affordance] expected exactly one main-frame navigation after clicking "Begin ` +
        `oral exam", observed ${navigations.length}: ${JSON.stringify(navigations)}`,
    );
  }
  const finalUrl = new URL(page.url());
  if (finalUrl.pathname !== "/session") {
    failures.push(
      `[landing-affordance] expected the begin button to navigate to /session, landed on ` +
        `${finalUrl.pathname}${finalUrl.search}${finalUrl.hash}`,
    );
  }
  return failures;
}

/* --------------------------------------------------------------------- *
 * Task 6 (`FRONTEND-011`): `--session-bootstrap`.
 * -------------------------------------------------------------------- */

/** The seeded bootstrap sentinel `LIBRARY_SNAPSHOT_FIXTURE` already carries (see its own header comment). */
const SESSION_BOOTSTRAP_SENTINEL =
  LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].actions.start.session_bootstrap_token;
const SESSION_BOOTSTRAP_ACCESSIBLE_NAME = `Start ${LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].title}`;
const SYNTHETIC_SESSION_TOKEN = "synthetic-session-token-for-frontend-accessibility-check";
const SYNTHETIC_REFRESH_TOKEN = "synthetic-refresh-token-for-frontend-accessibility-check";

/** A synthetic, complete `/api/viva-session/start` response body, matching the fixture's identity. */
function syntheticStartResponseBody() {
  return JSON.stringify({
    failure_class: null,
    refresh_expires_at: "2026-08-31T00:00:00Z",
    refresh_token: SYNTHETIC_REFRESH_TOKEN,
    session: {
      session_id: LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].actions.start.session_id,
      study_set_id: LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].id,
      user_id: LIBRARY_SNAPSHOT_FIXTURE.user_id,
    },
    session_absolute_expires_at: "2026-09-23T00:00:00Z",
    session_token: SYNTHETIC_SESSION_TOKEN,
    token_refresh_outcome: "issued",
  });
}

/**
 * Serializes `document.body` with every `<script>`/`<style>`/`<template>`
 * element removed first — the rendered, queryable markup surface a user, an
 * assistive technology, or a DOM-scraping log/analytics integration could
 * actually observe. This deliberately excludes Next.js's own inline RSC
 * flight-data `<script>` payload, which necessarily carries this client
 * component's props (including `session_bootstrap_token`, so client JS can
 * echo it back in the start POST body) but is neither rendered text nor an
 * element attribute in the sense `FRONTEND-011` cares about.
 *
 * @param {import("playwright").Page} page
 */
async function visibleBodyMarkup(page) {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    for (const el of Array.from(clone.querySelectorAll("script, style, template"))) el.remove();
    return clone.outerHTML;
  });
}

/**
 * D-07 Branch A Step 3's "adds no persistent browser storage": reads every
 * `localStorage`/`sessionStorage` key and `document.cookie` in one
 * `page.evaluate` round trip and fails if the serialized snapshot contains
 * the bootstrap sentinel, the minted session token, or the minted refresh
 * token. Storage is the one capability surface `FRONTEND-011`'s Step 1 names
 * ("no credential field enters DOM, URL query, storage, or logs") that had
 * no negative control anywhere in this script before this check — today's
 * real code never touches storage, so this exists to catch a future
 * regression, not a live leak.
 *
 * @param {import("playwright").Page} page
 */
async function checkNoSessionBootstrapStorageLeak(page) {
  const failures = [];
  const storageSnapshot = await page.evaluate(() =>
    JSON.stringify({
      cookie: document.cookie,
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  );
  for (const [needle, label] of [
    [SESSION_BOOTSTRAP_SENTINEL, "the bootstrap sentinel"],
    [SYNTHETIC_SESSION_TOKEN, "the minted session token"],
    [SYNTHETIC_REFRESH_TOKEN, "the minted refresh token"],
  ]) {
    if (storageSnapshot.includes(needle)) {
      failures.push(
        `[session-bootstrap] browser storage (localStorage/sessionStorage/cookie) persisted ` +
          `${label}: ${storageSnapshot}`,
      );
    }
  }
  return failures;
}

/**
 * Mounts `/`, seeds the library-snapshot fixture's `session_bootstrap_token`
 * sentinel, and runs both `--session-bootstrap` scenarios: normal secrecy/
 * fragment-placement (`checkSessionBootstrapSecrecyAndFragment`) and the
 * bounded-fetch timeout proof (`checkSessionBootstrapFetchBound`).
 */
async function runSessionBootstrapCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  const failures = [];
  try {
    await withFrontendDevServer(
      { artifactDir, extraEnv: harnessExtraEnv(stub.url) },
      async ({ baseUrl }) => {
        const hydratableBaseUrl = toHydratableUrl(baseUrl);
        const browser = await launchChromium();
        try {
          failures.push(
            ...(await checkSessionBootstrapSecrecyAndFragment(browser, hydratableBaseUrl)),
          );
          failures.push(...(await checkSessionBootstrapFetchBound(browser, hydratableBaseUrl)));
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
  return failures;
}

/**
 * D-07 Branch A's capability-location proof: the seeded bootstrap sentinel
 * never reaches rendered DOM text/attributes, a request URL, or a request
 * referrer; a real click sends it exactly once, only in the same-origin
 * start POST body (a real request, intercepted and fulfilled with a
 * synthetic complete response so this does not depend on Plan 11's
 * bootstrap-secret route configuration); and the minted session token
 * afterward appears only in the navigation fragment, never the query string,
 * a request URL, a referrer, or a browser console message.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkSessionBootstrapSecrecyAndFragment(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleTexts = [];
  page.on("console", (msg) => consoleTexts.push(msg.text()));
  // An uncaught exception or unhandled promise rejection is a distinct
  // Playwright event from `console` — Chromium's own error printer, not an
  // explicit `console.*` call — so "logs" covers both.
  page.on("pageerror", (error) => consoleTexts.push(String(error?.message ?? error)));
  const requestRecords = [];
  page.on("request", (request) => {
    const headers = request.headers();
    requestRecords.push({
      referer: headers.referer ?? headers.referrer ?? null,
      url: request.url(),
    });
  });
  const capturedStartRequests = [];
  await page.route("**/api/viva-session/start", async (route) => {
    capturedStartRequests.push({ body: route.request().postData() });
    await route.fulfill({
      body: syntheticStartResponseBody(),
      contentType: "application/json",
      status: 200,
    });
  });

  try {
    await gotoRouteReady(page, baseUrl, "/");

    const beforeClickMarkup = await visibleBodyMarkup(page);
    if (beforeClickMarkup.includes(SESSION_BOOTSTRAP_SENTINEL)) {
      failures.push(
        "[session-bootstrap] the bootstrap sentinel is present in the rendered DOM before any click",
      );
    }

    await page
      .getByRole("button", { name: SESSION_BOOTSTRAP_ACCESSIBLE_NAME, exact: true })
      .click();
    await page
      .waitForFunction(() => location.hash.includes("session_token="), undefined, {
        timeout: 10_000,
      })
      .catch(() => {});

    const afterClickMarkup = await visibleBodyMarkup(page);
    if (afterClickMarkup.includes(SESSION_BOOTSTRAP_SENTINEL)) {
      failures.push(
        "[session-bootstrap] the bootstrap sentinel is present in the rendered DOM after clicking Start",
      );
    }
    if (afterClickMarkup.includes(SYNTHETIC_SESSION_TOKEN)) {
      failures.push(
        "[session-bootstrap] the minted session token is present in the rendered DOM after navigation",
      );
    }

    if (capturedStartRequests.length !== 1) {
      failures.push(
        `[session-bootstrap] expected exactly one /api/viva-session/start request, saw ` +
          `${capturedStartRequests.length}`,
      );
    } else {
      let parsedBody = null;
      try {
        parsedBody = JSON.parse(capturedStartRequests[0].body ?? "");
      } catch {
        // handled by the null-body check below
      }
      if (parsedBody?.session_bootstrap_token !== SESSION_BOOTSTRAP_SENTINEL) {
        failures.push(
          "[session-bootstrap] the /api/viva-session/start POST body did not carry the " +
            `bootstrap sentinel exactly once (got ${JSON.stringify(parsedBody?.session_bootstrap_token)})`,
        );
      }
    }

    const currentUrl = new URL(page.url());
    if (currentUrl.pathname !== "/session") {
      failures.push(
        `[session-bootstrap] expected navigation to /session after a successful start, landed on ` +
          `${currentUrl.pathname}`,
      );
    }
    if (currentUrl.searchParams.has("session_token") || currentUrl.searchParams.has("token")) {
      failures.push(
        "[session-bootstrap] the minted session token leaked into the URL query string",
      );
    }
    if (!currentUrl.hash.includes("session_token=")) {
      failures.push(
        "[session-bootstrap] the minted session token did not appear in the navigation fragment",
      );
    }

    // D-07 Branch A Step 3's "adds no persistent browser storage" — the one
    // capability surface Step 1's own list (DOM text, attributes, URLs, and
    // logs) does not separately enumerate but that a credential could just
    // as easily leak into. Read after the click/navigation, i.e. after every
    // real production code path that could have written to it has run.
    failures.push(...(await checkNoSessionBootstrapStorageLeak(page)));

    for (const record of requestRecords) {
      if (
        record.url.includes(SESSION_BOOTSTRAP_SENTINEL) ||
        record.url.includes(SYNTHETIC_SESSION_TOKEN)
      ) {
        failures.push(
          `[session-bootstrap] a request URL leaked a session credential: ${record.url}`,
        );
      }
      if (
        record.referer?.includes(SESSION_BOOTSTRAP_SENTINEL) ||
        record.referer?.includes(SYNTHETIC_SESSION_TOKEN)
      ) {
        failures.push(
          `[session-bootstrap] a request referrer leaked a session credential: ${record.referer}`,
        );
      }
    }
    for (const text of consoleTexts) {
      if (
        text.includes(SESSION_BOOTSTRAP_SENTINEL) ||
        text.includes(SYNTHETIC_SESSION_TOKEN) ||
        text.includes(SYNTHETIC_REFRESH_TOKEN)
      ) {
        failures.push(
          `[session-bootstrap] a browser console message leaked a session credential: ${text}`,
        );
      }
    }
  } finally {
    await context.close();
  }
  return failures;
}

/**
 * D-07 Branch A's fetch-bound proof: a same-origin start request that never
 * resolves must abort at the 6000ms bound and surface an explicit status
 * (`"Session start timed out."`) rather than leaving the UI hung
 * indefinitely, and must never navigate or leak the sentinel while pending.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkSessionBootstrapFetchBound(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleTexts = [];
  page.on("console", (msg) => consoleTexts.push(msg.text()));
  // An uncaught exception or unhandled promise rejection is a distinct
  // Playwright event from `console` — Chromium's own error printer, not an
  // explicit `console.*` call — so "logs" covers both.
  page.on("pageerror", (error) => consoleTexts.push(String(error?.message ?? error)));
  // Never fulfill, continue, or abort: the request stays pending until the
  // client's own AbortController fires at the bound.
  await page.route("**/api/viva-session/start", () => {});

  try {
    await gotoRouteReady(page, baseUrl, "/");
    await page
      .getByRole("button", { name: SESSION_BOOTSTRAP_ACCESSIBLE_NAME, exact: true })
      .click();

    const startedAt = Date.now();
    const surfaced = await page
      .waitForFunction(
        () =>
          (document.querySelector(".viva-library__status")?.textContent ?? "").includes(
            "timed out",
          ),
        undefined,
        { timeout: 8_000 },
      )
      .then(() => true)
      .catch(() => false);
    const elapsedMs = Date.now() - startedAt;

    if (!surfaced) {
      failures.push(
        "[session-bootstrap] a hung /api/viva-session/start request never surfaced an explicit " +
          "timed-out status within 8000ms",
      );
    } else if (elapsedMs > 7_000) {
      failures.push(
        `[session-bootstrap] the start fetch's abort bound took ${elapsedMs}ms to surface, expected ` +
          "close to the 6000ms policy",
      );
    }

    const currentUrl = new URL(page.url());
    if (currentUrl.pathname === "/session") {
      failures.push("[session-bootstrap] a timed-out start request still navigated to /session");
    }
    failures.push(...(await checkNoSessionBootstrapStorageLeak(page)));
    for (const text of consoleTexts) {
      if (text.includes(SESSION_BOOTSTRAP_SENTINEL)) {
        failures.push(
          `[session-bootstrap] a browser console message leaked the bootstrap sentinel during a ` +
            `timeout: ${text}`,
        );
      }
    }
  } finally {
    await context.close();
  }
  return failures;
}

/* --------------------------------------------------------------------- *
 * Task 9 (`FRONTEND-004`): `--deletion`.
 * -------------------------------------------------------------------- */

/** The two D-04 CONFIRM_DELETE table rows this program's `LIBRARY_SNAPSHOT_FIXTURE` supports end to end. */
const DELETION_CHECK_TARGETS = [
  {
    completeStatus: "Delete source complete.",
    deletePathSuffix: "/api/viva-library/study-sets/biology-midterm",
    dialogTitle: "Delete Biology Midterm?",
    initiatingAccessibleName: "Delete source for Biology Midterm",
    kind: "study_set",
  },
  {
    completeStatus: "Delete recap complete.",
    deletePathSuffix: "/api/viva-library/study-sets/biology-midterm/sessions/voice-session-1",
    dialogTitle: "Delete Biology Midterm session recap?",
    initiatingAccessibleName: "Delete recap for Biology Midterm",
    kind: "session_history",
  },
];

async function runDeletionCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  const failures = [];
  try {
    await withFrontendDevServer(
      { artifactDir, extraEnv: harnessExtraEnv(stub.url) },
      async ({ baseUrl }) => {
        const hydratableBaseUrl = toHydratableUrl(baseUrl);
        const browser = await launchChromium();
        try {
          for (const target of DELETION_CHECK_TARGETS) {
            failures.push(
              ...(await checkDeliberateDeletionFlow(browser, hydratableBaseUrl, target)),
            );
          }
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
  return failures;
}

/**
 * D-04 CONFIRM_DELETE's real-browser proof for one table row: the first
 * click only opens a named `role="alertdialog"` confirmation (zero DELETE
 * requests, since the row's DELETE route is intercepted and only fulfilled
 * from inside this check, never reached by an unconfirmed click), focus
 * moves to the confirm action, Escape and Cancel each close it without
 * deleting and restore focus to the row's own initiating button, and
 * confirming issues the table's exact DELETE endpoint exactly once — proved
 * under a real Playwright `dblclick()` against a deliberately delayed route,
 * so the guard is exercised by a genuine double-activation, not merely a
 * disabled-attribute snapshot — before completion is announced through a
 * `role="status"` region with fixed copy.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {{completeStatus: string, deletePathSuffix: string, dialogTitle: string, initiatingAccessibleName: string, kind: string}} target
 */
async function checkDeliberateDeletionFlow(browser, baseUrl, target) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const deleteRequests = [];
  // A deliberate delay before fulfilling: a real Playwright `dblclick()`
  // fires its two clicks only tens of milliseconds apart, so without this
  // margin the first request could already have settled (and the confirm
  // button already be disabled) before the second click lands, making the
  // double-activation guard untested rather than proved.
  await page.route(`**${target.deletePathSuffix}*`, async (route) => {
    const request = route.request();
    if (request.method() !== "DELETE") {
      await route.continue();
      return;
    }
    deleteRequests.push(request.url());
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ body: "{}", contentType: "application/json", status: 200 });
  });

  try {
    await gotoRouteReady(page, baseUrl, "/");

    const initiatingButton = page.getByRole("button", {
      exact: true,
      name: target.initiatingAccessibleName,
    });
    await initiatingButton.click();

    if (deleteRequests.length !== 0) {
      failures.push(
        `[deletion:${target.kind}] the first click issued ${deleteRequests.length} DELETE ` +
          "request(s) before confirmation",
      );
    }

    const dialog = page.getByRole("alertdialog", { exact: true, name: target.dialogTitle });
    const dialogVisible = await dialog
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!dialogVisible) {
      failures.push(
        `[deletion:${target.kind}] no named "${target.dialogTitle}" alertdialog opened on the ` +
          "first click",
      );
      await context.close();
      return failures;
    }

    const confirmHasFocus = await page.evaluate(
      () => document.activeElement?.textContent?.trim() === "Delete",
    );
    if (!confirmHasFocus) {
      failures.push(`[deletion:${target.kind}] focus did not move to the confirm action on open`);
    }

    await page.keyboard.press("Escape");
    const closedOnEscape = await dialog
      .waitFor({ state: "hidden", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!closedOnEscape) {
      failures.push(`[deletion:${target.kind}] Escape did not close the dialog`);
    }
    if (
      !(await page.evaluate(
        (name) => document.activeElement?.getAttribute("aria-label") === name,
        target.initiatingAccessibleName,
      ))
    ) {
      failures.push(
        `[deletion:${target.kind}] focus was not restored to the initiating button after Escape`,
      );
    }
    if (deleteRequests.length !== 0) {
      failures.push(`[deletion:${target.kind}] Escape issued a DELETE request`);
    }

    await initiatingButton.click();
    await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    await dialog.getByRole("button", { exact: true, name: "Cancel" }).click();
    const closedOnCancel = await dialog
      .waitFor({ state: "hidden", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!closedOnCancel) {
      failures.push(`[deletion:${target.kind}] Cancel did not close the dialog`);
    }
    if (
      !(await page.evaluate(
        (name) => document.activeElement?.getAttribute("aria-label") === name,
        target.initiatingAccessibleName,
      ))
    ) {
      failures.push(
        `[deletion:${target.kind}] focus was not restored to the initiating button after Cancel`,
      );
    }
    if (deleteRequests.length !== 0) {
      failures.push(`[deletion:${target.kind}] Cancel issued a DELETE request`);
    }

    await initiatingButton.click();
    await dialog.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    await dialog.getByRole("button", { exact: true, name: "Delete" }).dblclick();
    await page
      .waitForFunction(
        (expected) => document.querySelector(".viva-library__status")?.textContent === expected,
        target.completeStatus,
        { timeout: 8_000 },
      )
      .catch(() => {});

    if (deleteRequests.length !== 1) {
      failures.push(
        `[deletion:${target.kind}] expected exactly one DELETE request after confirming (a real ` +
          `double click included), saw ${deleteRequests.length}`,
      );
    }

    const statusNode = page.locator(".viva-library__status");
    const statusText = await statusNode.textContent().catch(() => null);
    if (statusText !== target.completeStatus) {
      failures.push(
        `[deletion:${target.kind}] expected the status region to read "${target.completeStatus}", ` +
          `saw ${JSON.stringify(statusText)}`,
      );
    }
    const statusRole = await statusNode.getAttribute("role").catch(() => null);
    if (statusRole !== "status") {
      failures.push(
        `[deletion:${target.kind}] the completion status region is missing role="status" (saw ` +
          `${JSON.stringify(statusRole)})`,
      );
    }
  } finally {
    await context.close();
  }
  return failures;
}

/* --------------------------------------------------------------------- *
 * Task 4 (`FRONTEND-007`): `--assets`.
 * -------------------------------------------------------------------- */

/**
 * `withFrontendDevServer` hands back a `http://127.0.0.1:<port>` `baseUrl`.
 * Next.js dev's cross-origin dev-resource protection (`allowedDevOrigins`,
 * on by default) allows `localhost` unconditionally but does not recognize
 * a bare `127.0.0.1` as the same origin as the `next dev` child's own
 * (default `0.0.0.0`) bind address; the resulting blocked HMR/dev-client
 * websocket handshake was observed, empirically, to leave the page fully
 * server-rendered but *never client-hydrated* — no React root ever
 * attaches (confirmed via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` and a
 * DOM node's absent `__reactFiber*` property), so no `onError`/state-driven
 * behavior can run at all. `--owned-surfaces`/`--session-handoff` never hit
 * this because their checks are all computed-style/DOM-structure/native-
 * keyboard-focus checks that need no hydration; `--assets`' conditional
 * Muse-fallback proof is the first check in this file that requires real
 * client-side React state updates, which is what surfaced it. Rewriting
 * only the *navigation* URL's host to `localhost` (`next dev`'s default
 * `0.0.0.0` bind still answers there) fixes hydration without touching
 * `scripts/frontend-harness.mjs`, which Task 4 does not own.
 *
 * @param {string} baseUrl
 */
function toHydratableUrl(baseUrl) {
  return baseUrl.replace("127.0.0.1", "localhost");
}

/**
 * Mounts `/` twice — once for a normal, uninterrupted load (host/asset/font
 * checks) and once with `/viva-muse.webp` deliberately fulfilled with
 * invalid image bytes (the conditional-fallback recovery proof) — and
 * returns a flat list of human-readable failure strings; empty means every
 * asset check passed.
 */
async function runAssetsCheck() {
  const artifactDir = path.join(repoRoot, "artifacts/frontend-accessibility");
  mkdirSync(artifactDir, { recursive: true });
  const stub = await startLibrarySnapshotStub(LIBRARY_SNAPSHOT_FIXTURE);
  const failures = [];
  try {
    await withFrontendDevServer(
      { artifactDir, extraEnv: harnessExtraEnv(stub.url) },
      async ({ baseUrl }) => {
        const hydratableBaseUrl = toHydratableUrl(baseUrl);
        const browser = await launchChromium();
        try {
          failures.push(...(await checkNormalAssetLoad(browser, hydratableBaseUrl)));
          failures.push(...(await checkMuseFallbackRecovery(browser, hydratableBaseUrl)));
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stub.close();
  }
  return failures;
}

/**
 * A normal, uninterrupted load: no request may reach a Google Fonts host;
 * both self-hosted font roles (serif normal/italic, sans) must actually be
 * loadable; the visible Muse `<img>` must declare its real intrinsic
 * dimensions and eager/high-priority/async-decode loading; and a normal
 * WebP-capable Chromium must request `/viva-muse.webp` and never
 * `/viva-muse.png`.
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkNormalAssetLoad(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const requestedUrls = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  try {
    await gotoRouteReady(page, baseUrl, "/");

    for (const url of requestedUrls) {
      let host;
      try {
        host = new URL(url).host;
      } catch {
        continue;
      }
      if (host === "fonts.googleapis.com" || host === "fonts.gstatic.com") {
        failures.push(`[assets] page requested a Google Fonts host: ${url}`);
      }
    }

    const requestedWebp = requestedUrls.some((url) => url.endsWith("/viva-muse.webp"));
    const pngTransferCount = requestedUrls.filter((url) => url.endsWith("/viva-muse.png")).length;
    if (!requestedWebp) {
      failures.push("[assets] a normal load never requested /viva-muse.webp");
    }
    if (!checkNoPngDuringHealthyLoad(pngTransferCount)) {
      failures.push(
        `[assets] a normal WebP-capable load unexpectedly transferred /viva-muse.png ` +
          `${pngTransferCount} time(s) too`,
      );
    }

    const museImg = await page.evaluate(() => {
      const img = document.querySelector(".viva-muse__img");
      if (!img) return null;
      return {
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
        decoding: img.getAttribute("decoding"),
        fetchPriority: img.getAttribute("fetchpriority"),
        loading: img.getAttribute("loading"),
      };
    });
    if (!museImg) {
      failures.push("[assets] .viva-muse__img is not present in the DOM");
    } else {
      if (museImg.width !== "1672") {
        failures.push(
          `[assets] .viva-muse__img width attribute is ${JSON.stringify(museImg.width)}, expected "1672"`,
        );
      }
      if (museImg.height !== "941") {
        failures.push(
          `[assets] .viva-muse__img height attribute is ${JSON.stringify(museImg.height)}, expected "941"`,
        );
      }
      if (museImg.decoding !== "async") {
        failures.push(
          `[assets] .viva-muse__img decoding attribute is ${JSON.stringify(museImg.decoding)}, expected "async"`,
        );
      }
      if (museImg.fetchPriority !== "high") {
        failures.push(
          `[assets] .viva-muse__img fetchpriority attribute is ${JSON.stringify(museImg.fetchPriority)}, expected "high"`,
        );
      }
      if (museImg.loading === "lazy") {
        failures.push(
          '[assets] .viva-muse__img has loading="lazy", expected eager (the default) or an explicit "eager"',
        );
      }
    }

    for (const role of [
      { cssVar: "--viva-font-serif", style: "normal", label: "serif normal" },
      { cssVar: "--viva-font-serif", style: "italic", label: "serif italic" },
      { cssVar: "--viva-font-sans", style: "normal", label: "sans" },
    ]) {
      const result = await checkFontRoleLoadable(page, role);
      if (!result.ok) {
        failures.push(`[assets] ${role.label} font role: ${result.reason}`);
      }
    }
  } finally {
    await context.close();
  }
  return failures;
}

/**
 * Resolves `cssVar`'s real computed value on `<html>` (set by `next/font/
 * local`'s `variable` class — never guessed/hardcoded), isolates its first
 * (non-fallback) family name, and proves that exact family is loadable via
 * `document.fonts.load` followed by `document.fonts.check` — the pair the
 * Font Loading API spec requires for a reliable check of a not-yet-used
 * face, rather than `check()` alone (which only reports already-known
 * status and may false-negative on a face nothing has rendered with yet).
 *
 * @param {import("playwright").Page} page
 * @param {{ cssVar: string, style: "normal" | "italic" }} role
 */
async function checkFontRoleLoadable(page, { cssVar, style }) {
  return await page.evaluate(
    async ({ cssVar, style }) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
      if (!raw) {
        return {
          ok: false,
          reason: `${cssVar} is not defined on <html> (next/font/local variable class missing)`,
        };
      }
      const firstFamily = raw
        .split(",")[0]
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (!firstFamily) {
        return { ok: false, reason: `${cssVar} has no usable family name: "${raw}"` };
      }
      const fontShorthand = `${style === "italic" ? "italic " : ""}16px "${firstFamily}"`;
      try {
        await document.fonts.load(fontShorthand);
      } catch (error) {
        return {
          ok: false,
          reason: `document.fonts.load(${JSON.stringify(fontShorthand)}) threw: ${error}`,
        };
      }
      const ok = document.fonts.check(fontShorthand);
      return {
        ok,
        reason: ok ? null : `document.fonts.check(${JSON.stringify(fontShorthand)}) returned false`,
      };
    },
    { cssVar, style },
  );
}

/**
 * Fulfills every `/viva-muse.webp` request with deliberately invalid image
 * bytes (real HTTP 200, real `image/webp` content type, undecodable body),
 * then proves the mounted `MuseBackdrop` recovers: it must remove the
 * failed `<source type="image/webp">` so the browser's `<picture>`
 * source-selection algorithm re-runs and the `<img>` loads `/viva-muse.png`
 * instead, reaching `complete && naturalWidth === 1672`. A real Chrome
 * DevTools Protocol `Network` session (not Playwright's own request/
 * response events, which do not reliably distinguish a cache replay from a
 * real transfer) counts non-cached (HTTP 200) `/viva-muse.png` body
 * transfers: the visible `<picture>` image and `MuseGlyphCanvas`'s separate
 * offscreen sampler `Image()` may both fall back to PNG, but at most one of
 * them may need a real network body transfer — the plan's own words allow
 * them to "share that cached response".
 *
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 */
async function checkMuseFallbackRecovery(browser, baseUrl) {
  const failures = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const invalidWebpBytes = Buffer.from(
    "deliberately not a valid WebP bitstream, so the browser image decoder must fail",
  );
  const requestedUrls = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await page.route("**/viva-muse.webp", (route) =>
    route.fulfill({ status: 200, contentType: "image/webp", body: invalidWebpBytes }),
  );

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let nonCachedPngTransferCount = 0;
  cdp.on("Network.responseReceived", (event) => {
    if (event.response.url.endsWith("/viva-muse.png") && event.response.status === 200) {
      nonCachedPngTransferCount += 1;
    }
  });

  try {
    await gotoRouteReady(page, baseUrl, "/");

    const recovered = await page
      .waitForFunction(
        () => {
          const img = document.querySelector(".viva-muse__img");
          return Boolean(img?.complete && img.naturalWidth === 1672);
        },
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!recovered) {
      failures.push(
        "[assets] after /viva-muse.webp is fulfilled with invalid bytes, .viva-muse__img never " +
          "reached complete && naturalWidth === 1672 (PNG fallback did not recover)",
      );
    }

    if (!requestedUrls.some((url) => url.endsWith("/viva-muse.png"))) {
      failures.push(
        "[assets] after the WebP decode failure, the page never requested /viva-muse.png",
      );
    }

    if (nonCachedPngTransferCount > 1) {
      failures.push(
        `[assets] CDP recorded ${nonCachedPngTransferCount} non-cached (HTTP 200) /viva-muse.png ` +
          "body transfers, expected at most 1",
      );
    }
  } finally {
    await context.close();
  }
  return failures;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

// A-27.3/Task 11: only run the CLI when this file is executed directly
// (`node scripts/frontend-accessibility.mjs ...`), never when imported —
// `scripts/frontend-quality.test.mjs` imports this module's pure
// `checkMainLandmarkCount`/etc. exports specifically so it can test them
// "without running browsers" (its own owning requirement); an unguarded
// top-level `main()` call would launch a real mounted check, and any
// eventual failure there would silently corrupt `process.exitCode` for
// that entire, unrelated `node --test` run. Mirrors `scripts/dev-agent.mjs`'s
// own identical guard.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
