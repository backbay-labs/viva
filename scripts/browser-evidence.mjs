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
    console_error_count: Array.isArray(result.console_errors) ? result.console_errors.length : 0,
    page_error_count: Array.isArray(result.page_errors) ? result.page_errors.length : 0,
  };
}

export function assertReleaseBrowserEvidence(evidence) {
  const failures = [];
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
  if (evidence.console_error_count !== 0) failures.push("console_error_count must be 0");
  if (evidence.page_error_count !== 0) failures.push("page_error_count must be 0");
  if (failures.length > 0) {
    throw new Error(`Browser E2E release evidence is incomplete: ${failures.join("; ")}`);
  }
}

export function shouldSkipMissingBrowserResult(error, skipBrowserValue) {
  return skipBrowserValue === "1" && error instanceof Error && error.code === "ENOENT";
}
