import { createHash, createHmac } from "node:crypto";

export const PRODUCTION_RELEASE_GATE_SCHEMA = "viva.production_release_gate.v1";
export const RELEASE_BUNDLE_INTEGRITY_SCHEMA = "viva.release_bundle_integrity.v1";
export const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 24 * 60 * 60;

const REQUIRED_RECOVERY_SCENARIOS = Object.freeze([
  "provider_rate_limited",
  "provider_timeout",
  "invalid_token",
  "expired_token",
  "replayed_token",
  "double_submit_race",
  "deterministic_partial_recap",
]);

const REQUIRED_PROVIDER_FAILURE_QUERIES = Object.freeze([
  "provider_429",
  "provider_timeout",
  "token_refresh_failure",
  "recap_failure",
  "release_gate_stale_evidence",
]);

const ACCEPTED_LIMITER_STATES = new Set(["enabled", "configured", "observed"]);
export const FORBIDDEN_EVIDENCE_MARKERS = Object.freeze([
  "pcm16_base64",
  "answer_text",
  "transcript_final",
  "source_context",
  "pasted_text",
  "session_token",
  "viva1.",
  "session-secret",
  "raw_prompt",
  "provider_prompt",
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "Bearer ",
]);

export function finalizeReleaseEvidenceBundle({ evidence, env = process.env, now = new Date() }) {
  const draft = cloneJson(evidence);
  draft.production_release_gate = buildProductionReleaseGateEvidence({ evidence: draft, env, now });
  const integrity = buildReleaseBundleIntegrity({ evidence: draft, env });
  const finalized = {
    ...draft,
    release_bundle: {
      ...(draft.release_bundle ?? {}),
      integrity,
    },
    production_release_gate: {
      ...draft.production_release_gate,
      integrity: summarizeIntegrity(integrity),
    },
  };

  assertReleaseBundleIntegrity(finalized, { env });
  assertProductionReleaseGate(finalized);
  return finalized;
}

export function buildProductionReleaseGateEvidence({ evidence, env = process.env, now = new Date() }) {
  const productionRequested = env.VIVA_PRODUCTION_RELEASE === "1";
  const generatedAt = parseDate(evidence.generated_at);
  const observedAt = now instanceof Date ? now : new Date(now);
  const ageSeconds =
    generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime())
      ? Math.max(0, Math.floor((observedAt.getTime() - generatedAt.getTime()) / 1000))
      : null;
  const maxAgeSeconds = positiveIntegerOrDefault(
    env.VIVA_RELEASE_EVIDENCE_MAX_AGE_SECONDS,
    DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  );
  const browserEvidence = evidence.browser_e2e ?? {};
  const hostedBrowser = browserEvidence.hosted_e2e ?? null;
  const releaseDeployIds = {
    web: stringOrNull(env.VIVA_RELEASE_WEB_DEPLOY_ID ?? evidence.rollback_drain?.production_snapshot?.web_deploy_id),
    agent: stringOrNull(
      env.VIVA_RELEASE_AGENT_DEPLOY_ID ?? evidence.rollback_drain?.production_snapshot?.agent_deploy_id,
    ),
  };
  const liveDeployIds = {
    web: stringOrNull(env.VIVA_LIVE_WEB_DEPLOY_ID ?? env.VIVA_CURRENT_WEB_DEPLOY_ID),
    agent: stringOrNull(env.VIVA_LIVE_AGENT_DEPLOY_ID ?? env.VIVA_CURRENT_AGENT_DEPLOY_ID),
  };
  const evidenceDeployIds = {
    web: stringOrNull(hostedBrowser?.deploy_ids?.web),
    agent: stringOrNull(hostedBrowser?.deploy_ids?.agent),
  };

  const gate = {
    schema: PRODUCTION_RELEASE_GATE_SCHEMA,
    generated_at: observedAt.toISOString(),
    production_requested: productionRequested,
    max_age_seconds: maxAgeSeconds,
    evidence_age_seconds: ageSeconds,
    skip_browser_requested: env.VIVA_RELEASE_CHECK_SKIP_BROWSER === "1",
    hosted_browser_evidence: summarizeHostedBrowserEvidence(hostedBrowser),
    live_smoke: summarizeLiveSmoke(evidence.live_smoke, {
      maxAgeSeconds,
      now: observedAt,
    }),
    submitted_answer_recovery_matrix: summarizeRecoveryMatrix(evidence.hosted_e2e_matrix),
    provider_failure_recovery_proof: summarizeProviderFailureProof(
      evidence.provider_failure_observability,
    ),
    redaction_audit: summarizeRedaction(evidence, hostedBrowser),
    config_parity: summarizeConfigParity({ env, hostedBrowser }),
    budget_controls: summarizeBudgetControls({ env, liveSmoke: evidence.live_smoke }),
    durability: summarizeDurability({ env, evidence, hostedBrowser }),
    rollback_owner_decision: summarizeRollbackOwnerDecision(evidence.rollback_drain),
    issue_proofs: summarizeIssueProofs({ env, evidence }),
    deploy_identity: {
      release_deploy_ids: releaseDeployIds,
      live_deploy_ids: liveDeployIds,
      evidence_deploy_ids: evidenceDeployIds,
      release_ids_present: bothPresent(releaseDeployIds),
      live_ids_present: bothPresent(liveDeployIds),
      evidence_ids_present: bothPresent(evidenceDeployIds),
      matches_live:
        bothPresent(liveDeployIds) &&
        evidenceDeployIds.web === liveDeployIds.web &&
        evidenceDeployIds.agent === liveDeployIds.agent,
      matches_release:
        bothPresent(releaseDeployIds) &&
        evidenceDeployIds.web === releaseDeployIds.web &&
        evidenceDeployIds.agent === releaseDeployIds.agent,
    },
    integrity: null,
    sanitized: true,
  };

  const missing = missingProductionEvidence(gate, { env, evidence });
  return {
    ...gate,
    missing_required_evidence: missing,
    allowed: productionRequested && missing.length === 0,
    reason:
      productionRequested && missing.length === 0
        ? "fresh_hosted_signed_evidence_and_owner_release_decision_present"
        : productionRequested
          ? "production_release_missing_required_evidence"
          : "non_production_release_check",
  };
}

