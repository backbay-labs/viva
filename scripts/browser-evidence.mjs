const REQUIRED_BROWSER_STORY_FRAME_IDS = [
  "pending_local_preview",
  "server_ready_study_set",
  "active_synthetic_manuscript",
  "recap",
];

export function normalizeBrowserEvidence(result) {
  return {
    artifact_dir: result.artifact_dir,
    legacy_upload_visible: result.legacy_upload_visible === true,
    manuscript_ready: result.manuscript_ready === true,
    conductor_terminal_fold: result.conductor_terminal_fold === true,
    recap_payload_visible: result.recap_payload_visible === true,
    next_session_recommendation_visible: result.next_session_recommendation_visible === true,
    source_folio_visible: result.source_folio_visible === true,
    bounded_source_visible: result.bounded_source_visible === true,
    post_answer_source_folio_visible: result.post_answer_source_folio_visible === true,
    post_answer_bounded_source_visible: result.post_answer_bounded_source_visible === true,
    post_answer_source_reference_event_seen:
      result.post_answer_source_reference_event_seen === true,
    post_answer_concept_status_event_seen: result.post_answer_concept_status_event_seen === true,
    local_only_actions_hidden: result.local_only_actions_hidden === true,
    browser_story: normalizeBrowserStory(result.browser_story),
    console_error_count: Array.isArray(result.console_errors) ? result.console_errors.length : 0,
    page_error_count: Array.isArray(result.page_errors) ? result.page_errors.length : 0,
  };
}

export function assertReleaseBrowserEvidence(evidence) {
  const failures = [];
  const browserStory = evidence.browser_story ?? {
    frame_ids: [],
  };
  if (evidence.legacy_upload_visible !== false) failures.push("legacy_upload_visible must be false");
  if (evidence.manuscript_ready !== true) failures.push("manuscript_ready must be true");
  if (evidence.conductor_terminal_fold !== true)
    failures.push("conductor_terminal_fold must be true");
  if (evidence.recap_payload_visible !== true) failures.push("recap_payload_visible must be true");
  if (evidence.next_session_recommendation_visible !== true)
    failures.push("next_session_recommendation_visible must be true");
  if (evidence.source_folio_visible !== true) failures.push("source_folio_visible must be true");
  if (evidence.bounded_source_visible !== true) failures.push("bounded_source_visible must be true");
  if (evidence.post_answer_source_folio_visible !== true)
    failures.push("post_answer_source_folio_visible must be true");
  if (evidence.post_answer_bounded_source_visible !== true)
    failures.push("post_answer_bounded_source_visible must be true");
  if (evidence.post_answer_source_reference_event_seen !== true)
    failures.push("post_answer_source_reference_event_seen must be true");
  if (evidence.post_answer_concept_status_event_seen !== true)
    failures.push("post_answer_concept_status_event_seen must be true");
  if (evidence.local_only_actions_hidden !== true)
    failures.push("local_only_actions_hidden must be true");
  if (browserStory.schema !== "viva.browser_story.v1")
    failures.push("browser_story.schema must be viva.browser_story.v1");
  if (browserStory.sanitized !== true) failures.push("browser_story.sanitized must be true");
  if (browserStory.trace_retained !== false)
    failures.push("browser_story.trace_retained must be false");
  if (browserStory.artifact_forbidden_hits !== 0)
    failures.push("browser_story.artifact_forbidden_hits must be 0");
  if (browserStory.command_summary_present !== true)
    failures.push("browser_story.command_summary must tie screenshots to validation run");
  if (browserStory.fixture_hash_count < 1)
    failures.push("browser_story.fixture_hashes must tie screenshots to fixtures");
  if (!browserStory.validation_run_id)
    failures.push("browser_story.command_summary.validation_run_id must be present");
  for (const frameId of REQUIRED_BROWSER_STORY_FRAME_IDS) {
    if (!browserStory.frame_ids.includes(frameId)) {
      failures.push(`browser_story.frames must include ${frameId}`);
    }
  }
  if (browserStory.screenshot_count < REQUIRED_BROWSER_STORY_FRAME_IDS.length) {
    failures.push(
      `browser_story.frames must include at least ${REQUIRED_BROWSER_STORY_FRAME_IDS.length} screenshots`,
    );
  }
  if (evidence.console_error_count !== 0) failures.push("console_error_count must be 0");
  if (evidence.page_error_count !== 0) failures.push("page_error_count must be 0");
  if (failures.length > 0) {
    throw new Error(`Browser E2E release evidence is incomplete: ${failures.join("; ")}`);
  }
}

export function shouldSkipMissingBrowserResult(error, skipBrowserValue) {
  return skipBrowserValue === "1" && error instanceof Error && error.code === "ENOENT";
}

function normalizeBrowserStory(story) {
  const frames = Array.isArray(story?.frames) ? story.frames : [];
  const commandSummary = isRecord(story?.command_summary) ? story.command_summary : null;
  const artifactAudit = isRecord(story?.artifact_audit) ? story.artifact_audit : null;
  const frameIds = frames
    .map((frame) => (typeof frame?.id === "string" ? frame.id : null))
    .filter(Boolean);
  const screenshots = frames
    .map((frame) => (typeof frame?.screenshot === "string" ? frame.screenshot : null))
    .filter(Boolean);

  return {
    artifact_forbidden_hits: Number.isInteger(artifactAudit?.forbidden_hits)
      ? artifactAudit.forbidden_hits
      : null,
    command_summary_present: hasCommandSummary(commandSummary),
    fixture_hash_count: countFixtureHashes(story?.fixture_hashes),
    frame_ids: frameIds,
    sanitized: story?.sanitized === true,
    schema: typeof story?.schema === "string" ? story.schema : null,
    screenshot_count: new Set(screenshots).size,
    trace_retained: typeof story?.trace_retained === "boolean" ? story.trace_retained : null,
    validation_run_id:
      typeof commandSummary?.validation_run_id === "string" ? commandSummary.validation_run_id : null,
  };
}

function hasCommandSummary(commandSummary) {
  return (
    isRecord(commandSummary) &&
    typeof commandSummary.command === "string" &&
    commandSummary.command.length > 0 &&
    typeof commandSummary.provider === "string" &&
    commandSummary.provider.length > 0 &&
    typeof commandSummary.validation_run_id === "string" &&
    commandSummary.validation_run_id.length > 0
  );
}

function countFixtureHashes(fixtureHashes) {
  if (!isRecord(fixtureHashes)) return 0;
  return Object.values(fixtureHashes).filter(
    (record) =>
      isRecord(record) &&
      Number.isInteger(record.bytes) &&
      record.bytes > 0 &&
      typeof record.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(record.sha256),
  ).length;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
