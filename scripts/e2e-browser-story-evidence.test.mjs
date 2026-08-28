// A-43(d): the deferred RELEASE-009 e2e-browser consumer marker-rejection
// leg. `writeAuditedBrowserStoryResult` (e2e-browser-story-evidence.mjs) is
// the one place the e2e-browser family writes real evidence files to disk
// and then re-scans that same directory for forbidden markers via
// `auditTextArtifacts` (redaction-control.mjs) -- the same write-then-audit
// cycle `release-check.mjs` and `hosted-monitor-runner.mjs` already have
// dedicated marker-rejection coverage for. This module had neither a
// dedicated test file nor that coverage: the existing
// hosted-e2e-matrix.test.mjs assertions only exercise the CLEAN
// (forbidden_hits: 0) path against a synthetic, already-computed audit
// object, never a real poisoned write this module's own scan must catch.
//
// `auditTextArtifacts` fails CLOSED by throwing, not by returning a nonzero
// count (a real hit never reaches `return { forbidden_hits: 0 }`), so
// "marker-rejection" here means: the write-and-audit call rejects.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeAuditedBrowserStoryResult } from "./e2e-browser-story-evidence.mjs";
import { FORBIDDEN_EVIDENCE_MARKERS } from "./redaction-control.mjs";

async function artifactDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-browser-story-evidence-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** `hostedMode: true` forces the real scan; `trace_retained`'s own skip is covered separately below. */
function plan(dir) {
  return {
    root: dir,
    artifactDir: dir,
    hostedMode: true,
    validationRunId: "viva-test-run",
    agentProvider: "synthetic",
  };
}

function storyResult({ traceRetained = false, frames = [] } = {}) {
  return {
    schema: "viva.browser_story_result.v1",
    browser_story: {
      schema: "viva.browser_story.v1",
      trace_retained: traceRetained,
      frames,
    },
  };
}

test("a clean browser story write passes the real on-disk forbidden-marker scan", async (t) => {
  const dir = await artifactDir(t);
  const result = await writeAuditedBrowserStoryResult(storyResult(), plan(dir));

  assert.equal(result.browser_story.artifact_audit.forbidden_hits, 0);
  assert.ok(result.browser_story.artifact_audit.scanned_files > 0);

  const onDisk = await readFile(path.join(dir, "result.json"), "utf8");
  for (const marker of FORBIDDEN_EVIDENCE_MARKERS) assert.ok(!onDisk.includes(marker));
});

// Every canonical marker, not a hand-picked subset: this is the same
// exhaustive-over-the-canonical-list shape RELEASE-009's other covered call
// sites use, so a marker added to (or dropped from) the shared list is felt
// here too, not just at the sites that already had coverage.
for (const marker of FORBIDDEN_EVIDENCE_MARKERS) {
  test(`a browser story payload carrying the ${JSON.stringify(marker)} marker is rejected by the real write-then-scan, not silently persisted`, async (t) => {
    const dir = await artifactDir(t);
    const poisoned = storyResult({ frames: [{ kind: "diagnostic", note: `poisoned: ${marker}` }] });

    await assert.rejects(
      writeAuditedBrowserStoryResult(poisoned, plan(dir)),
      (error) => error instanceof Error && error.message.includes(marker),
      `writing a payload carrying "${marker}" must reject, naming the marker`,
    );
  });
}

test("the local-trace-retained non-hosted path is a disclosed skip, never a silent bypass of a poisoned write", async (t) => {
  const dir = await artifactDir(t);
  const poisoned = storyResult({
    traceRetained: true,
    frames: [{ note: `poisoned: ${FORBIDDEN_EVIDENCE_MARKERS[0]}` }],
  });

  const result = await writeAuditedBrowserStoryResult(poisoned, { ...plan(dir), hostedMode: false });

  // The audit genuinely never ran (scanned_files: 0) and says so via
  // `skipped`, rather than fabricating a clean 0-hit result that would read
  // exactly like the real scan's own success shape.
  assert.equal(result.browser_story.artifact_audit.skipped, "local_trace_retained");
  assert.equal(result.browser_story.artifact_audit.scanned_files, 0);
  assert.equal(result.browser_story.artifact_audit.forbidden_hits, 0);
});

test("hostedMode always takes the real scan even when trace_retained is true, and still rejects a poisoned write", async (t) => {
  const dir = await artifactDir(t);
  const poisoned = storyResult({
    traceRetained: true,
    frames: [{ note: `poisoned: ${FORBIDDEN_EVIDENCE_MARKERS[0]}` }],
  });

  await assert.rejects(
    writeAuditedBrowserStoryResult(poisoned, plan(dir)),
    (error) => error instanceof Error && error.message.includes(FORBIDDEN_EVIDENCE_MARKERS[0]),
  );
});