export function assertProductionReleaseGate(evidence) {
  const gate = evidence?.production_release_gate ?? evidence;
  if (gate?.schema !== PRODUCTION_RELEASE_GATE_SCHEMA) {
    throw new Error("Invalid production release gate schema");
  }
  assertNoForbiddenEvidenceMarkers(gate);
  if (gate.production_requested === true && gate.allowed !== true) {
    throw new Error(
      `production release blocked: ${gate.reason}; missing=${gate.missing_required_evidence.join(",")}`,
    );
  }
  return gate;
}

export function buildReleaseBundleIntegrity({ evidence, env = process.env }) {
  const payload = canonicalJson(stripIntegrityFields(evidence));
  const payloadSha256 = sha256(payload);
  const signingSecret = stringOrNull(env.VIVA_RELEASE_BUNDLE_SIGNING_SECRET);
  const signature =
    signingSecret === null
      ? sha256(`unsigned:${payloadSha256}`)
      : createHmac("sha256", signingSecret).update(payloadSha256).digest("hex");
  return {
    schema: RELEASE_BUNDLE_INTEGRITY_SCHEMA,
    algorithm: "sha256",
    payload_sha256: payloadSha256,
    signature_algorithm: signingSecret === null ? "sha256-self" : "hmac-sha256",
    signature_sha256: signature,
    signature_key_present: signingSecret !== null,
    verified: true,
  };
}

export function assertReleaseBundleIntegrity(evidence, { env = process.env } = {}) {
  const integrity = evidence?.release_bundle?.integrity;
  if (integrity?.schema !== RELEASE_BUNDLE_INTEGRITY_SCHEMA) {
    throw new Error("release bundle integrity is missing");
  }
  const expected = buildReleaseBundleIntegrity({ evidence, env });
  if (
    integrity.payload_sha256 !== expected.payload_sha256 ||
    integrity.signature_sha256 !== expected.signature_sha256 ||
    integrity.signature_algorithm !== expected.signature_algorithm
  ) {
    throw new Error("release bundle integrity verification failed");
  }
  if (integrity.verified !== true) {
    throw new Error("release bundle integrity must be verified");
  }
  return integrity;
}

