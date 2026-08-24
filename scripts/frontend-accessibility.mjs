import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  launchChromium,
  repoRoot,
  startLibrarySnapshotStub,
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
 * session}.css` changed no rendering. Task 3 onward adds the landmark/
 * target-size/contrast/assets/session-handoff/deletion/bootstrap/
 * static-export modes named in later tasks' RED commands; this file's
 * mode dispatch is written so those are additive.
 */

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

/**
 * A complete, type-shaped `VivaLibrarySnapshot` fixture (see
 * `apps/web/lib/viva-library.ts`) — content is arbitrary but structurally
 * real, so the mounted page renders actual `.viva-library__*` DOM rather
 * than the `snapshot: null` empty-render path. No production data, no
 * session/control-token shape reused from a real deployment.
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
          session_id: null,
          session_bootstrap_token: "stub-bootstrap-token",
          session_token: null,
          same_origin_control_token: null,
          control_token: "stub-control-token",
        },
        resume: { available: false, unavailable_reason: "no_active_session" },
        archive: { available: true, control_token: "stub-control-token" },
        delete: { available: true, control_token: "stub-control-token" },
      },
    },
  ],
  sessions: [
    {
      actions: { delete: { available: true, control_token: "stub-control-token" } },
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

async function main() {
  const args = process.argv.slice(2);
  const writeFlagIndex = args.indexOf("--write-computed-style-baseline");
  const compareFlagIndex = args.indexOf("--compare-computed-style-baseline");

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

  fail(
    "no recognized mode flag. Task 2 supports --write-computed-style-baseline <path> and " +
      "--compare-computed-style-baseline <path>; later tasks add more modes.",
  );
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
        extraEnv: {
          VIVA_AGENT_HTTP_URL: stub.url,
          VIVA_AGENT_REST_BEARER_TOKEN: "local-frontend-harness-bearer",
          VIVA_SESSION_ALLOWED_USER_IDS: LIBRARY_SNAPSHOT_FIXTURE.user_id,
          VIVA_SESSION_ALLOWED_STUDY_SET_IDS: LIBRARY_SNAPSHOT_FIXTURE.study_sets[0].id,
        },
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

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