function missingProductionEvidence(gate, { env, evidence }) {
  if (gate.production_requested !== true) return [];
  const missing = [];
  pushUnless(missing, "production_browser_skip_disabled", gate.skip_browser_requested !== true);
  pushUnless(missing, "fresh_evidence_bundle", isFresh(gate));
  pushUnless(missing, "hosted_browser_evidence", gate.hosted_browser_evidence.present);
  pushUnless(missing, "synthetic_hosted_browser_result", gate.hosted_browser_evidence.synthetic_happy_path);
  pushUnless(missing, "hosted_browser_deploy_ids", gate.deploy_identity.evidence_ids_present);
  pushUnless(missing, "current_live_deploy_ids", gate.deploy_identity.live_ids_present);
  pushUnless(
    missing,
    "deploy_id_match",
    gate.deploy_identity.matches_live && gate.deploy_identity.matches_release,
  );
  pushUnless(missing, "provider_mode_and_model", gate.hosted_browser_evidence.provider_model_present);
  pushUnless(missing, "postgres_durability", gate.durability.production_durable);
  pushUnless(missing, "budget_capped_live_smoke", gate.live_smoke.passed_budget_capped);
  pushUnless(
    missing,
    "submitted_answer_recovery_matrix",
    gate.submitted_answer_recovery_matrix.complete,
  );
  pushUnless(
    missing,
    "provider_failure_recovery_proof",
    gate.provider_failure_recovery_proof.complete,
  );
  pushUnless(missing, "redaction_audit_zero", gate.redaction_audit.forbidden_hits_zero);
  pushUnless(missing, "config_parity", gate.config_parity.complete);
  pushUnless(missing, "budget_caps_provider_limiter", gate.budget_controls.complete);
  pushUnless(missing, "rollback_owner_proceed", gate.rollback_owner_decision.allowed);
  pushUnless(missing, "bac528_harness_disabled", gate.issue_proofs.bac_528_harness_disabled);
  pushUnless(missing, "bac531_consent_deletion_proof", gate.issue_proofs.bac_531_consent_deletion);
  pushUnless(missing, "bac529_gemini_quota_sufficiency", gate.issue_proofs.bac_529_quota_sufficient);
  pushUnless(missing, "bundle_signing_secret", stringOrNull(env.VIVA_RELEASE_BUNDLE_SIGNING_SECRET) !== null);
  pushUnless(missing, "release_evidence_sanitized", evidence.sanitized === true);
  return missing;
}

function summarizeHostedBrowserEvidence(hostedBrowser) {
  return {
    present: hostedBrowser?.schema === "viva.hosted_e2e_result.v1" && hostedBrowser.hosted_mode === true,
    schema: hostedBrowser?.schema ?? null,
    scenario_id: hostedBrowser?.scenario_id ?? null,
    hosted_mode: hostedBrowser?.hosted_mode === true,
    provider: hostedBrowser?.provider ?? null,
    model: hostedBrowser?.model ?? null,
    provider_model_present:
      typeof hostedBrowser?.provider === "string" &&
      hostedBrowser.provider.length > 0 &&
      typeof hostedBrowser?.model === "string" &&
      hostedBrowser.model.length > 0,
    synthetic_happy_path:
      hostedBrowser?.hosted_mode === true &&
      hostedBrowser?.provider === "synthetic" &&
      hostedBrowser?.scenario_id === "happy_path" &&
      hostedBrowser?.terminal_reason === "completed" &&
      hostedBrowser?.recap_success === true,
  };
}

function summarizeLiveSmoke(liveSmoke, { maxAgeSeconds = null, now = null } = {}) {
  const caps = liveSmoke?.caps ?? {};
  const capSummary = {
    max_duration_ms: numberOrNull(caps.max_duration_ms),
    max_turns: numberOrNull(caps.max_turns),
    max_audio_bytes: numberOrNull(caps.max_audio_bytes),
    max_session_cost_usd: numberOrNull(caps.max_session_cost_usd),
  };
  const budgetCapped =
    positiveWithin(capSummary.max_duration_ms, 90_000) &&
    positiveWithin(capSummary.max_turns, 1) &&
    positiveWithin(capSummary.max_audio_bytes, 262_144) &&
    positiveWithin(capSummary.max_session_cost_usd, 0.25);
  const generatedAt = parseDate(liveSmoke?.generated_at);
  const observedAt = now instanceof Date ? now : parseDate(now);
  const ageSeconds =
    generatedAt instanceof Date &&
    observedAt instanceof Date &&
    !Number.isNaN(generatedAt.getTime()) &&
    !Number.isNaN(observedAt.getTime())
      ? Math.max(0, Math.floor((observedAt.getTime() - generatedAt.getTime()) / 1000))
      : null;
  const fresh =
    Number.isInteger(ageSeconds) &&
    Number.isInteger(maxAgeSeconds) &&
    ageSeconds >= 0 &&
    ageSeconds <= maxAgeSeconds;
  const passedWithBudgetCaps =
    liveSmoke?.schema === "viva.live_provider_smoke.v1" &&
    liveSmoke.enabled === true &&
    liveSmoke.status === "passed" &&
    liveSmoke.provider === "cartesia_gemini" &&
    budgetCapped;
  return {
    present: liveSmoke?.schema === "viva.live_provider_smoke.v1",
    generated_at: liveSmoke?.generated_at ?? null,
    age_seconds: ageSeconds,
    fresh,
    enabled: liveSmoke?.enabled === true,
    status: liveSmoke?.status ?? null,
    provider: liveSmoke?.provider ?? null,
    caps: capSummary,
    durable_store_observed: liveSmoke?.readiness?.store?.durable === true,
    budget_capped: passedWithBudgetCaps,
    passed_budget_capped: passedWithBudgetCaps && fresh,
  };
}

function summarizeRecoveryMatrix(matrix) {
  const scenarioIds = Array.isArray(matrix?.scenarios)
    ? matrix.scenarios.map((scenario) => scenario.id).filter(Boolean)
    : [];
  const scenarioIdSet = new Set(scenarioIds);
  const missingScenarioIds = REQUIRED_RECOVERY_SCENARIOS.filter((id) => !scenarioIdSet.has(id));
  const executedScenarioIds = new Set(
    (Array.isArray(matrix?.results) ? matrix.results : [])
      .filter((result) => result?.status === "passed" && result.sanitized === true)
      .map((result) => result.scenario_id ?? result.id)
      .filter(Boolean),
  );
  const missingExecutedScenarioIds = REQUIRED_RECOVERY_SCENARIOS.filter(
    (id) => !executedScenarioIds.has(id),
  );
  return {
    schema: matrix?.schema ?? null,
    required_scenario_ids: [...REQUIRED_RECOVERY_SCENARIOS],
    missing_scenario_ids: missingScenarioIds,
    missing_executed_scenario_ids: missingExecutedScenarioIds,
    complete:
      matrix?.schema === "viva.hosted_e2e_matrix.v1" &&
      missingScenarioIds.length === 0 &&
      missingExecutedScenarioIds.length === 0,
  };
}

function summarizeProviderFailureProof(observability) {
  const queryIds = Array.isArray(observability?.log_queries)
    ? observability.log_queries.map((query) => query.id).filter(Boolean)
    : [];
  const queryIdSet = new Set(queryIds);
  const missingQueryIds = REQUIRED_PROVIDER_FAILURE_QUERIES.filter((id) => !queryIdSet.has(id));
  const observationRows = [
    ...(Array.isArray(observability?.observations) ? observability.observations : []),
    ...(Array.isArray(observability?.fixture?.events) ? observability.fixture.events : []),
  ];
  const observedQueryIds = new Set(
    observationRows
      .filter((observation) => observation?.sanitized === true)
      .map((observation) => observation.query_id ?? observation.id)
      .filter(Boolean),
  );
  const missingObservedQueryIds = REQUIRED_PROVIDER_FAILURE_QUERIES.filter(
    (id) => !observedQueryIds.has(id),
  );
  return {
    schema: observability?.schema ?? null,
    missing_query_ids: missingQueryIds,
    missing_observed_query_ids: missingObservedQueryIds,
    complete:
      observability?.schema === "viva.provider_failure_observability.v1" &&
      missingQueryIds.length === 0 &&
      missingObservedQueryIds.length === 0 &&
      observability.sanitized === true,
  };
}

function summarizeRedaction(evidence, hostedBrowser) {
  const artifactHits = integerOrNull(evidence.artifact_audit?.forbidden_hits);
  const hostedHits = integerOrNull(hostedBrowser?.redaction_audit?.forbidden_hits);
  return {
    artifact_forbidden_hits: artifactHits,
    hosted_forbidden_hits: hostedHits,
    forbidden_hits_zero: artifactHits === 0 && hostedHits === 0,
  };
}

function summarizeConfigParity({ env, hostedBrowser }) {
  const configDiffSha = sha256OrNull(
    env.VIVA_RELEASE_CONFIG_DIFF_SHA256 ?? env.VIVA_CONFIG_DIFF_SHA256,
  );
  const secretsSnapshotSha = sha256OrNull(env.VIVA_RELEASE_SECRETS_SNAPSHOT_SHA256);
  const expectedWebOrigin = originFromUrl(env.VIVA_RELEASE_WEB_ORIGIN ?? env.VIVA_HOSTED_WEB_URL);
  const expectedAgentOrigin = originFromUrl(
    env.VIVA_RELEASE_AGENT_ORIGIN ?? env.VIVA_HOSTED_AGENT_HTTP_URL ?? env.VIVA_HOSTED_AGENT_WS_URL,
  );
  const evidenceWebOrigin = originFromUrl(hostedBrowser?.web_url);
  const evidenceAgentOrigin = originFromUrl(hostedBrowser?.agent_url);
  const originsMatch =
    expectedWebOrigin !== null &&
    expectedAgentOrigin !== null &&
    evidenceWebOrigin === expectedWebOrigin &&
    evidenceAgentOrigin === expectedAgentOrigin;
  return {
    config_diff_sha256_present: configDiffSha !== null,
    secrets_snapshot_sha256_present: secretsSnapshotSha !== null,
    web_origin: evidenceWebOrigin,
    agent_origin: evidenceAgentOrigin,
    expected_web_origin: expectedWebOrigin,
    expected_agent_origin: expectedAgentOrigin,
    origins_match: originsMatch,
    complete: configDiffSha !== null && secretsSnapshotSha !== null && originsMatch,
  };
}

function summarizeBudgetControls({ env, liveSmoke }) {
  const limiterState = stringOrNull(env.VIVA_PROVIDER_LIMITER_STATE);
  const liveCaps = summarizeLiveSmoke(liveSmoke);
  return {
    limiter_state: limiterState,
    limiter_configured: limiterState !== null && ACCEPTED_LIMITER_STATES.has(limiterState),
    live_smoke_caps_configured: liveCaps.budget_capped,
    complete:
      limiterState !== null && ACCEPTED_LIMITER_STATES.has(limiterState) && liveCaps.budget_capped,
  };
}

function summarizeDurability({ env, evidence, hostedBrowser }) {
  const postgresState = stringOrNull(
    env.VIVA_RELEASE_POSTGRES_STATE ?? evidence.rollback_drain?.production_snapshot?.postgres_state,
  );
  const hostedDurability = stringOrNull(hostedBrowser?.postgres_durability);
  const liveDurable = evidence.live_smoke?.readiness?.store?.durable === true;
  const ephemeral =
    /^(in_memory|memory|ephemeral|none|disabled|not_asserted)$/i.test(postgresState ?? "") ||
    /^(in_memory|memory|ephemeral|none|disabled|not_asserted)$/i.test(hostedDurability ?? "");
  const productionDurable =
    postgresState !== null &&
    /postgres|durable|ready/i.test(postgresState) &&
    hostedDurability !== null &&
    /postgres|durable|ready/i.test(hostedDurability) &&
    liveDurable &&
    !ephemeral;
  return {
    durable_state_tickets_claimed: ["BAC-520", "BAC-521", "BAC-522"],
    postgres_state: postgresState,
    hosted_postgres_durability: hostedDurability,
    live_smoke_store_durable: liveDurable,
    production_durable: productionDurable,
  };
}

function summarizeRollbackOwnerDecision(rollbackDrain) {
  const gate = rollbackDrain?.production_release_gate ?? {};
  return {
    thresholds_present: gate.thresholds_present === true,
    owner_decision_present: gate.owner_decision_present === true,
    owner_decision_allows_release: gate.owner_decision_allows_release === true,
    allowed: gate.allowed === true,
  };
}

function summarizeIssueProofs({ env, evidence }) {
  return {
    bac_528_harness_disabled: evidence.failure_control_harness?.enabled_for_release === false,
    bac_531_consent_deletion: hasConsentDeletionProof(evidence.privacy, env),
    bac_529_quota_sufficient: hasGeminiQuotaProof(env, evidence.provider_readiness),
  };
}

function hasConsentDeletionProof(privacy, env) {
  const removed = new Set(Array.isArray(privacy?.deletion_proof?.proves_removed) ? privacy.deletion_proof.proves_removed : []);
  return (
    privacy?.consent_disclosure_in_product === true &&
    privacy?.raw_audio_persisted === false &&
    privacy?.transcripts_persisted === false &&
    privacy?.answers_persisted === false &&
    privacy?.deletion_proof?.proves_session_tombstoned === true &&
    removed.has("answer-attempt envelopes") &&
    env.CARTESIA_ZERO_DATA_RETENTION_ENABLED === "1" &&
    env.GEMINI_ZERO_DATA_RETENTION_APPROVED === "1"
  );
}

function hasGeminiQuotaProof(env, providerReadiness) {
  const rpm = positiveIntegerOrNull(env.VIVA_GEMINI_QUOTA_RPM_LIMIT);
  const tpm = positiveIntegerOrNull(env.VIVA_GEMINI_QUOTA_TPM_LIMIT);
  const readinessHasLiveProvider = Array.isArray(providerReadiness?.providers)
    ? providerReadiness.providers.some((provider) => provider.provider === "cartesia_gemini")
    : false;
  return env.VIVA_GEMINI_QUOTA_CONFIRMED === "1" && rpm !== null && tpm !== null && readinessHasLiveProvider;
}

function isFresh(gate) {
  return (
    Number.isInteger(gate.evidence_age_seconds) &&
    gate.evidence_age_seconds >= 0 &&
    gate.evidence_age_seconds <= gate.max_age_seconds
  );
}

function summarizeIntegrity(integrity) {
  return {
    schema: integrity.schema,
    algorithm: integrity.algorithm,
    payload_sha256: integrity.payload_sha256,
    signature_algorithm: integrity.signature_algorithm,
    signature_key_present: integrity.signature_key_present,
    verified: integrity.verified === true,
  };
}

function stripIntegrityFields(evidence) {
  const clone = cloneJson(evidence);
  if (clone.release_bundle) delete clone.release_bundle.integrity;
  if (clone.production_release_gate) delete clone.production_release_gate.integrity;
  return clone;
}

function assertNoForbiddenEvidenceMarkers(value) {
  const serialized = JSON.stringify(value);
  for (const needle of FORBIDDEN_EVIDENCE_MARKERS) {
    if (serialized.includes(needle)) {
      throw new Error(`production release evidence includes forbidden payload marker: ${needle}`);
    }
  }
  for (const [name, envValue] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) continue;
    if (envValue && envValue.length >= 8 && serialized.includes(envValue)) {
      throw new Error(`production release evidence includes secret value from ${name}`);
    }
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256OrNull(value) {
  const normalized = stringOrNull(value);
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function originFromUrl(value) {
  const normalized = stringOrNull(value);
  if (normalized === null) return null;
  try {
    const url = new URL(normalized);
    return url.origin;
  } catch {
    return null;
  }
}

function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function bothPresent(record) {
  return stringOrNull(record.web) !== null && stringOrNull(record.agent) !== null;
}

function pushUnless(missing, id, condition) {
  if (!condition) missing.push(id);
}

function positiveWithin(value, max) {
  return typeof value === "number" && value > 0 && value <= max;
}

function positiveIntegerOrDefault(value, fallback) {
  const parsed = positiveIntegerOrNull(value);
  return parsed ?? fallback;
}

function positiveIntegerOrNull(value) {
  const normalized = stringOrNull(value);
  if (normalized === null) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === normalized ? parsed : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
